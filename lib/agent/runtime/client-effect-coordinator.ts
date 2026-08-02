import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
  CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
  type AcceptedTargetBinding,
  type ClientEffectAck,
  type ClientEffectCoordinatorSnapshot,
  type ClientEffectDelivery,
  type ClientEffectRequest,
  type ClientEffectTraceEvent,
  type ClientEffectTerminalResult,
  type WhiteboardDeleteCommittedObservation,
  type WhiteboardCloseCommittedObservation,
  type WhiteboardClearCommittedObservation,
  type WhiteboardOpenCommittedObservation,
  type WhiteboardVisibilityTarget,
} from './client-effect-contract';

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_ACKNOWLEDGEMENTS_PER_EFFECT = 64;

interface CoordinatorEntry {
  request: ClientEffectRequest;
  acknowledgementToken: string;
  status: ClientEffectCoordinatorSnapshot['status'];
  paused: boolean;
  activeRemainingMs: number;
  activeStartedAt: number | null;
  targetBinding?: AcceptedTargetBinding;
  visibilityTarget?: WhiteboardVisibilityTarget;
  terminalResult?: ClientEffectTerminalResult;
  hardTimer: TimerHandle | null;
  activeTimer: TimerHandle | null;
  acknowledgements: Map<string, { fingerprint: string; snapshot: ClientEffectCoordinatorSnapshot }>;
  result: Promise<ClientEffectTerminalResult>;
  resolveResult: (result: ClientEffectTerminalResult) => void;
}

interface CoordinatorTombstone {
  acknowledgementTokenDigest: Buffer;
  idempotencyKey: string;
  snapshot: ClientEffectCoordinatorSnapshot;
}

export type ClientEffectAckOutcome =
  | { kind: 'applied' | 'duplicate' | 'late'; snapshot: ClientEffectCoordinatorSnapshot }
  | { kind: 'invalid'; reason: string; snapshot?: ClientEffectCoordinatorSnapshot }
  | { kind: 'unauthorized' | 'unknown' };

export interface RegisteredClientEffect {
  delivery: ClientEffectDelivery;
  result: Promise<ClientEffectTerminalResult>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function registrationIdentity(request: ClientEffectRequest): string {
  return stableJson({
    protocolVersion: request.protocolVersion,
    executionId: request.executionId,
    idempotencyKey: request.idempotencyKey,
    toolName: request.toolName,
    target: request.target,
    postcondition: request.postcondition,
    argsDigest: request.argsDigest,
  });
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenMatchesDigest(token: string, expected: Buffer): boolean {
  const actual = tokenDigest(token);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function bindingsEqual(left: AcceptedTargetBinding, right: AcceptedTargetBinding): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.stageId === right.stageId &&
    left.sceneId === right.sceneId &&
    left.whiteboardId === right.whiteboardId &&
    left.bindingVersion === right.bindingVersion
  );
}

function visibilityTargetsEqual(
  left: WhiteboardVisibilityTarget,
  right: WhiteboardVisibilityTarget,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.stageId === right.stageId &&
    left.sceneId === right.sceneId &&
    left.bindingVersion === right.bindingVersion
  );
}

export class ClientEffectCoordinator {
  private readonly entries = new Map<string, CoordinatorEntry>();
  private readonly effectOwners = new Map<string, string>();
  private readonly tombstones = new Map<string, CoordinatorTombstone>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly tombstoneLimit = 256,
    private readonly onTrace?: (event: ClientEffectTraceEvent) => void,
  ) {
    if (!Number.isInteger(tombstoneLimit) || tombstoneLimit <= 0) {
      throw new Error('Client effect tombstone limit must be a positive integer.');
    }
  }

  register(request: ClientEffectRequest): RegisteredClientEffect {
    const existing = this.entries.get(request.executionId);
    if (existing) {
      if (registrationIdentity(existing.request) !== registrationIdentity(request)) {
        throw new Error(`Client effect execution "${request.executionId}" conflicts.`);
      }
      this.trace(existing, { type: 'duplicate_delivery' });
      return {
        delivery: {
          request: existing.request,
          acknowledgementToken: existing.acknowledgementToken,
        },
        result: existing.result,
      };
    }
    if (this.tombstones.has(request.executionId)) {
      throw new Error(`Client effect execution "${request.executionId}" is already registered.`);
    }
    if (
      !Number.isFinite(request.activeEffectBudgetMs) ||
      request.activeEffectBudgetMs <= 0 ||
      !Number.isFinite(request.deadlineAt) ||
      request.deadlineAt <= this.now()
    ) {
      throw new Error('Client effect requires positive active and hard timing bounds.');
    }
    const ownershipKey = this.ownershipKey(request);
    const owner = this.effectOwners.get(ownershipKey);
    if (owner && owner !== request.executionId) {
      if (
        request.postcondition.kind === 'whiteboard_open' ||
        request.postcondition.kind === 'whiteboard_closed' ||
        request.postcondition.kind === 'whiteboard_empty' ||
        request.postcondition.kind === 'whiteboard_code_edited' ||
        request.postcondition.kind === 'whiteboard_element_absent'
      ) {
        throw new Error('CLIENT_EFFECT_RESOURCE_BUSY');
      }
      throw new Error(
        `Stable element "${request.postcondition.stableElementId}" belongs to another execution.`,
      );
    }

    let resolveResult!: (result: ClientEffectTerminalResult) => void;
    const result = new Promise<ClientEffectTerminalResult>((resolve) => {
      resolveResult = resolve;
    });
    const acknowledgementToken = randomBytes(24).toString('base64url');
    const entry: CoordinatorEntry = {
      request,
      acknowledgementToken,
      status: 'pending',
      paused: false,
      activeRemainingMs: request.activeEffectBudgetMs,
      activeStartedAt: this.now(),
      hardTimer: null,
      activeTimer: null,
      acknowledgements: new Map(),
      result,
      resolveResult,
    };
    this.entries.set(request.executionId, entry);
    this.effectOwners.set(ownershipKey, request.executionId);
    this.trace(entry, { type: 'registered' });
    this.armTimers(entry);

    return {
      delivery: { request, acknowledgementToken },
      result,
    };
  }

  authorize(executionId: string, token: string): 'authorized' | 'unauthorized' | 'unknown' {
    const entry = this.entries.get(executionId);
    if (entry) {
      if (tokensEqual(token, entry.acknowledgementToken)) return 'authorized';
      this.trace(entry, { type: 'ack_rejected', code: 'UNAUTHORIZED' });
      return 'unauthorized';
    }
    const tombstone = this.tombstones.get(executionId);
    if (!tombstone) return 'unknown';
    return tokenMatchesDigest(token, tombstone.acknowledgementTokenDigest)
      ? 'authorized'
      : 'unauthorized';
  }

  acknowledge(executionId: string, token: string, ack: ClientEffectAck): ClientEffectAckOutcome {
    const entry = this.entries.get(executionId);
    if (!entry) {
      const tombstone = this.tombstones.get(executionId);
      if (!tombstone) return { kind: 'unknown' };
      if (!tokenMatchesDigest(token, tombstone.acknowledgementTokenDigest)) {
        return { kind: 'unauthorized' };
      }
      if (ack.executionId !== executionId || ack.idempotencyKey !== tombstone.idempotencyKey) {
        return {
          kind: 'invalid',
          reason: 'ACK identity does not match the cleaned-up execution.',
          snapshot: tombstone.snapshot,
        };
      }
      return { kind: 'late', snapshot: tombstone.snapshot };
    }
    if (!tokensEqual(token, entry.acknowledgementToken)) {
      this.trace(entry, { type: 'ack_rejected', code: 'UNAUTHORIZED' });
      return { kind: 'unauthorized' };
    }
    if (ack.executionId !== executionId || ack.idempotencyKey !== entry.request.idempotencyKey) {
      this.trace(entry, { type: 'ack_rejected', ackStatus: ack.status, code: 'IDENTITY' });
      return { kind: 'invalid', reason: 'ACK identity does not match the execution.' };
    }
    if (!entry.terminalResult && this.now() >= entry.request.deadlineAt) {
      this.settle(entry, 'cancelled', {
        code: 'HARD_DEADLINE_EXCEEDED',
        message: 'Client effect exceeded its hard wall-clock deadline.',
        retryable: false,
      });
      const snapshot = this.snapshot(entry);
      this.trace(entry, { type: 'ack_late', ackStatus: ack.status });
      return { kind: 'late', snapshot };
    }

    const fingerprint = stableJson(ack);
    const previous = entry.acknowledgements.get(ack.clientEventId);
    if (previous) {
      if (previous.fingerprint === fingerprint) {
        this.trace(entry, { type: 'ack_duplicate', ackStatus: ack.status });
        return {
          kind: 'duplicate',
          snapshot: entry.terminalResult ? this.snapshot(entry) : previous.snapshot,
        };
      }
      this.trace(entry, { type: 'ack_rejected', ackStatus: ack.status, code: 'CONFLICT' });
      return {
        kind: 'invalid',
        reason: 'clientEventId was reused with a conflicting payload.',
        snapshot: this.snapshot(entry),
      };
    }

    if (entry.terminalResult) {
      const snapshot = this.snapshot(entry);
      this.trace(entry, { type: 'ack_late', ackStatus: ack.status });
      return { kind: 'late', snapshot };
    }

    if (entry.acknowledgements.size >= MAX_ACKNOWLEDGEMENTS_PER_EFFECT) {
      this.trace(entry, { type: 'ack_rejected', ackStatus: ack.status, code: 'LIMIT' });
      return {
        kind: 'invalid',
        reason: 'Client effect acknowledgement limit exceeded.',
        snapshot: this.snapshot(entry),
      };
    }
    const invalid = this.applyAck(entry, ack);
    if (invalid) {
      this.trace(entry, { type: 'ack_rejected', ackStatus: ack.status, code: 'TRANSITION' });
      return { kind: 'invalid', reason: invalid, snapshot: this.snapshot(entry) };
    }

    const snapshot = this.snapshot(entry);
    entry.acknowledgements.set(ack.clientEventId, { fingerprint, snapshot });
    this.trace(entry, { type: 'ack_applied', ackStatus: ack.status });
    return { kind: 'applied', snapshot };
  }

  cancel(
    executionId: string,
    code: string,
    message: string,
  ): ClientEffectCoordinatorSnapshot | null {
    const entry = this.entries.get(executionId);
    if (!entry) return null;
    this.settle(entry, 'cancelled', { code, message, retryable: false });
    return this.snapshot(entry);
  }

  getSnapshot(executionId: string): ClientEffectCoordinatorSnapshot | null {
    const entry = this.entries.get(executionId);
    return entry ? this.snapshot(entry) : null;
  }

  cleanup(executionId: string): void {
    const entry = this.entries.get(executionId);
    if (!entry?.terminalResult) return;
    this.clearTimers(entry);
    const snapshot = this.snapshot(entry);
    this.entries.delete(executionId);
    this.effectOwners.delete(this.ownershipKey(entry.request));
    this.tombstones.set(executionId, {
      acknowledgementTokenDigest: tokenDigest(entry.acknowledgementToken),
      idempotencyKey: entry.request.idempotencyKey,
      snapshot,
    });
    this.trace(entry, { type: 'cleaned_up' });
    while (this.tombstones.size > this.tombstoneLimit) {
      const oldest = this.tombstones.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.tombstones.delete(oldest);
    }
  }

  clearForTests(): void {
    for (const entry of this.entries.values()) this.clearTimers(entry);
    this.entries.clear();
    this.effectOwners.clear();
    this.tombstones.clear();
  }

  private applyAck(entry: CoordinatorEntry, ack: ClientEffectAck): string | null {
    switch (ack.status) {
      case 'presentation_paused':
        if (!entry.paused) this.pauseActiveTimer(entry);
        return null;
      case 'presentation_resumed':
        if (entry.paused) this.resumeActiveTimer(entry);
        return null;
      case 'accepted': {
        if (entry.status !== 'pending') return 'accepted requires pending state.';
        const target = entry.request.target;
        if (entry.request.postcondition.kind === 'whiteboard_closed') {
          if (!('visibilityTarget' in ack)) {
            return 'Whiteboard close requires a visibility target.';
          }
          if (
            ack.visibilityTarget.requestId !== target.requestId ||
            ack.visibilityTarget.sessionId !== target.sessionId ||
            ack.visibilityTarget.stageId !== target.stageId ||
            ack.visibilityTarget.sceneId !== target.sceneId
          ) {
            return 'Accepted visibility target does not match the requested stage and scene.';
          }
          entry.visibilityTarget = ack.visibilityTarget;
          entry.status = 'accepted';
          return null;
        }
        if (!('targetBinding' in ack)) {
          return 'Accepted entity effect requires a target binding.';
        }
        if (
          ack.targetBinding.requestId !== target.requestId ||
          ack.targetBinding.sessionId !== target.sessionId ||
          ack.targetBinding.stageId !== target.stageId ||
          ack.targetBinding.sceneId !== target.sceneId
        ) {
          return 'Accepted target does not match the requested stage and scene.';
        }
        if (
          (entry.request.postcondition.kind === 'whiteboard_code_edited' ||
            entry.request.postcondition.kind === 'whiteboard_element_absent' ||
            entry.request.postcondition.kind === 'whiteboard_empty') &&
          ack.targetBinding.whiteboardId !== entry.request.postcondition.expectedWhiteboardId
        ) {
          return entry.request.postcondition.kind === 'whiteboard_code_edited'
            ? 'Accepted whiteboard does not match the requested edit target.'
            : entry.request.postcondition.kind === 'whiteboard_element_absent'
              ? 'Accepted whiteboard does not match the requested delete target.'
              : 'Accepted whiteboard does not match the requested clear target.';
        }
        entry.targetBinding = ack.targetBinding;
        entry.status = 'accepted';
        return null;
      }
      case 'effect_committed': {
        if (entry.status !== 'accepted') {
          return 'effect_committed requires accepted state.';
        }
        const expected = entry.request.postcondition;
        if (expected.kind === 'whiteboard_closed') {
          if (
            !entry.visibilityTarget ||
            !('visibilityTarget' in ack) ||
            !visibilityTargetsEqual(entry.visibilityTarget, ack.visibilityTarget)
          ) {
            return 'Committed visibility target differs from accepted target.';
          }
          const observed = ack.postcondition;
          if (
            !('kind' in observed) ||
            observed.kind !== 'whiteboard_closed' ||
            observed.normalizationVersion !== expected.normalizationVersion ||
            observed.desiredOpen !== false ||
            observed.observedOpen !== false
          ) {
            return 'Committed postcondition does not match the requested whiteboard close effect.';
          }
          this.settle(entry, 'effect_committed', undefined, observed);
          return null;
        }
        if (!entry.targetBinding || !('targetBinding' in ack)) {
          return 'effect_committed entity effect requires an accepted target binding.';
        }
        if (!bindingsEqual(entry.targetBinding, ack.targetBinding)) {
          return 'Committed target binding differs from accepted target.';
        }
        const observed = ack.postcondition;
        if (expected.kind === 'whiteboard_element_absent') {
          if (
            !('kind' in observed) ||
            observed.kind !== 'whiteboard_element_absent' ||
            observed.normalizationVersion !== expected.normalizationVersion ||
            observed.stableElementId !== expected.stableElementId ||
            observed.whiteboardId !== expected.expectedWhiteboardId ||
            observed.whiteboardId !== entry.targetBinding.whiteboardId ||
            observed.observedElementType !== expected.expectedElementType ||
            observed.matchingElementCountBefore !== 1 ||
            observed.matchingElementCountAfter !== 0 ||
            observed.elementCountBefore <= 0 ||
            observed.elementCountAfter !== observed.elementCountBefore - 1 ||
            observed.deleted !== true
          ) {
            return 'Committed postcondition does not match the requested whiteboard delete effect.';
          }
          this.settle(entry, 'effect_committed', undefined, observed);
          return null;
        }
        if (expected.kind === 'whiteboard_open') {
          if (
            !('kind' in observed) ||
            observed.kind !== 'whiteboard_open' ||
            observed.normalizationVersion !== expected.normalizationVersion ||
            observed.whiteboardId !== entry.targetBinding.whiteboardId ||
            observed.desiredOpen !== true ||
            observed.observedOpen !== true
          ) {
            return 'Committed postcondition does not match the requested whiteboard open effect.';
          }
          this.settle(entry, 'effect_committed', undefined, observed);
          return null;
        }
        if (expected.kind === 'whiteboard_empty') {
          if (
            !('kind' in observed) ||
            observed.kind !== 'whiteboard_empty' ||
            observed.normalizationVersion !== expected.normalizationVersion ||
            observed.membershipNormalizationVersion !== expected.membershipNormalizationVersion ||
            observed.boardContentNormalizationVersion !==
              expected.boardContentNormalizationVersion ||
            observed.whiteboardId !== expected.expectedWhiteboardId ||
            observed.whiteboardId !== entry.targetBinding.whiteboardId ||
            observed.elementCountBefore !== expected.expectedElementCount ||
            observed.elementCountAfter !== 0 ||
            observed.observedMembershipDigestBefore !== expected.expectedMembershipDigest ||
            (observed.cleared
              ? observed.elementCountBefore <= 0 ||
                observed.observedOpen !== true ||
                observed.boardContentDigestAtAccepted !==
                  observed.boardContentDigestBeforeMutation ||
                observed.historySnapshotDigest !== observed.boardContentDigestBeforeMutation ||
                observed.observedBoardContentDigestAfter !==
                  CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST
              : observed.elementCountBefore !== 0 ||
                observed.visibilityChanged !== false ||
                observed.observedMembershipDigestBefore !==
                  CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST ||
                observed.verifiedEmptyBoardContentDigest !==
                  CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST)
          ) {
            return 'Committed postcondition does not match the requested whiteboard clear effect.';
          }
          this.settle(entry, 'effect_committed', undefined, observed);
          return null;
        }
        if ('kind' in observed) {
          return 'Committed lifecycle postcondition does not match the requested element effect.';
        }
        const baseMatches =
          observed.stableElementId === expected.stableElementId &&
          observed.elementType === expected.elementType &&
          observed.normalizationVersion === expected.normalizationVersion &&
          observed.matchingElementCount === 1;
        const postconditionMatches =
          baseMatches &&
          ((expected.kind === 'whiteboard_text_exists' &&
            observed.elementType === 'text' &&
            observed.observedContentDigest === expected.expectedContentDigest) ||
            (expected.kind === 'whiteboard_shape_exists' &&
              observed.elementType === 'shape' &&
              observed.observedShapeDigest === expected.expectedShapeDigest &&
              observed.shape === expected.shape &&
              observed.bounds.x === expected.bounds.x &&
              observed.bounds.y === expected.bounds.y &&
              observed.bounds.width === expected.bounds.width &&
              observed.bounds.height === expected.bounds.height &&
              observed.fillColor === expected.fillColor) ||
            (expected.kind === 'whiteboard_line_exists' &&
              observed.elementType === 'line' &&
              observed.observedLineDigest === expected.expectedLineDigest &&
              observed.start.x === expected.start.x &&
              observed.start.y === expected.start.y &&
              observed.end.x === expected.end.x &&
              observed.end.y === expected.end.y &&
              observed.strokeColor === expected.strokeColor &&
              observed.strokeWidth === expected.strokeWidth &&
              observed.strokeStyle === expected.strokeStyle &&
              observed.markers[0] === expected.markers[0] &&
              observed.markers[1] === expected.markers[1]) ||
            (expected.kind === 'whiteboard_latex_exists' &&
              observed.elementType === 'latex' &&
              observed.observedFormulaDigest === expected.expectedFormulaDigest &&
              observed.observedHtmlDigest === expected.expectedHtmlDigest &&
              observed.latex === expected.latex &&
              observed.bounds.x === expected.bounds.x &&
              observed.bounds.y === expected.bounds.y &&
              observed.bounds.width === expected.bounds.width &&
              observed.bounds.height === expected.bounds.height &&
              observed.color === expected.color &&
              observed.renderVersion === expected.renderVersion) ||
            (expected.kind === 'whiteboard_table_exists' &&
              observed.elementType === 'table' &&
              observed.observedTableDigest === expected.expectedTableDigest) ||
            (expected.kind === 'whiteboard_chart_exists' &&
              observed.elementType === 'chart' &&
              observed.observedChartDigest === expected.expectedChartDigest) ||
            (expected.kind === 'whiteboard_code_exists' &&
              observed.elementType === 'code' &&
              observed.normalizationVersion === expected.normalizationVersion &&
              'observedCodeDigest' in observed &&
              observed.observedCodeDigest === expected.expectedCodeDigest) ||
            (expected.kind === 'whiteboard_code_edited' &&
              observed.elementType === 'code' &&
              observed.normalizationVersion === expected.normalizationVersion &&
              'expectedWhiteboardId' in observed &&
              observed.expectedWhiteboardId === expected.expectedWhiteboardId &&
              observed.observedBeforeCodeDigest === expected.expectedBeforeCodeDigest &&
              observed.observedAfterCodeDigest === expected.expectedAfterCodeDigest &&
              observed.noOp === expected.noOp));
        if (!postconditionMatches) {
          return 'Committed postcondition does not match the requested effect.';
        }
        this.settle(entry, 'effect_committed');
        return null;
      }
      case 'effect_failed':
        if (
          entry.status !== 'accepted' &&
          !(
            entry.status === 'pending' &&
            (entry.request.postcondition.kind === 'whiteboard_code_edited' ||
              entry.request.postcondition.kind === 'whiteboard_element_absent' ||
              entry.request.postcondition.kind === 'whiteboard_empty')
          )
        ) {
          return 'effect_failed requires accepted state, except for existing-element preparation failure.';
        }
        this.settle(entry, 'effect_failed', ack.error);
        return null;
      case 'cancelled':
        this.settle(entry, 'cancelled', ack.error);
        return null;
    }
  }

  private ownershipKey(request: ClientEffectRequest): string {
    if (
      request.postcondition.kind === 'whiteboard_open' ||
      request.postcondition.kind === 'whiteboard_closed'
    ) {
      return [request.target.sessionId, request.target.stageId, 'whiteboard_visibility'].join(
        '\u0000',
      );
    }
    if (request.postcondition.kind === 'whiteboard_empty') {
      return [request.target.sessionId, request.target.stageId, 'whiteboard_content'].join(
        '\u0000',
      );
    }
    if (
      request.postcondition.kind !== 'whiteboard_code_edited' &&
      request.postcondition.kind !== 'whiteboard_element_absent'
    ) {
      return request.postcondition.stableElementId;
    }
    const whiteboardScope = request.postcondition.expectedWhiteboardId;
    return [
      request.target.sessionId,
      request.target.stageId,
      whiteboardScope,
      request.postcondition.stableElementId,
    ].join('\u0000');
  }

  private armTimers(entry: CoordinatorEntry): void {
    const hardRemainingMs = entry.request.deadlineAt - this.now();
    if (hardRemainingMs <= 0) {
      this.settle(entry, 'cancelled', {
        code: 'HARD_DEADLINE_EXCEEDED',
        message: 'Client effect hard deadline expired before delivery.',
        retryable: false,
      });
      return;
    }
    entry.hardTimer = setTimeout(() => {
      this.settle(entry, 'cancelled', {
        code: 'HARD_DEADLINE_EXCEEDED',
        message: 'Client effect exceeded its hard wall-clock deadline.',
        retryable: false,
      });
    }, hardRemainingMs);
    this.resumeActiveTimer(entry);
  }

  private pauseActiveTimer(entry: CoordinatorEntry): void {
    if (entry.activeStartedAt !== null) {
      entry.activeRemainingMs = Math.max(
        0,
        entry.activeRemainingMs - (this.now() - entry.activeStartedAt),
      );
    }
    if (entry.activeTimer) clearTimeout(entry.activeTimer);
    entry.activeTimer = null;
    entry.activeStartedAt = null;
    if (entry.activeRemainingMs <= 0) {
      this.settle(entry, 'timed_out', {
        code: 'CLIENT_EFFECT_TIMEOUT',
        message: 'Client effect exceeded its active execution budget.',
        retryable: true,
      });
      return;
    }
    entry.paused = true;
  }

  private resumeActiveTimer(entry: CoordinatorEntry): void {
    if (entry.terminalResult || entry.activeTimer) return;
    entry.paused = false;
    entry.activeStartedAt = this.now();
    entry.activeTimer = setTimeout(() => {
      entry.activeRemainingMs = 0;
      entry.activeStartedAt = null;
      this.settle(entry, 'timed_out', {
        code: 'CLIENT_EFFECT_TIMEOUT',
        message: 'Client effect exceeded its active execution budget.',
        retryable: true,
      });
    }, entry.activeRemainingMs);
  }

  private settle(
    entry: CoordinatorEntry,
    status: ClientEffectTerminalResult['status'],
    error?: ClientEffectTerminalResult['error'],
    committedObservation?:
      | WhiteboardOpenCommittedObservation
      | WhiteboardCloseCommittedObservation
      | WhiteboardClearCommittedObservation
      | WhiteboardDeleteCommittedObservation,
  ): void {
    if (entry.terminalResult) return;
    if (
      status === 'effect_committed' &&
      (entry.request.postcondition.kind === 'whiteboard_open' ||
        entry.request.postcondition.kind === 'whiteboard_closed' ||
        entry.request.postcondition.kind === 'whiteboard_empty' ||
        entry.request.postcondition.kind === 'whiteboard_element_absent') &&
      !committedObservation
    ) {
      throw new Error('CLIENT_EFFECT_LIFECYCLE_COMMITTED_OBSERVATION_MISSING');
    }
    if (entry.activeStartedAt !== null) {
      entry.activeRemainingMs = Math.max(
        0,
        entry.activeRemainingMs - (this.now() - entry.activeStartedAt),
      );
    }
    this.clearTimers(entry);
    entry.status = status;
    entry.terminalResult = {
      executionId: entry.request.executionId,
      status,
      isError: status !== 'effect_committed',
      completedAt: this.now(),
      ...(entry.targetBinding ? { targetBinding: entry.targetBinding } : {}),
      ...(entry.visibilityTarget ? { visibilityTarget: entry.visibilityTarget } : {}),
      ...(committedObservation ? { committedObservation } : {}),
      ...(error ? { error } : {}),
    };
    this.trace(entry, {
      type: 'settled',
      code: error?.code,
    });
    entry.resolveResult(entry.terminalResult);
  }

  private clearTimers(entry: CoordinatorEntry): void {
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    if (entry.activeTimer) clearTimeout(entry.activeTimer);
    entry.hardTimer = null;
    entry.activeTimer = null;
    entry.activeStartedAt = null;
  }

  private snapshot(entry: CoordinatorEntry): ClientEffectCoordinatorSnapshot {
    const activeRemainingMs =
      entry.activeStartedAt === null
        ? entry.activeRemainingMs
        : Math.max(0, entry.activeRemainingMs - (this.now() - entry.activeStartedAt));
    return {
      executionId: entry.request.executionId,
      idempotencyKey: entry.request.idempotencyKey,
      status: entry.status,
      paused: entry.paused,
      activeRemainingMs,
      deadlineAt: entry.request.deadlineAt,
      ...(entry.targetBinding ? { targetBinding: entry.targetBinding } : {}),
      ...(entry.visibilityTarget ? { visibilityTarget: entry.visibilityTarget } : {}),
      ...(entry.terminalResult ? { terminalResult: entry.terminalResult } : {}),
    };
  }

  private trace(
    entry: CoordinatorEntry,
    event: Pick<ClientEffectTraceEvent, 'type' | 'ackStatus' | 'code'>,
  ): void {
    this.onTrace?.({
      ...event,
      at: this.now(),
      traceId: entry.request.traceId,
      runId: entry.request.runId,
      agentInvocationId: entry.request.agentInvocationId,
      toolCallId: entry.request.toolCallId,
      executionId: entry.request.executionId,
      status: entry.status,
    });
  }
}

const processGlobal = globalThis as typeof globalThis & {
  __openmaicPiClientEffectCoordinator?: ClientEffectCoordinator;
};

export const piClientEffectCoordinator =
  processGlobal.__openmaicPiClientEffectCoordinator ??
  (processGlobal.__openmaicPiClientEffectCoordinator = new ClientEffectCoordinator());
