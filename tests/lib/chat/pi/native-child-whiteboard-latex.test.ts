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
  WhiteboardLatexPostcondition,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ClientEffectExecutionRequest,
} from '@/lib/agent/runtime/native-child-contract';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildNativeWhiteboardLatexTool } from '@/lib/chat/pi/tools/native-whiteboard';
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

const latexArgs = {
  latex: String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`,
  x: 120,
  y: 80,
  width: 500,
  height: 100,
  color: '#2244aa',
};

const envelope: ClientEffectExecutionRequest = {
  protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
  kind: 'client_effect',
  traceId: 'trace-latex-1',
  runId: 'run-latex-1',
  agentInvocationId: 'message-latex-1',
  agentId: 'teacher-1',
  depth: 1,
  sequence: 1,
  toolCallId: 'tool-call-latex-1',
  executionId: 'execution-latex-1',
  idempotencyKey: 'run-latex-1:message-latex-1:tool-call-latex-1',
  toolName: 'wb_draw_latex',
  args: latexArgs,
  argsDigest: 'sha256:latex-args',
  issuedAt: Date.now(),
  deadlineAt: Date.now() + 30_000,
  attempt: 1,
};

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: '王老师',
  role: 'teacher',
  persona: 'Teach clearly with one formula.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_draw_latex'],
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

function latexPostcondition(delivery: ClientEffectDelivery): WhiteboardLatexPostcondition {
  if (delivery.request.postcondition.kind !== 'whiteboard_latex_exists') {
    throw new Error('Expected a wb_draw_latex client effect.');
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
  const expected = latexPostcondition(delivery);
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
      elementType: 'latex',
      normalizationVersion: expected.normalizationVersion,
      observedFormulaDigest: expected.expectedFormulaDigest,
      observedHtmlDigest: expected.expectedHtmlDigest,
      matchingElementCount: 1,
      latex: expected.latex,
      bounds: expected.bounds,
      color: expected.color,
      renderVersion: expected.renderVersion,
    },
  });
}

function buildLatexCallAgent(opts: {
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

describe('Teacher native wb_draw_latex', () => {
  afterEach(() => piClientEffectCoordinator.clearForTests());

  it('does not settle at accepted and succeeds only after exact formula state commits', async () => {
    let delivery!: ClientEffectDelivery;
    let settled = false;
    const onCommitted = vi.fn();
    const { handler } = buildNativeWhiteboardLatexTool({
      body,
      messageId: 'message-latex-1',
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
        clientEventId: 'latex-accepted',
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

  it('rejects malformed, escaped-control, and out-of-board formulas before delivery', async () => {
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardLatexTool({
      body,
      messageId: 'message-latex-1',
      send,
    });

    await expect(
      handler({ request: envelope, params: { ...latexArgs, latex: String.raw`\frac{a}{` } }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_LATEX_RENDER_INVALID' },
    });
    await expect(
      handler({ request: envelope, params: { ...latexArgs, latex: '\text{x}' } }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_LATEX_INPUT_INVALID' },
    });
    await expect(
      handler({ request: envelope, params: { ...latexArgs, x: 900, width: 200 } }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_LATEX_BOUNDS_INVALID' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns verified toolResult to the same Child and continues in one Teacher bubble', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_latex',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '公式已确认，分母的二次项系数不能为零。' }], 'stop'),
            '公式已确认，分母的二次项系数不能为零。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我先把求根公式写在白板上。' },
                {
                  type: 'toolCall',
                  id: 'latex-call-1',
                  name: 'wb_draw_latex',
                  arguments: latexArgs,
                },
              ],
              'toolUse',
            ),
            '我先把求根公式写在白板上。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildLatexCallAgent({
      streamFn,
      events,
      onActionDone,
      sendClientEffect: acknowledgeCommitted,
    });

    const result = await callAgent.execute('director-latex-call-1', {
      agentId: teacher.id,
      instruction: 'Write the quadratic formula and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain(
      'Whiteboard formula was rendered and its postcondition was verified.',
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
        actionName: 'wb_draw_latex',
        agentId: teacher.id,
        params: expect.objectContaining({ latex: latexArgs.latex }),
      }),
    );
    expect(result.details).toMatchObject({
      text: '我先把求根公式写在白板上。公式已确认，分母的二次项系数不能为零。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { kind: 'client_effect', toolName: 'wb_draw_latex' },
            status: 'succeeded',
            isError: false,
          },
        ],
      },
    });
  });

  it('returns an explicit browser failure and lets the same Child recover verbally', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_latex',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '公式没有成功显示，我改用口头说明。' }], 'stop'),
            '公式没有成功显示，我改用口头说明。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我尝试把公式写到白板上。' },
                {
                  type: 'toolCall',
                  id: 'latex-failed-call',
                  name: 'wb_draw_latex',
                  arguments: latexArgs,
                },
              ],
              'toolUse',
            ),
            '我尝试把公式写到白板上。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const callAgent = buildLatexCallAgent({
      streamFn,
      events,
      sendClientEffect: (delivery) => {
        const binding = targetBinding(delivery);
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'latex-failed-accepted',
            status: 'accepted',
            targetBinding: binding,
          },
        );
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'latex-failed',
            status: 'effect_failed',
            error: {
              code: 'BROWSER_MUTATION_FAILED',
              message: 'The browser rejected the formula mutation.',
              retryable: false,
            },
          },
        );
      },
    });

    const result = await callAgent.execute('director-latex-call-failed', {
      agentId: teacher.id,
      instruction: 'Write the quadratic formula and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain('The browser rejected the formula mutation.');
    expect(result.details).toMatchObject({
      text: '我尝试把公式写到白板上。公式没有成功显示，我改用口头说明。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { toolName: 'wb_draw_latex' },
            status: 'execution_failed',
            isError: true,
          },
        ],
      },
    });
  });
});
