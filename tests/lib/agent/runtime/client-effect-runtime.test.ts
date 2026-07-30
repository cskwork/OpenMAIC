import { describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import { BrowserClientEffectRuntime } from '@/lib/agent/client/client-effect-runtime';
import {
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestWhiteboardShapeV1,
  digestVisibleTextV1,
  normalizeWhiteboardShapeV1,
  type ClientEffectAck,
  type ClientEffectDelivery,
} from '@/lib/agent/runtime/client-effect-contract';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

function createStore(): StageStore {
  let state = {
    stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 1, whiteboard: [] },
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

async function delivery(): Promise<ClientEffectDelivery> {
  return {
    acknowledgementToken: 'capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-1',
      runId: 'run-1',
      agentInvocationId: 'message-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-call-1',
      executionId: 'execution-1',
      idempotencyKey: 'run-1:message-1:tool-call-1',
      toolName: 'wb_draw_text',
      args: { content: 'k 决定方向', x: 100, y: 120 },
      argsDigest: 'sha256:args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_text_exists',
        stableElementId: 'element-1',
        elementType: 'text',
        normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
        expectedContentDigest: await digestVisibleTextV1('k 决定方向'),
      },
    },
  };
}

async function shapeDelivery(): Promise<ClientEffectDelivery> {
  const shape = normalizeWhiteboardShapeV1({
    shape: 'triangle',
    x: 200,
    y: 100,
    width: 260,
    height: 180,
    fillColor: '#8844cc',
  });
  return {
    acknowledgementToken: 'shape-capability',
    request: {
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
      args: {
        shape: 'triangle',
        x: 200,
        y: 100,
        width: 260,
        height: 180,
        fillColor: '#8844cc',
      },
      argsDigest: 'sha256:shape-args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-shape-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_shape_exists',
        stableElementId: 'shape-element-1',
        elementType: 'shape',
        normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
        expectedShapeDigest: await digestWhiteboardShapeV1(shape),
        ...shape,
      },
    },
  };
}

describe('BrowserClientEffectRuntime', () => {
  it('invokes the default browser fetch with the global receiver', async () => {
    const acknowledgements: ClientEffectAck[] = [];
    const browserFetch = vi.fn(function (
      this: typeof globalThis,
      _url: string | URL | Request,
      init?: RequestInit,
    ) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
      acknowledgements.push(ack);
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', browserFetch);
    try {
      const runtime = new BrowserClientEffectRuntime({
        sessionId: 'session-1',
        requestId: 'request-1',
        store: createStore(),
        waitForPresentation: async () => {},
        ensureWhiteboardVisible: async () => {},
      });

      await expect(runtime.execute(await delivery(), new AbortController().signal)).resolves.toBe(
        'effect_committed',
      );
      expect(acknowledgements.map((ack) => ack.status)).toEqual([
        'presentation_paused',
        'presentation_resumed',
        'accepted',
        'effect_committed',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('freezes presentation time, commits once, and returns the verified browser result', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const fetchAck = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
      acknowledgements.push(ack);
      return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    let releasePresentation!: () => void;
    const presentation = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck,
      waitForPresentation: () => presentation,
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await delivery();

    runtime.reserve(effect);
    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);
    await vi.waitFor(() =>
      expect(acknowledgements.map((ack) => ack.status)).toEqual(['presentation_paused']),
    );
    releasePresentation();

    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('executes a shape once and ACKs its verified geometry to the same server execution', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await shapeDelivery();

    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);

    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    if (effect.request.postcondition.kind !== 'whiteboard_shape_exists') {
      throw new Error('Expected a shape delivery.');
    }
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    const committed = acknowledgements.at(-1);
    expect(committed).toMatchObject({
      executionId: effect.request.executionId,
      idempotencyKey: effect.request.idempotencyKey,
      status: 'effect_committed',
      postcondition: {
        stableElementId: effect.request.postcondition.stableElementId,
        elementType: 'shape',
        observedShapeDigest: effect.request.postcondition.expectedShapeDigest,
        shape: 'triangle',
        bounds: { x: 200, y: 100, width: 260, height: 180 },
        fillColor: '#8844cc',
        matchingElementCount: 1,
      },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('cancels a presentation wait on request abort without leaving a pending execution', async () => {
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: (_executionId, signal) =>
        new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('Operation aborted', 'AbortError'));
          signal.addEventListener('abort', rejectAbort, { once: true });
          if (signal.aborted) rejectAbort();
        }),
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await delivery();
    const controller = new AbortController();
    const execution = runtime.execute(effect, controller.signal);
    controller.abort();

    await expect(execution).resolves.toBe('cancelled');
    expect(acknowledgements.map((ack) => ack.status)).toEqual(['presentation_paused', 'cancelled']);
  });

  it('settles a paused execution at its hard deadline without waiting for resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    try {
      const acknowledgements: ClientEffectAck[] = [];
      const store = createStore();
      const runtime = new BrowserClientEffectRuntime({
        sessionId: 'session-1',
        requestId: 'request-1',
        store,
        fetchAck: async (_url, init) => {
          const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
          acknowledgements.push(ack);
          return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        waitForPresentation: async () => {},
        ensureWhiteboardVisible: async () => {},
      });
      runtime.pause();
      const effect = await delivery();
      effect.request.deadlineAt = Date.now() + 100;
      const execution = runtime.execute(effect, new AbortController().signal);

      await vi.advanceTimersByTimeAsync(101);

      await expect(execution).resolves.toBe('cancelled');
      expect(acknowledgements.map((ack) => ack.status)).toEqual(['presentation_paused']);
      expect(
        store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles locally when the ACK channel fails instead of leaving a hanging promise', async () => {
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: async () => {
        throw new Error('network unavailable');
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(await delivery(), new AbortController().signal)).resolves.toBe(
      'cancelled',
    );
  });

  it('rejects a duplicate execution when its capability token changes', async () => {
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: vi.fn(),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await delivery();
    runtime.reserve(effect);

    expect(() =>
      runtime.reserve({ ...effect, acknowledgementToken: 'different-capability' }),
    ).toThrow('CLIENT_EFFECT_DUPLICATE_CONFLICT');
  });

  it('does not report success when a late commit receives authoritative timed_out state', async () => {
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        const status = ack.status === 'effect_committed' ? 'timed_out' : ack.status;
        return new Response(JSON.stringify({ success: true, state: { status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(await delivery(), new AbortController().signal)).resolves.toBe(
      'timed_out',
    );
  });
});
