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
  WhiteboardChartPostcondition,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ClientEffectExecutionRequest,
} from '@/lib/agent/runtime/native-child-contract';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildNativeWhiteboardChartTool } from '@/lib/chat/pi/tools/native-whiteboard';
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

const chartArgs = {
  chartType: 'line' as const,
  x: 80,
  y: 60,
  width: 600,
  height: 300,
  data: {
    labels: ['一月', '二月'],
    legends: ['甲', '乙'],
    series: [
      [1, 2],
      [3, 4],
    ],
  },
  themeColors: ['#4472c4', '#ed7d31'],
};

const envelope: ClientEffectExecutionRequest = {
  protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
  kind: 'client_effect',
  traceId: 'trace-chart-1',
  runId: 'run-chart-1',
  agentInvocationId: 'message-chart-1',
  agentId: 'teacher-1',
  depth: 1,
  sequence: 1,
  toolCallId: 'tool-call-chart-1',
  executionId: 'execution-chart-1',
  idempotencyKey: 'run-chart-1:message-chart-1:tool-call-chart-1',
  toolName: 'wb_draw_chart',
  args: chartArgs,
  argsDigest: 'sha256:chart-args',
  issuedAt: Date.now(),
  deadlineAt: Date.now() + 30_000,
  attempt: 1,
};

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: '王老师',
  role: 'teacher',
  persona: 'Teach clearly with one concise chart.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_draw_chart'],
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

function chartPostcondition(delivery: ClientEffectDelivery): WhiteboardChartPostcondition {
  if (delivery.request.postcondition.kind !== 'whiteboard_chart_exists') {
    throw new Error('Expected a wb_draw_chart client effect.');
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
  const expected = chartPostcondition(delivery);
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
      elementType: 'chart',
      normalizationVersion: expected.normalizationVersion,
      observedChartDigest: expected.expectedChartDigest,
      matchingElementCount: 1,
    },
  });
}

function buildChartCallAgent(opts: {
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
    enableNativeChildWhiteboard: true,
    nativeChildStreamFn: opts.streamFn,
    nativeChildTimeoutMs: 5_000,
  });
}

describe('Teacher native wb_draw_chart', () => {
  afterEach(() => piClientEffectCoordinator.clearForTests());

  it('does not settle at accepted and succeeds only after the exact chart digest commits', async () => {
    let delivery!: ClientEffectDelivery;
    let settled = false;
    const onCommitted = vi.fn();
    const { handler } = buildNativeWhiteboardChartTool({
      body,
      messageId: 'message-chart-1',
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
        clientEventId: 'chart-accepted',
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

  it('rejects malformed chart dimensions before browser delivery', async () => {
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardChartTool({
      body,
      messageId: 'message-chart-1',
      send,
    });

    await expect(
      handler({
        request: envelope,
        params: {
          ...chartArgs,
          data: { labels: ['A'], legends: ['甲', '乙'], series: [[1]] },
        },
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_CHART_DIMENSIONS_INVALID' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the verified toolResult to the same Child and records one committed action', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_chart',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '折线图已确认，甲和乙的变化可以直接比较。' }], 'stop'),
            '折线图已确认，甲和乙的变化可以直接比较。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我先画一张折线图比较两组数据。' },
                {
                  type: 'toolCall',
                  id: 'chart-call-1',
                  name: 'wb_draw_chart',
                  arguments: chartArgs,
                },
              ],
              'toolUse',
            ),
            '我先画一张折线图比较两组数据。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildChartCallAgent({
      streamFn,
      events,
      onActionDone,
      sendClientEffect: acknowledgeCommitted,
    });

    const result = await callAgent.execute('director-chart-call-1', {
      agentId: teacher.id,
      instruction: 'Draw one concise comparison chart and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain(
      'Whiteboard chart was committed and its postcondition was verified.',
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
        actionName: 'wb_draw_chart',
        agentId: teacher.id,
        params: expect.objectContaining({ chartType: 'line', data: chartArgs.data }),
      }),
    );
    expect(result.details).toMatchObject({
      text: '我先画一张折线图比较两组数据。折线图已确认，甲和乙的变化可以直接比较。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { kind: 'client_effect', toolName: 'wb_draw_chart' },
            status: 'succeeded',
            isError: false,
          },
        ],
      },
    });
  });

  it('returns a failed toolResult to the same Child without a false action record', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_chart',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '图表没有执行成功，我改用口头比较。' }], 'stop'),
            '图表没有执行成功，我改用口头比较。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我尝试画一张比较图。' },
                {
                  type: 'toolCall',
                  id: 'chart-failed-call',
                  name: 'wb_draw_chart',
                  arguments: chartArgs,
                },
              ],
              'toolUse',
            ),
            '我尝试画一张比较图。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildChartCallAgent({
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
            clientEventId: 'chart-failed-accepted',
            status: 'accepted',
            targetBinding: binding,
          },
        );
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'chart-failed',
            status: 'effect_failed',
            error: {
              code: 'BROWSER_MUTATION_FAILED',
              message: 'The browser rejected the chart mutation.',
              retryable: false,
            },
          },
        );
      },
    });

    const result = await callAgent.execute('director-chart-call-failed', {
      agentId: teacher.id,
      instruction: 'Draw one concise comparison chart and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain('The browser rejected the chart mutation.');
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      text: '我尝试画一张比较图。图表没有执行成功，我改用口头比较。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { toolName: 'wb_draw_chart' },
            status: 'execution_failed',
            isError: true,
          },
        ],
      },
    });
  });
});
