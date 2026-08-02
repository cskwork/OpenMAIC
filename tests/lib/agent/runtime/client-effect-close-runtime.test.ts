import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import { BrowserClientEffectRuntime } from '@/lib/agent/client/client-effect-runtime';
import {
  CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
  type ClientEffectAck,
  type ClientEffectDelivery,
} from '@/lib/agent/runtime/client-effect-contract';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';
import { WB_CLOSE_MS } from '@/lib/choreography/timing';

function createStore(withWhiteboard = false): StageStore {
  let state = {
    stage: {
      id: 'stage-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: withWhiteboard
        ? [
            {
              id: 'whiteboard-1',
              viewportSize: 1000,
              viewportRatio: 16 / 9,
              background: { type: 'solid' as const, color: '#fff' },
              animations: [],
              elements: [],
            },
          ]
        : [],
    },
    scenes: [{ id: 'scene-1' }, { id: 'scene-2' }],
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

function closeDelivery(executionId = 'execution-close-1'): ClientEffectDelivery {
  return {
    acknowledgementToken: `capability-${executionId}`,
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-close',
      runId: 'run-close',
      agentInvocationId: 'message-close',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: `tool-${executionId}`,
      executionId,
      idempotencyKey: `run-close:message-close:${executionId}`,
      toolName: 'wb_close',
      args: {},
      argsDigest: 'sha256:close',
      issuedAt: Date.now(),
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-close',
      },
      activeEffectBudgetMs: 3_000,
      postcondition: {
        kind: 'whiteboard_closed',
        normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
        desiredOpen: false,
      },
    },
  };
}

function ackRecorder(acks: ClientEffectAck[], onAck?: (ack: ClientEffectAck) => void) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
    acks.push(ack);
    onAck?.(ack);
    return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserClientEffectRuntime wb_close', () => {
  it('closes an entity-less visible overlay without creating a whiteboard', async () => {
    vi.useFakeTimers();
    const store = createStore(false);
    const acks: ClientEffectAck[] = [];
    let open = true;
    const ensureVisible = vi.fn(async () => {});
    const setVisible = vi.fn((next: boolean) => {
      open = next;
    });
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: ensureVisible,
      observeWhiteboardOpen: () => open,
      setWhiteboardVisible: setVisible,
    });

    const execution = runtime.execute(closeDelivery(), new AbortController().signal);
    await vi.runAllTimersAsync();

    await expect(execution).resolves.toBe('effect_committed');
    expect(open).toBe(false);
    expect(setVisible).toHaveBeenCalledOnce();
    expect(ensureVisible).not.toHaveBeenCalled();
    expect(store.getState().stage?.whiteboard).toEqual([]);
    expect(acks.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    expect(acks[2]).toMatchObject({
      status: 'accepted',
      visibilityTarget: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        bindingVersion: 1,
      },
    });
    expect(acks[2]).not.toHaveProperty('targetBinding');
    expect(acks.at(-1)).toMatchObject({
      status: 'effect_committed',
      postcondition: {
        kind: 'whiteboard_closed',
        desiredOpen: false,
        observedOpen: false,
        visibilityChanged: true,
      },
    });
  });

  it('verifies an already-closed no-op without mutation or open animation', async () => {
    const store = createStore(true);
    const acks: ClientEffectAck[] = [];
    const ensureVisible = vi.fn(async () => {});
    const setVisible = vi.fn();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: ensureVisible,
      observeWhiteboardOpen: () => false,
      setWhiteboardVisible: setVisible,
    });

    await expect(runtime.execute(closeDelivery(), new AbortController().signal)).resolves.toBe(
      'effect_committed',
    );
    expect(setVisible).not.toHaveBeenCalled();
    expect(ensureVisible).not.toHaveBeenCalled();
    expect(acks.at(-1)).toMatchObject({
      status: 'effect_committed',
      postcondition: { kind: 'whiteboard_closed', visibilityChanged: false },
    });
  });

  it('reuses one execution for duplicate delivery and mutates once', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    let open = true;
    const setVisible = vi.fn((next: boolean) => {
      open = next;
    });
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
      observeWhiteboardOpen: () => open,
      setWhiteboardVisible: setVisible,
    });
    const delivery = closeDelivery();
    const results = Promise.all([
      runtime.execute(delivery, new AbortController().signal),
      runtime.execute(delivery, new AbortController().signal),
    ]);
    await vi.runAllTimersAsync();

    await expect(results).resolves.toEqual(['effect_committed', 'effect_committed']);
    expect(setVisible).toHaveBeenCalledOnce();
    expect(acks.filter((ack) => ack.status === 'effect_committed')).toHaveLength(1);
  });

  it('withholds commit while paused after the visibility mutation', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    let open = true;
    const setVisible = vi.fn((next: boolean) => {
      open = next;
      runtime.pause();
    });
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
      observeWhiteboardOpen: () => open,
      setWhiteboardVisible: setVisible,
    });
    const execution = runtime.execute(closeDelivery(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(WB_CLOSE_MS * 2);

    expect(open).toBe(false);
    expect(acks.some((ack) => ack.status === 'effect_committed')).toBe(false);
    runtime.resume();
    await vi.runAllTimersAsync();
    await expect(execution).resolves.toBe('effect_committed');
    expect(acks.map((ack) => ack.status)).toContain('presentation_paused');
    expect(acks.at(-1)?.status).toBe('effect_committed');
  });

  it('reports whether cancellation happened before or after mutation', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const afterMutationAcks: ClientEffectAck[] = [];
    let open = true;
    const afterMutationAbort = new AbortController();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(afterMutationAcks),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
      observeWhiteboardOpen: () => open,
      setWhiteboardVisible: (next) => {
        open = next;
        afterMutationAbort.abort();
      },
    });
    const afterMutation = runtime.execute(closeDelivery(), afterMutationAbort.signal);
    await vi.runAllTimersAsync();
    await expect(afterMutation).resolves.toBe('cancelled');
    expect(afterMutationAcks.at(-1)).toMatchObject({
      status: 'cancelled',
      error: { code: 'CLIENT_EFFECT_CLOSE_STATE_UNCONFIRMED' },
    });

    const beforeMutationAcks: ClientEffectAck[] = [];
    const secondStore = createStore();
    const beforeMutationRuntime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: secondStore,
      fetchAck: ackRecorder(beforeMutationAcks, (ack) => {
        if (ack.status === 'accepted') secondStore.setState({ currentSceneId: 'scene-2' });
      }),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
      observeWhiteboardOpen: () => true,
      setWhiteboardVisible: vi.fn(),
    });
    await expect(
      beforeMutationRuntime.execute(
        closeDelivery('execution-close-2'),
        new AbortController().signal,
      ),
    ).resolves.toBe('cancelled');
    expect(beforeMutationAcks.at(-1)).toMatchObject({
      status: 'cancelled',
      error: { code: 'CLIENT_EFFECT_CLOSE_FAILED_BEFORE_MUTATION' },
    });
  });
});
