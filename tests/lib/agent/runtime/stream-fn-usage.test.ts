import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { createPiChatUsageCollector } from '@/lib/chat/pi/usage';
import type { StatelessEvent } from '@/lib/types/chat';

describe('createCallLlmStreamFn usage', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('writes AI SDK token usage into the completed Pi assistant message', async () => {
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'answer' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: {
            inputTokens: 120,
            outputTokens: 30,
            inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 },
          },
        };
      })(),
      // The adapter deliberately takes terminal usage from fullStream.finish,
      // not from a separately resolving result promise.
      usage: new Promise(() => {}),
    });
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    const message = await stream.result();

    expect(message.usage).toMatchObject({
      input: 105,
      output: 30,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 150,
    });
  });

  it('emits provisional usage on a later provider error and preserves actual model identity', async () => {
    const events: StatelessEvent[] = [];
    const collector = createPiChatUsageCollector({
      send: async (event) => {
        events.push(event);
      },
      provider: 'openai',
      resolvedModel: 'resolved-model',
      requestUsageId: 'request-1',
      createId: () => 'call-1',
    });
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        yield {
          type: 'finish-step',
          response: { modelId: 'actual-model' },
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        };
        yield { type: 'error', error: new Error('provider failed after step') };
      })(),
    });
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      usageObserver: collector.createObserver({ scope: 'director' }),
    });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    const message = await stream.result();
    await collector.flush();

    expect(message.stopReason).toBe('error');
    expect(events.map((event) => event.type)).toEqual([
      'llm_call_start',
      'llm_usage',
      'llm_call_end',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'llm_call_end',
      data: {
        status: 'error',
        usageStatus: 'complete',
        actualModel: 'actual-model',
      },
    });
  });

  it('does not allocate identity or emit lifecycle events for a pre-aborted invocation', async () => {
    const events: StatelessEvent[] = [];
    const collector = createPiChatUsageCollector({
      send: async (event) => {
        events.push(event);
      },
      provider: 'openai',
      resolvedModel: 'resolved-model',
      requestUsageId: 'request-1',
    });
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      abortSignal: controller.signal,
      usageObserver: collector.createObserver({ scope: 'director' }),
    });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    await stream.result();
    await collector.flush();

    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(collector.getSummary()).toMatchObject({ callCount: 0, endedCallCount: 0 });
  });

  it('settles an admitted stream setup exception as one error call with missing usage', async () => {
    const events: StatelessEvent[] = [];
    const collector = createPiChatUsageCollector({
      send: async (event) => {
        events.push(event);
      },
      provider: 'openai',
      resolvedModel: 'resolved-model',
      requestUsageId: 'request-1',
      createId: () => 'call-1',
    });
    mocks.streamLLM.mockReturnValue({
      fullStream: {
        [Symbol.asyncIterator]() {
          throw new Error('sync setup failure');
        },
      },
    });
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      usageObserver: collector.createObserver({ scope: 'director' }),
    });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    for await (const _event of stream) {
      // Drain the protocol stream so setup failure remains an explicit Pi
      // error event rather than an unread terminal event.
    }
    await stream.result();
    await collector.flush();

    expect(events.map((event) => event.type)).toEqual(['llm_call_start', 'llm_call_end']);
    expect(events.at(-1)).toMatchObject({
      data: { status: 'error', usageStatus: 'missing' },
    });
  });
});
