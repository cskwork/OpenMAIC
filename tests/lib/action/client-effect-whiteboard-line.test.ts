import { describe, expect, it } from 'vitest';
import type { PPTLineElement } from '@openmaic/dsl';
import {
  executeNativeWhiteboardLineEffect,
  prepareNativeWhiteboardTarget,
  verifyNativeWhiteboardLineEffect,
  type NativeWbDrawLineInput,
} from '@/lib/action/client-effect-whiteboard';
import {
  createWhiteboardLineElement,
  readAbsoluteWhiteboardLineEndpoints,
} from '@/lib/action/whiteboard-lines';
import {
  digestWhiteboardLineV1,
  normalizeWhiteboardLineV1,
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

const input: NativeWbDrawLineInput = {
  executionId: 'execution-line-1',
  stableElementId: 'line-1',
  startX: 420,
  startY: 300,
  endX: 120,
  endY: 80,
  color: '#2244aa',
  width: 4,
  style: 'dashed',
  points: ['', 'arrow'],
};

async function expectedLine(lineInput: NativeWbDrawLineInput = input) {
  const line = normalizeWhiteboardLineV1(lineInput);
  return { line, digest: await digestWhiteboardLineV1(line) };
}

describe('native wb_draw_line client effect', () => {
  it('preserves ordered endpoints and marker direction using the Legacy line mapping', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedLine();
    const result = await executeNativeWhiteboardLineEffect({
      store,
      targetBinding: binding,
      input,
      expectedLine: expected.line,
      expectedLineDigest: expected.digest,
    });

    expect(result).toMatchObject({
      replayed: false,
      postcondition: {
        stableElementId: input.stableElementId,
        elementType: 'line',
        start: { x: 420, y: 300 },
        end: { x: 120, y: 80 },
        strokeColor: '#2244aa',
        strokeWidth: 4,
        strokeStyle: 'dashed',
        markers: ['', 'arrow'],
        observedLineDigest: expected.digest,
        matchingElementCount: 1,
      },
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0];
    expect(element).toMatchObject({
      id: input.stableElementId,
      type: 'line',
      left: 120,
      top: 80,
      width: 4,
      start: [300, 220],
      end: [0, 0],
      style: 'dashed',
      color: '#2244aa',
      points: ['', 'arrow'],
      clientEffectExecutionId: input.executionId,
      clientEffectLineDigest: expected.digest,
    });
    expect(readAbsoluteWhiteboardLineEndpoints(element as PPTLineElement)).toEqual({
      startX: 420,
      startY: 300,
      endX: 120,
      endY: 80,
    });
  });

  it('keeps Native defaults mechanically equal to the Legacy element factory', async () => {
    const normalized = normalizeWhiteboardLineV1({
      startX: 20,
      startY: 30,
      endX: 200,
      endY: 180,
    });
    const legacy = createWhiteboardLineElement({
      id: 'legacy-line',
      startX: 20,
      startY: 30,
      endX: 200,
      endY: 180,
    });

    expect(normalized).toEqual({
      start: { x: 20, y: 30 },
      end: { x: 200, y: 180 },
      strokeColor: '#333333',
      strokeWidth: 2,
      strokeStyle: 'solid',
      markers: ['', ''],
    });
    expect(legacy).toMatchObject({
      width: normalized.strokeWidth,
      color: normalized.strokeColor,
      style: normalized.strokeStyle,
      points: normalized.markers,
    });
    expect(readAbsoluteWhiteboardLineEndpoints(legacy)).toEqual({
      startX: normalized.start.x,
      startY: normalized.start.y,
      endX: normalized.end.x,
      endY: normalized.end.y,
    });
  });

  it('replays the same execution once and fails closed on conflicting line state', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedLine();
    await executeNativeWhiteboardLineEffect({
      store,
      targetBinding: binding,
      input,
      expectedLine: expected.line,
      expectedLineDigest: expected.digest,
    });
    const replay = await executeNativeWhiteboardLineEffect({
      store,
      targetBinding: binding,
      input,
      expectedLine: expected.line,
      expectedLineDigest: expected.digest,
    });

    expect(replay.replayed).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);

    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as {
      color?: string;
    };
    element.color = '#ff0000';
    await expect(
      verifyNativeWhiteboardLineEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedLine: expected.line,
        expectedLineDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_LINE_MISMATCH');
  });

  it.each([
    [{ ...input, endX: input.startX, endY: input.startY }, 'CLIENT_EFFECT_LINE_ZERO_LENGTH'],
    [{ ...input, endX: 1001 }, 'CLIENT_EFFECT_LINE_BOUNDS_INVALID'],
    [{ ...input, width: 101 }, 'CLIENT_EFFECT_LINE_STROKE_INVALID'],
  ])('rejects invalid line state before mutation', async (invalid, code) => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);

    await expect(
      executeNativeWhiteboardLineEffect({
        store,
        targetBinding: binding,
        input: invalid,
        expectedLine: normalizeWhiteboardLineV1(input),
        expectedLineDigest: 'sha256:invalid',
      }),
    ).rejects.toThrow(code);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(0);
  });

  it('cancels on scene change or request abort before mutation', async () => {
    const changedStore = createStore();
    const changedBinding = prepareNativeWhiteboardTarget(changedStore, target);
    const expected = await expectedLine();
    changedStore.setState({ currentSceneId: 'scene-2' });

    await expect(
      executeNativeWhiteboardLineEffect({
        store: changedStore,
        targetBinding: changedBinding,
        input,
        expectedLine: expected.line,
        expectedLineDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');

    const abortedStore = createStore();
    const abortedBinding = prepareNativeWhiteboardTarget(abortedStore, target);
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeNativeWhiteboardLineEffect({
        store: abortedStore,
        targetBinding: abortedBinding,
        input,
        expectedLine: expected.line,
        expectedLineDigest: expected.digest,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedStore.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(0);
  });
});
