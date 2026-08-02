import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import type { StageStore } from '@/lib/api/stage-api';
import { BrowserClientEffectRuntime } from '@/lib/agent/client/client-effect-runtime';
import {
  isClientEffectAck,
  type ClientEffectAck,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import { WB_CLOSE_MS } from '@/lib/choreography/timing';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildNativeWhiteboardCloseTool } from '@/lib/chat/pi/tools/native-whiteboard';
import { NativeWhiteboardViewState } from '@/lib/chat/pi/tools/native-whiteboard-view-state';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { WhiteboardActionRecord } from '@/lib/orchestration/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

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
    agentIds: ['teacher-1'],
    piSessionId: 'session-1',
    piRequestId: 'request-1',
  },
} as unknown as StatelessChatRequest;

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: '王老师',
  role: 'teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_close', 'wb_draw_text'],
  priority: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
};

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'test',
    provider: 'test',
    model: 'deterministic',
    usage,
    stopReason: 'toolUse',
    timestamp: 1,
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

function createBrowserStore(): StageStore {
  let state = {
    stage: {
      id: 'stage-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [],
    },
    scenes: [{ id: 'scene-1' }],
    currentSceneId: 'scene-1',
    mode: 'playback' as const,
  };
  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
  } as unknown as StageStore;
}

function buildTeacherCall(opts: {
  streamFn: StreamFn;
  events: StatelessEvent[];
  send?: (event: StatelessEvent) => Promise<void>;
  onActionDone?: (record?: WhiteboardActionRecord) => void;
  maxActionsPerAgent?: number;
}) {
  return buildCallAgentTool({
    body,
    agentConfigs: [teacher],
    send:
      opts.send ??
      (async (event) => {
        opts.events.push(event);
      }),
    languageModel: {} as LanguageModel,
    onAgentDone: vi.fn(),
    onActionDone: opts.onActionDone ?? vi.fn(),
    thinkingConfig: { mode: 'disabled', enabled: false },
    abortSignal: new AbortController().signal,
    maxAgentTurns: 2,
    getAgentTurnCount: () => 0,
    getAgentResponses: () => [],
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: opts.maxActionsPerAgent ?? 2,
    enableWhiteboardTools: true,
    childRuntimeMode: 'native',
    enableNativeChildWhiteboard: true,
    nativeChildStreamFn: opts.streamFn,
    nativeChildTimeoutMs: 5_000,
  });
}

afterEach(() => piClientEffectCoordinator.clearForTests());

describe('Teacher native wb_close lifecycle bridge', () => {
  it('exposes a strict empty-object schema and rejects exhausted budget before delivery', async () => {
    const send = vi.fn();
    const { tool, handler } = buildNativeWhiteboardCloseTool({
      body,
      viewState: new NativeWhiteboardViewState(body),
      messageId: 'message-close-schema',
      canExecute: () => false,
      send,
    });
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    await expect(
      handler({
        request: {
          protocolVersion: 'maic.tool-execution.v1',
          kind: 'client_effect',
          traceId: 'trace',
          runId: 'run',
          agentInvocationId: 'message-close-schema',
          agentId: 'teacher-1',
          depth: 1,
          sequence: 1,
          toolCallId: 'tool-close-budget',
          executionId: 'execution-close-budget',
          idempotencyKey: 'run:message-close-schema:tool-close-budget',
          toolName: 'wb_close',
          args: {},
          argsDigest: 'sha256:close',
          issuedAt: Date.now(),
          deadlineAt: Date.now() + 30_000,
          attempt: 1,
        },
        params: {},
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'ACTION_BUDGET_EXHAUSTED' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('reserves the worst-case close animation budget before delivery', async () => {
    const now = 1_000;
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardCloseTool({
      body,
      viewState: new NativeWhiteboardViewState(body),
      messageId: 'message-close-deadline',
      send,
      now: () => now,
    });

    await expect(
      handler({
        request: {
          protocolVersion: 'maic.tool-execution.v1',
          kind: 'client_effect',
          traceId: 'trace',
          runId: 'run',
          agentInvocationId: 'message-close-deadline',
          agentId: 'teacher-1',
          depth: 1,
          sequence: 1,
          toolCallId: 'tool-close-deadline',
          executionId: 'execution-close-deadline',
          idempotencyKey: 'run:message-close-deadline:tool-close-deadline',
          toolName: 'wb_close',
          args: {},
          argsDigest: 'sha256:close',
          issuedAt: now,
          deadlineAt: now + WB_CLOSE_MS + 1_500,
          attempt: 1,
        },
        params: {},
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_DEADLINE_EXHAUSTED' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses real Pi validation to reject extra close arguments before delivery', async () => {
    const contexts: Context[] = [];
    const events: StatelessEvent[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      return contexts.length === 1
        ? streamMessage(assistantToolCall('close-invalid', 'wb_close', { reason: 'done' }))
        : streamMessage({
            role: 'assistant',
            content: [{ type: 'text', text: '关闭参数无效，我不会声称白板已经关闭。' }],
            api: 'test',
            provider: 'test',
            model: 'deterministic',
            usage,
            stopReason: 'stop',
            timestamp: 1,
          });
    }) as StreamFn;
    const callAgent = buildTeacherCall({ streamFn, events });

    const result = await callAgent.execute('director-close-invalid', {
      agentId: teacher.id,
      instruction: 'Close the board.',
    });

    expect(contexts).toHaveLength(2);
    expect(events.some((event) => event.type === 'client_effect')).toBe(false);
    expect(result.details).toMatchObject({
      text: '关闭参数无效，我不会声称白板已经关闭。',
      nativeChildRun: { status: 'completed' },
    });
  });

  it('does not close or emit a client effect unless the Child explicitly calls wb_close', async () => {
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const streamFn = (() =>
      streamMessage({
        role: 'assistant',
        content: [{ type: 'text', text: '讲解完成，但白板继续保留给后续课堂 Agent。' }],
        api: 'test',
        provider: 'test',
        model: 'deterministic',
        usage,
        stopReason: 'stop',
        timestamp: 1,
      })) as StreamFn;
    const callAgent = buildTeacherCall({ streamFn, events, onActionDone });

    const result = await callAgent.execute('director-no-implicit-close', {
      agentId: teacher.id,
      instruction: 'Finish explaining and leave the board available for the next agent.',
    });

    expect(events.some((event) => event.type === 'client_effect')).toBe(false);
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      text: '讲解完成，但白板继续保留给后续课堂 Agent。',
      nativeChildRun: { status: 'completed', toolExecutions: [] },
    });
  });

  it('runs Close then Draw through Browser ACK and continues one Child', async () => {
    const contexts: Context[] = [];
    const events: StatelessEvent[] = [];
    const acknowledgements: ClientEffectAck[] = [];
    const capabilityTokens = new Map<string, string>();
    const store = createBrowserStore();
    let whiteboardOpen = true;
    const browserRuntime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => whiteboardOpen,
      setWhiteboardVisible: (open) => {
        whiteboardOpen = open;
      },
      ensureWhiteboardVisible: async () => {
        whiteboardOpen = true;
      },
      fetchAck: async (_url, init) => {
        const raw = JSON.parse(String(init?.body)) as unknown;
        if (!isClientEffectAck(raw)) {
          return new Response(JSON.stringify({ success: false, error: 'invalid ACK' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        acknowledgements.push(raw);
        const token = capabilityTokens.get(raw.executionId);
        if (!token) throw new Error('Missing capability token.');
        const outcome = piClientEffectCoordinator.acknowledge(raw.executionId, token, raw);
        if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate' && outcome.kind !== 'late') {
          return new Response(JSON.stringify({ success: false, error: outcome.kind }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ success: true, state: { status: outcome.snapshot.status } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const hasDrawResult = context.messages.some(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_text',
      );
      const hasCloseResult = context.messages.some(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_close',
      );
      if (hasDrawResult) {
        return streamMessage({
          role: 'assistant',
          content: [{ type: 'text', text: '白板重新打开并写入新内容，我们继续。' }],
          api: 'test',
          provider: 'test',
          model: 'deterministic',
          usage,
          stopReason: 'stop',
          timestamp: 1,
        });
      }
      return hasCloseResult
        ? streamMessage(
            assistantToolCall('draw-after-close', 'wb_draw_text', {
              content: '新的讲解',
              x: 100,
              y: 120,
            }),
          )
        : streamMessage(assistantToolCall('close-before-draw', 'wb_close', {}));
    }) as StreamFn;
    const onActionDone = vi.fn();
    const callAgent = buildTeacherCall({
      streamFn,
      events,
      onActionDone,
      send: async (event) => {
        events.push(event);
        if (event.type !== 'client_effect') return;
        capabilityTokens.set(event.data.request.executionId, event.data.acknowledgementToken);
        await browserRuntime.execute(event.data, new AbortController().signal);
      },
    });

    const result = await callAgent.execute('director-close-draw', {
      agentId: teacher.id,
      instruction: 'Close the board, then deliberately draw new content.',
    });

    expect(contexts).toHaveLength(3);
    expect(whiteboardOpen).toBe(true);
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(onActionDone.mock.calls.map(([record]) => record.actionName)).toEqual([
      'wb_close',
      'wb_draw_text',
    ]);
    expect(result.details).toMatchObject({
      text: '白板重新打开并写入新内容，我们继续。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          { request: { toolName: 'wb_close' }, status: 'succeeded' },
          { request: { toolName: 'wb_draw_text' }, status: 'succeeded' },
        ],
      },
    });
    expect(acknowledgements.filter((ack) => ack.status === 'effect_committed')).toHaveLength(2);
  });

  it('does not count a browser-verified already-closed no-op as an action', async () => {
    const contexts: Context[] = [];
    const events: StatelessEvent[] = [];
    const tokens = new Map<string, string>();
    const store = createBrowserStore();
    let whiteboardOpen = false;
    const browserRuntime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => whiteboardOpen,
      setWhiteboardVisible: (open) => {
        whiteboardOpen = open;
      },
      ensureWhiteboardVisible: async () => {
        whiteboardOpen = true;
      },
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        const outcome = piClientEffectCoordinator.acknowledge(
          ack.executionId,
          tokens.get(ack.executionId) ?? '',
          ack,
        );
        return new Response(
          JSON.stringify({
            success: outcome.kind !== 'invalid',
            state:
              'snapshot' in outcome && outcome.snapshot
                ? { status: outcome.snapshot.status }
                : undefined,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const hasCloseResult = context.messages.some(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_close',
      );
      return hasCloseResult
        ? streamMessage({
            role: 'assistant',
            content: [{ type: 'text', text: '白板本来就是关闭的，我们继续。' }],
            api: 'test',
            provider: 'test',
            model: 'deterministic',
            usage,
            stopReason: 'stop',
            timestamp: 1,
          })
        : streamMessage(assistantToolCall('close-no-op', 'wb_close', {}));
    }) as StreamFn;
    const onActionDone = vi.fn();
    const onAgentDone = vi.fn();
    const callAgent = buildCallAgentTool({
      body: { ...body, storeState: { ...body.storeState, whiteboardOpen: false } },
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
        if (event.type !== 'client_effect') return;
        tokens.set(event.data.request.executionId, event.data.acknowledgementToken);
        await browserRuntime.execute(event.data, new AbortController().signal);
      },
      languageModel: {} as LanguageModel,
      onAgentDone,
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 2,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: true,
      childRuntimeMode: 'native',
      enableNativeChildWhiteboard: true,
      nativeChildStreamFn: streamFn,
      nativeChildTimeoutMs: 5_000,
    });

    await callAgent.execute('director-close-no-op', {
      agentId: teacher.id,
      instruction: 'Close the already closed board.',
    });

    expect(contexts).toHaveLength(2);
    expect(onActionDone).not.toHaveBeenCalled();
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 0 }));
  });

  it('preserves entity authority on commitClosed and only invalidates visibility', () => {
    const state = new NativeWhiteboardViewState({
      ...body,
      storeState: {
        ...body.storeState,
        stage: {
          ...body.storeState.stage,
          whiteboard: [
            {
              id: 'whiteboard-1',
              elements: [{ id: 'element-1', type: 'text' }],
            },
          ],
        },
      },
    } as StatelessChatRequest);
    state.commitClosed({
      kind: 'whiteboard_closed',
      normalizationVersion: 'maic.whiteboard-visibility.v1',
      desiredOpen: false,
      observedOpen: false,
      visibilityChanged: true,
    });
    expect(state.isOpen()).toBe(false);
    expect(state.isVisibilityTrusted()).toBe(true);
    expect(state.getWhiteboardId()).toBe('whiteboard-1');
    expect(state.getElementType('element-1')).toBe('text');
    expect(state.getSnapshotAuthority()).toBe('request_start');

    state.invalidateVisibility();
    expect(state.isVisibilityTrusted()).toBe(false);
    expect(state.getWhiteboardId()).toBe('whiteboard-1');
    expect(state.getElementType('element-1')).toBe('text');
  });

  it('invalidates only visibility after an unconfirmed mutation but retains it on pre-mutation failure', async () => {
    const makeState = () =>
      new NativeWhiteboardViewState({
        ...body,
        storeState: {
          ...body.storeState,
          stage: {
            ...body.storeState.stage,
            whiteboard: [
              {
                id: 'whiteboard-1',
                elements: [{ id: 'element-1', type: 'text' }],
              },
            ],
          },
        },
      } as StatelessChatRequest);
    const executeFailure = async (
      state: NativeWhiteboardViewState,
      executionId: string,
      errorCode: string,
    ) => {
      const { handler } = buildNativeWhiteboardCloseTool({
        body,
        viewState: state,
        messageId: executionId,
        send: async (event) => {
          if (event.type !== 'client_effect') return;
          const visibilityTarget = {
            requestId: event.data.request.target.requestId,
            sessionId: event.data.request.target.sessionId,
            stageId: event.data.request.target.stageId,
            sceneId: event.data.request.target.sceneId,
            bindingVersion: 1,
          };
          piClientEffectCoordinator.acknowledge(
            event.data.request.executionId,
            event.data.acknowledgementToken,
            {
              protocolVersion: 'maic.tool-execution.v1',
              executionId: event.data.request.executionId,
              idempotencyKey: event.data.request.idempotencyKey,
              clientEventId: `${executionId}-accepted`,
              observedAt: Date.now(),
              status: 'accepted',
              visibilityTarget,
            },
          );
          piClientEffectCoordinator.acknowledge(
            event.data.request.executionId,
            event.data.acknowledgementToken,
            {
              protocolVersion: 'maic.tool-execution.v1',
              executionId: event.data.request.executionId,
              idempotencyKey: event.data.request.idempotencyKey,
              clientEventId: `${executionId}-failed`,
              observedAt: Date.now(),
              status: 'effect_failed',
              error: { code: errorCode, message: 'close failed', retryable: true },
            },
          );
        },
      });
      return handler({
        request: {
          protocolVersion: 'maic.tool-execution.v1',
          kind: 'client_effect',
          traceId: 'trace-close-failure',
          runId: 'run-close-failure',
          agentInvocationId: executionId,
          agentId: 'teacher-1',
          depth: 1,
          sequence: 1,
          toolCallId: `tool-${executionId}`,
          executionId,
          idempotencyKey: `run-close-failure:${executionId}`,
          toolName: 'wb_close',
          args: {},
          argsDigest: 'sha256:close',
          issuedAt: Date.now(),
          deadlineAt: Date.now() + 30_000,
          attempt: 1,
        },
        params: {},
      });
    };

    const afterMutation = makeState();
    await executeFailure(
      afterMutation,
      'execution-close-unconfirmed',
      'CLIENT_EFFECT_CLOSE_STATE_UNCONFIRMED',
    );
    expect(afterMutation.isVisibilityTrusted()).toBe(false);
    expect(afterMutation.getWhiteboardId()).toBe('whiteboard-1');
    expect(afterMutation.getElementType('element-1')).toBe('text');

    const beforeMutation = makeState();
    await executeFailure(
      beforeMutation,
      'execution-close-pre-mutation',
      'CLIENT_EFFECT_CLOSE_FAILED_BEFORE_MUTATION',
    );
    expect(beforeMutation.isVisibilityTrusted()).toBe(true);
    expect(beforeMutation.isOpen()).toBe(true);
    expect(beforeMutation.getWhiteboardId()).toBe('whiteboard-1');
    expect(beforeMutation.getElementType('element-1')).toBe('text');
  });
});
