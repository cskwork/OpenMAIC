import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { resolvePiWebSearchMode } from '@/lib/chat/pi/director-loop';
import { buildCallAgentTool, resolveNativeChildCapabilities } from '@/lib/chat/pi/tools/call-agent';
import { buildChildWebSearchTool } from '@/lib/chat/pi/tools/web-search';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const EMPTY_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: '王老师',
  role: 'teacher',
  persona: 'Use evidence and cite exact URLs.',
  avatar: '',
  color: '#3366ff',
  allowedActions: [],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

function assistantText(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'deterministic',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: 1,
  };
}

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    ...assistantText(''),
    content: [{ type: 'toolCall', id, name, arguments: args }],
    stopReason: 'toolUse',
  };
}

function streamMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() =>
    stream.push({
      type: 'done',
      reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message,
    }),
  );
  return stream;
}

function findToolResult(context: Context, toolName: string) {
  return context.messages.find(
    (message): message is Extract<Context['messages'][number], { role: 'toolResult' }> =>
      message.role === 'toolResult' && message.toolName === toolName,
  );
}

function makeBody(): StatelessChatRequest {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: '请核对今天发布的官方结果。' }],
      },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'Current Events', createdAt: 1, updatedAt: 2 },
      outlines: [],
      scenes: [],
      currentSceneId: null,
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: {
      agentIds: [teacher.id],
      agentConfigs: [teacher],
      sessionType: 'qa',
    },
    apiKey: '',
  } as StatelessChatRequest;
}

function makeSearchTool(
  searchResponses: NonNullable<Parameters<typeof buildChildWebSearchTool>[0]>['searchResponses'],
  configured = true,
): AgentTool {
  return buildChildWebSearchTool({
    resolveConfig: () =>
      configured
        ? {
            providerId: 'responses',
            apiKey: 'test-key',
            baseUrl: 'https://search.test/v1',
            model: 'search-model',
          }
        : undefined,
    searchResponses,
    now: () => new Date('2026-07-28T08:00:00.000Z'),
  });
}

function makeCallAgent(opts: {
  streamFn: StreamFn;
  createTool: () => AgentTool;
  events?: StatelessEvent[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}) {
  const events = opts.events ?? [];
  return buildCallAgentTool({
    body: makeBody(),
    agentConfigs: [teacher],
    send: async (event) => {
      events.push(event);
    },
    languageModel: {} as LanguageModel,
    onAgentDone: vi.fn(),
    onActionDone: vi.fn(),
    thinkingConfig: { mode: 'disabled', enabled: false },
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    maxAgentTurns: 4,
    getAgentTurnCount: () => 0,
    getAgentResponses: () => [],
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: 0,
    enableWhiteboardTools: false,
    enableNativeChildWebSearch: true,
    createNativeChildWebSearchTool: opts.createTool,
    nativeChildStreamFn: opts.streamFn,
    nativeChildTimeoutMs: opts.timeoutMs ?? 1_000,
  });
}

function childSearchStream(contexts: Context[]): StreamFn {
  return ((_model, context) => {
    contexts.push(context);
    const result = findToolResult(context, 'web_search');
    if (!result) {
      return streamMessage(
        assistantToolCall('child-search-1', 'web_search', {
          query: 'official current result',
        }),
      );
    }
    const text = result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    return streamMessage(
      assistantText(
        result.isError
          ? `搜索不可用，无法可靠回答。错误：${text}`
          : `根据官方来源，结果已核实：https://example.test/official`,
      ),
    );
  }) as StreamFn;
}

describe('Phase 1 Child native web_search', () => {
  it.each([
    {
      role: 'teacher' as const,
      allowedActions: ['wb_draw_text'],
      expected: {
        nativeWhiteboardEnabled: true,
        nativeWhiteboardToolNames: ['wb_draw_text'],
        childWebSearchEnabled: true,
        nativeChildEnabled: true,
      },
    },
    {
      role: 'assistant' as const,
      allowedActions: ['wb_draw_text'],
      expected: {
        nativeWhiteboardEnabled: false,
        nativeWhiteboardToolNames: [],
        childWebSearchEnabled: false,
        nativeChildEnabled: false,
      },
    },
    {
      role: 'student' as const,
      allowedActions: [],
      expected: {
        nativeWhiteboardEnabled: false,
        nativeWhiteboardToolNames: [],
        childWebSearchEnabled: false,
        nativeChildEnabled: false,
      },
    },
  ])(
    'keeps $role on the correct runtime when native web and whiteboard flags coexist',
    ({ role, allowedActions, expected }) => {
      expect(
        resolveNativeChildCapabilities({
          agent: { role, allowedActions },
          enableNativeChildWebSearch: true,
          enableNativeChildWhiteboard: true,
          enableWhiteboardTools: true,
          maxActionsPerAgent: 1,
        }),
      ).toEqual(expected);
    },
  );

  it('exposes only the migrated whiteboard tools allowed for this Teacher', () => {
    const base = {
      role: 'teacher' as const,
      enableNativeChildWebSearch: false,
      enableNativeChildWhiteboard: true,
      enableWhiteboardTools: true,
      maxActionsPerAgent: 2,
    };

    expect(
      resolveNativeChildCapabilities({
        ...base,
        agent: { role: base.role, allowedActions: ['wb_draw_shape'] },
      }),
    ).toMatchObject({
      nativeWhiteboardEnabled: true,
      nativeWhiteboardToolNames: ['wb_draw_shape'],
      nativeChildEnabled: true,
    });
    expect(
      resolveNativeChildCapabilities({
        ...base,
        agent: { role: base.role, allowedActions: ['wb_draw_latex'] },
      }),
    ).toMatchObject({
      nativeWhiteboardEnabled: true,
      nativeWhiteboardToolNames: ['wb_draw_latex'],
      nativeChildEnabled: true,
    });
    expect(
      resolveNativeChildCapabilities({
        ...base,
        agent: {
          role: base.role,
          allowedActions: [
            'wb_draw_text',
            'wb_draw_shape',
            'wb_draw_line',
            'wb_draw_latex',
            'wb_draw_table',
            'wb_draw_chart',
          ],
        },
      }),
    ).toMatchObject({
      nativeWhiteboardEnabled: true,
      nativeWhiteboardToolNames: [
        'wb_draw_text',
        'wb_draw_shape',
        'wb_draw_line',
        'wb_draw_latex',
        'wb_draw_table',
        'wb_draw_chart',
      ],
      nativeChildEnabled: true,
    });
    expect(
      resolveNativeChildCapabilities({
        ...base,
        agent: { role: base.role, allowedActions: ['wb_draw_line'] },
      }),
    ).toMatchObject({
      nativeWhiteboardEnabled: true,
      nativeWhiteboardToolNames: ['wb_draw_line'],
      nativeChildEnabled: true,
    });
    expect(
      resolveNativeChildCapabilities({
        ...base,
        agent: {
          role: base.role,
          allowedActions: ['wb_draw_chart'],
        },
      }),
    ).toMatchObject({
      nativeWhiteboardEnabled: true,
      nativeWhiteboardToolNames: ['wb_draw_chart'],
      nativeChildEnabled: true,
    });
    expect(
      resolveNativeChildCapabilities({
        ...base,
        agent: {
          role: base.role,
          allowedActions: ['wb_draw_code', 'wb_edit_code'],
        },
      }),
    ).toMatchObject({
      nativeWhiteboardEnabled: false,
      nativeWhiteboardToolNames: [],
      nativeChildEnabled: false,
    });
  });

  it.each([
    {
      name: 'master off overrides native mode',
      input: {
        enableWebSearch: false,
        enableNativeChildWebSearch: true,
        enableWhiteboardTools: false,
      },
      expected: 'disabled',
    },
    {
      name: 'master on plus native mode selects Child',
      input: {
        enableWebSearch: true,
        enableNativeChildWebSearch: true,
        enableWhiteboardTools: false,
      },
      expected: 'child',
    },
    {
      name: 'whiteboard without native effect mode keeps legacy Child and Director search',
      input: {
        enableWebSearch: true,
        enableNativeChildWebSearch: true,
        enableWhiteboardTools: true,
      },
      expected: 'director',
    },
    {
      name: 'native whiteboard lets Child web search coexist in the same Pi run',
      input: {
        enableWebSearch: true,
        enableNativeChildWebSearch: true,
        enableNativeChildWhiteboard: true,
        enableWhiteboardTools: true,
      },
      expected: 'hybrid',
    },
    {
      name: 'master on without native mode keeps Director search',
      input: {
        enableWebSearch: true,
        enableNativeChildWebSearch: false,
        enableWhiteboardTools: false,
      },
      expected: 'director',
    },
  ])('resolves Director-level routing: $name', ({ input, expected }) => {
    expect(resolvePiWebSearchMode(input)).toBe(expected);
  });

  it('executes web_search in the real Child Pi loop and returns ChildRunResult to call_agent', async () => {
    const contexts: Context[] = [];
    const searchResponses = vi.fn(async () => ({
      answer: 'Official result confirmed.',
      query: 'official current result',
      responseTime: 0.1,
      sources: [
        {
          title: 'Official source',
          url: 'https://example.test/official',
          content: 'The official result.',
          score: 1,
        },
      ],
    }));
    const events: StatelessEvent[] = [];
    const callAgent = makeCallAgent({
      streamFn: childSearchStream(contexts),
      createTool: () => makeSearchTool(searchResponses),
      events,
    });

    const result = await callAgent.execute('director-call-1', {
      agentId: teacher.id,
      instruction: 'Search for the official current result and answer with its exact URL.',
    });

    expect(searchResponses).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(2);
    expect(findToolResult(contexts[1], 'web_search')).toMatchObject({
      toolCallId: 'child-search-1',
      isError: false,
      details: {
        status: 'ok',
        sourceCount: 1,
        sources: [{ url: 'https://example.test/official' }],
      },
    });
    expect(result.details).toMatchObject({
      agentId: teacher.id,
      text: '根据官方来源，结果已核实：https://example.test/official',
      nativeChildRun: {
        status: 'completed',
        finalOutput: '根据官方来源，结果已核实：https://example.test/official',
        toolExecutions: [
          {
            request: {
              agentId: teacher.id,
              depth: 1,
              toolName: 'web_search',
              toolCallId: 'child-search-1',
              args: { query: 'official current result' },
            },
            status: 'succeeded',
            isError: false,
            details: {
              status: 'ok',
              sources: [{ url: 'https://example.test/official' }],
            },
          },
        ],
      },
    });
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'text_delta', 'agent_end']);
  });

  it.each([
    {
      name: 'provider failure',
      search: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
      status: 'error',
    },
    {
      name: 'response parsing timeout',
      search: vi.fn(async () => {
        throw new Error('Web search response parsing timed out after 20ms');
      }),
      status: 'error',
    },
    {
      name: 'no legal URL',
      search: vi.fn(async () => ({
        answer: 'Unsupported answer.',
        query: 'official current result',
        responseTime: 0.1,
        sources: [
          {
            title: 'Invalid',
            url: 'javascript:alert(1)',
            content: 'Not auditable.',
            score: 1,
          },
        ],
      })),
      status: 'insufficient_evidence',
    },
  ])(
    'fails closed for $name and feeds an explicit error to the same Child',
    async ({ search, status }) => {
      const contexts: Context[] = [];
      const callAgent = makeCallAgent({
        streamFn: childSearchStream(contexts),
        createTool: () => makeSearchTool(search),
      });

      const result = await callAgent.execute('director-call-failed', {
        agentId: teacher.id,
        instruction: 'Search for the official current result.',
      });
      const childToolResult = findToolResult(contexts[1], 'web_search');

      expect(childToolResult).toMatchObject({
        isError: true,
        details: { status, sourceCount: 0, sources: [] },
      });
      expect(result.details).toMatchObject({
        nativeChildRun: {
          status: 'completed',
          toolExecutions: [{ status: 'execution_failed', isError: true }],
        },
      });
      expect((result.details as { text: string }).text).toContain('搜索不可用');
      expect(JSON.stringify(result)).not.toContain('https://example.test/official');
    },
  );

  it('feeds not_configured to the same Child without calling the provider', async () => {
    const contexts: Context[] = [];
    const searchResponses = vi.fn();
    const callAgent = makeCallAgent({
      streamFn: childSearchStream(contexts),
      createTool: () => makeSearchTool(searchResponses, false),
    });

    const result = await callAgent.execute('director-call-not-configured', {
      agentId: teacher.id,
      instruction: 'Search for the official current result.',
    });

    expect(searchResponses).not.toHaveBeenCalled();
    expect(findToolResult(contexts[1], 'web_search')).toMatchObject({
      isError: true,
      details: {
        status: 'not_configured',
        sourceCount: 0,
        sources: [],
      },
    });
    expect(result.details).toMatchObject({
      text: expect.stringContaining('搜索不可用'),
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [{ status: 'execution_failed', isError: true }],
      },
    });
  });

  it('cancels the Child on external abort and does not continue after the tool call', async () => {
    const controller = new AbortController();
    const contexts: Context[] = [];
    const searchStarted = Promise.withResolvers<void>();
    const searchResponses = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          searchStarted.resolve();
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const callAgent = makeCallAgent({
      streamFn: childSearchStream(contexts),
      createTool: () => makeSearchTool(searchResponses as never),
      abortSignal: controller.signal,
    });

    const run = callAgent.execute('director-call-abort', {
      agentId: teacher.id,
      instruction: 'Search for the official current result.',
    });
    await searchStarted.promise;
    controller.abort();
    const result = await run;

    expect(result.details).toMatchObject({
      text: '',
      nativeChildRun: {
        status: 'cancelled',
        stopReason: 'aborted',
        toolExecutions: [{ status: 'cancelled', isError: true }],
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(contexts).toHaveLength(1);
  });

  it('does not reuse a successful toolResult in a later failed Child invocation', async () => {
    const contexts: Context[] = [];
    let invocation = 0;
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = findToolResult(context, 'web_search');
      if (!result) {
        invocation += 1;
        return streamMessage(
          assistantToolCall(`child-search-${invocation}`, 'web_search', {
            query: `query-${invocation}`,
          }),
        );
      }
      const resultText = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      return streamMessage(
        assistantText(result.isError ? '第二次搜索失败，不能复用旧证据。' : resultText),
      );
    }) as StreamFn;
    const searchResponses = vi
      .fn()
      .mockResolvedValueOnce({
        answer: 'First answer.',
        query: 'query-1',
        responseTime: 0.1,
        sources: [
          {
            title: 'First source',
            url: 'https://example.test/first',
            content: 'First evidence.',
            score: 1,
          },
        ],
      })
      .mockRejectedValueOnce(new Error('second search failed'));
    const callAgent = makeCallAgent({
      streamFn,
      createTool: () => makeSearchTool(searchResponses),
    });

    const first = await callAgent.execute('director-call-1', {
      agentId: teacher.id,
      instruction: 'First current question.',
    });
    const second = await callAgent.execute('director-call-2', {
      agentId: teacher.id,
      instruction: 'Second current question.',
    });

    const secondRunContexts = contexts.slice(2);
    expect(secondRunContexts).toHaveLength(2);
    expect(JSON.stringify(secondRunContexts)).not.toContain('https://example.test/first');
    expect(JSON.stringify(second)).not.toContain('https://example.test/first');
    expect(second.details).toMatchObject({
      text: '第二次搜索失败，不能复用旧证据。',
      nativeChildRun: {
        toolExecutions: [{ status: 'execution_failed', isError: true }],
      },
    });
    const firstRequest = (
      first.details as {
        nativeChildRun: {
          toolExecutions: Array<{
            request: { traceId: string; runId: string; agentInvocationId: string };
          }>;
        };
      }
    ).nativeChildRun.toolExecutions[0]?.request;
    const secondRequest = (
      second.details as {
        nativeChildRun: {
          toolExecutions: Array<{
            request: { traceId: string; runId: string; agentInvocationId: string };
          }>;
        };
      }
    ).nativeChildRun.toolExecutions[0]?.request;
    expect(firstRequest?.traceId).toBeTruthy();
    expect(secondRequest?.traceId).toBe(firstRequest?.traceId);
    expect(secondRequest?.runId).not.toBe(firstRequest?.runId);
    expect(secondRequest?.agentInvocationId).not.toBe(firstRequest?.agentInvocationId);
  });

  it('joins the ChildRunResult back into the same real Director Pi context', async () => {
    const childContexts: Context[] = [];
    const directorContexts: Context[] = [];
    const callAgent = makeCallAgent({
      streamFn: childSearchStream(childContexts),
      createTool: () =>
        makeSearchTool(
          vi.fn(async () => ({
            answer: 'Official result confirmed.',
            query: 'official current result',
            responseTime: 0.1,
            sources: [
              {
                title: 'Official source',
                url: 'https://example.test/official',
                content: 'The official result.',
                score: 1,
              },
            ],
          })),
        ),
    });
    const directorStreamFn = ((_model, context) => {
      directorContexts.push(context);
      const result = findToolResult(context, 'call_agent');
      return streamMessage(
        result
          ? assistantText(
              JSON.stringify(result.details).includes('https://example.test/official')
                ? 'Director received the sourced ChildRunResult.'
                : 'Director did not receive the ChildRunResult.',
            )
          : assistantToolCall('director-call-1', 'call_agent', {
              agentId: teacher.id,
              instruction: 'Search for the official current result and cite the exact URL.',
            }),
      );
    }) as StreamFn;
    const director = buildAgent({
      streamFn: directorStreamFn,
      systemPrompt: 'Delegate the current question.',
      tools: [callAgent],
      allowedToolNames: new Set(['call_agent']),
    });

    await director.prompt('Find the current official result.');
    await director.waitForIdle();

    expect(directorContexts).toHaveLength(2);
    expect(findToolResult(directorContexts[1], 'call_agent')).toMatchObject({
      isError: false,
      details: {
        nativeChildRun: {
          status: 'completed',
          toolExecutions: [
            {
              request: { toolName: 'web_search' },
              status: 'succeeded',
            },
          ],
        },
      },
    });
    expect(director.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Director received the sourced ChildRunResult.' }],
    });
  });
});
