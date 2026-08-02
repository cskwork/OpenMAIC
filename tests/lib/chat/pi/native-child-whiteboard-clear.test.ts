import { afterEach, describe, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
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
  CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
  CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
  CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
  isClientEffectAck,
  type ClientEffectAck,
  type ClientEffectDelivery,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ClientEffectExecutionRequest,
} from '@/lib/agent/runtime/native-child-contract';
import { buildNativeWhiteboardClearTool } from '@/lib/chat/pi/tools/native-whiteboard';
import { NativeWhiteboardCodeState } from '@/lib/chat/pi/tools/native-whiteboard-code-state';
import { NativeWhiteboardViewState } from '@/lib/chat/pi/tools/native-whiteboard-view-state';
import { buildCallAgentTool, resolveNativeChildCapabilities } from '@/lib/chat/pi/tools/call-agent';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessEvent } from '@/lib/types/chat';

function makeBody(elements: Array<Record<string, unknown>>): StatelessChatRequest {
  return {
    messages: [],
    storeState: {
      stage: {
        id: 'stage-1',
        name: 'Course',
        whiteboard: [{ id: 'whiteboard-1', elements }],
      },
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
}

function createBrowserStore(elements = [structuredClone(textElement)]): StageStore {
  let state = {
    stage: {
      id: 'stage-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [
        {
          id: 'whiteboard-1',
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          background: { type: 'solid' as const, color: '#fff' },
          animations: [],
          elements,
        },
      ],
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

const textElement = {
  id: 'text-1',
  type: 'text',
  content: '<p>old</p>',
  left: 0,
  top: 0,
  width: 100,
  height: 50,
  rotate: 0,
};

const envelope: ClientEffectExecutionRequest = {
  protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
  kind: 'client_effect',
  traceId: 'trace-clear',
  runId: 'run-clear',
  agentInvocationId: 'message-1',
  agentId: 'teacher-1',
  depth: 1,
  sequence: 1,
  toolCallId: 'tool-clear',
  executionId: 'execution-clear',
  idempotencyKey: 'run-clear:message-1:tool-clear',
  toolName: 'wb_clear',
  args: {},
  argsDigest: 'sha256:clear',
  issuedAt: Date.now(),
  deadlineAt: Date.now() + 30_000,
  attempt: 1,
};

function acknowledge(delivery: ClientEffectDelivery, ack: ClientEffectAck): void {
  expect(
    piClientEffectCoordinator.acknowledge(
      delivery.request.executionId,
      delivery.acknowledgementToken,
      ack,
    ).kind,
  ).toBe('applied');
}

function ackBase(delivery: ClientEffectDelivery) {
  return {
    protocolVersion: 'maic.tool-execution.v1' as const,
    executionId: delivery.request.executionId,
    idempotencyKey: delivery.request.idempotencyKey,
    observedAt: Date.now(),
  };
}

afterEach(() => piClientEffectCoordinator.clearForTests());

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
) {
  return {
    role: 'assistant' as const,
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

describe('native wb_clear tool', () => {
  it('uses strict empty parameters and the explicit Teacher capability filter', () => {
    const body = makeBody([textElement]);
    const { tool } = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-1',
      send: vi.fn(),
      viewState: new NativeWhiteboardViewState(body),
      codeState: new NativeWhiteboardCodeState(body),
    });
    expect(Value.Check(tool.parameters, {})).toBe(true);
    expect(Value.Check(tool.parameters, { extra: true })).toBe(false);
    expect(
      resolveNativeChildCapabilities({
        agent: { role: 'teacher', allowedActions: ['wb_clear'] },
        enableNativeChildWhiteboard: true,
        enableWhiteboardTools: true,
        maxActionsPerAgent: 1,
      }),
    ).toMatchObject({ nativeWhiteboardToolNames: ['wb_clear'] });
  });

  it('uses real Pi validation to reject extra wb_clear arguments before client delivery', async () => {
    const body = makeBody([textElement]);
    const teacher: AgentConfig = {
      id: 'teacher-1',
      name: '王老师',
      role: 'teacher',
      persona: 'Teach clearly.',
      avatar: '',
      color: '#36f',
      allowedActions: ['wb_clear'],
      priority: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      isDefault: true,
    };
    const contexts: Context[] = [];
    const events: StatelessEvent[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      return contexts.length === 1
        ? streamed(
            assistant(
              [
                {
                  type: 'toolCall',
                  id: 'clear-invalid',
                  name: 'wb_clear',
                  arguments: { extra: 1 },
                },
              ],
              'toolUse',
            ),
          )
        : streamed(
            assistant([{ type: 'text', text: '清板参数不合法，我不会声称白板已清空。' }], 'stop'),
          );
    }) as StreamFn;
    const onAgentDone = vi.fn();
    const onActionDone = vi.fn();
    const callAgent = buildCallAgentTool({
      body,
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
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

    const result = await callAgent.execute('director-clear-invalid', {
      agentId: teacher.id,
      instruction: 'Clear unrelated old work.',
    });

    expect(contexts).toHaveLength(2);
    const toolResult = contexts[1].messages.find(
      (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_clear',
    );
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      toolName: 'wb_clear',
      isError: true,
    });
    expect(JSON.stringify(toolResult)).toContain('extra');
    expect(events.some((event) => event.type === 'client_effect')).toBe(false);
    expect(onActionDone).not.toHaveBeenCalled();
    expect(onAgentDone).toHaveBeenCalledWith(
      expect.objectContaining({ actionCount: 0, whiteboardActions: [] }),
    );
    expect(result.details).toMatchObject({
      text: '清板参数不合法，我不会声称白板已清空。',
      nativeChildRun: { status: 'completed' },
    });
  });

  it('does not promote a stale absent snapshot to authoritative empty membership', () => {
    const body = makeBody([]);
    body.storeState.stage!.whiteboard = [];
    const binding = {
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      whiteboardId: 'existing-board',
      bindingVersion: 1,
    };

    const openState = new NativeWhiteboardViewState(body);
    openState.commitOpen(binding, {
      kind: 'whiteboard_open',
      normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
      whiteboardId: binding.whiteboardId,
      desiredOpen: true,
      observedOpen: true,
      created: false,
      visibilityChanged: true,
    });
    expect(openState.getClearAuthority()).toMatchObject({
      status: 'trusted_present',
      whiteboardId: 'existing-board',
      membershipComplete: false,
      elements: [],
    });

    const createdState = new NativeWhiteboardViewState(body);
    createdState.commitOpen(binding, {
      kind: 'whiteboard_open',
      normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
      whiteboardId: binding.whiteboardId,
      desiredOpen: true,
      observedOpen: true,
      created: true,
      visibilityChanged: true,
    });
    expect(createdState.getClearAuthority()).toMatchObject({
      status: 'trusted_present',
      whiteboardId: 'existing-board',
      membershipComplete: true,
      elements: [],
    });

    const drawState = new NativeWhiteboardViewState(body);
    drawState.commitElement(binding, 'new-text', 'text');
    expect(drawState.getClearAuthority()).toMatchObject({
      status: 'trusted_present',
      whiteboardId: 'existing-board',
      membershipComplete: false,
      elements: [{ id: 'new-text', type: 'text' }],
    });
  });

  it('rejects a closed non-empty clear when the open lifecycle budget is unavailable', async () => {
    const body = makeBody([textElement]);
    body.storeState.whiteboardOpen = false;
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-budget',
      send,
      viewState: new NativeWhiteboardViewState(body),
      codeState: new NativeWhiteboardCodeState(body),
      now: () => 1_000,
    });

    await expect(
      handler({
        request: { ...envelope, executionId: 'clear-low-budget', deadlineAt: 4_000 },
        params: {},
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_DEADLINE_EXHAUSTED' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a trusted absent whiteboard as a direct no-effect success', async () => {
    const body = makeBody([]);
    body.storeState.stage!.whiteboard = [];
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-absent',
      send,
      viewState: new NativeWhiteboardViewState(body),
      codeState: new NativeWhiteboardCodeState(body),
      canExecute: () => false,
    });
    await expect(handler({ request: envelope, params: {} })).resolves.toMatchObject({
      isError: false,
      details: { reason: 'whiteboard_absent', cleared: false, actionChanged: false },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns verified clear toolResult to the same Child and keeps one classroom bubble', async () => {
    const body = makeBody([textElement]);
    const teacher: AgentConfig = {
      id: 'teacher-1',
      name: '王老师',
      role: 'teacher',
      persona: 'Teach clearly.',
      avatar: '',
      color: '#36f',
      allowedActions: ['wb_clear'],
      priority: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      isDefault: true,
    };
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      const result = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_clear',
      );
      return result
        ? streamed(
            assistant([{ type: 'text', text: '旧内容已清空，我们继续当前主题。' }], 'stop'),
            '旧内容已清空，我们继续当前主题。',
          )
        : streamed(
            assistant(
              [{ type: 'toolCall', id: 'clear-call', name: 'wb_clear', arguments: {} }],
              'toolUse',
            ),
          );
    }) as StreamFn;
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const callAgent = buildCallAgentTool({
      body,
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
        if (event.type !== 'client_effect' || !event.data) return;
        const delivery = event.data;
        if (delivery.request.postcondition.kind !== 'whiteboard_empty') throw new Error('wrong');
        const binding = {
          ...delivery.request.target,
          whiteboardId: 'whiteboard-1',
          bindingVersion: 1,
        };
        acknowledge(delivery, {
          ...ackBase(delivery),
          clientEventId: 'call-accepted',
          status: 'accepted',
          targetBinding: binding,
        });
        acknowledge(delivery, {
          ...ackBase(delivery),
          clientEventId: 'call-committed',
          status: 'effect_committed',
          targetBinding: binding,
          postcondition: {
            kind: 'whiteboard_empty',
            normalizationVersion: 'maic.whiteboard-clear.v1',
            membershipNormalizationVersion: 'maic.whiteboard-membership.v1',
            boardContentNormalizationVersion: 'maic.whiteboard-content.v1',
            whiteboardId: 'whiteboard-1',
            cleared: true,
            elementCountBefore: 1,
            elementCountAfter: 0,
            observedMembershipDigestBefore: delivery.request.postcondition.expectedMembershipDigest,
            boardContentDigestAtAccepted: 'sha256:content',
            boardContentDigestBeforeMutation: 'sha256:content',
            observedBoardContentDigestAfter: CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
            historySnapshotDigest: 'sha256:content',
            observedOpen: true,
            visibilityChanged: false,
          },
        });
      },
      languageModel: {} as LanguageModel,
      onAgentDone: vi.fn(),
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
    const result = await callAgent.execute('director-clear', {
      agentId: 'teacher-1',
      instruction: 'Clear unrelated old work, then continue.',
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'toolResult', toolName: 'wb_clear', isError: false }),
      ]),
    );
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(onActionDone).toHaveBeenCalledWith(expect.objectContaining({ actionName: 'wb_clear' }));
    expect(result.details).toMatchObject({ nativeChildRun: { status: 'completed' } });
  });

  it('runs Browser mutation and validated ACK through to the same Child continuation', async () => {
    const body = makeBody([textElement]);
    const teacher: AgentConfig = {
      id: 'teacher-1',
      name: '王老师',
      role: 'teacher',
      persona: 'Teach clearly.',
      avatar: '',
      color: '#36f',
      allowedActions: ['wb_clear'],
      priority: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      isDefault: true,
    };
    const store = createBrowserStore();
    const contexts: Context[] = [];
    const events: StatelessEvent[] = [];
    const acknowledgements: ClientEffectAck[] = [];
    const capabilityTokens = new Map<string, string>();
    const pushExact = vi.fn((_elements, digest: string) => ({
      snapshotIndex: 0,
      boardContentDigest: digest,
      inserted: true,
    }));
    const browserRuntime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => true,
      ensureWhiteboardVisible: async () => {},
      setWhiteboardClearing: () => {},
      pushExactWhiteboardSnapshot: pushExact,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as unknown;
        if (!isClientEffectAck(ack)) {
          return new Response(JSON.stringify({ success: false, error: 'invalid ACK' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        acknowledgements.push(ack);
        const capabilityToken = capabilityTokens.get(ack.executionId);
        if (!capabilityToken) throw new Error('Missing test capability token.');
        const outcome = piClientEffectCoordinator.acknowledge(
          ack.executionId,
          capabilityToken,
          ack,
        );
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
      const clearResult = context.messages.find(
        (entry) => entry.role === 'toolResult' && entry.toolName === 'wb_clear',
      );
      return clearResult
        ? streamed(
            assistant([{ type: 'text', text: '白板已经真实清空，我继续解释。' }], 'stop'),
            '白板已经真实清空，我继续解释。',
          )
        : streamed(
            assistant(
              [{ type: 'toolCall', id: 'clear-browser-call', name: 'wb_clear', arguments: {} }],
              'toolUse',
            ),
          );
    }) as StreamFn;
    const onActionDone = vi.fn();
    const callAgent = buildCallAgentTool({
      body,
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
        if (event.type !== 'client_effect') return;
        capabilityTokens.set(event.data.request.executionId, event.data.acknowledgementToken);
        await browserRuntime.execute(event.data, new AbortController().signal);
      },
      languageModel: {} as LanguageModel,
      onAgentDone: vi.fn(),
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

    const result = await callAgent.execute('director-browser-clear', {
      agentId: teacher.id,
      instruction: 'Clear unrelated old work, then continue.',
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'toolResult', toolName: 'wb_clear', isError: false }),
      ]),
    );
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    expect(acknowledgements.every((ack) => isClientEffectAck(ack))).toBe(true);
    expect(store.getState().stage?.whiteboard?.at(-1)?.elements).toEqual([]);
    expect(pushExact).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(onActionDone).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      text: '白板已经真实清空，我继续解释。',
      nativeChildRun: {
        status: 'completed',
        toolExecutions: [{ request: { toolName: 'wb_clear' }, status: 'succeeded' }],
      },
    });
  });

  it('commits a verified real clear, clears targeting state, and reports actionChanged', async () => {
    const body = makeBody([textElement]);
    const codeState = new NativeWhiteboardCodeState(body);
    const viewState = new NativeWhiteboardViewState(body, (id) => codeState.commitBinding(id));
    const send = vi.fn(async (event: { type: string; data?: ClientEffectDelivery }) => {
      if (event.type !== 'client_effect' || !event.data) return;
      const delivery = event.data;
      if (delivery.request.postcondition.kind !== 'whiteboard_empty') throw new Error('wrong');
      const binding = {
        ...delivery.request.target,
        whiteboardId: 'whiteboard-1',
        bindingVersion: 1,
      };
      acknowledge(delivery, {
        ...ackBase(delivery),
        clientEventId: 'accepted',
        status: 'accepted',
        targetBinding: binding,
      });
      acknowledge(delivery, {
        ...ackBase(delivery),
        clientEventId: 'committed',
        status: 'effect_committed',
        targetBinding: binding,
        postcondition: {
          kind: 'whiteboard_empty',
          normalizationVersion: 'maic.whiteboard-clear.v1',
          membershipNormalizationVersion: 'maic.whiteboard-membership.v1',
          boardContentNormalizationVersion: 'maic.whiteboard-content.v1',
          whiteboardId: 'whiteboard-1',
          cleared: true,
          elementCountBefore: 1,
          elementCountAfter: 0,
          observedMembershipDigestBefore: delivery.request.postcondition.expectedMembershipDigest,
          boardContentDigestAtAccepted: 'sha256:content',
          boardContentDigestBeforeMutation: 'sha256:content',
          observedBoardContentDigestAfter: CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
          historySnapshotDigest: 'sha256:content',
          observedOpen: true,
          visibilityChanged: false,
        },
      });
    });
    const onCommitted = vi.fn();
    const { handler } = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-1',
      send: send as never,
      viewState,
      codeState,
      onCommittedWithTerminal: onCommitted,
    });

    const result = await handler({ request: envelope, params: {} });
    expect(result).toMatchObject({
      isError: false,
      details: { cleared: true, actionChanged: true, elementCountBefore: 1, elementCountAfter: 0 },
    });
    expect(viewState.getClearAuthority()).toMatchObject({
      status: 'trusted_present',
      membershipComplete: true,
      elements: [],
    });
    expect(viewState.shouldSuppressRequestStartSnapshot()).toBe(true);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('allows a verified empty no-op above action budget without counting an action', async () => {
    const body = makeBody([]);
    const codeState = new NativeWhiteboardCodeState(body);
    const viewState = new NativeWhiteboardViewState(body);
    const send = vi.fn(async (event: { type: string; data?: ClientEffectDelivery }) => {
      if (event.type !== 'client_effect' || !event.data) return;
      const delivery = event.data;
      const binding = {
        ...delivery.request.target,
        whiteboardId: 'whiteboard-1',
        bindingVersion: 1,
      };
      acknowledge(delivery, {
        ...ackBase(delivery),
        clientEventId: 'accepted-empty',
        status: 'accepted',
        targetBinding: binding,
      });
      acknowledge(delivery, {
        ...ackBase(delivery),
        clientEventId: 'committed-empty',
        status: 'effect_committed',
        targetBinding: binding,
        postcondition: {
          kind: 'whiteboard_empty',
          normalizationVersion: 'maic.whiteboard-clear.v1',
          membershipNormalizationVersion: 'maic.whiteboard-membership.v1',
          boardContentNormalizationVersion: 'maic.whiteboard-content.v1',
          whiteboardId: 'whiteboard-1',
          cleared: false,
          elementCountBefore: 0,
          elementCountAfter: 0,
          observedMembershipDigestBefore: CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
          verifiedEmptyBoardContentDigest: CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
          observedOpen: true,
          visibilityChanged: false,
        },
      });
    });
    const { handler } = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-1',
      send: send as never,
      viewState,
      codeState,
      canExecute: () => false,
    });
    const result = await handler({ request: envelope, params: {} });
    expect(result).toMatchObject({
      isError: false,
      details: { cleared: false, actionChanged: false },
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects incomplete membership before delivery and action accounting', async () => {
    const body = makeBody([{ ...textElement, id: 'bad\nidentifier' }]);
    const codeState = new NativeWhiteboardCodeState(body);
    const send = vi.fn();
    const { handler } = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-1',
      send,
      viewState: new NativeWhiteboardViewState(body),
      codeState,
    });
    await expect(handler({ request: envelope, params: {} })).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_CLEAR_MEMBERSHIP_UNTRUSTED' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns structured RESOURCE_BUSY for a concurrent clear owner', async () => {
    const body = makeBody([textElement]);
    let firstDelivery!: ClientEffectDelivery;
    const first = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-first',
      send: async (event) => {
        if (event.type !== 'client_effect' || !event.data) return;
        firstDelivery = event.data;
        const binding = {
          ...event.data.request.target,
          whiteboardId: 'whiteboard-1',
          bindingVersion: 1,
        };
        acknowledge(event.data, {
          ...ackBase(event.data),
          clientEventId: 'busy-accepted',
          status: 'accepted',
          targetBinding: binding,
        });
      },
      viewState: new NativeWhiteboardViewState(body),
      codeState: new NativeWhiteboardCodeState(body),
    });
    const firstResult = first.handler({ request: envelope, params: {} });
    await vi.waitFor(() => expect(firstDelivery).toBeDefined());

    const secondSend = vi.fn();
    const second = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-second',
      send: secondSend,
      viewState: new NativeWhiteboardViewState(body),
      codeState: new NativeWhiteboardCodeState(body),
    });
    await expect(
      second.handler({
        request: {
          ...envelope,
          executionId: 'execution-clear-second',
          toolCallId: 'tool-clear-second',
          idempotencyKey: 'run-clear:message-2:tool-clear-second',
        },
        params: {},
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: 'CLIENT_EFFECT_RESOURCE_BUSY', retryable: true },
    });
    expect(secondSend).not.toHaveBeenCalled();
    piClientEffectCoordinator.cancel(
      firstDelivery.request.executionId,
      'TEST_CANCEL',
      'finish test',
    );
    await expect(firstResult).resolves.toMatchObject({ isError: true });
  });

  it('invalidates stale targeting authority after an accepted clear fails', async () => {
    const body = makeBody([textElement]);
    const codeState = new NativeWhiteboardCodeState(body);
    const viewState = new NativeWhiteboardViewState(body, (id) => codeState.commitBinding(id));
    const { handler } = buildNativeWhiteboardClearTool({
      body,
      messageId: 'message-failed',
      viewState,
      codeState,
      send: async (event) => {
        if (event.type !== 'client_effect' || !event.data) return;
        const binding = {
          ...event.data.request.target,
          whiteboardId: 'whiteboard-1',
          bindingVersion: 1,
        };
        acknowledge(event.data, {
          ...ackBase(event.data),
          clientEventId: 'failed-accepted',
          status: 'accepted',
          targetBinding: binding,
        });
        acknowledge(event.data, {
          ...ackBase(event.data),
          clientEventId: 'failed-terminal',
          status: 'effect_failed',
          error: {
            code: 'CLIENT_EFFECT_CLEAR_CONTENT_CHANGED',
            message: 'changed',
            retryable: true,
          },
        });
      },
    });
    await expect(handler({ request: envelope, params: {} })).resolves.toMatchObject({
      isError: true,
    });
    expect(viewState.getClearAuthority()).toMatchObject({
      status: 'trusted_present',
      membershipComplete: false,
      elements: [],
    });
    expect(viewState.shouldSuppressRequestStartSnapshot()).toBe(true);
    expect(viewState.getElementType('text-1')).toBeUndefined();
  });
});
