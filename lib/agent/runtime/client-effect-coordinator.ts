import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type AcceptedTargetBinding,
  type ClientEffectAck,
  type ClientEffectCoordinatorSnapshot,
  type ClientEffectDelivery,
  type ClientEffectRequest,
  type ClientEffectTraceEvent,
  type ClientEffectTerminalResult,
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
  terminalResult?: ClientEffectTerminalResult;
  hardTimer: TimerHandle | null;
  activeTimer: TimerHandle | null;
  acknowledgements: Map<string, { fingerprint: string; snapshot: ClientEffectCoordinatorSnapshot }>;
  result: Promise<ClientEffectTerminalResult>;
  resolveResult: (result: ClientEffectTerminalResult) => void;
}

export type ClientEffectAckOutcome =
  | { kind: 'applied' | 'duplicate' | 'late'; snapshot: ClientEffectCoordinatorSnapshot }
  | { kind: 'invalid'; reason: string; snapshot?: ClientEffectCoordinatorSnapshot }
  | { kind: 'unauthorized' | 'unknown' | 'gone' };

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
    stableElementId: request.postcondition.stableElementId,
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

export class ClientEffectCoordinator {
  private readonly entries = new Map<string, CoordinatorEntry>();
  private readonly stableElementOwners = new Map<string, string>();
  private readonly tombstones = new Map<string, ClientEffectTerminalResult>();

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
    const stableElementId = request.postcondition.stableElementId;
    const owner = this.stableElementOwners.get(stableElementId);
    if (owner && owner !== request.executionId) {
      throw new Error(`Stable element "${stableElementId}" belongs to another execution.`);
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
    this.stableElementOwners.set(stableElementId, request.executionId);
    this.trace(entry, { type: 'registered' });
    this.armTimers(entry);

    return {
      delivery: { request, acknowledgementToken },
      result,
    };
  }

  authorize(
    executionId: string,
    token: string,
  ): 'authorized' | 'unauthorized' | 'unknown' | 'gone' {
    const entry = this.entries.get(executionId);
    if (!entry) return this.tombstones.has(executionId) ? 'gone' : 'unknown';
    if (tokensEqual(token, entry.acknowledgementToken)) return 'authorized';
    this.trace(entry, { type: 'ack_rejected', code: 'UNAUTHORIZED' });
    return 'unauthorized';
  }

  acknowledge(executionId: string, token: string, ack: ClientEffectAck): ClientEffectAckOutcome {
    const entry = this.entries.get(executionId);
    if (!entry) {
      return this.tombstones.has(executionId) ? { kind: 'gone' } : { kind: 'unknown' };
    }
    if (!tokensEqual(token, entry.acknowledgementToken)) {
      this.trace(entry, { type: 'ack_rejected', code: 'UNAUTHORIZED' });
      return { kind: 'unauthorized' };
    }
    if (ack.executionId !== executionId || ack.idempotencyKey !== entry.request.idempotencyKey) {
      this.trace(entry, { type: 'ack_rejected', ackStatus: ack.status, code: 'IDENTITY' });
      return { kind: 'invalid', reason: 'ACK identity does not match the execution.' };
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
    this.entries.delete(executionId);
    this.stableElementOwners.delete(entry.request.postcondition.stableElementId);
    this.tombstones.set(executionId, entry.terminalResult);
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
    this.stableElementOwners.clear();
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
        if (
          ack.targetBinding.requestId !== target.requestId ||
          ack.targetBinding.sessionId !== target.sessionId ||
          ack.targetBinding.stageId !== target.stageId ||
          ack.targetBinding.sceneId !== target.sceneId
        ) {
          return 'Accepted target does not match the requested stage and scene.';
        }
        entry.targetBinding = ack.targetBinding;
        entry.status = 'accepted';
        return null;
      }
      case 'effect_committed': {
        if (entry.status !== 'accepted' || !entry.targetBinding) {
          return 'effect_committed requires accepted state.';
        }
        if (!bindingsEqual(entry.targetBinding, ack.targetBinding)) {
          return 'Committed target binding differs from accepted target.';
        }
        const expected = entry.request.postcondition;
        const observed = ack.postcondition;
        if (
          observed.stableElementId !== expected.stableElementId ||
          observed.elementType !== expected.elementType ||
          observed.normalizationVersion !== expected.normalizationVersion ||
          observed.observedContentDigest !== expected.expectedContentDigest ||
          observed.matchingElementCount !== 1
        ) {
          return 'Committed postcondition does not match the requested effect.';
        }
        this.settle(entry, 'effect_committed');
        return null;
      }
      case 'effect_failed':
        if (entry.status !== 'accepted') return 'effect_failed requires accepted state.';
        this.settle(entry, 'effect_failed', ack.error);
        return null;
      case 'cancelled':
        this.settle(entry, 'cancelled', ack.error);
        return null;
    }
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
  ): void {
    if (entry.terminalResult) return;
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
