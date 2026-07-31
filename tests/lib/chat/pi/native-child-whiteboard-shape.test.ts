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
  WhiteboardShapePostcondition,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ClientEffectExecutionRequest,
} from '@/lib/agent/runtime/native-child-contract';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildNativeWhiteboardShapeTool } from '@/lib/chat/pi/tools/native-whiteboard';
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

const shapeArgs = {
  shape: 'rectangle' as const,
  x: 100,
  y: 80,
  width: 280,
  height: 160,
  fillColor: '#4477aa',
};

const envelope: ClientEffectExecutionRequest = {
  protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
  kind: 'client_effect',
  traceId: 'trace-shape-1',
  runId: 'run-shape-1',
  agentInvocationId: 'message-shape-1',
  agentId: 'teacher-1',
  depth: 1,
  sequence: 1,
  toolCallId: 'tool-call-shape-1',
  executionId: 'execution-shape-1',
  idempotencyKey: 'run-shape-1:message-shape-1:tool-call-shape-1',
  toolName: 'wb_draw_shape',
  args: shapeArgs,
  argsDigest: 'sha256:shape-args',
  issuedAt: Date.now(),
  deadlineAt: Date.now() + 30_000,
  attempt: 1,
};

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: '王老师',
  role: 'teacher',
  persona: 'Teach clearly with one simple diagram.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_draw_shape'],
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

function shapePostcondition(delivery: ClientEffectDelivery): WhiteboardShapePostcondition {
  if (delivery.request.postcondition.kind !== 'whiteboard_shape_exists') {
    throw new Error('Expected a wb_draw_shape client effect.');
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
  const expected = shapePostcondition(delivery);
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
      elementType: 'shape',
      normalizationVersion: expected.normalizationVersion,
      observedShapeDigest: expected.expectedShapeDigest,
      matchingElementCount: 1,
      shape: expected.shape,
      bounds: expected.bounds,
      fillColor: expected.fillColor,
    },
  });
}

function buildShapeCallAgent(opts: {
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
      if (event.type === 'client_effect') {
        opts.sendClientEffect?.(event.data);
      }
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

describe('Teacher native wb_draw_shape', () => {
  afterEach(() => piClientEffectCoordinator.clearForTests());

  it('does not settle at accepted and returns success only after exact shape commit', async () => {
    let delivery!: ClientEffectDelivery;
    let settled = false;
    const onCommitted = vi.fn();
    const { handler } = buildNativeWhiteboardShapeTool({
      body,
      messageId: 'message-shape-1',
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
        clientEventId: 'shape-accepted',
        status: 'accepted',
        targetBinding: binding,
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledgeCommitted(delivery);
    await expect(resultPromise).resolves.toMatchObject({
      isError: false,
      details: {
        status: 'effect_committed',
        executionId: envelope.executionId,
      },
    });
    expect(onCommitted).toHaveBeenCalledWith(envelope.args);
  });

  it('rejects invalid board bounds before delivery', async () => {
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardShapeTool({
      body,
      messageId: 'message-shape-1',
      send,
    });

    await expect(
      handler({
        request: envelope,
        params: { ...shapeArgs, x: 900, width: 200 },
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_SHAPE_BOUNDS_INVALID' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns verified toolResult to the same Child, then continues in one Teacher bubble', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_shape',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '图形已确认，这个矩形表示函数输入。' }], 'stop'),
            '图形已确认，这个矩形表示函数输入。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我先画一个矩形表示输入区域。' },
                {
                  type: 'toolCall',
                  id: 'shape-call-1',
                  name: 'wb_draw_shape',
                  arguments: {
                    shape: 'rectangle',
                    x: 100,
                    y: 80,
                    width: 280,
                    height: 160,
                    fillColor: '#4477aa',
                  },
                },
              ],
              'toolUse',
            ),
            '我先画一个矩形表示输入区域。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildShapeCallAgent({
      streamFn,
      events,
      onActionDone,
      sendClientEffect: acknowledgeCommitted,
    });

    const result = await callAgent.execute('director-shape-call-1', {
      agentId: teacher.id,
      instruction: 'Draw one rectangle and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain(
      'Whiteboard shape was rendered and its postcondition was verified.',
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
        actionName: 'wb_draw_shape',
        agentId: teacher.id,
        params: expect.objectContaining({ shape: 'rectangle' }),
      }),
    );
    expect(result.details).toMatchObject({
      text: '我先画一个矩形表示输入区域。图形已确认，这个矩形表示函数输入。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { kind: 'client_effect', toolName: 'wb_draw_shape' },
            status: 'succeeded',
            isError: false,
          },
        ],
      },
    });
  });

  it('returns an explicit failed toolResult and lets the same Child explain the failure', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_shape',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '图形没有执行成功，我改用口头说明。' }], 'stop'),
            '图形没有执行成功，我改用口头说明。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我尝试画一个矩形。' },
                {
                  type: 'toolCall',
                  id: 'shape-failed-call',
                  name: 'wb_draw_shape',
                  arguments: {
                    shape: 'rectangle',
                    x: 100,
                    y: 80,
                    width: 280,
                    height: 160,
                  },
                },
              ],
              'toolUse',
            ),
            '我尝试画一个矩形。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const callAgent = buildShapeCallAgent({
      streamFn,
      events,
      sendClientEffect: (delivery) => {
        const binding = targetBinding(delivery);
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'shape-failed-accepted',
            status: 'accepted',
            targetBinding: binding,
          },
        );
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'shape-failed',
            status: 'effect_failed',
            error: {
              code: 'BROWSER_MUTATION_FAILED',
              message: 'The browser rejected the shape mutation.',
              retryable: false,
            },
          },
        );
      },
    });

    const result = await callAgent.execute('director-shape-call-failed', {
      agentId: teacher.id,
      instruction: 'Draw one rectangle and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain('The browser rejected the shape mutation.');
    expect(result.details).toMatchObject({
      text: '我尝试画一个矩形。图形没有执行成功，我改用口头说明。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { toolName: 'wb_draw_shape' },
            status: 'execution_failed',
            isError: true,
          },
        ],
      },
    });
  });
});
