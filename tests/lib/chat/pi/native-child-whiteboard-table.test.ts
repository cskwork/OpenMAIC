import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import type {
  ClientEffectAck,
  ClientEffectDelivery,
  WhiteboardTablePostcondition,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ClientEffectExecutionRequest,
} from '@/lib/agent/runtime/native-child-contract';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildNativeWhiteboardTableTool } from '@/lib/chat/pi/tools/native-whiteboard';
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

const tableArgs = {
  data: [
    ['参数', '作用'],
    ['k', '决定方向'],
    ['b', '决定高低'],
  ],
  x: 80,
  y: 60,
  width: 600,
  height: 240,
  theme: { color: '#4472c4' },
};

const envelope: ClientEffectExecutionRequest = {
  protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
  kind: 'client_effect',
  traceId: 'trace-table-1',
  runId: 'run-table-1',
  agentInvocationId: 'message-table-1',
  agentId: 'teacher-1',
  depth: 1,
  sequence: 1,
  toolCallId: 'tool-call-table-1',
  executionId: 'execution-table-1',
  idempotencyKey: 'run-table-1:message-table-1:tool-call-table-1',
  toolName: 'wb_draw_table',
  args: tableArgs,
  argsDigest: 'sha256:table-args',
  issuedAt: Date.now(),
  deadlineAt: Date.now() + 30_000,
  attempt: 1,
};

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: '王老师',
  role: 'teacher',
  persona: 'Teach clearly with one concise comparison table.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_draw_table'],
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

function message(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'deterministic',
    usage,
    stopReason,
    timestamp: 1,
  };
}

function streamed(finalMessage: AssistantMessage, delta?: string) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (delta) {
      stream.push({ type: 'start', partial: { ...finalMessage, content: [] } });
      stream.push({
        type: 'text_delta',
        contentIndex: 0,
        delta,
        partial: { ...finalMessage, content: [{ type: 'text', text: delta }] },
      });
    }
    stream.push({
      type: 'done',
      reason: finalMessage.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message: finalMessage,
    });
  });
  return stream;
}

function ackBase(delivery: ClientEffectDelivery) {
  return {
    protocolVersion: 'maic.tool-execution.v1' as const,
    executionId: delivery.request.executionId,
    idempotencyKey: delivery.request.idempotencyKey,
    observedAt: Date.now(),
  };
}

function tablePostcondition(delivery: ClientEffectDelivery): WhiteboardTablePostcondition {
  if (delivery.request.postcondition.kind !== 'whiteboard_table_exists') {
    throw new Error('Expected a wb_draw_table client effect.');
  }
  return delivery.request.postcondition;
}

function targetBinding(delivery: ClientEffectDelivery) {
  return {
    ...delivery.request.target,
    whiteboardId: 'whiteboard-1',
    bindingVersion: 1 as const,
  };
}

function acknowledgeCommitted(delivery: ClientEffectDelivery): void {
  const binding = targetBinding(delivery);
  const expected = tablePostcondition(delivery);
  const acknowledge = (ack: ClientEffectAck) =>
    piClientEffectCoordinator.acknowledge(
      delivery.request.executionId,
      delivery.acknowledgementToken,
      ack,
    );
  acknowledge({
    ...ackBase(delivery),
    clientEventId: `${delivery.request.executionId}-accepted`,
    status: 'accepted',
    targetBinding: binding,
  });
  acknowledge({
    ...ackBase(delivery),
    clientEventId: `${delivery.request.executionId}-committed`,
    status: 'effect_committed',
    targetBinding: binding,
    postcondition: {
      stableElementId: expected.stableElementId,
      elementType: 'table',
      normalizationVersion: expected.normalizationVersion,
      observedTableDigest: expected.expectedTableDigest,
      matchingElementCount: 1,
    },
  });
}

function buildTableCallAgent(opts: {
  streamFn: StreamFn;
  events: StatelessEvent[];
  onActionDone?: (record?: WhiteboardActionRecord) => void;
  sendClientEffect?: (delivery: ClientEffectDelivery) => void;
}) {
  return buildCallAgentTool({
    body,
    agentConfigs: [teacher],
    send: async (event) => {
      opts.events.push(event);
      if (event.type === 'client_effect') opts.sendClientEffect?.(event.data);
    },
    languageModel: {} as LanguageModel,
    onAgentDone: vi.fn(),
    onActionDone: opts.onActionDone ?? vi.fn(),
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
    nativeChildStreamFn: opts.streamFn,
    nativeChildTimeoutMs: 5_000,
  });
}

describe('Teacher native wb_draw_table', () => {
  afterEach(() => piClientEffectCoordinator.clearForTests());

  it('does not settle at accepted and succeeds only after the exact table digest commits', async () => {
    let delivery!: ClientEffectDelivery;
    let settled = false;
    const onCommitted = vi.fn();
    const { handler } = buildNativeWhiteboardTableTool({
      body,
      viewState: new NativeWhiteboardViewState(body),
      messageId: 'message-table-1',
      onCommitted,
      send: async (event) => {
        if (event.type === 'client_effect') delivery = event.data;
      },
    });

    const resultPromise = handler({ request: envelope, params: envelope.args }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(delivery).toBeDefined());
    const binding = targetBinding(delivery);
    piClientEffectCoordinator.acknowledge(
      delivery.request.executionId,
      delivery.acknowledgementToken,
      {
        ...ackBase(delivery),
        clientEventId: 'table-accepted',
        status: 'accepted',
        targetBinding: binding,
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledgeCommitted(delivery);
    await expect(resultPromise).resolves.toMatchObject({
      isError: false,
      details: { status: 'effect_committed', executionId: envelope.executionId },
    });
    expect(onCommitted).toHaveBeenCalledWith(envelope.args);
  });

  it('rejects malformed and oversized tables before browser delivery', async () => {
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardTableTool({
      body,
      viewState: new NativeWhiteboardViewState(body),
      messageId: 'message-table-1',
      send,
    });

    await expect(
      handler({
        request: envelope,
        params: { ...tableArgs, data: [['a'], ['b', 'c']] },
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_TABLE_DIMENSIONS_INVALID' },
    });
    await expect(
      handler({
        request: envelope,
        params: { ...tableArgs, data: [['x'.repeat(257)]] },
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_TABLE_CELL_INVALID' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the verified toolResult to the same Child and records one committed action', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_table',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '表格已确认，k 定方向，b 定高低。' }], 'stop'),
            '表格已确认，k 定方向，b 定高低。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我先用表格比较 k 和 b。' },
                {
                  type: 'toolCall',
                  id: 'table-call-1',
                  name: 'wb_draw_table',
                  arguments: tableArgs,
                },
              ],
              'toolUse',
            ),
            '我先用表格比较 k 和 b。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildTableCallAgent({
      streamFn,
      events,
      onActionDone,
      sendClientEffect: acknowledgeCommitted,
    });

    const result = await callAgent.execute('director-table-call-1', {
      agentId: teacher.id,
      instruction: 'Draw one concise comparison table and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain(
      'Whiteboard table was rendered and its postcondition was verified.',
    );
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'text_delta',
      'client_effect',
      'text_delta',
      'agent_end',
    ]);
    const messageIds = events.flatMap((event) =>
      event.type === 'agent_start' || event.type === 'agent_end'
        ? [event.data.messageId]
        : event.type === 'text_delta'
          ? [event.data.messageId]
          : event.type === 'client_effect'
            ? [event.data.request.target.messageId]
            : [],
    );
    expect(new Set(messageIds).size).toBe(1);
    expect(onActionDone).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'wb_draw_table',
        agentId: teacher.id,
        params: expect.objectContaining({ data: tableArgs.data }),
      }),
    );
    expect(result.details).toMatchObject({
      text: '我先用表格比较 k 和 b。表格已确认，k 定方向，b 定高低。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { kind: 'client_effect', toolName: 'wb_draw_table' },
            status: 'succeeded',
            isError: false,
          },
        ],
      },
    });
  });

  it('returns a failed toolResult and lets the same Child recover without a false action record', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_table',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '表格未执行成功，我改用口头比较。' }], 'stop'),
            '表格未执行成功，我改用口头比较。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我尝试画一个比较表。' },
                {
                  type: 'toolCall',
                  id: 'table-failed-call',
                  name: 'wb_draw_table',
                  arguments: tableArgs,
                },
              ],
              'toolUse',
            ),
            '我尝试画一个比较表。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildTableCallAgent({
      streamFn,
      events,
      onActionDone,
      sendClientEffect: (delivery) => {
        const binding = targetBinding(delivery);
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'table-failed-accepted',
            status: 'accepted',
            targetBinding: binding,
          },
        );
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'table-failed',
            status: 'effect_failed',
            error: {
              code: 'BROWSER_MUTATION_FAILED',
              message: 'The browser rejected the table mutation.',
              retryable: false,
            },
          },
        );
      },
    });

    const result = await callAgent.execute('director-table-call-failed', {
      agentId: teacher.id,
      instruction: 'Draw one concise comparison table and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain('The browser rejected the table mutation.');
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      text: '我尝试画一个比较表。表格未执行成功，我改用口头比较。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { toolName: 'wb_draw_table' },
            status: 'execution_failed',
            isError: true,
          },
        ],
      },
    });
  });
});
