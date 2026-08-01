import { describe, expect, it } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import {
  executeNativeWhiteboardDeleteEffect,
  prepareNativeWhiteboardDeleteTarget,
} from '@/lib/action/client-effect-whiteboard';
import { CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION } from '@/lib/agent/runtime/client-effect-contract';

function createStore(
  opts: { duplicate?: boolean; noWhiteboard?: boolean; ignoreWrites?: boolean } = {},
): StageStore {
  let current = {
    stage: {
      id: 'stage-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: opts.noWhiteboard
        ? []
        : [
            {
              id: 'whiteboard-1',
              viewportSize: 1000,
              viewportRatio: 16 / 9,
              background: { type: 'solid' as const, color: '#ffffff' },
              animations: [],
              elements: [
                {
                  id: 'delete-me',
                  type: 'text' as const,
                  content: '<p>remove</p>',
                  defaultFontName: 'Microsoft YaHei',
                  defaultColor: '#333333',
                  left: 10,
                  top: 10,
                  width: 100,
                  height: 50,
                  rotate: 0,
                },
                ...(opts.duplicate
                  ? [
                      {
                        id: 'delete-me',
                        type: 'shape' as const,
                        viewBox: [1000, 1000] as [number, number],
                        path: 'M0 0',
                        fill: '#fff',
                        fixedRatio: false,
                        left: 20,
                        top: 20,
                        width: 20,
                        height: 20,
                        rotate: 0,
                      },
                    ]
                  : []),
                {
                  id: 'keep-me',
                  type: 'shape' as const,
                  viewBox: [1000, 1000] as [number, number],
                  path: 'M0 0',
                  fill: '#fff',
                  fixedRatio: false,
                  left: 30,
                  top: 30,
                  width: 20,
                  height: 20,
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
    getState: () => current,
    setState: (partial: Partial<typeof current>) => {
      if (opts.ignoreWrites) return;
      current = { ...current, ...partial };
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

describe('native wb_delete client effect', () => {
  it('deletes exactly one verified element and proves 1 -> 0 and N -> N - 1', () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardDeleteTarget(store, target, 'whiteboard-1');
    const result = executeNativeWhiteboardDeleteEffect({
      store,
      targetBinding: binding,
      stableElementId: 'delete-me',
      expectedWhiteboardId: 'whiteboard-1',
      expectedElementType: 'text',
    });

    expect(result.postcondition).toEqual({
      kind: 'whiteboard_element_absent',
      normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
      stableElementId: 'delete-me',
      whiteboardId: 'whiteboard-1',
      observedElementType: 'text',
      matchingElementCountBefore: 1,
      matchingElementCountAfter: 0,
      elementCountBefore: 2,
      elementCountAfter: 1,
      deleted: true,
    });
    expect(store.getState().stage?.whiteboard?.[0].elements.map((element) => element.id)).toEqual([
      'keep-me',
    ]);
  });

  it('fails closed for missing, duplicate, type-mismatched, and wrong-board targets', () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardDeleteTarget(store, target, 'whiteboard-1');
    expect(() =>
      executeNativeWhiteboardDeleteEffect({
        store,
        targetBinding: binding,
        stableElementId: 'missing',
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementType: 'text',
      }),
    ).toThrow('CLIENT_EFFECT_DELETE_ELEMENT_NOT_FOUND');
    expect(() =>
      executeNativeWhiteboardDeleteEffect({
        store,
        targetBinding: binding,
        stableElementId: 'delete-me',
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementType: 'shape',
      }),
    ).toThrow('CLIENT_EFFECT_DELETE_ELEMENT_TYPE_MISMATCH');

    const duplicateStore = createStore({ duplicate: true });
    expect(() =>
      executeNativeWhiteboardDeleteEffect({
        store: duplicateStore,
        targetBinding: prepareNativeWhiteboardDeleteTarget(duplicateStore, target, 'whiteboard-1'),
        stableElementId: 'delete-me',
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementType: 'text',
      }),
    ).toThrow('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
    expect(() => prepareNativeWhiteboardDeleteTarget(store, target, 'other-board')).toThrow(
      'CLIENT_EFFECT_DELETE_WHITEBOARD_MISMATCH',
    );
  });

  it('does not create a whiteboard when the existing target is absent', () => {
    const store = createStore({ noWhiteboard: true });
    expect(() => prepareNativeWhiteboardDeleteTarget(store, target, 'whiteboard-1')).toThrow(
      'CLIENT_EFFECT_DELETE_WHITEBOARD_MISMATCH',
    );
    expect(store.getState().stage?.whiteboard).toEqual([]);
  });

  it('fails closed when the mutation API reports success but the element remains', () => {
    const store = createStore({ ignoreWrites: true });
    expect(() =>
      executeNativeWhiteboardDeleteEffect({
        store,
        targetBinding: prepareNativeWhiteboardDeleteTarget(store, target, 'whiteboard-1'),
        stableElementId: 'delete-me',
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementType: 'text',
      }),
    ).toThrow('CLIENT_EFFECT_DELETE_POSTCONDITION_FAILED');
    expect(
      store
        .getState()
        .stage?.whiteboard?.[0].elements.some((element) => element.id === 'delete-me'),
    ).toBe(true);
  });

  it('does not mutate after a scene switch or pre-mutation abort', () => {
    const switchedStore = createStore();
    const switchedBinding = prepareNativeWhiteboardDeleteTarget(
      switchedStore,
      target,
      'whiteboard-1',
    );
    switchedStore.getState().currentSceneId = 'scene-2';
    expect(() =>
      executeNativeWhiteboardDeleteEffect({
        store: switchedStore,
        targetBinding: switchedBinding,
        stableElementId: 'delete-me',
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementType: 'text',
      }),
    ).toThrow('CLIENT_EFFECT_TARGET_CHANGED');
    expect(
      switchedStore
        .getState()
        .stage?.whiteboard?.[0].elements.some((element) => element.id === 'delete-me'),
    ).toBe(true);

    const abortedStore = createStore();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      executeNativeWhiteboardDeleteEffect({
        store: abortedStore,
        targetBinding: prepareNativeWhiteboardDeleteTarget(abortedStore, target, 'whiteboard-1'),
        stableElementId: 'delete-me',
        expectedWhiteboardId: 'whiteboard-1',
        expectedElementType: 'text',
        signal: controller.signal,
      }),
    ).toThrowError(DOMException);
    expect(
      abortedStore
        .getState()
        .stage?.whiteboard?.[0].elements.some((element) => element.id === 'delete-me'),
    ).toBe(true);
  });
});
