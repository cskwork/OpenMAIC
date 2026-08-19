import { describe, expect, it } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { createPiChatUsageCollector } from '@/lib/chat/pi/usage';
import type { StatelessEvent } from '@/lib/types/chat';

function makeCollector(events: StatelessEvent[]) {
  let id = 0;
  let tick = 0;
  return createPiChatUsageCollector({
    send: async (event) => {
      events.push(event);
    },
    provider: 'openai',
    resolvedModel: 'gpt-test',
    requestUsageId: 'request-1',
    createId: () => `call-${++id}`,
    now: () => new Date(1_700_000_000_000 + tick++ * 1_000),
  });
}

function makeUsage(
  overrides: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    inputTokenDetails?: Partial<LanguageModelUsage['inputTokenDetails']>;
    outputTokenDetails?: Partial<LanguageModelUsage['outputTokenDetails']>;
  } = {},
): LanguageModelUsage {
  return {
    inputTokens: overrides.inputTokens,
    outputTokens: overrides.outputTokens,
    totalTokens: overrides.totalTokens,
    cachedInputTokens: overrides.cachedInputTokens,
    reasoningTokens: overrides.reasoningTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      ...overrides.inputTokenDetails,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
      ...overrides.outputTokenDetails,
    },
  };
}

describe('Pi Chat usage collector', () => {
  it('emits one ordered lifecycle and replaces provisional usage with final totalUsage', async () => {
    const events: StatelessEvent[] = [];
    const collector = makeCollector(events);
    const call = collector.createObserver({ scope: 'director' }).beginCall();

    call.observeFinishStep(
      makeUsage({
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 1 },
        outputTokenDetails: { reasoningTokens: 1 },
      }),
      'provider-preview-model',
    );
    call.settle(
      'completed',
      makeUsage({
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 },
        outputTokenDetails: { reasoningTokens: 2 },
      }),
      'stop',
    );
    // A losing terminal must not emit or mutate a second settlement.
    call.settle('error', makeUsage({ inputTokens: 999, outputTokens: 999, totalTokens: 1998 }));
    await collector.flush();

    expect(events.map((event) => event.type)).toEqual([
      'llm_call_start',
      'llm_usage',
      'llm_call_end',
    ]);
    expect(events[0]).toMatchObject({
      type: 'llm_call_start',
      data: {
        requestUsageId: 'request-1',
        callId: 'call-1',
        sequence: 1,
        phase: 'director_initial',
        transportIndex: 1,
        provider: 'openai',
        resolvedModel: 'gpt-test',
        startedAt: 1_700_000_000_000,
      },
    });
    expect(events[1]).toMatchObject({
      type: 'llm_usage',
      data: {
        actualModel: 'provider-preview-model',
        status: 'completed',
        usageStatus: 'complete',
        normalizedUsage: {
          inputTokens: 20,
          outputTokens: 5,
          cacheReadTokens: 4,
          cacheCreationTokens: 2,
          reasoningTokens: 2,
          totalTokens: 25,
        },
        observedAt: 1_700_000_002_000,
      },
    });
    expect(events[2]).toMatchObject({
      type: 'llm_call_end',
      data: {
        status: 'completed',
        finishReason: 'stop',
        usageStatus: 'complete',
        completedAt: 1_700_000_003_000,
      },
    });
    expect(collector.getSummary()).toEqual({
      requestUsageId: 'request-1',
      callCount: 1,
      endedCallCount: 1,
      usageEventCount: 1,
      complete: true,
      partialCallCount: 0,
      missingCallCount: 0,
      observedRetryCount: 0,
      retryVisibility: 'openmaic_only',
      totals: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheCreationTokens: 2,
        reasoningTokens: 2,
        totalTokens: 25,
      },
    });
  });

  it('keeps logical run counters independent while sequence and callId stay request-unique', async () => {
    const events: StatelessEvent[] = [];
    const collector = makeCollector(events);
    const director = collector.createObserver({ scope: 'director' });
    const childA = collector.createObserver({
      scope: 'child',
      agentId: 'teacher-a',
      runtimeMode: 'native',
    });
    const childB = collector.createObserver({
      scope: 'child',
      agentId: 'teacher-b',
      runtimeMode: 'legacy',
    });
    const compaction = collector.createObserver({ scope: 'compaction' });

    for (const observer of [director, director, childA, childA, childB, compaction, compaction]) {
      observer.beginCall().settle('error');
    }
    await collector.flush();

    const starts = events.filter(
      (event): event is Extract<StatelessEvent, { type: 'llm_call_start' }> =>
        event.type === 'llm_call_start',
    );
    expect(starts.map((event) => [event.data.phase, event.data.transportIndex])).toEqual([
      ['director_initial', 1],
      ['director_continuation', 2],
      ['child_initial', 1],
      ['child_continuation', 2],
      ['child_initial', 1],
      ['compaction', 1],
      ['compaction', 2],
    ]);
    expect(starts.map((event) => event.data.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(starts.map((event) => event.data.callId)).size).toBe(7);
  });

  it('distinguishes missing and invalid partial usage without fabricating zero tokens', async () => {
    const events: StatelessEvent[] = [];
    const collector = makeCollector(events);
    collector
      .createObserver({ scope: 'child', runtimeMode: 'native' })
      .beginCall()
      .settle('cancelled');
    collector
      .createObserver({ scope: 'child', runtimeMode: 'native' })
      .beginCall()
      .settle(
        'error',
        makeUsage({
          inputTokens: 4,
          outputTokens: -1,
          totalTokens: 3,
          inputTokenDetails: { cacheReadTokens: 5 },
        }),
      );
    await collector.flush();

    const usageEvents = events.filter((event) => event.type === 'llm_usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      data: {
        usageStatus: 'partial',
        normalizedUsage: { inputTokens: 4 },
      },
    });
    expect(usageEvents[0]).not.toMatchObject({ data: { normalizedUsage: { outputTokens: 0 } } });
    expect(collector.getSummary()).toMatchObject({
      complete: false,
      partialCallCount: 1,
      missingCallCount: 1,
      totals: { inputTokens: 4 },
    });
  });

  it('serializes start, usage, and end writes even when the first write is delayed', async () => {
    const events: StatelessEvent[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const collector = createPiChatUsageCollector({
      send: async (event) => {
        if (event.type === 'llm_call_start') await startGate;
        events.push(event);
      },
      provider: 'openai',
      resolvedModel: 'gpt-test',
      requestUsageId: 'request-1',
      createId: () => 'call-1',
    });
    collector
      .createObserver({ scope: 'director' })
      .beginCall()
      .settle('completed', makeUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }));

    await Promise.resolve();
    expect(events).toEqual([]);
    releaseStart();
    await collector.flush();
    expect(events.map((event) => event.type)).toEqual([
      'llm_call_start',
      'llm_usage',
      'llm_call_end',
    ]);
  });

  it('treats wholly invalid usage as missing and never emits an empty usage event', async () => {
    const events: StatelessEvent[] = [];
    const collector = makeCollector(events);
    collector
      .createObserver({ scope: 'director' })
      .beginCall()
      .settle(
        'error',
        makeUsage({ inputTokens: Number.NaN, outputTokens: -1, totalTokens: Infinity }),
      );
    await collector.flush();

    expect(events.filter((event) => event.type === 'llm_usage')).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'llm_call_end',
      data: { status: 'error', usageStatus: 'missing' },
    });
    expect(collector.getSummary()).toMatchObject({
      complete: false,
      missingCallCount: 1,
      totals: {},
    });
  });

  it('derives aggregate totalTokens only from aggregate input and output totals', async () => {
    const events: StatelessEvent[] = [];
    const collector = makeCollector(events);
    collector
      .createObserver({ scope: 'director' })
      .beginCall()
      .settle('completed', makeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    collector
      .createObserver({ scope: 'director' })
      .beginCall()
      .settle('completed', makeUsage({ totalTokens: 20 }));
    await collector.flush();

    expect(collector.getSummary()).toMatchObject({
      complete: false,
      partialCallCount: 1,
      totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });
});
