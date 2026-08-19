import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { createDirectorCompactionRuntime } from '@/lib/chat/pi/director-compaction';
import { createPiChatUsageCollector } from '@/lib/chat/pi/usage';
import type { StatelessEvent } from '@/lib/types/chat';

const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

function longHistory(label: string): AgentMessage[] {
  return Array.from({ length: 12 }, (_, index) => ({
    role: 'user' as const,
    content: `${label}-${index}: ${'important classroom context '.repeat(80)}`,
    timestamp: index,
  }));
}

describe('Director compaction usage wiring', () => {
  beforeEach(() => {
    mocks.streamLLM.mockReset();
    mocks.streamLLM.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Compact the classroom memory without losing facts.' };
        yield {
          type: 'finish-step',
          response: { modelId: 'actual-compaction-model' },
          usage: USAGE,
        };
        yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE };
      })(),
    }));
  });

  it('uses a request-scoped 1-based counter across repeated compaction transports', async () => {
    const events: StatelessEvent[] = [];
    const collector = createPiChatUsageCollector({
      send: async (event) => {
        events.push(event);
      },
      provider: 'openai',
      resolvedModel: 'resolved-model',
      requestUsageId: 'request-1',
    });
    const runtime = createDirectorCompactionRuntime({
      streamFn: createCallLlmStreamFn({
        languageModel: {} as never,
        usageObserver: collector.createObserver({ scope: 'compaction' }),
      }),
      contextWindow: 600,
      maxOutputTokens: 200,
      settings: { enabled: true, reserveTokens: 160, keepRecentTokens: 120 },
    });

    try {
      await runtime.transformContext(longHistory('first'));
      await runtime.transformContext(longHistory('second'));
      await collector.flush();

      expect(runtime.getTrace().triggerCount).toBe(2);
      const starts = events.filter((event) => event.type === 'llm_call_start');
      expect(starts.map((event) => [event.data.phase, event.data.transportIndex])).toEqual([
        ['compaction', 1],
        ['compaction', 2],
      ]);
      expect(events.filter((event) => event.type === 'llm_usage')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'llm_call_end')).toHaveLength(2);
      expect(
        events
          .filter((event) => event.type === 'llm_call_end')
          .every((event) => event.data.actualModel === 'actual-compaction-model'),
      ).toBe(true);
    } finally {
      runtime.dispose();
    }
  });
});
