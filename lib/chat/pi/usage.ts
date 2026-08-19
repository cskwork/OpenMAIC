import type { LanguageModelUsage } from 'ai';
import { nanoid } from 'nanoid';

export type PiLlmCallPhase =
  | 'director_initial'
  | 'director_continuation'
  | 'child_initial'
  | 'child_continuation'
  | 'compaction';

export type PiLlmCallStatus = 'completed' | 'error' | 'cancelled';
export type PiLlmUsageStatus = 'complete' | 'partial' | 'missing';
export type PiLlmCallScope = 'director' | 'child' | 'compaction';

export interface PiNormalizedLlmUsage {
  /** Total input tokens. Cache token classes below are subsets, not additions. */
  inputTokens?: number;
  /** Total output tokens. reasoningTokens below is a subset, not an addition. */
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface PiLlmCallIdentity {
  requestUsageId: string;
  callId: string;
  sequence: number;
  phase: PiLlmCallPhase;
  transportIndex: number;
  provider: string;
  resolvedModel: string;
  agentId?: string;
  runtimeMode?: 'legacy' | 'native';
}

export interface PiLlmCallStartData extends PiLlmCallIdentity {
  startedAt: number;
}

export interface PiLlmUsageData extends PiLlmCallIdentity {
  actualModel?: string;
  status: PiLlmCallStatus;
  usageStatus: Exclude<PiLlmUsageStatus, 'missing'>;
  rawUsage: unknown;
  normalizedUsage: PiNormalizedLlmUsage;
  observedAt: number;
}

export interface PiLlmCallEndData extends PiLlmCallIdentity {
  actualModel?: string;
  status: PiLlmCallStatus;
  finishReason?: string;
  usageStatus: PiLlmUsageStatus;
  completedAt: number;
}

export interface PiChatUsageSummary {
  requestUsageId: string;
  callCount: number;
  endedCallCount: number;
  usageEventCount: number;
  complete: boolean;
  partialCallCount: number;
  missingCallCount: number;
  observedRetryCount: number;
  retryVisibility: 'openmaic_only';
  totals: PiNormalizedLlmUsage;
}

export type PiUsageLifecycleEvent =
  | { type: 'llm_call_start'; data: PiLlmCallStartData }
  | { type: 'llm_usage'; data: PiLlmUsageData }
  | { type: 'llm_call_end'; data: PiLlmCallEndData };

export interface PiLlmUsageCall {
  observeFinishStep(usage: LanguageModelUsage | undefined, actualModel?: string): void;
  settle(status: PiLlmCallStatus, finalUsage?: LanguageModelUsage, finishReason?: string): void;
}

export interface PiLlmUsageObserver {
  beginCall(): PiLlmUsageCall;
}

interface StoredCall {
  identity: PiLlmCallIdentity;
  startedAt: number;
  observedAt?: number;
  completedAt?: number;
  status?: PiLlmCallStatus;
  finishReason?: string;
  usageStatus: PiLlmUsageStatus;
  rawUsage?: unknown;
  normalizedUsage?: PiNormalizedLlmUsage;
  actualModel?: string;
}

export interface PiChatUsageCollector {
  requestUsageId: string;
  createObserver(options: {
    scope: PiLlmCallScope;
    agentId?: string;
    runtimeMode?: 'legacy' | 'native';
  }): PiLlmUsageObserver;
  flush(): Promise<void>;
  getSummary(): PiChatUsageSummary;
}

export function createPiChatUsageCollector(options: {
  send: (event: PiUsageLifecycleEvent) => Promise<void>;
  provider: string;
  resolvedModel: string;
  requestUsageId?: string;
  now?: () => Date;
  createId?: () => string;
}): PiChatUsageCollector {
  const requestUsageId = options.requestUsageId ?? nanoid();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? nanoid;
  const calls: StoredCall[] = [];
  let sequence = 0;
  let delivery = Promise.resolve();

  const enqueue = (event: PiUsageLifecycleEvent): void => {
    // Usage lifecycle events share one request-local queue. A rejected write is
    // observed and does not create an unhandled rejection; the request owner
    // still controls cancellation and stream closure.
    delivery = delivery.then(() => options.send(event)).catch(() => undefined);
  };

  const createObserver = ({
    scope,
    agentId,
    runtimeMode,
  }: {
    scope: PiLlmCallScope;
    agentId?: string;
    runtimeMode?: 'legacy' | 'native';
  }) => {
    let transportIndex = 0;
    return {
      beginCall(): PiLlmUsageCall {
        transportIndex += 1;
        sequence += 1;
        const phase = phaseFor(scope, transportIndex);
        const identity: PiLlmCallIdentity = {
          requestUsageId,
          callId: createId(),
          sequence,
          phase,
          transportIndex,
          provider: options.provider,
          resolvedModel: options.resolvedModel,
          ...(agentId ? { agentId } : {}),
          ...(runtimeMode ? { runtimeMode } : {}),
        };
        const call: StoredCall = {
          identity,
          startedAt: now().getTime(),
          usageStatus: 'missing',
        };
        // Registration precedes delivery so request summaries can never omit an
        // admitted provider invocation merely because its SSE write failed.
        calls.push(call);
        enqueue({ type: 'llm_call_start', data: { ...identity, startedAt: call.startedAt } });

        let settled = false;
        return {
          observeFinishStep(usage, actualModel) {
            if (settled) return;
            if (usage !== undefined) {
              call.rawUsage = toJsonSafe(usage);
              const analyzed = analyzeBenchmarkUsage(usage);
              call.normalizedUsage = analyzed.normalizedUsage;
              call.usageStatus = analyzed.usageStatus;
              call.observedAt = now().getTime();
            }
            const model = nonEmptyString(actualModel);
            if (model) call.actualModel = model;
          },
          settle(status, finalUsage, finishReason) {
            if (settled) return;
            settled = true;
            if (finalUsage !== undefined) {
              // The final aggregate is authoritative and replaces (never adds
              // to) any provisional finish-step usage.
              call.rawUsage = toJsonSafe(finalUsage);
              const analyzed = analyzeBenchmarkUsage(finalUsage);
              call.normalizedUsage = analyzed.normalizedUsage;
              call.usageStatus = analyzed.usageStatus;
              call.observedAt = now().getTime();
            }
            call.status = status;
            call.finishReason = nonEmptyString(finishReason);
            call.completedAt = now().getTime();
            if (call.usageStatus !== 'missing' && call.rawUsage !== undefined) {
              enqueue({
                type: 'llm_usage',
                data: {
                  ...call.identity,
                  ...(call.actualModel ? { actualModel: call.actualModel } : {}),
                  status,
                  usageStatus: call.usageStatus,
                  rawUsage: call.rawUsage,
                  normalizedUsage: call.normalizedUsage ?? {},
                  observedAt: call.observedAt ?? call.completedAt,
                },
              });
            }
            enqueue({
              type: 'llm_call_end',
              data: {
                ...call.identity,
                ...(call.actualModel ? { actualModel: call.actualModel } : {}),
                status,
                ...(call.finishReason ? { finishReason: call.finishReason } : {}),
                usageStatus: call.usageStatus,
                completedAt: call.completedAt,
              },
            });
          },
        };
      },
    };
  };

  return {
    requestUsageId,
    createObserver,
    flush: () => delivery,
    getSummary: () => summarize(requestUsageId, calls),
  };
}

function phaseFor(scope: PiLlmCallScope, transportIndex: number): PiLlmCallPhase {
  if (scope === 'compaction') return 'compaction';
  if (scope === 'director') {
    return transportIndex === 1 ? 'director_initial' : 'director_continuation';
  }
  return transportIndex === 1 ? 'child_initial' : 'child_continuation';
}

type TokenField = { value?: number; invalid: boolean };

function tokenField(value: unknown): TokenField {
  if (value === undefined) return { invalid: false };
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { value, invalid: false };
  }
  return { invalid: true };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function preferTokenField(primary: unknown, fallback: unknown): TokenField {
  const primaryField = tokenField(primary);
  const fallbackField = tokenField(fallback);
  const conflict =
    primaryField.value !== undefined &&
    fallbackField.value !== undefined &&
    primaryField.value !== fallbackField.value;
  return {
    value: primaryField.value ?? fallbackField.value,
    invalid: primaryField.invalid || fallbackField.invalid || conflict,
  };
}

function analyzeBenchmarkUsage(usage: LanguageModelUsage): {
  normalizedUsage?: PiNormalizedLlmUsage;
  usageStatus: PiLlmUsageStatus;
} {
  const input = tokenField(usage.inputTokens);
  const output = tokenField(usage.outputTokens);
  const cacheRead = preferTokenField(
    usage.inputTokenDetails?.cacheReadTokens,
    usage.cachedInputTokens,
  );
  const cacheCreation = tokenField(usage.inputTokenDetails?.cacheWriteTokens);
  const reasoning = preferTokenField(
    usage.outputTokenDetails?.reasoningTokens,
    usage.reasoningTokens,
  );
  const providerTotal = tokenField(usage.totalTokens);
  let invalid =
    input.invalid ||
    output.invalid ||
    cacheRead.invalid ||
    cacheCreation.invalid ||
    reasoning.invalid ||
    providerTotal.invalid;

  const inputTokens = input.value;
  const outputTokens = output.value;
  let cacheReadTokens = cacheRead.value;
  let cacheCreationTokens = cacheCreation.value;
  let reasoningTokens = reasoning.value;

  if (
    inputTokens !== undefined &&
    (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) > inputTokens
  ) {
    invalid = true;
    cacheReadTokens = undefined;
    cacheCreationTokens = undefined;
  }
  if (outputTokens !== undefined && (reasoningTokens ?? 0) > outputTokens) {
    invalid = true;
    reasoningTokens = undefined;
  }

  let usableProviderTotal = providerTotal.value;
  const knownTokenLowerBound = (inputTokens ?? 0) + (outputTokens ?? 0);
  if (usableProviderTotal !== undefined && usableProviderTotal < knownTokenLowerBound) {
    invalid = true;
    usableProviderTotal = undefined;
  }
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : usableProviderTotal;
  if (
    providerTotal.value !== undefined &&
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    providerTotal.value !== totalTokens
  ) {
    invalid = true;
  }

  const normalizedUsage: PiNormalizedLlmUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  if (Object.keys(normalizedUsage).length === 0) {
    return { usageStatus: 'missing' };
  }
  return {
    normalizedUsage,
    usageStatus:
      !invalid && inputTokens !== undefined && outputTokens !== undefined ? 'complete' : 'partial',
  };
}

function toJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint') return item.toString();
        if (typeof item === 'number' && !Number.isFinite(item)) return undefined;
        return item;
      }),
    );
  } catch {
    return {};
  }
}

function summarize(requestUsageId: string, calls: StoredCall[]): PiChatUsageSummary {
  const ended = calls.filter((call) => call.status !== undefined);
  const partialCallCount = ended.filter((call) => call.usageStatus === 'partial').length;
  const missingCallCount = ended.filter((call) => call.usageStatus === 'missing').length;
  const usageCalls = ended.filter((call) => call.usageStatus !== 'missing');
  const totals = usageCalls.reduce<PiNormalizedLlmUsage>((sum, call) => {
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'reasoningTokens',
    ] as const) {
      const value = call.normalizedUsage?.[key];
      if (value !== undefined) sum[key] = (sum[key] ?? 0) + value;
    }
    return sum;
  }, {});
  if (totals.inputTokens !== undefined && totals.outputTokens !== undefined) {
    totals.totalTokens = totals.inputTokens + totals.outputTokens;
  }
  return {
    requestUsageId,
    callCount: calls.length,
    endedCallCount: ended.length,
    usageEventCount: usageCalls.length,
    complete: calls.length === ended.length && partialCallCount === 0 && missingCallCount === 0,
    partialCallCount,
    missingCallCount,
    observedRetryCount: 0,
    retryVisibility: 'openmaic_only',
    totals,
  };
}
