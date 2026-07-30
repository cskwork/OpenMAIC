import { describe, expect, it } from 'vitest';
import {
  executeNativeWhiteboardShapeEffect,
  prepareNativeWhiteboardTarget,
  verifyNativeWhiteboardShapeEffect,
  type NativeWbDrawShapeInput,
} from '@/lib/action/client-effect-whiteboard';
import {
  digestWhiteboardShapeV1,
  normalizeWhiteboardShapeV1,
} from '@/lib/agent/runtime/client-effect-contract';
import type { StageStore } from '@/lib/api/stage-api';

function createStore(): StageStore {
  let state = {
    stage: {
      id: 'stage-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [],
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

const target = {
  requestId: 'request-1',
  sessionId: 'session-1',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  messageId: 'message-1',
};

const input: NativeWbDrawShapeInput = {
  executionId: 'execution-shape-1',
  stableElementId: 'shape-1',
  shape: 'circle',
  x: 120,
  y: 80,
  width: 240,
  height: 180,
  fillColor: '#33aa66',
};

async function expectedShape() {
  const shape = normalizeWhiteboardShapeV1(input);
  return { shape, digest: await digestWhiteboardShapeV1(shape) };
}

describe('native wb_draw_shape client effect', () => {
  it('creates one owned shape and verifies kind, bounds, fill, and digest', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedShape();
    const result = await executeNativeWhiteboardShapeEffect({
      store,
      targetBinding: binding,
      input,
      expectedShape: expected.shape,
      expectedShapeDigest: expected.digest,
    });

    expect(result).toMatchObject({
      replayed: false,
      postcondition: {
        stableElementId: input.stableElementId,
        elementType: 'shape',
        shape: 'circle',
        bounds: { x: 120, y: 80, width: 240, height: 180 },
        fillColor: '#33aa66',
        observedShapeDigest: expected.digest,
        matchingElementCount: 1,
      },
    });
    const elements = store.getState().stage?.whiteboard?.[0]?.elements;
    expect(elements).toHaveLength(1);
    expect(elements?.[0]).toMatchObject({
      id: input.stableElementId,
      type: 'shape',
      left: 120,
      top: 80,
      width: 240,
      height: 180,
      fill: '#33aa66',
      clientEffectExecutionId: input.executionId,
      clientEffectShapeKind: 'circle',
      clientEffectShapeDigest: expected.digest,
    });
  });

  it('replays the same execution without creating a duplicate element', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedShape();
    await executeNativeWhiteboardShapeEffect({
      store,
      targetBinding: binding,
      input,
      expectedShape: expected.shape,
      expectedShapeDigest: expected.digest,
    });
    const replay = await executeNativeWhiteboardShapeEffect({
      store,
      targetBinding: binding,
      input,
      expectedShape: expected.shape,
      expectedShapeDigest: expected.digest,
    });

    expect(replay.replayed).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);
  });

  it('fails closed when an existing stable element has conflicting shape state', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedShape();
    await executeNativeWhiteboardShapeEffect({
      store,
      targetBinding: binding,
      input,
      expectedShape: expected.shape,
      expectedShapeDigest: expected.digest,
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as {
      fill?: string;
    };
    element.fill = '#ff0000';

    await expect(
      verifyNativeWhiteboardShapeEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedShape: expected.shape,
        expectedShapeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_SHAPE_MISMATCH');
  });

  it('rejects out-of-board bounds before mutating the whiteboard', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const invalid = { ...input, x: 900, width: 200 };

    await expect(
      executeNativeWhiteboardShapeEffect({
        store,
        targetBinding: binding,
        input: invalid,
        expectedShape: {
          shape: invalid.shape,
          bounds: {
            x: invalid.x,
            y: invalid.y,
            width: invalid.width,
            height: invalid.height,
          },
          fillColor: invalid.fillColor ?? '#5b9bd5',
        },
        expectedShapeDigest: 'sha256:invalid',
      }),
    ).rejects.toThrow('CLIENT_EFFECT_SHAPE_BOUNDS_INVALID');
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(0);
  });

  it('cancels before mutation when the accepted scene is no longer current', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedShape();
    store.setState({ currentSceneId: 'scene-2' });

    await expect(
      executeNativeWhiteboardShapeEffect({
        store,
        targetBinding: binding,
        input,
        expectedShape: expected.shape,
        expectedShapeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');
  });

  it('honors request cancellation before mutation', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedShape();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeNativeWhiteboardShapeEffect({
        store,
        targetBinding: binding,
        input,
        expectedShape: expected.shape,
        expectedShapeDigest: expected.digest,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(0);
  });
});
