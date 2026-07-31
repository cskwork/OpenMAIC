import { describe, expect, it } from 'vitest';
import type { PPTCodeElement } from '@openmaic/dsl';
import type { StageStore } from '@/lib/api/stage-api';
import {
  executeNativeWhiteboardCodeEditEffect,
  prepareNativeExistingWhiteboardTarget,
} from '@/lib/action/client-effect-whiteboard';
import {
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  applyWhiteboardCodeEditV1,
  assertWhiteboardEditableCodeStateV1,
  digestWhiteboardEditableCodeStateV1,
  type WhiteboardEditableCodeState,
} from '@/lib/agent/runtime/client-effect-contract';

const before: WhiteboardEditableCodeState = {
  language: 'python',
  lines: [
    { id: 'A', content: 'a = 1' },
    { id: 'B', content: 'b = 2' },
    { id: 'C', content: 'print(a + b)' },
    { id: 'D', content: 'done = True' },
  ],
  fileName: 'main.py',
  bounds: { x: 80, y: 60, width: 600, height: 300 },
  showLineNumbers: true,
  fontSize: 14,
  rotate: 0,
};

function createStore(state: WhiteboardEditableCodeState = before): StageStore {
  let current = {
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
          background: { type: 'solid' as const, color: '#ffffff' },
          animations: [],
          elements: [
            {
              id: 'code-1',
              type: 'code' as const,
              language: state.language,
              lines: state.lines.map((line) => ({ ...line })),
              fileName: state.fileName,
              showLineNumbers: state.showLineNumbers,
              fontSize: state.fontSize,
              left: state.bounds.x,
              top: state.bounds.y,
              width: state.bounds.width,
              height: state.bounds.height,
              rotate: state.rotate,
            },
          ],
        },
      ],
    },
    scenes: [{ id: 'scene-1' }, { id: 'scene-2' }],
    currentSceneId: 'scene-1',
    mode: 'playback' as const,
  };
  return {
    getState: () => current,
    setState: (partial: Partial<typeof current>) => {
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

async function executeEdit(opts: {
  store: StageStore;
  executionId: string;
  intent: Parameters<typeof applyWhiteboardCodeEditV1>[0]['intent'];
}) {
  const transition = applyWhiteboardCodeEditV1({
    before,
    intent: opts.intent,
    executionId: opts.executionId,
  });
  const binding = prepareNativeExistingWhiteboardTarget(opts.store, target, 'whiteboard-1');
  return executeNativeWhiteboardCodeEditEffect({
    store: opts.store,
    targetBinding: binding,
    executionId: opts.executionId,
    stableElementId: 'code-1',
    expectedWhiteboardId: 'whiteboard-1',
    expectedBeforeCodeDigest: await digestWhiteboardEditableCodeStateV1(before),
    expectedAfterCodeState: transition.after,
    expectedAfterCodeDigest: await digestWhiteboardEditableCodeStateV1(transition.after),
    noOp: transition.noOp,
  });
}

describe('native wb_edit_code client effect', () => {
  it('rejects control characters in metadata while preserving tabs in code content', () => {
    for (const id of ['bad\tid', 'bad\nid', 'bad\u2028id', 'bad\u2029id']) {
      expect(() =>
        assertWhiteboardEditableCodeStateV1({
          ...before,
          lines: [{ id, content: 'value' }],
        }),
      ).toThrow('CLIENT_EFFECT_CODE_EDIT_LINE_ID_INVALID');
    }
    for (const language of ['type\tscript', 'type\nscript', 'type\u2028script']) {
      expect(() => assertWhiteboardEditableCodeStateV1({ ...before, language })).toThrow(
        'CLIENT_EFFECT_CODE_EDIT_LANGUAGE_INVALID',
      );
    }
    for (const fileName of ['main\t.py', 'main\n.py', 'main\u2029.py']) {
      expect(() => assertWhiteboardEditableCodeStateV1({ ...before, fileName })).toThrow(
        'CLIENT_EFFECT_CODE_EDIT_FILE_NAME_INVALID',
      );
    }
    expect(
      assertWhiteboardEditableCodeStateV1({
        ...before,
        lines: [{ id: 'safe-line', content: 'const\tvalue = 1;' }],
      }).lines,
    ).toEqual([{ id: 'safe-line', content: 'const\tvalue = 1;' }]);
    expect(() =>
      assertWhiteboardEditableCodeStateV1({
        ...before,
        lines: [{ id: 'safe-line', content: 'forged\u2028line' }],
      }),
    ).toThrow('CLIENT_EFFECT_CODE_EDIT_CONTENT_INVALID');
  });

  it('freezes deterministic insert IDs and treats empty content as one blank line', () => {
    const result = applyWhiteboardCodeEditV1({
      before,
      intent: {
        elementId: 'code-1',
        operation: 'insert_after',
        lineId: 'B',
        content: '',
      },
      executionId: 'edit-1',
    });

    expect(result.after.lines).toEqual([
      before.lines[0],
      before.lines[1],
      { id: 'CE_edit-1_3', content: '' },
      before.lines[2],
      before.lines[3],
    ]);
    expect(result.newLineIds).toEqual(['CE_edit-1_3']);
    expect(result.noOp).toBe(false);
  });

  it('uses the surviving-line anchor rule for non-contiguous, non-source-ordered replace IDs', () => {
    const result = applyWhiteboardCodeEditV1({
      before,
      intent: {
        elementId: 'code-1',
        operation: 'replace_lines',
        lineIds: ['C', 'A'],
        content: 'first\nsecond\nthird',
      },
      executionId: 'edit-2',
    });

    expect(result.after.lines).toEqual([
      { id: 'B', content: 'b = 2' },
      { id: 'C', content: 'first' },
      { id: 'A', content: 'second' },
      { id: 'CE_edit-2_4', content: 'third' },
      { id: 'D', content: 'done = True' },
    ]);
  });

  it('allows delete-all, rejects duplicate targets, and detects a valid no-op', () => {
    expect(
      applyWhiteboardCodeEditV1({
        before,
        intent: {
          elementId: 'code-1',
          operation: 'delete_lines',
          lineIds: ['A', 'B', 'C', 'D'],
        },
        executionId: 'edit-delete',
      }).after.lines,
    ).toEqual([]);

    expect(() =>
      applyWhiteboardCodeEditV1({
        before,
        intent: {
          elementId: 'code-1',
          operation: 'delete_lines',
          lineIds: ['A', 'A'],
        },
        executionId: 'edit-duplicate',
      }),
    ).toThrow('CLIENT_EFFECT_CODE_EDIT_TARGET_DUPLICATE');

    expect(
      applyWhiteboardCodeEditV1({
        before,
        intent: {
          elementId: 'code-1',
          operation: 'replace_lines',
          lineIds: ['B'],
          content: 'b = 2',
        },
        executionId: 'edit-no-op',
      }).noOp,
    ).toBe(true);

    expect(
      applyWhiteboardCodeEditV1({
        before,
        intent: {
          elementId: 'code-1',
          operation: 'replace_lines',
          lineIds: ['B'],
          content: '',
        },
        executionId: 'edit-empty-replace',
      }).after.lines[1],
    ).toEqual({ id: 'B', content: '' });
  });

  it('edits a pre-existing Legacy element, preserves its ID, and verifies before/after digests', async () => {
    const store = createStore();
    const result = await executeEdit({
      store,
      executionId: 'edit-browser-1',
      intent: {
        elementId: 'code-1',
        operation: 'replace_lines',
        lineIds: ['B'],
        content: 'b = 3',
      },
    });

    expect(result.replayed).toBe(false);
    expect(result.postcondition).toMatchObject({
      stableElementId: 'code-1',
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
      expectedWhiteboardId: 'whiteboard-1',
      matchingElementCount: 1,
      noOp: false,
    });
    const elements = store.getState().stage?.whiteboard?.[0]?.elements ?? [];
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      id: 'code-1',
      lines: [before.lines[0], { id: 'B', content: 'b = 3' }, before.lines[2], before.lines[3]],
      clientEffectLastEditExecutionId: 'edit-browser-1',
    });
  });

  it('replays the same receipt after runtime reconstruction without a second visible mutation', async () => {
    const store = createStore();
    const intent = {
      elementId: 'code-1',
      operation: 'insert_before' as const,
      lineId: 'A',
      content: '# intro',
    };
    const first = await executeEdit({ store, executionId: 'edit-replay', intent });
    const transition = applyWhiteboardCodeEditV1({
      before,
      intent,
      executionId: 'edit-replay',
    });
    const binding = prepareNativeExistingWhiteboardTarget(store, target, 'whiteboard-1');
    const replay = await executeNativeWhiteboardCodeEditEffect({
      store,
      targetBinding: binding,
      executionId: 'edit-replay',
      stableElementId: 'code-1',
      expectedWhiteboardId: 'whiteboard-1',
      expectedBeforeCodeDigest: await digestWhiteboardEditableCodeStateV1(before),
      expectedAfterCodeState: transition.after,
      expectedAfterCodeDigest: await digestWhiteboardEditableCodeStateV1(transition.after),
      noOp: false,
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);
  });

  it('accepts an exact no-op replay but rejects another execution with the same visible digest', async () => {
    const store = createStore();
    const intent = {
      elementId: 'code-1',
      operation: 'replace_lines' as const,
      lineIds: ['B'],
      content: 'b = 2',
    };
    const first = await executeEdit({ store, executionId: 'edit-no-op-first', intent });
    expect(first.postcondition.noOp).toBe(true);

    const exactReplay = await executeEdit({
      store,
      executionId: 'edit-no-op-first',
      intent,
    });
    expect(exactReplay.replayed).toBe(true);

    await expect(
      executeEdit({
        store,
        executionId: 'edit-no-op-other',
        intent,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CODE_EDIT_STALE_BEFORE_STATE');
  });

  it('fails closed for a stale execution after another edit receipt and leaves the element unchanged', async () => {
    const store = createStore();
    await executeEdit({
      store,
      executionId: 'edit-newer',
      intent: {
        elementId: 'code-1',
        operation: 'replace_lines',
        lineIds: ['B'],
        content: 'b = 3',
      },
    });
    const snapshot = structuredClone(store.getState().stage?.whiteboard?.[0]?.elements);

    await expect(
      executeEdit({
        store,
        executionId: 'edit-stale',
        intent: {
          elementId: 'code-1',
          operation: 'replace_lines',
          lineIds: ['B'],
          content: 'b = 4',
        },
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CODE_EDIT_STALE_BEFORE_STATE');
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toEqual(snapshot);
  });

  it('does not create or switch whiteboards when the exact request-start board is missing', () => {
    const store = createStore();
    const stage = store.getState().stage!;
    store.setState({
      stage: {
        ...stage,
        whiteboard: [
          ...(stage.whiteboard ?? []),
          {
            ...stage.whiteboard![0],
            id: 'whiteboard-2',
            elements: [],
          },
        ],
      },
    });

    expect(() => prepareNativeExistingWhiteboardTarget(store, target, 'whiteboard-1')).toThrow(
      'CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_MISMATCH',
    );
    expect(store.getState().stage?.whiteboard).toHaveLength(2);
  });

  it('rejects a non-code target without requiring Native draw ownership metadata', async () => {
    const store = createStore();
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTCodeElement;
    Object.assign(element, { type: 'text' });
    const transition = applyWhiteboardCodeEditV1({
      before,
      intent: {
        elementId: 'code-1',
        operation: 'delete_lines',
        lineIds: ['A'],
      },
      executionId: 'edit-wrong-type',
    });
    const binding = prepareNativeExistingWhiteboardTarget(store, target, 'whiteboard-1');

    await expect(
      executeNativeWhiteboardCodeEditEffect({
        store,
        targetBinding: binding,
        executionId: 'edit-wrong-type',
        stableElementId: 'code-1',
        expectedWhiteboardId: 'whiteboard-1',
        expectedBeforeCodeDigest: await digestWhiteboardEditableCodeStateV1(before),
        expectedAfterCodeState: transition.after,
        expectedAfterCodeDigest: await digestWhiteboardEditableCodeStateV1(transition.after),
        noOp: false,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CODE_EDIT_ELEMENT_TYPE_MISMATCH');
  });
});
