import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type RunNativeChildOptions,
} from '@/lib/agent/runtime/native-child-contract';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';

const EMPTY_USAGE = {
  input: 2,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

function streamMessage(
  message: AssistantMessage,
): ReturnType<typeof createAssistantMessageEventStream> {
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

function streamMessageWithVisibleDelta(
  message: AssistantMessage,
  delta: string,
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: { ...message, content: [] } });
    stream.push({
      type: 'text_start',
      contentIndex: 0,
      partial: { ...message, content: [{ type: 'text', text: '' }] },
    });
    stream.push({
      type: 'text_delta',
      contentIndex: 0,
      delta,
      partial: { ...message, content: [{ type: 'text', text: delta }] },
    });
    stream.push({
      type: 'text_end',
      contentIndex: 0,
      content: delta,
      partial: message,
    });
    stream.push({
      type: 'done',
      reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message,
    });
  });
  return stream;
}

function contextHasToolResult(context: Context, toolName: string): boolean {
  return context.messages.some(
    (message) => message.role === 'toolResult' && message.toolName === toolName,
  );
}

function findToolResult(context: Context, toolName: string) {
  return context.messages.find(
    (message): message is Extract<Context['messages'][number], { role: 'toolResult' }> =>
      message.role === 'toolResult' && message.toolName === toolName,
  );
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function baseOptions(overrides: Partial<RunNativeChildOptions> = {}): RunNativeChildOptions {
  return {
    traceId: 'trace-1',
    runId: 'run-1',
    agentInvocationId: 'child-1',
    agentId: 'teacher-1',
    depth: 1,
    streamFn: (() => streamMessage(assistantText('unused'))) as StreamFn,
    systemPrompt: 'You are a deterministic test child.',
    prompt: 'Use the tool, then explain its result.',
    tools: [],
    timeoutMs: 1_000,
    maxToolExecutions: 4,
    maxToolCallAttempts: 8,
    now: (() => {
      let time = 100;
      return () => time++;
    })(),
    createExecutionId: () => 'execution-1',
    ...overrides,
  };
}

describe('runNativeChild Phase 0', () => {
  it('waits for a client effect result and streams same-Child text on both sides', async () => {
    const visible: Array<{ delta: string; sequence: number }> = [];
    const EffectParams = Type.Object({ content: Type.String() });
    const tool: AgentTool<typeof EffectParams> = {
      name: 'wb_draw_text',
      label: 'Draw text',
      description: 'Draw text in the browser.',
      parameters: EffectParams,
      execute: vi.fn(async () => {
        throw new Error('The direct executor must not run.');
      }),
    };
    const handler = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'effect committed' }],
      details: { status: 'effect_committed' },
      isError: false,
    }));
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      if (contextHasToolResult(context, tool.name)) {
        return streamMessageWithVisibleDelta(
          assistantText('白板已经显示，我们继续解释。'),
          '白板已经显示，我们继续解释。',
        );
      }
      const message = {
        ...assistantToolCall('effect-call-1', tool.name, { content: 'k 决定方向' }),
        content: [
          { type: 'text' as const, text: '我先把结论写到白板上。' },
          {
            type: 'toolCall' as const,
            id: 'effect-call-1',
            name: tool.name,
            arguments: { content: 'k 决定方向' },
          },
        ],
      };
      return streamMessageWithVisibleDelta(message, '我先把结论写到白板上。');
    }) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        tools: [tool],
        clientEffectHandlers: new Map([[tool.name, handler]]),
        onVisibleTextDelta: (event) => {
          visible.push({
            delta: event.delta,
            sequence: event.assistantTurnSequence,
          });
          return event.delta;
        },
      }),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(2);
    expect(visible).toEqual([
      { delta: '我先把结论写到白板上。', sequence: 1 },
      { delta: '白板已经显示，我们继续解释。', sequence: 2 },
    ]);
    expect(result.status).toBe('completed');
    expect(result.visibleOutput).toBe('我先把结论写到白板上。白板已经显示，我们继续解释。');
    expect(result.toolExecutions[0]).toMatchObject({
      request: { kind: 'client_effect', toolName: 'wb_draw_text' },
      status: 'succeeded',
      isError: false,
    });
  });

  it('does not restore sanitizer-suppressed raw text into visibleOutput', async () => {
    const streamFn = (() =>
      streamMessageWithVisibleDelta(
        assistantText('<action>hidden</action>'),
        '<action>',
      )) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        onVisibleTextDelta: () => '',
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.visibleOutput).toBeUndefined();
    expect(result.finalOutput).toBe('<action>hidden</action>');
  });

  it('uses Pi native tool execution and continues in the same Child context', async () => {
    const contexts: Context[] = [];
    const LookupParams = Type.Object({ topic: Type.String() });
    const execute = vi.fn(async (_toolCallId: string, params: { topic: string }) => ({
      content: [{ type: 'text' as const, text: `verified:${params.topic}` }],
      details: { source: 'deterministic-server-tool' },
    }));
    const tool: AgentTool<typeof LookupParams> = {
      name: 'deterministic_lookup',
      label: 'Deterministic lookup',
      description: 'Return deterministic evidence.',
      parameters: LookupParams,
      execute,
    };
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const toolResult = findToolResult(context, tool.name);
      return streamMessage(
        toolResult
          ? assistantText(
              toolResult.content.some(
                (part) => part.type === 'text' && part.text === 'verified:photosynthesis',
              )
                ? 'The same Child saw verified:photosynthesis and continued.'
                : 'The Child received the wrong tool result.',
            )
          : assistantToolCall('tool-call-1', tool.name, { topic: 'photosynthesis' }),
      );
    }) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        tools: [tool],
      }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(2);
    expect(contextHasToolResult(contexts[1], tool.name)).toBe(true);
    expect(findToolResult(contexts[1], tool.name)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tool-call-1',
      toolName: 'deterministic_lookup',
      content: [{ type: 'text', text: 'verified:photosynthesis' }],
      details: { source: 'deterministic-server-tool' },
      isError: false,
    });
    expect(result).toMatchObject({
      agentInvocationId: 'child-1',
      status: 'completed',
      finalOutput: 'The same Child saw verified:photosynthesis and continued.',
      stopReason: 'stop',
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    });
    expect(result.toolExecutions).toHaveLength(1);
    expect(result.toolExecutions[0]).toMatchObject({
      request: {
        protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
        kind: 'server',
        traceId: 'trace-1',
        runId: 'run-1',
        agentInvocationId: 'child-1',
        agentId: 'teacher-1',
        depth: 1,
        sequence: 1,
        toolCallId: 'tool-call-1',
        executionId: 'execution-1',
        idempotencyKey: 'run-1:child-1:tool-call-1',
        toolName: 'deterministic_lookup',
        args: { topic: 'photosynthesis' },
        argsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        attempt: 1,
      },
      status: 'succeeded',
      isError: false,
      details: { source: 'deterministic-server-tool' },
    });
  });

  it('feeds a native tool failure back to the same Child for correction', async () => {
    const contexts: Context[] = [];
    const tool: AgentTool = {
      name: 'failing_lookup',
      label: 'Failing lookup',
      description: 'Fail deterministically.',
      parameters: Type.Object({}),
      execute: vi.fn(async () => {
        throw new Error('deterministic tool failure');
      }),
    };
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const toolResult = findToolResult(context, tool.name);
      return streamMessage(
        toolResult
          ? assistantText(
              toolResult.isError &&
                toolResult.content.some(
                  (part) =>
                    part.type === 'text' && part.text.includes('deterministic tool failure'),
                )
                ? 'The lookup failed, so I did not claim success.'
                : 'The failure result was not preserved.',
            )
          : assistantToolCall('tool-call-fail', tool.name, {}),
      );
    }) as StreamFn;

    const result = await runNativeChild(baseOptions({ streamFn, tools: [tool] }));

    expect(contexts).toHaveLength(2);
    expect(contextHasToolResult(contexts[1], tool.name)).toBe(true);
    expect(findToolResult(contexts[1], tool.name)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tool-call-fail',
      toolName: 'failing_lookup',
      content: [{ type: 'text', text: 'deterministic tool failure' }],
      details: {},
      isError: true,
    });
    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('The lookup failed, so I did not claim success.');
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        status: 'execution_failed',
        isError: true,
      }),
    ]);
  });

  it('rejects a tool outside the request-scoped allowlist without executing it', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
      details: {},
    }));
    const tool: AgentTool = {
      name: 'disabled_tool',
      label: 'Disabled tool',
      description: 'This tool is registered but not authorized for the Child.',
      parameters: Type.Object({}),
      execute,
    };
    const streamFn = ((_model, context) =>
      streamMessage(
        contextHasToolResult(context, tool.name)
          ? assistantText('The tool was unavailable, so I stopped.')
          : assistantToolCall('tool-call-rejected', tool.name, {}),
      )) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        tools: [tool],
        allowedToolNames: new Set(),
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('The tool was unavailable, so I stopped.');
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        status: 'rejected',
        isError: true,
      }),
    ]);
  });

  it('stops the Child when the server-tool execution budget is exhausted', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      details: {},
    }));
    const tool: AgentTool = {
      name: 'bounded_tool',
      label: 'Bounded tool',
      description: 'Request this tool repeatedly.',
      parameters: Type.Object({}),
      execute,
    };
    let turn = 0;
    const streamFn = (() => {
      turn += 1;
      return streamMessage(assistantToolCall(`tool-call-budget-${turn}`, tool.name, {}));
    }) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        tools: [tool],
        maxToolExecutions: 1,
      }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('tool_execution_budget');
    expect(result.finalOutput).toBeUndefined();
    expect(result.toolExecutions.map((execution) => execution.status)).toEqual([
      'succeeded',
      'rejected',
    ]);
  });

  it('bounds repeated rejected tool-call attempts independently of executions', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
      details: {},
    }));
    const tool: AgentTool = {
      name: 'always_disabled_tool',
      label: 'Always disabled tool',
      description: 'Remain outside the request-scoped allowlist.',
      parameters: Type.Object({}),
      execute,
    };
    let streamCalls = 0;
    const streamFn = (() => {
      streamCalls += 1;
      return streamMessage(assistantToolCall(`rejected-attempt-${streamCalls}`, tool.name, {}));
    }) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        tools: [tool],
        allowedToolNames: new Set(),
        maxToolExecutions: 1,
        maxToolCallAttempts: 2,
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(streamCalls).toBe(3);
    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('tool_call_attempt_budget');
    expect(result.toolExecutions).toHaveLength(3);
    expect(result.toolExecutions.every((execution) => execution.status === 'rejected')).toBe(true);
  });

  it('counts repeated unknown tool calls against the hard attempt cap', async () => {
    let streamCalls = 0;
    const streamFn = (() => {
      streamCalls += 1;
      return streamMessage(assistantToolCall(`unknown-attempt-${streamCalls}`, 'unknown_tool', {}));
    }) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        tools: [],
        maxToolExecutions: 1,
        maxToolCallAttempts: 2,
      }),
    );

    expect(streamCalls).toBe(3);
    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('tool_call_attempt_budget');
    expect(result.toolExecutions).toHaveLength(3);
    expect(result.toolExecutions.every((execution) => execution.status === 'rejected')).toBe(true);
  });

  it('counts repeated schema-invalid tool calls against the hard attempt cap', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
      details: {},
    }));
    const tool: AgentTool = {
      name: 'strict_tool',
      label: 'Strict tool',
      description: 'Require a non-empty query.',
      parameters: Type.Object(
        { query: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      execute,
    };
    let streamCalls = 0;
    const streamFn = (() => {
      streamCalls += 1;
      return streamMessage(assistantToolCall(`invalid-attempt-${streamCalls}`, tool.name, {}));
    }) as StreamFn;

    const result = await runNativeChild(
      baseOptions({
        streamFn,
        tools: [tool],
        maxToolExecutions: 1,
        maxToolCallAttempts: 2,
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(streamCalls).toBe(3);
    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('tool_call_attempt_budget');
    expect(result.toolExecutions).toHaveLength(3);
    expect(result.toolExecutions.every((execution) => execution.status === 'rejected')).toBe(true);
  });

  it('returns on timeout even when the underlying tool ignores AbortSignal forever', async () => {
    const tool: AgentTool = {
      name: 'blocking_tool',
      label: 'Blocking tool',
      description: 'Ignore AbortSignal and never settle.',
      parameters: Type.Object({}),
      execute: vi.fn(async () => await new Promise<never>(() => {})),
    };
    const streamFn = ((_model, context) =>
      streamMessage(
        contextHasToolResult(context, tool.name)
          ? assistantText('must not continue after timeout')
          : assistantToolCall('tool-call-timeout', tool.name, {}),
      )) as StreamFn;

    const result = await settlesWithin(
      runNativeChild(
        baseOptions({
          streamFn,
          tools: [tool],
          timeoutMs: 20,
        }),
      ),
      250,
    );

    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('timeout');
    expect(result.finalOutput).toBeUndefined();
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        status: 'timeout',
        isError: true,
      }),
    ]);
  });

  it('keeps timeout status and isError consistent when a late tool eventually succeeds', async () => {
    const tool: AgentTool = {
      name: 'late_success_tool',
      label: 'Late success tool',
      description: 'Resolve successfully after the Child deadline.',
      parameters: Type.Object({}),
      execute: vi.fn(
        async () =>
          await new Promise<{
            content: Array<{ type: 'text'; text: string }>;
            details: Record<string, never>;
          }>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  content: [{ type: 'text' as const, text: 'late success' }],
                  details: {},
                }),
              50,
            );
          }),
      ),
    };
    const streamFn = ((_model, context) =>
      streamMessage(
        contextHasToolResult(context, tool.name)
          ? assistantText('must not become a valid late answer')
          : assistantToolCall('tool-call-late-success', tool.name, {}),
      )) as StreamFn;

    const result = await settlesWithin(
      runNativeChild(
        baseOptions({
          streamFn,
          tools: [tool],
          timeoutMs: 10,
        }),
      ),
      250,
    );

    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('timeout');
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        status: 'timeout',
        isError: true,
      }),
    ]);
  });

  it('returns on external abort even when the underlying tool ignores AbortSignal', async () => {
    const controller = new AbortController();
    const tool: AgentTool = {
      name: 'abortable_tool',
      label: 'Abortable tool',
      description: 'Ignore AbortSignal and never settle.',
      parameters: Type.Object({}),
      execute: vi.fn(async () => await new Promise<never>(() => {})),
    };
    const streamFn = ((_model, context) =>
      streamMessage(
        contextHasToolResult(context, tool.name)
          ? assistantText('must not continue after cancellation')
          : assistantToolCall('tool-call-abort', tool.name, {}),
      )) as StreamFn;

    const run = runNativeChild(
      baseOptions({
        streamFn,
        tools: [tool],
        abortSignal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 10);
    const result = await settlesWithin(run, 250);

    expect(result.status).toBe('cancelled');
    expect(result.stopReason).toBe('aborted');
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        isError: true,
      }),
    ]);
  });

  it('returns on timeout when the StreamFn promise never resolves', async () => {
    const streamFn = vi.fn(
      async () => await new Promise<ReturnType<typeof createAssistantMessageEventStream>>(() => {}),
    ) as StreamFn;

    const result = await settlesWithin(
      runNativeChild(
        baseOptions({
          streamFn,
          timeoutMs: 20,
        }),
      ),
      250,
    );

    expect(streamFn).toHaveBeenCalledOnce();
    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('timeout');
    expect(result.finalOutput).toBeUndefined();
    expect(result.toolExecutions).toEqual([]);
  });

  it('returns on external abort when the StreamFn promise never resolves', async () => {
    const controller = new AbortController();
    const streamFn = vi.fn(
      async () => await new Promise<ReturnType<typeof createAssistantMessageEventStream>>(() => {}),
    ) as StreamFn;
    const run = runNativeChild(
      baseOptions({
        streamFn,
        abortSignal: controller.signal,
      }),
    );

    setTimeout(() => controller.abort(), 10);
    const result = await settlesWithin(run, 250);

    expect(streamFn).toHaveBeenCalledOnce();
    expect(result.status).toBe('cancelled');
    expect(result.stopReason).toBe('aborted');
    expect(result.finalOutput).toBeUndefined();
    expect(result.toolExecutions).toEqual([]);
  });

  it('returns on timeout when the StreamFn event stream never ends', async () => {
    const streamFn = vi.fn(() => createAssistantMessageEventStream()) as StreamFn;

    const result = await settlesWithin(
      runNativeChild(
        baseOptions({
          streamFn,
          timeoutMs: 20,
        }),
      ),
      250,
    );

    expect(streamFn).toHaveBeenCalledOnce();
    expect(result.status).toBe('exhausted');
    expect(result.stopReason).toBe('timeout');
    expect(result.finalOutput).toBeUndefined();
    expect(result.toolExecutions).toEqual([]);
  });

  it('returns on external abort when the StreamFn event stream never ends', async () => {
    const controller = new AbortController();
    const streamFn = vi.fn(() => createAssistantMessageEventStream()) as StreamFn;
    const run = runNativeChild(
      baseOptions({
        streamFn,
        abortSignal: controller.signal,
      }),
    );

    setTimeout(() => controller.abort(), 10);
    const result = await settlesWithin(run, 250);

    expect(streamFn).toHaveBeenCalledOnce();
    expect(result.status).toBe('cancelled');
    expect(result.stopReason).toBe('aborted');
    expect(result.finalOutput).toBeUndefined();
    expect(result.toolExecutions).toEqual([]);
  });
});
