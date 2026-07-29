import { describe, expect, it } from 'vitest';
import {
  executeNativeWhiteboardTextEffect,
  prepareNativeWhiteboardTarget,
  verifyNativeWhiteboardTextEffect,
  type NativeWbDrawTextInput,
} from '@/lib/action/client-effect-whiteboard';
import { digestVisibleTextV1 } from '@/lib/agent/runtime/client-effect-contract';
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

const target = {
  requestId: 'request-1',
  sessionId: 'session-1',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  messageId: 'message-1',
};

const input: NativeWbDrawTextInput = {
  executionId: 'execution-1',
  stableElementId: 'element-1',
  content: 'k < 0 & b > 0\n一次函数',
  x: 100,
  y: 120,
};

describe('native wb_draw_text client effect', () => {
  it('binds and writes only to an explicit whiteboard, then verifies the real element', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const result = await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest: await digestVisibleTextV1(input.content),
    });

    expect(result.replayed).toBe(false);
    expect(result.postcondition).toMatchObject({
      stableElementId: input.stableElementId,
      observedContentDigest: await digestVisibleTextV1(input.content),
      matchingElementCount: 1,
    });
    const whiteboard = store
      .getState()
      .stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId);
    expect(whiteboard?.elements).toHaveLength(1);
    expect(whiteboard?.elements[0]).toMatchObject({
      id: input.stableElementId,
      type: 'text',
      clientEffectExecutionId: input.executionId,
    });
    expect((whiteboard?.elements[0] as { content?: string }).content).toContain(
      'k &lt; 0 &amp; b &gt; 0',
    );
  });

  it('replays an existing matching element without adding another element', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expectedContentDigest = await digestVisibleTextV1(input.content);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest,
    });
    const replay = await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest,
    });

    expect(replay.replayed).toBe(true);
    expect(
      store.getState().stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId)
        ?.elements,
    ).toHaveLength(1);
  });

  it('writes to the accepted whiteboard instead of a newer whiteboard', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    store.getState().stage?.whiteboard?.push({
      id: 'newer-whiteboard',
      viewportSize: 1000,
      viewportRatio: 16 / 9,
      elements: [],
      background: { type: 'solid', color: '#fff' },
      animations: [],
    });

    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest: await digestVisibleTextV1(input.content),
    });

    const whiteboards = store.getState().stage?.whiteboard;
    expect(
      whiteboards?.find((candidate) => candidate.id === binding.whiteboardId)?.elements,
    ).toHaveLength(1);
    expect(
      whiteboards?.find((candidate) => candidate.id === 'newer-whiteboard')?.elements,
    ).toHaveLength(0);
  });

  it('rejects request content mismatch before drawing', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    await expect(
      executeNativeWhiteboardTextEffect({
        store,
        targetBinding: binding,
        input,
        expectedContentDigest: await digestVisibleTextV1('different request'),
      }),
    ).rejects.toThrow('CLIENT_EFFECT_REQUEST_CONTENT_MISMATCH');
    expect(
      store.getState().stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId)
        ?.elements,
    ).toHaveLength(0);
  });

  it('fails closed if the scene changes before mutation', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    store.setState({ currentSceneId: 'scene-2' });

    await expect(
      executeNativeWhiteboardTextEffect({
        store,
        targetBinding: binding,
        input,
        expectedContentDigest: await digestVisibleTextV1(input.content),
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');
    expect(
      store.getState().stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId)
        ?.elements,
    ).toHaveLength(0);
  });

  it('fails closed for a duplicate stable element ID', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest: await digestVisibleTextV1(input.content),
    });
    const whiteboard = store
      .getState()
      .stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId);
    whiteboard?.elements.push({ ...whiteboard.elements[0] });

    await expect(
      verifyNativeWhiteboardTextEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedContentDigest: await digestVisibleTextV1(input.content),
      }),
    ).rejects.toThrow('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  });

  it('fails closed for the right ID with mismatched visible content', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest: await digestVisibleTextV1(input.content),
    });
    const element = store
      .getState()
      .stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId)
      ?.elements.find((candidate) => candidate.id === input.stableElementId) as
      | { content?: string }
      | undefined;
    if (element) element.content = '<p style="font-size: 18px;">wrong</p>';

    await expect(
      verifyNativeWhiteboardTextEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedContentDigest: await digestVisibleTextV1(input.content),
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CONTENT_MISMATCH');
  });

  it('revalidates scene identity after asynchronous digest verification', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expectedContentDigest = await digestVisibleTextV1(input.content);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest,
    });

    const verification = verifyNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      executionId: input.executionId,
      stableElementId: input.stableElementId,
      expectedContentDigest,
    });
    queueMicrotask(() => store.setState({ currentSceneId: 'scene-2' }));

    await expect(verification).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');
  });

  it('fails closed if element content changes during digest verification', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expectedContentDigest = await digestVisibleTextV1(input.content);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest,
    });

    const verification = verifyNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      executionId: input.executionId,
      stableElementId: input.stableElementId,
      expectedContentDigest,
    });
    queueMicrotask(() => {
      const element = store
        .getState()
        .stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId)
        ?.elements.find((candidate) => candidate.id === input.stableElementId) as
        | { content?: string }
        | undefined;
      if (element) element.content = '<p style="font-size: 18px;">changed</p>';
    });

    await expect(verification).rejects.toThrow('CLIENT_EFFECT_CONTENT_MISMATCH');
  });

  it('fails closed if the element is deleted during digest verification', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expectedContentDigest = await digestVisibleTextV1(input.content);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest,
    });

    const verification = verifyNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      executionId: input.executionId,
      stableElementId: input.stableElementId,
      expectedContentDigest,
    });
    queueMicrotask(() => {
      const whiteboard = store
        .getState()
        .stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId);
      if (whiteboard) whiteboard.elements = [];
    });

    await expect(verification).rejects.toThrow('CLIENT_EFFECT_ELEMENT_NOT_FOUND');
  });

  it('fails closed if a duplicate appears during digest verification', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expectedContentDigest = await digestVisibleTextV1(input.content);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest,
    });

    const verification = verifyNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      executionId: input.executionId,
      stableElementId: input.stableElementId,
      expectedContentDigest,
    });
    queueMicrotask(() => {
      const whiteboard = store
        .getState()
        .stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId);
      if (whiteboard) whiteboard.elements.push({ ...whiteboard.elements[0] });
    });

    await expect(verification).rejects.toThrow('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  });

  it('does not return a commit candidate when aborted after mutation', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const controller = new AbortController();
    const originalSetState = store.setState;
    store.setState = (partial) => {
      originalSetState(partial);
      const hasElement = store
        .getState()
        .stage?.whiteboard?.some((whiteboard) =>
          whiteboard.elements.some((element) => element.id === input.stableElementId),
        );
      if (hasElement) controller.abort();
    };

    await expect(
      executeNativeWhiteboardTextEffect({
        store,
        targetBinding: binding,
        input,
        expectedContentDigest: await digestVisibleTextV1(input.content),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      store.getState().stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId)
        ?.elements,
    ).toHaveLength(1);
  });

  it('does not return a commit candidate when aborted during verification', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expectedContentDigest = await digestVisibleTextV1(input.content);
    await executeNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      input,
      expectedContentDigest,
    });
    const controller = new AbortController();
    const verification = verifyNativeWhiteboardTextEffect({
      store,
      targetBinding: binding,
      executionId: input.executionId,
      stableElementId: input.stableElementId,
      expectedContentDigest,
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());

    await expect(verification).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects whitespace-only content and an unreasonable font size before mutation', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);

    for (const invalidInput of [
      { ...input, content: ' \r\n\u00a0 ' },
      { ...input, stableElementId: '   ' },
      { ...input, fontSize: 0.5 },
      { ...input, fontSize: 513 },
    ]) {
      await expect(
        executeNativeWhiteboardTextEffect({
          store,
          targetBinding: binding,
          input: invalidInput,
          expectedContentDigest: await digestVisibleTextV1(invalidInput.content),
        }),
      ).rejects.toThrow('CLIENT_EFFECT_INPUT_INVALID');
    }
    expect(
      store.getState().stage?.whiteboard?.find((candidate) => candidate.id === binding.whiteboardId)
        ?.elements,
    ).toHaveLength(0);
  });
});
