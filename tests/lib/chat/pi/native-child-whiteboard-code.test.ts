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
  WhiteboardCodePostcondition,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ClientEffectExecutionRequest,
} from '@/lib/agent/runtime/native-child-contract';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildNativeWhiteboardCodeTool } from '@/lib/chat/pi/tools/native-whiteboard';
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

const codeArgs = {
  language: 'ts',
  code: 'const k = 2;\r\nconsole.log(k);',
  x: 80,
  y: 60,
  width: 600,
  height: 300,
  fileName: 'example.ts',
};

const envelope: ClientEffectExecutionRequest = {
  protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
  kind: 'client_effect',
  traceId: 'trace-code-1',
  runId: 'run-code-1',
  agentInvocationId: 'message-code-1',
  agentId: 'teacher-1',
  depth: 1,
  sequence: 1,
  toolCallId: 'tool-call-code-1',
  executionId: 'execution-code-1',
  idempotencyKey: 'run-code-1:message-code-1:tool-call-code-1',
  toolName: 'wb_draw_code',
  args: codeArgs,
  argsDigest: 'sha256:code-args',
  issuedAt: Date.now(),
  deadlineAt: Date.now() + 30_000,
  attempt: 1,
};

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: '王老师',
  role: 'teacher',
  persona: 'Teach clearly with one concise code example.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_draw_code'],
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

function codePostcondition(delivery: ClientEffectDelivery): WhiteboardCodePostcondition {
  if (delivery.request.postcondition.kind !== 'whiteboard_code_exists') {
    throw new Error('Expected a wb_draw_code client effect.');
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
  const expected = codePostcondition(delivery);
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
      elementType: 'code',
      normalizationVersion: expected.normalizationVersion,
      observedCodeDigest: expected.expectedCodeDigest,
      matchingElementCount: 1,
    },
  });
}

function buildCodeCallAgent(opts: {
  streamFn: StreamFn;
  events: StatelessEvent[];
  childRuntimeMode?: 'legacy' | 'native';
  agent?: AgentConfig;
  languageModel?: LanguageModel;
  onActionDone?: (record?: WhiteboardActionRecord) => void;
  sendClientEffect?: (delivery: ClientEffectDelivery) => void;
}) {
  const selectedAgent = opts.agent ?? teacher;
  return buildCallAgentTool({
    body,
    agentConfigs: [selectedAgent],
    send: async (event) => {
      opts.events.push(event);
      if (event.type === 'client_effect') opts.sendClientEffect?.(event.data);
    },
    languageModel: opts.languageModel ?? ({} as LanguageModel),
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
    childRuntimeMode: opts.childRuntimeMode ?? 'native',
    enableNativeChildWhiteboard: true,
    nativeChildStreamFn: opts.streamFn,
    nativeChildTimeoutMs: 5_000,
  });
}

describe('Teacher native wb_draw_code', () => {
  afterEach(() => piClientEffectCoordinator.clearForTests());

  it('does not settle at accepted and commits normalized IDs only after the exact digest', async () => {
    let delivery!: ClientEffectDelivery;
    let settled = false;
    const onCommitted = vi.fn();
    const { handler } = buildNativeWhiteboardCodeTool({
      body,
      messageId: 'message-code-1',
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
        clientEventId: 'code-accepted',
        status: 'accepted',
        targetBinding: binding,
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledgeCommitted(delivery);
    await expect(resultPromise).resolves.toMatchObject({
      isError: false,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('stable line IDs are L1 through L2'),
        },
      ],
      details: {
        status: 'effect_committed',
        executionId: envelope.executionId,
        stableElementId: `client-effect-${envelope.executionId}`,
        lineIds: ['L1', 'L2'],
      },
    });
    expect(onCommitted).toHaveBeenCalledWith({
      language: 'typescript',
      code: 'const k = 2;\nconsole.log(k);',
      x: 80,
      y: 60,
      width: 600,
      height: 300,
      fileName: 'example.ts',
      elementId: `client-effect-${envelope.executionId}`,
      lineIds: ['L1', 'L2'],
    });
  });

  it('rejects malformed code before browser delivery', async () => {
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardCodeTool({
      body,
      messageId: 'message-code-1',
      send,
    });

    await expect(
      handler({
        request: envelope,
        params: { ...codeArgs, code: 'bad\u0000code' },
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_CODE_CONTENT_INVALID' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the verified IDs to the same Child and records one trusted committed action', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_code',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '代码已经写好，k 的值会被打印出来。' }], 'stop'),
            '代码已经写好，k 的值会被打印出来。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我先写一段最小代码。' },
                {
                  type: 'toolCall',
                  id: 'code-call',
                  name: 'wb_draw_code',
                  arguments: codeArgs,
                },
              ],
              'toolUse',
            ),
            '我先写一段最小代码。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildCodeCallAgent({
      streamFn,
      events,
      onActionDone,
      sendClientEffect: acknowledgeCommitted,
    });

    const result = await callAgent.execute('director-code-call-1', {
      agentId: teacher.id,
      instruction: 'Draw one concise code example and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain('stable line IDs are L1 through L2');
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
        actionName: 'wb_draw_code',
        agentId: teacher.id,
        params: expect.objectContaining({
          language: 'typescript',
          code: 'const k = 2;\nconsole.log(k);',
          elementId: expect.stringMatching(/^client-effect-/),
          lineIds: ['L1', 'L2'],
        }),
      }),
    );
    expect(result.details).toMatchObject({
      text: '我先写一段最小代码。代码已经写好，k 的值会被打印出来。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { kind: 'client_effect', toolName: 'wb_draw_code' },
            status: 'succeeded',
            isError: false,
            details: { lineIds: ['L1', 'L2'] },
          },
        ],
      },
    });
  });

  it('returns browser failure to the same Child without a false action record', async () => {
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_draw_code',
      );
      return result
        ? streamed(
            message([{ type: 'text', text: '代码块没有执行成功，我改用口头说明。' }], 'stop'),
            '代码块没有执行成功，我改用口头说明。',
          )
        : streamed(
            message(
              [
                { type: 'text', text: '我尝试写一段代码。' },
                {
                  type: 'toolCall',
                  id: 'code-failed-call',
                  name: 'wb_draw_code',
                  arguments: codeArgs,
                },
              ],
              'toolUse',
            ),
            '我尝试写一段代码。',
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildCodeCallAgent({
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
            clientEventId: 'code-failed-accepted',
            status: 'accepted',
            targetBinding: binding,
          },
        );
        piClientEffectCoordinator.acknowledge(
          delivery.request.executionId,
          delivery.acknowledgementToken,
          {
            ...ackBase(delivery),
            clientEventId: 'code-failed',
            status: 'effect_failed',
            error: {
              code: 'BROWSER_MUTATION_FAILED',
              message: 'The browser rejected the code mutation.',
              retryable: false,
            },
          },
        );
      },
    });

    const result = await callAgent.execute('director-code-call-failed', {
      agentId: teacher.id,
      instruction: 'Draw one concise code example and explain it.',
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1])).toContain('The browser rejected the code mutation.');
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [
          {
            request: { toolName: 'wb_draw_code' },
            status: 'execution_failed',
            isError: true,
          },
        ],
      },
    });
  });

  it('keeps explicit Native mode when the allowlist also declares an unmigrated edit tool', async () => {
    const mixedCodeTeacher: AgentConfig = {
      ...teacher,
      allowedActions: ['wb_draw_code', 'wb_edit_code'],
    };
    const nativeStreamFn = vi.fn((() =>
      streamed(
        message([{ type: 'text', text: 'Native draw remains available.' }], 'stop'),
      )) as StreamFn);
    const events: StatelessEvent[] = [];
    const callAgent = buildCodeCallAgent({
      streamFn: nativeStreamFn as StreamFn,
      events,
      agent: mixedCodeTeacher,
    });

    const result = await callAgent.execute('director-code-edit-call', {
      agentId: mixedCodeTeacher.id,
      instruction: 'Explain the code example.',
    });

    expect(nativeStreamFn).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'client_effect')).toBe(false);
    expect(result.details).toMatchObject({
      agentId: mixedCodeTeacher.id,
      text: 'Native draw remains available.',
      runtimeMode: 'native',
      availableToolNames: ['wb_draw_code'],
      unavailableAllowedToolNames: ['wb_edit_code'],
      nativeChildRun: {
        status: 'completed',
      },
    });
  });
});
