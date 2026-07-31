import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

const teacher: AgentConfig = {
  id: 'teacher-1',
  role: 'teacher',
  name: 'Teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#000000',
  allowedActions: ['wb_draw_text', 'wb_edit_code'],
  priority: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
};

const body = {
  messages: [],
  storeState: {
    stage: { id: 'stage-1', name: 'Course' },
    scenes: [{ id: 'scene-1' }],
    currentSceneId: 'scene-1',
    mode: 'playback',
    whiteboardOpen: true,
  },
  config: {
    agentIds: [teacher.id],
    piSessionId: 'session-1',
    piRequestId: 'request-1',
  },
} as unknown as StatelessChatRequest;

function nativeTextStream(text: string): StreamFn {
  return ((_model, _context) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'test',
      provider: 'test',
      model: 'deterministic',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({
        type: 'text_start',
        contentIndex: 0,
        partial: message,
      });
      stream.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: text,
        partial: message,
      });
      stream.push({
        type: 'text_end',
        contentIndex: 0,
        content: text,
        partial: message,
      });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    });
    return stream;
  }) as StreamFn;
}

function legacyTextModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 'legacy-text' },
        { type: 'text-delta' as const, id: 'legacy-text', delta: text },
        { type: 'text-end' as const, id: 'legacy-text' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ]),
    }),
  });
}

function buildTool(opts: {
  childRuntimeMode?: 'legacy' | 'native';
  nativeChildStreamFn: StreamFn;
  enableWhiteboardTools: boolean;
  enableNativeChildWhiteboard: boolean;
  maxActionsPerAgent: number;
}) {
  return buildCallAgentTool({
    body,
    agentConfigs: [teacher],
    send: vi.fn(),
    languageModel: legacyTextModel('[{"type":"text","content":"Legacy response."}]'),
    onAgentDone: vi.fn(),
    onActionDone: vi.fn(),
    thinkingConfig: { mode: 'disabled', enabled: false },
    abortSignal: new AbortController().signal,
    maxAgentTurns: 2,
    getAgentTurnCount: () => 0,
    getAgentResponses: () => [],
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: opts.maxActionsPerAgent,
    enableWhiteboardTools: opts.enableWhiteboardTools,
    childRuntimeMode: opts.childRuntimeMode,
    enableNativeChildWhiteboard: opts.enableNativeChildWhiteboard,
    nativeChildStreamFn: opts.nativeChildStreamFn,
    nativeChildTimeoutMs: 1_000,
  });
}

describe('Pi Child runtime selection', () => {
  it('defaults to Legacy even when Native capability flags are enabled', async () => {
    const nativeStreamFn = vi.fn(nativeTextStream('Native must not run.'));
    const tool = buildTool({
      nativeChildStreamFn: nativeStreamFn as StreamFn,
      enableWhiteboardTools: true,
      enableNativeChildWhiteboard: true,
      maxActionsPerAgent: 1,
    });

    const result = await tool.execute('call-legacy-default', {
      agentId: teacher.id,
      instruction: 'Explain.',
    });

    expect(nativeStreamFn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      runtimeMode: 'legacy',
      text: 'Legacy response.',
      availableToolNames: expect.arrayContaining(['wb_draw_text', 'wb_edit_code']),
    });
    expect(result.details).not.toHaveProperty('nativeChildRun');
  });

  it.each([
    {
      name: 'whiteboard capability disabled',
      enableWhiteboardTools: true,
      enableNativeChildWhiteboard: false,
      maxActionsPerAgent: 1,
    },
    {
      name: 'whiteboard action budget is zero',
      enableWhiteboardTools: true,
      enableNativeChildWhiteboard: true,
      maxActionsPerAgent: 0,
    },
  ])('keeps explicit Native mode with zero registered tools: $name', async (input) => {
    const nativeStreamFn = vi.fn(nativeTextStream('Native pure-text response.'));
    const tool = buildTool({
      childRuntimeMode: 'native',
      nativeChildStreamFn: nativeStreamFn as StreamFn,
      ...input,
    });

    const result = await tool.execute(`call-native-${input.name}`, {
      agentId: teacher.id,
      instruction: 'Explain without tools.',
    });

    expect(nativeStreamFn).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      runtimeMode: 'native',
      text: 'Native pure-text response.',
      availableToolNames: [],
      unavailableAllowedToolNames: ['wb_draw_text', 'wb_edit_code'],
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [],
      },
    });
  });
});
