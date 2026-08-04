import { createHash, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  isRevisionedWhiteboardAuthenticatedTarget,
  isRevisionedWhiteboardCommittedReceiptForExpected,
  isRevisionedWhiteboardExpectedDescriptor,
  isRevisionedWhiteboardMutationAck,
  isRevisionedWhiteboardMutationIdentity,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedWhiteboardAuthenticatedTarget,
  type RevisionedWhiteboardBinding,
  type RevisionedWhiteboardEnvironmentBinding,
  type RevisionedWhiteboardMutationAck,
  type RevisionedWhiteboardMutationToolName,
  type RevisionedWhiteboardExpectedDescriptor,
  type ShapeValidatedRevisionedWhiteboardReceipt,
} from './revisioned-whiteboard-contract';
import { digestRevisionedValue } from './revisioned-whiteboard-digest';

type RevisionedCoordinatorStatus = 'pending' | 'accepted' | 'committed' | 'rejected' | 'uncertain';

const coordinatorAuthenticatedReceiptBrand: unique symbol = Symbol(
  'coordinatorAuthenticatedRevisionedWhiteboardReceipt',
);

export type CoordinatorAuthenticatedRevisionedWhiteboardReceipt = Readonly<{
  receipt: ShapeValidatedRevisionedWhiteboardReceipt;
  authenticatedTarget: Readonly<RevisionedWhiteboardAuthenticatedTarget>;
  deadlineAt: number;
  readonly [coordinatorAuthenticatedReceiptBrand]: true;
}>;

export function isCoordinatorAuthenticatedRevisionedWhiteboardReceipt(
  value: unknown,
): value is CoordinatorAuthenticatedRevisionedWhiteboardReceipt {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as Partial<CoordinatorAuthenticatedRevisionedWhiteboardReceipt>)[
      coordinatorAuthenticatedReceiptBrand
    ] === true &&
    Object.isFrozen(value) &&
    Object.isFrozen(
      (value as Partial<CoordinatorAuthenticatedRevisionedWhiteboardReceipt>).authenticatedTarget,
    ) &&
    Object.isFrozen((value as Partial<CoordinatorAuthenticatedRevisionedWhiteboardReceipt>).receipt)
  );
}

export type RevisionedWhiteboardTerminal = {
  executionId: string;
  status: Extract<RevisionedCoordinatorStatus, 'committed' | 'rejected' | 'uncertain'>;
  mutationMayHaveCommitted: boolean;
  actionDisposition: 'none' | 'consume_once';
  receipt?: ShapeValidatedRevisionedWhiteboardReceipt;
  authenticatedReceipt?: CoordinatorAuthenticatedRevisionedWhiteboardReceipt;
};

export interface RevisionedWhiteboardCoordinatorRegistration {
  executionId: string;
  requestDigest: string;
  toolName: RevisionedWhiteboardMutationToolName;
  expectedBinding: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intentDigest?: string;
  observationAuthorizationDigest?: string;
  expectedMutation?: RevisionedWhiteboardExpectedDescriptor;
}

export type PendingRegisteredRevisionedMutation = {
  kind: 'pending';
  acknowledgementToken: string;
  terminal: Promise<RevisionedWhiteboardTerminal>;
};

export type SettledRevisionedMutationReplay = {
  kind: 'settled_replay';
  terminal: Promise<RevisionedWhiteboardTerminal>;
};

export type RegisteredRevisionedMutation =
  | PendingRegisteredRevisionedMutation
  | SettledRevisionedMutationReplay;

type Entry = RevisionedWhiteboardCoordinatorRegistration & {
  registrationDigest: string;
  status: RevisionedCoordinatorStatus;
  acceptedBinding?: RevisionedWhiteboardEnvironmentBinding;
  terminal?: RevisionedWhiteboardTerminal;
  terminalAck?: string;
  actionChargeTaken: boolean;
  hardTimer: ReturnType<typeof setTimeout>;
  acknowledgementToken: string;
  terminalPromise: Promise<RevisionedWhiteboardTerminal>;
  resolveTerminal: (terminal: RevisionedWhiteboardTerminal) => void;
};

type Tombstone = {
  requestDigest: string;
  registrationDigest: string;
  observationAuthorizationDigest?: string;
  terminal: RevisionedWhiteboardTerminal;
  terminalAck?: string;
  expiresAt: number;
  acknowledgementTokenDigest: string;
  actionChargeTaken: boolean;
};

export type RevisionedAckResult =
  | { kind: 'applied' | 'duplicate'; status: RevisionedCoordinatorStatus }
  | { kind: 'unknown' | 'invalid'; reason?: string };

function bindingsEqual(
  left: RevisionedWhiteboardEnvironmentBinding,
  right: RevisionedWhiteboardEnvironmentBinding,
): boolean {
  return (
    left.stageId === right.stageId &&
    left.whiteboardId === right.whiteboardId &&
    left.revision === right.revision
  );
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function registrationDigest(input: RevisionedWhiteboardCoordinatorRegistration): string {
  return digestRevisionedValue({
    executionId: input.executionId,
    requestDigest: input.requestDigest,
    intentDigest: input.intentDigest ?? null,
    toolName: input.toolName,
    expectedBinding: input.expectedBinding,
    authenticatedTarget: input.authenticatedTarget,
    deadlineAt: input.deadlineAt,
    expectedMutation: input.expectedMutation ?? null,
  });
}

/**
 * A tool enters this map atomically with its exact descriptor and receipt
 * verifier, before any executable v2 handler can register it. The reverse map
 * is exhaustive over the descriptor union so adding a descriptor cannot
 * silently leave committed receipt validation optional.
 */
const exactToolByDescriptorKind = {
  wb_draw_text_v2: 'wb_draw_text',
  wb_draw_shape_v2: 'wb_draw_shape',
  wb_draw_line_v2: 'wb_draw_line',
  wb_draw_latex_v2: 'wb_draw_latex',
  wb_draw_table_v2: 'wb_draw_table',
  wb_draw_chart_v2: 'wb_draw_chart',
} as const satisfies Record<
  RevisionedWhiteboardExpectedDescriptor['kind'],
  RevisionedWhiteboardMutationToolName
>;

function toolRequiresExactDescriptor(toolName: RevisionedWhiteboardMutationToolName): boolean {
  return Object.values(exactToolByDescriptorKind).some((candidate) => candidate === toolName);
}

function descriptorMatchesTool(
  descriptor: RevisionedWhiteboardExpectedDescriptor,
  toolName: RevisionedWhiteboardMutationToolName,
): boolean {
  return exactToolByDescriptorKind[descriptor.kind] === toolName;
}

function acceptedBindingsEqual(
  left: Extract<RevisionedWhiteboardMutationAck, { status: 'accepted' }>['targetBinding'],
  right: RevisionedWhiteboardEnvironmentBinding,
): boolean {
  return (
    left.stageId === right.stageId &&
    left.whiteboardId === right.whiteboardId &&
    left.observedRevision === right.revision
  );
}

function receiptCorrelationError(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  accepted: RevisionedWhiteboardEnvironmentBinding,
  expected: RevisionedWhiteboardBinding,
): string | null {
  if (receipt.outcome === 'committed' || receipt.outcome === 'uncertain') {
    if (
      !bindingsEqual(receipt.previousBinding, accepted) ||
      !bindingsEqual(receipt.previousBinding, expected)
    ) {
      return 'REVISIONED_WHITEBOARD_RECEIPT_TARGET_MISMATCH';
    }
    if (
      receipt.currentBinding.stageId !== receipt.previousBinding.stageId ||
      receipt.currentBinding.revision !==
        receipt.previousBinding.revision + (receipt.changed ? 1 : 0) ||
      (!receipt.changed && !bindingsEqual(receipt.currentBinding, receipt.previousBinding))
    ) {
      return 'REVISIONED_WHITEBOARD_RECEIPT_REVISION_INVALID';
    }
    return null;
  }

  if (!bindingsEqual(receipt.previousBinding, receipt.currentBinding)) {
    return 'REVISIONED_WHITEBOARD_RECEIPT_REVISION_INVALID';
  }
  switch (receipt.error.code) {
    case 'TARGET_PRECONDITION_FAILED':
    case 'WHITEBOARD_AUTHORITY_BYPASS_DETECTED':
      return bindingsEqual(receipt.previousBinding, accepted)
        ? null
        : 'REVISIONED_WHITEBOARD_RECEIPT_TARGET_MISMATCH';
    case 'AUTHENTICATED_TARGET_CHANGED':
      return null;
    case 'STALE_STATE':
      return receipt.previousBinding.stageId === expected.stageId &&
        !bindingsEqual(receipt.previousBinding, expected)
        ? null
        : 'REVISIONED_WHITEBOARD_RECEIPT_TARGET_MISMATCH';
    case 'TARGET_CHANGED':
      return receipt.previousBinding.stageId !== expected.stageId
        ? null
        : 'REVISIONED_WHITEBOARD_RECEIPT_TARGET_MISMATCH';
    case 'EXECUTION_ID_CONFLICT':
      return null;
  }
}

/** Internal/test-only v2 coordinator. It is not wired into the public inventory. */
export class RevisionedWhiteboardCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly maxEntries: number;
  private readonly maxTombstones: number;
  private readonly now: () => number;
  private readonly replayGraceMs: number;
  private readonly createToken: () => string;

  constructor(
    opts: {
      maxEntries?: number;
      maxTombstones?: number;
      now?: () => number;
      replayGraceMs?: number;
      createToken?: () => string;
    } = {},
  ) {
    this.maxEntries = opts.maxEntries ?? 512;
    this.maxTombstones = opts.maxTombstones ?? 256;
    this.now = opts.now ?? Date.now;
    this.replayGraceMs = opts.replayGraceMs ?? 30_000;
    this.createToken = opts.createToken ?? (() => nanoid(32));
  }

  findAuthorizedReplay(
    input: RevisionedWhiteboardCoordinatorRegistration,
  ): RegisteredRevisionedMutation | null {
    this.cleanupExpired();
    this.validateRegistration(input);
    const expectedDigest = registrationDigest(input);
    const existing = this.entries.get(input.executionId);
    if (existing) {
      if (
        existing.registrationDigest !== expectedDigest ||
        existing.observationAuthorizationDigest !== input.observationAuthorizationDigest
      ) {
        throw new Error('REVISIONED_WHITEBOARD_REGISTRATION_CONFLICT');
      }
      if (!existing.terminal && this.now() >= existing.deadlineAt) {
        this.settleDeliveryFailure(existing.executionId);
      }
      return existing.terminal
        ? { kind: 'settled_replay', terminal: existing.terminalPromise }
        : {
            kind: 'pending',
            acknowledgementToken: existing.acknowledgementToken,
            terminal: existing.terminalPromise,
          };
    }
    const tombstone = this.tombstones.get(input.executionId);
    if (!tombstone) return null;
    if (
      tombstone.registrationDigest !== expectedDigest ||
      tombstone.observationAuthorizationDigest !== input.observationAuthorizationDigest
    ) {
      throw new Error('REVISIONED_WHITEBOARD_REGISTRATION_CONFLICT');
    }
    return { kind: 'settled_replay', terminal: Promise.resolve(tombstone.terminal) };
  }

  register(input: RevisionedWhiteboardCoordinatorRegistration): RegisteredRevisionedMutation {
    const replay = this.findAuthorizedReplay(input);
    if (replay) return replay;
    if (this.entries.size >= this.maxEntries) {
      throw new Error('REVISIONED_WHITEBOARD_COORDINATOR_CAPACITY_EXCEEDED');
    }
    const remainingMs = input.deadlineAt - this.now();
    if (remainingMs <= 0) throw new Error('REVISIONED_WHITEBOARD_DEADLINE_EXCEEDED');
    const hardTimer = setTimeout(() => this.settleDeliveryFailure(input.executionId), remainingMs);
    const acknowledgementToken = this.createToken();
    const expectedBinding = Object.freeze({ ...input.expectedBinding });
    const authenticatedTarget = Object.freeze({ ...input.authenticatedTarget });
    const expectedMutation = input.expectedMutation
      ? Object.freeze({ ...input.expectedMutation })
      : undefined;
    let resolveTerminal!: (terminal: RevisionedWhiteboardTerminal) => void;
    const terminalPromise = new Promise<RevisionedWhiteboardTerminal>((resolve) => {
      resolveTerminal = resolve;
    });
    this.entries.set(input.executionId, {
      executionId: input.executionId,
      requestDigest: input.requestDigest,
      toolName: input.toolName,
      expectedBinding,
      authenticatedTarget,
      deadlineAt: input.deadlineAt,
      ...(input.intentDigest ? { intentDigest: input.intentDigest } : {}),
      ...(input.observationAuthorizationDigest
        ? { observationAuthorizationDigest: input.observationAuthorizationDigest }
        : {}),
      ...(expectedMutation ? { expectedMutation } : {}),
      registrationDigest: registrationDigest(input),
      status: 'pending',
      actionChargeTaken: false,
      hardTimer,
      acknowledgementToken,
      terminalPromise,
      resolveTerminal,
    });
    return { kind: 'pending', acknowledgementToken, terminal: terminalPromise };
  }

  authorize(
    executionId: string,
    acknowledgementToken: string,
  ): 'authorized' | 'unauthorized' | 'unknown' {
    this.cleanupExpired();
    const entry = this.entries.get(executionId);
    if (entry) {
      return tokenMatches(acknowledgementToken, entry.acknowledgementToken)
        ? 'authorized'
        : 'unauthorized';
    }
    const tombstone = this.tombstones.get(executionId);
    if (!tombstone) return 'unknown';
    return tokenMatchesDigest(acknowledgementToken, tombstone.acknowledgementTokenDigest)
      ? 'authorized'
      : 'unauthorized';
  }

  private validateRegistration(input: RevisionedWhiteboardCoordinatorRegistration): void {
    const requiresExactDescriptor = toolRequiresExactDescriptor(input.toolName);
    if (
      !isRevisionedWhiteboardMutationIdentity({
        executionId: input.executionId,
        requestDigest: input.requestDigest,
        toolName: input.toolName,
        expectedBinding: input.expectedBinding,
      }) ||
      !isRevisionedWhiteboardAuthenticatedTarget(input.authenticatedTarget) ||
      !Number.isFinite(input.deadlineAt) ||
      (input.intentDigest !== undefined && !isSha256Digest(input.intentDigest)) ||
      (input.observationAuthorizationDigest !== undefined &&
        !isSha256Digest(input.observationAuthorizationDigest)) ||
      (requiresExactDescriptor && input.expectedMutation === undefined) ||
      (input.expectedMutation !== undefined &&
        (!isRevisionedWhiteboardExpectedDescriptor(input.expectedMutation) ||
          !descriptorMatchesTool(input.expectedMutation, input.toolName) ||
          input.expectedMutation.intentDigest !== input.intentDigest ||
          input.observationAuthorizationDigest === undefined))
    ) {
      throw new Error('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
    }
  }

  applyAck(acknowledgementToken: string, value: unknown): RevisionedAckResult {
    this.cleanupExpired();
    if (!isRevisionedWhiteboardMutationAck(value)) {
      return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_INVALID' };
    }
    const ack: RevisionedWhiteboardMutationAck = value;
    const entry = this.entries.get(ack.executionId);
    if (!entry) {
      const tombstone = this.tombstones.get(ack.executionId);
      if (!tombstone || tombstone.requestDigest !== ack.requestDigest) return { kind: 'unknown' };
      if (!tokenMatchesDigest(acknowledgementToken, tombstone.acknowledgementTokenDigest)) {
        return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_UNAUTHORIZED' };
      }
      const serialized = JSON.stringify(ack);
      return tombstone.terminalAck === serialized
        ? { kind: 'duplicate', status: tombstone.terminal.status }
        : { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_CONFLICT' };
    }
    if (entry.requestDigest !== ack.requestDigest) {
      return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_CONFLICT' };
    }
    if (!tokenMatches(acknowledgementToken, entry.acknowledgementToken)) {
      return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_UNAUTHORIZED' };
    }
    if (!entry.terminal && this.now() >= entry.deadlineAt) {
      this.settleDeliveryFailure(entry.executionId);
    }

    if (ack.status === 'accepted') {
      if (entry.terminal) {
        return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_AFTER_TERMINAL' };
      }
      if (entry.status === 'accepted') {
        return acceptedBindingsEqual(ack.targetBinding, entry.acceptedBinding!)
          ? { kind: 'duplicate', status: entry.status }
          : { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_CONFLICT' };
      }
      entry.acceptedBinding = {
        stageId: ack.targetBinding.stageId,
        whiteboardId: ack.targetBinding.whiteboardId,
        revision: ack.targetBinding.observedRevision,
      };
      entry.status = 'accepted';
      return { kind: 'applied', status: entry.status };
    }

    const serialized = JSON.stringify(ack);
    if (entry.terminal) {
      return entry.terminalAck === serialized
        ? { kind: 'duplicate', status: entry.status }
        : { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACK_CONFLICT' };
    }
    if (entry.status !== 'accepted' || !entry.acceptedBinding) {
      return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_TERMINAL_REQUIRES_ACCEPTED' };
    }
    const receipt = verifyRevisionedWhiteboardAuthorityReceipt(ack.receipt);
    if (!receipt) return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_RECEIPT_INVALID' };
    if (receipt.toolName !== entry.toolName) {
      return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_RECEIPT_TOOL_MISMATCH' };
    }
    const correlationError = receiptCorrelationError(
      receipt,
      entry.acceptedBinding,
      entry.expectedBinding,
    );
    if (correlationError) return { kind: 'invalid', reason: correlationError };
    if (
      receipt.outcome === 'committed' &&
      toolRequiresExactDescriptor(entry.toolName) &&
      (!entry.expectedMutation ||
        !isRevisionedWhiteboardCommittedReceiptForExpected(receipt, entry.expectedMutation))
    ) {
      return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_DRAW_RECEIPT_INVALID' };
    }

    const actionDisposition =
      receipt.outcome === 'uncertain' || (receipt.outcome === 'committed' && receipt.changed)
        ? 'consume_once'
        : 'none';
    const authenticatedReceipt: CoordinatorAuthenticatedRevisionedWhiteboardReceipt = Object.freeze(
      {
        receipt,
        authenticatedTarget: entry.authenticatedTarget,
        deadlineAt: entry.deadlineAt,
        [coordinatorAuthenticatedReceiptBrand]: true as const,
      },
    );
    const terminal: RevisionedWhiteboardTerminal = {
      executionId: entry.executionId,
      status:
        receipt.outcome === 'committed'
          ? 'committed'
          : receipt.outcome === 'rejected'
            ? 'rejected'
            : 'uncertain',
      mutationMayHaveCommitted: receipt.mutationMayHaveCommitted,
      actionDisposition,
      receipt,
      authenticatedReceipt,
    };
    this.settle(entry, terminal, serialized);
    return { kind: 'applied', status: entry.status };
  }

  settleDeliveryFailure(executionId: string): RevisionedWhiteboardTerminal | null {
    const entry = this.entries.get(executionId);
    if (!entry || entry.terminal) return entry?.terminal ?? null;
    if (entry.status !== 'accepted') {
      const terminal: RevisionedWhiteboardTerminal = {
        executionId,
        status: 'rejected',
        mutationMayHaveCommitted: false,
        actionDisposition: 'none',
      };
      this.settle(entry, terminal);
      return terminal;
    }
    const terminal: RevisionedWhiteboardTerminal = {
      executionId,
      status: 'uncertain',
      mutationMayHaveCommitted: true,
      actionDisposition: 'consume_once',
    };
    this.settle(entry, terminal);
    return terminal;
  }

  getTerminal(executionId: string): RevisionedWhiteboardTerminal | null {
    this.cleanupExpired();
    return (
      this.entries.get(executionId)?.terminal ?? this.tombstones.get(executionId)?.terminal ?? null
    );
  }

  takeActionCharge(executionId: string): boolean {
    const entry = this.entries.get(executionId);
    if (entry) {
      if (entry.terminal?.actionDisposition !== 'consume_once' || entry.actionChargeTaken) {
        return false;
      }
      entry.actionChargeTaken = true;
      return true;
    }
    const tombstone = this.tombstones.get(executionId);
    if (
      !tombstone ||
      tombstone.terminal.actionDisposition !== 'consume_once' ||
      tombstone.actionChargeTaken
    ) {
      return false;
    }
    tombstone.actionChargeTaken = true;
    return true;
  }

  cleanup(executionId: string): void {
    const entry = this.entries.get(executionId);
    if (!entry?.terminal) return;
    clearTimeout(entry.hardTimer);
    this.entries.delete(executionId);
    this.tombstones.set(executionId, {
      requestDigest: entry.requestDigest,
      registrationDigest: entry.registrationDigest,
      ...(entry.observationAuthorizationDigest
        ? { observationAuthorizationDigest: entry.observationAuthorizationDigest }
        : {}),
      terminal: entry.terminal,
      terminalAck: entry.terminalAck,
      expiresAt: this.now() + this.replayGraceMs,
      acknowledgementTokenDigest: digest(entry.acknowledgementToken),
      actionChargeTaken: entry.actionChargeTaken,
    });
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.tombstones.delete(oldest);
    }
  }

  clearForTests(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.hardTimer);
    this.entries.clear();
    this.tombstones.clear();
  }

  private settle(entry: Entry, terminal: RevisionedWhiteboardTerminal, terminalAck?: string): void {
    if (entry.terminal) return;
    clearTimeout(entry.hardTimer);
    const terminalSnapshot = Object.freeze({ ...terminal });
    entry.status = terminalSnapshot.status;
    entry.terminal = terminalSnapshot;
    entry.terminalAck = terminalAck;
    entry.resolveTerminal(terminalSnapshot);
  }

  private cleanupExpired(): void {
    const current = this.now();
    for (const [executionId, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= current) this.tombstones.delete(executionId);
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenMatches(actual: string, expected: string): boolean {
  return tokenMatchesDigest(actual, digest(expected));
}

function tokenMatchesDigest(actual: string, expectedDigest: string): boolean {
  const actualBytes = Buffer.from(digest(actual), 'hex');
  const expectedBytes = Buffer.from(expectedDigest, 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const processGlobal = globalThis as typeof globalThis & {
  __openmaicRevisionedWhiteboardCoordinator?: RevisionedWhiteboardCoordinator;
};

export const piRevisionedWhiteboardCoordinator =
  processGlobal.__openmaicRevisionedWhiteboardCoordinator ??
  (processGlobal.__openmaicRevisionedWhiteboardCoordinator = new RevisionedWhiteboardCoordinator());
