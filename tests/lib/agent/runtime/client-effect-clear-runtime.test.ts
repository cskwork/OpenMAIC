import { describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import { BrowserClientEffectRuntime } from '@/lib/agent/client/client-effect-runtime';
import {
  CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
  CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
  CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
  digestWhiteboardMembershipV1,
  type ClientEffectAck,
  type ClientEffectDelivery,
} from '@/lib/agent/runtime/client-effect-contract';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

function text(id: string, content: string) {
  return {
    id,
    type: 'text' as const,
    content: `<p>${content}</p>`,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333',
    left: 0,
    top: 0,
    width: 100,
    height: 50,
    rotate: 0,
  };
}

function createStore(
  elements = [text('a', 'alpha'), text('b', 'beta')],
  options: { ignoreClearWrites?: boolean } = {},
): StageStore {
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
      if (options.ignoreClearWrites && partial.stage?.whiteboard?.at(-1)?.elements.length === 0) {
        return;
      }
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
  } as unknown as StageStore;
}

async function clearDelivery(elementIds: string[]): Promise<ClientEffectDelivery> {
  return {
    acknowledgementToken: 'clear-capability',
    request: {
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
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-1',
      },
      activeEffectBudgetMs: 3_000,
      postcondition: {
        kind: 'whiteboard_empty',
        normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
        membershipNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
        boardContentNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementCount: elementIds.length,
        expectedMembershipDigest: await digestWhiteboardMembershipV1(
          elementIds.map((id) => ({ id, type: 'text' as const })),
        ),
      },
    },
  };
}

function ackRecorder(acks: ClientEffectAck[]) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
    acks.push(ack);
    return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('BrowserClientEffectRuntime wb_clear', () => {
  it('saves exact history, clears once, and reports the authoritative observation', async () => {
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    let open = false;
    const clearing: boolean[] = [];
    const pushExact = vi.fn((elements, digest: string) => ({
      snapshotIndex: 0,
      boardContentDigest: digest,
      inserted: true,
      elementCount: elements.length,
    }));
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => open,
      ensureWhiteboardVisible: async () => {
        open = true;
      },
      setWhiteboardClearing: (value) => clearing.push(value),
      pushExactWhiteboardSnapshot: pushExact,
    });

    await expect(
      runtime.execute(await clearDelivery(['a', 'b']), new AbortController().signal),
    ).resolves.toBe('effect_committed');
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    expect(pushExact).toHaveBeenCalledOnce();
    expect(clearing).toEqual([true, false]);
    expect(acks.at(-1)).toMatchObject({
      status: 'effect_committed',
      postcondition: {
        kind: 'whiteboard_empty',
        cleared: true,
        elementCountBefore: 2,
        elementCountAfter: 0,
        observedOpen: true,
        visibilityChanged: true,
      },
    });
  });

  it('reuses one execution for an identical duplicate clear delivery', async () => {
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    const pushExact = vi.fn((_elements, digest: string) => ({
      snapshotIndex: 0,
      boardContentDigest: digest,
      inserted: true,
    }));
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => true,
      ensureWhiteboardVisible: async () => {},
      setWhiteboardClearing: () => {},
      pushExactWhiteboardSnapshot: pushExact,
    });
    const delivery = await clearDelivery(['a', 'b']);

    await expect(
      Promise.all([
        runtime.execute(delivery, new AbortController().signal),
        runtime.execute(delivery, new AbortController().signal),
      ]),
    ).resolves.toEqual(['effect_committed', 'effect_committed']);
    expect(pushExact).toHaveBeenCalledOnce();
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    expect(acks.filter((ack) => ack.status === 'effect_committed')).toHaveLength(1);
  });

  it('verifies an empty board without opening, history, animation, or mutation', async () => {
    const store = createStore([]);
    const acks: ClientEffectAck[] = [];
    const ensureVisible = vi.fn(async () => {});
    const pushExact = vi.fn();
    const setClearing = vi.fn();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => false,
      ensureWhiteboardVisible: ensureVisible,
      setWhiteboardClearing: setClearing,
      pushExactWhiteboardSnapshot: pushExact,
    });

    await expect(
      runtime.execute(await clearDelivery([]), new AbortController().signal),
    ).resolves.toBe('effect_committed');
    expect(ensureVisible).not.toHaveBeenCalled();
    expect(pushExact).not.toHaveBeenCalled();
    expect(setClearing).not.toHaveBeenCalled();
    expect(acks.at(-1)).toMatchObject({
      status: 'effect_committed',
      postcondition: { kind: 'whiteboard_empty', cleared: false, visibilityChanged: false },
    });
  });

  it('fails closed when content changes during the clear animation', async () => {
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    const pushExact = vi.fn();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => true,
      ensureWhiteboardVisible: async () => {},
      setWhiteboardClearing: (clearing) => {
        if (clearing) {
          const element = store.getState().stage!.whiteboard![0].elements[0];
          if (element.type === 'text') element.content = '<p>changed</p>';
        }
      },
      pushExactWhiteboardSnapshot: pushExact,
    });

    await expect(
      runtime.execute(await clearDelivery(['a', 'b']), new AbortController().signal),
    ).resolves.toBe('effect_failed');
    expect(pushExact).not.toHaveBeenCalled();
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    expect(acks.at(-1)).toMatchObject({
      status: 'effect_failed',
      error: { code: 'CLIENT_EFFECT_CLEAR_CONTENT_CHANGED' },
    });
  });

  it('does not mutate when the exact history receipt is not authoritative', async () => {
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => true,
      ensureWhiteboardVisible: async () => {},
      setWhiteboardClearing: () => {},
      pushExactWhiteboardSnapshot: () => ({
        snapshotIndex: 0,
        boardContentDigest: 'sha256:wrong-receipt',
        inserted: true,
      }),
    });

    await expect(
      runtime.execute(await clearDelivery(['a', 'b']), new AbortController().signal),
    ).resolves.toBe('effect_failed');
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    expect(acks.at(-1)).toMatchObject({
      status: 'effect_failed',
      error: { code: 'CLIENT_EFFECT_CLEAR_HISTORY_RECEIPT_MISMATCH' },
    });
  });

  it('does not report success when the mutation API leaves content behind', async () => {
    const store = createStore(undefined, { ignoreClearWrites: true });
    const acks: ClientEffectAck[] = [];
    const pushExact = vi.fn((_elements, digest: string) => ({
      snapshotIndex: 0,
      boardContentDigest: digest,
      inserted: true,
    }));
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => true,
      ensureWhiteboardVisible: async () => {},
      setWhiteboardClearing: () => {},
      pushExactWhiteboardSnapshot: pushExact,
    });

    await expect(
      runtime.execute(await clearDelivery(['a', 'b']), new AbortController().signal),
    ).resolves.toBe('effect_failed');
    expect(pushExact).toHaveBeenCalledOnce();
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    expect(acks.at(-1)).toMatchObject({
      status: 'effect_failed',
      error: { code: 'CLIENT_EFFECT_CLEAR_POSTCONDITION_FAILED' },
    });
  });

  it('cancels without history or mutation when the request aborts during animation', async () => {
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    const controller = new AbortController();
    const pushExact = vi.fn();
    const clearing: boolean[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => true,
      ensureWhiteboardVisible: async () => {},
      setWhiteboardClearing: (value) => {
        clearing.push(value);
        if (value) controller.abort();
      },
      pushExactWhiteboardSnapshot: pushExact,
    });
    await expect(runtime.execute(await clearDelivery(['a', 'b']), controller.signal)).resolves.toBe(
      'cancelled',
    );
    expect(pushExact).not.toHaveBeenCalled();
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    expect(clearing).toEqual([true, false]);
  });

  it('pauses the pending animation and resumes the same execution', async () => {
    const store = createStore();
    const acks: ClientEffectAck[] = [];
    let pausedOnce = false;
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: ackRecorder(acks),
      waitForPresentation: async () => {},
      observeWhiteboardOpen: () => true,
      ensureWhiteboardVisible: async () => {},
      setWhiteboardClearing: (value) => {
        if (value && !pausedOnce) {
          pausedOnce = true;
          runtime.pause();
          setTimeout(() => runtime.resume(), 30);
        }
      },
      pushExactWhiteboardSnapshot: (_elements, digest) => ({
        snapshotIndex: 0,
        boardContentDigest: digest,
        inserted: true,
      }),
    });
    await expect(
      runtime.execute(await clearDelivery(['a', 'b']), new AbortController().signal),
    ).resolves.toBe('effect_committed');
    expect(acks.map((ack) => ack.status)).toEqual(
      expect.arrayContaining(['presentation_paused', 'presentation_resumed', 'effect_committed']),
    );
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
  });

  it('rechecks pause after digest B before entering the synchronous clear commit', async () => {
    const store = createStore();
    const delivery = await clearDelivery(['a', 'b']);
    let runtime!: BrowserClientEffectRuntime;
    let digestCalls = 0;
    let pausedAtDigest = false;
    const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementation(async (...args: Parameters<SubtleCrypto['digest']>) => {
        digestCalls += 1;
        const result = await nativeDigest(...args);
        if (digestCalls === 4) {
          pausedAtDigest = true;
          runtime.pause();
        }
        return result;
      });
    try {
      runtime = new BrowserClientEffectRuntime({
        sessionId: 'session-1',
        requestId: 'request-1',
        store,
        fetchAck: ackRecorder([]),
        waitForPresentation: async () => {},
        observeWhiteboardOpen: () => true,
        ensureWhiteboardVisible: async () => {},
        setWhiteboardClearing: () => {},
        pushExactWhiteboardSnapshot: (_elements, digest) => ({
          snapshotIndex: 0,
          boardContentDigest: digest,
          inserted: true,
        }),
      });
      const execution = runtime.execute(delivery, new AbortController().signal);
      await vi.waitFor(() => expect(pausedAtDigest).toBe(true));
      expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
      runtime.resume();
      await expect(execution).resolves.toBe('effect_committed');
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('rejects a B/C race created while digest B is resolving', async () => {
    const store = createStore();
    const delivery = await clearDelivery(['a', 'b']);
    let digestCalls = 0;
    const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementation(async (...args: Parameters<SubtleCrypto['digest']>) => {
        digestCalls += 1;
        const result = await nativeDigest(...args);
        if (digestCalls === 4) {
          const element = store.getState().stage!.whiteboard![0].elements[0];
          if (element.type === 'text') element.content = '<p>changed after capture B</p>';
        }
        return result;
      });
    const pushExact = vi.fn();
    try {
      const runtime = new BrowserClientEffectRuntime({
        sessionId: 'session-1',
        requestId: 'request-1',
        store,
        fetchAck: ackRecorder([]),
        waitForPresentation: async () => {},
        observeWhiteboardOpen: () => true,
        ensureWhiteboardVisible: async () => {},
        setWhiteboardClearing: () => {},
        pushExactWhiteboardSnapshot: pushExact,
      });
      await expect(runtime.execute(delivery, new AbortController().signal)).resolves.toBe(
        'effect_failed',
      );
      expect(pushExact).not.toHaveBeenCalled();
      expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('fails closed when the scene changes while digest B is resolving', async () => {
    const store = createStore();
    const delivery = await clearDelivery(['a', 'b']);
    let digestCalls = 0;
    const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementation(async (...args: Parameters<SubtleCrypto['digest']>) => {
        digestCalls += 1;
        const result = await nativeDigest(...args);
        if (digestCalls === 4) {
          store.setState({ currentSceneId: 'scene-2' } as never);
        }
        return result;
      });
    const pushExact = vi.fn();
    try {
      const runtime = new BrowserClientEffectRuntime({
        sessionId: 'session-1',
        requestId: 'request-1',
        store,
        fetchAck: ackRecorder([]),
        waitForPresentation: async () => {},
        observeWhiteboardOpen: () => true,
        ensureWhiteboardVisible: async () => {},
        setWhiteboardClearing: () => {},
        pushExactWhiteboardSnapshot: pushExact,
      });
      await expect(runtime.execute(delivery, new AbortController().signal)).resolves.toBe(
        'cancelled',
      );
      expect(pushExact).not.toHaveBeenCalled();
      expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    } finally {
      digestSpy.mockRestore();
    }
  });
});
