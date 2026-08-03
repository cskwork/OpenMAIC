import { createHash, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  isRevisionedWhiteboardAuthenticatedTarget,
  isRevisionedWhiteboardMutationAck,
  isRevisionedWhiteboardMutationIdentity,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedWhiteboardAuthenticatedTarget,
  type RevisionedWhiteboardBinding,
  type RevisionedWhiteboardEnvironmentBinding,
  type RevisionedWhiteboardMutationAck,
  type RevisionedWhiteboardMutationToolName,
  type ShapeValidatedRevisionedWhiteboardReceipt,
} from './revisioned-whiteboard-contract';

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
}

type Entry = RevisionedWhiteboardCoordinatorRegistration & {
  status: RevisionedCoordinatorStatus;
  acceptedBinding?: RevisionedWhiteboardEnvironmentBinding;
  terminal?: RevisionedWhiteboardTerminal;
  terminalAck?: string;
  actionChargeTaken: boolean;
  hardTimer: ReturnType<typeof setTimeout>;
  acknowledgementToken: string;
};

type Tombstone = {
  requestDigest: string;
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

function targetsEqual(
  left: RevisionedWhiteboardAuthenticatedTarget,
  right: RevisionedWhiteboardAuthenticatedTarget,
): boolean {
  return (
    left.childInvocationId === right.childInvocationId &&
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.sceneId === right.sceneId
  );
}

function acceptedBindingMatchesExpected(
  accepted: Extract<RevisionedWhiteboardMutationAck, { status: 'accepted' }>['targetBinding'],
  expected: RevisionedWhiteboardBinding,
): boolean {
  return (
    accepted.stageId === expected.stageId &&
    accepted.whiteboardId === expected.whiteboardId &&
    accepted.observedRevision === expected.revision
  );
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
): string | null {
  if (receipt.outcome === 'committed' || receipt.outcome === 'uncertain') {
    if (!bindingsEqual(receipt.previousBinding, accepted)) {
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
      return receipt.previousBinding.stageId === accepted.stageId &&
        !bindingsEqual(receipt.previousBinding, accepted)
        ? null
        : 'REVISIONED_WHITEBOARD_RECEIPT_TARGET_MISMATCH';
    case 'TARGET_CHANGED':
      return receipt.previousBinding.stageId !== accepted.stageId
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

  register(input: RevisionedWhiteboardCoordinatorRegistration): {
    acknowledgementToken: string;
  } {
    this.cleanupExpired();
    if (
      !isRevisionedWhiteboardMutationIdentity({
        executionId: input.executionId,
        requestDigest: input.requestDigest,
        toolName: input.toolName,
        expectedBinding: input.expectedBinding,
      }) ||
      !isRevisionedWhiteboardAuthenticatedTarget(input.authenticatedTarget) ||
      !Number.isFinite(input.deadlineAt)
    ) {
      throw new Error('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
    }
    const existing = this.entries.get(input.executionId);
    if (existing) {
      if (
        existing.requestDigest !== input.requestDigest ||
        existing.toolName !== input.toolName ||
        !bindingsEqual(existing.expectedBinding, input.expectedBinding) ||
        !targetsEqual(existing.authenticatedTarget, input.authenticatedTarget) ||
        existing.deadlineAt !== input.deadlineAt
      ) {
        throw new Error('REVISIONED_WHITEBOARD_REGISTRATION_CONFLICT');
      }
      if (!existing.terminal && this.now() >= existing.deadlineAt) {
        this.settleDeliveryFailure(existing.executionId);
      }
      if (existing.terminal) throw new Error('REVISIONED_WHITEBOARD_REGISTRATION_TERMINAL');
      return { acknowledgementToken: existing.acknowledgementToken };
    }
    if (this.tombstones.has(input.executionId)) {
      throw new Error('REVISIONED_WHITEBOARD_REGISTRATION_CONFLICT');
    }
    if (this.entries.size >= this.maxEntries) {
      throw new Error('REVISIONED_WHITEBOARD_COORDINATOR_CAPACITY_EXCEEDED');
    }
    const remainingMs = input.deadlineAt - this.now();
    if (remainingMs <= 0) throw new Error('REVISIONED_WHITEBOARD_DEADLINE_EXCEEDED');
    const hardTimer = setTimeout(() => this.settleDeliveryFailure(input.executionId), remainingMs);
    const acknowledgementToken = this.createToken();
    const expectedBinding = Object.freeze({ ...input.expectedBinding });
    const authenticatedTarget = Object.freeze({ ...input.authenticatedTarget });
    this.entries.set(input.executionId, {
      executionId: input.executionId,
      requestDigest: input.requestDigest,
      toolName: input.toolName,
      expectedBinding,
      authenticatedTarget,
      deadlineAt: input.deadlineAt,
      status: 'pending',
      actionChargeTaken: false,
      hardTimer,
      acknowledgementToken,
    });
    return { acknowledgementToken };
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
      if (!acceptedBindingMatchesExpected(ack.targetBinding, entry.expectedBinding)) {
        return { kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_ACCEPTED_TARGET_MISMATCH' };
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
    const correlationError = receiptCorrelationError(receipt, entry.acceptedBinding);
    if (correlationError) return { kind: 'invalid', reason: correlationError };

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

  private settle(entry: Entry, terminal: RevisionedWhiteboardTerminal, terminalAck?: string): void {
    if (entry.terminal) return;
    clearTimeout(entry.hardTimer);
    const terminalSnapshot = Object.freeze({ ...terminal });
    entry.status = terminalSnapshot.status;
    entry.terminal = terminalSnapshot;
    entry.terminalAck = terminalAck;
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
