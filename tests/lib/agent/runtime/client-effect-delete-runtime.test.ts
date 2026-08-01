import { describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import { BrowserClientEffectRuntime } from '@/lib/agent/client/client-effect-runtime';
import {
  CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
  type ClientEffectAck,
  type ClientEffectDelivery,
} from '@/lib/agent/runtime/client-effect-contract';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

function createStore(): StageStore {
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
          elements: [
            {
              id: 'delete-me',
              type: 'text' as const,
              content: '<p>remove</p>',
              defaultFontName: 'Microsoft YaHei',
              defaultColor: '#333',
              left: 0,
              top: 0,
              width: 100,
              height: 50,
              rotate: 0,
            },
            {
              id: 'keep-me',
              type: 'text' as const,
              content: '<p>keep</p>',
              defaultFontName: 'Microsoft YaHei',
              defaultColor: '#333',
              left: 100,
              top: 0,
              width: 100,
              height: 50,
              rotate: 0,
            },
          ],
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

function deleteDelivery(elementId = 'delete-me'): ClientEffectDelivery {
  return {
    acknowledgementToken: 'delete-capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-delete',
      runId: 'run-delete',
      agentInvocationId: 'message-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-delete',
      executionId: 'execution-delete',
      idempotencyKey: 'run-delete:message-1:tool-delete',
      toolName: 'wb_delete',
      args: { elementId },
      argsDigest: `sha256:${elementId}`,
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
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_element_absent',
        normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
        stableElementId: elementId,
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementType: 'text',
      },
    },
  };
}

describe('BrowserClientEffectRuntime wb_delete', () => {
  it('executes one exact deletion, emits a strict postcondition, and deduplicates delivery', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const ensureWhiteboardVisible = vi.fn(async () => {});
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      waitForPresentation: async () => {},
      ensureWhiteboardVisible,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const delivery = deleteDelivery();

    const first = runtime.execute(delivery, new AbortController().signal);
    const duplicate = runtime.execute(delivery, new AbortController().signal);
    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');

    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    expect(acknowledgements.at(-1)).toMatchObject({
      status: 'effect_committed',
      postcondition: {
        kind: 'whiteboard_element_absent',
        stableElementId: 'delete-me',
        whiteboardId: 'whiteboard-1',
        observedElementType: 'text',
        matchingElementCountBefore: 1,
        matchingElementCountAfter: 0,
        elementCountBefore: 2,
        elementCountAfter: 1,
        deleted: true,
      },
    });
    expect(ensureWhiteboardVisible).toHaveBeenCalledOnce();
    expect(store.getState().stage?.whiteboard?.[0].elements.map((element) => element.id)).toEqual([
      'keep-me',
    ]);
  });

  it('fails before accepted without creating or mutating a whiteboard when the target is stale', async () => {
    const store = createStore();
    store.getState().stage!.whiteboard = [];
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: vi.fn(async () => {}),
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await expect(runtime.execute(deleteDelivery(), new AbortController().signal)).resolves.toBe(
      'effect_failed',
    );
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'effect_failed',
    ]);
    expect(acknowledgements.at(-1)).toMatchObject({
      status: 'effect_failed',
      error: { code: 'CLIENT_EFFECT_DELETE_WHITEBOARD_MISMATCH', retryable: false },
    });
    expect(store.getState().stage?.whiteboard).toEqual([]);
  });
});
