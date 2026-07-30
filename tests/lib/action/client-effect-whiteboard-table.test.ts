import { describe, expect, it } from 'vitest';
import type { PPTTableElement } from '@openmaic/dsl';
import {
  executeNativeWhiteboardTableEffect,
  prepareNativeWhiteboardTarget,
  verifyNativeWhiteboardTableEffect,
  type NativeWbDrawTableInput,
} from '@/lib/action/client-effect-whiteboard';
import {
  createWhiteboardTableElement,
  escapeWhiteboardTableCellText,
} from '@/lib/action/whiteboard-tables';
import {
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  digestWhiteboardTableV1,
  normalizeWhiteboardTableV1,
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

const input: NativeWbDrawTableInput = {
  executionId: 'execution-table-1',
  stableElementId: 'table-1',
  data: [
    ['参数', '作用'],
    ['k', '决定方向'],
    ['b', '决定高低'],
  ],
  x: 80,
  y: 60,
  width: 600,
  height: 240,
  theme: { color: '#4472c4' },
};

async function expectedTable(tableInput: NativeWbDrawTableInput = input) {
  const table = normalizeWhiteboardTableV1(tableInput);
  return { table, digest: await digestWhiteboardTableV1(table) };
}

describe('native wb_draw_table client effect', () => {
  it('renders one deterministic table and verifies its complete trusted spec', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedTable();
    const result = await executeNativeWhiteboardTableEffect({
      store,
      targetBinding: binding,
      input,
      expectedTable: expected.table,
      expectedTableDigest: expected.digest,
    });

    expect(result).toEqual({
      replayed: false,
      postcondition: {
        stableElementId: input.stableElementId,
        elementType: 'table',
        normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
        observedTableDigest: expected.digest,
        matchingElementCount: 1,
      },
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTTableElement & {
      clientEffectExecutionId?: string;
      clientEffectTableDigest?: string;
    };
    expect(element).toMatchObject({
      id: input.stableElementId,
      type: 'table',
      left: 80,
      top: 60,
      width: 600,
      height: 240,
      rotate: 0,
      colWidths: [0.5, 0.5],
      cellMinHeight: 36,
      outline: { width: 2, style: 'solid', color: '#eeece1' },
      theme: {
        color: '#4472c4',
        rowHeader: true,
        rowFooter: false,
        colHeader: false,
        colFooter: false,
      },
      clientEffectExecutionId: input.executionId,
      clientEffectTableDigest: expected.digest,
    });
    expect(element.data.flat().map((cell) => cell.id)).toEqual([
      'cell_0',
      'cell_1',
      'cell_2',
      'cell_3',
      'cell_4',
      'cell_5',
    ]);
  });

  it('escapes model-controlled HTML only in the Native path while preserving Legacy data', async () => {
    const unsafe = `<img src=x onerror="alert(1)"> & 'quoted'`;
    const nativeInput = { ...input, data: [['header'], [unsafe]] };
    const expected = await expectedTable(nativeInput);
    expect(expected.table.data[1][0]).toBe(escapeWhiteboardTableCellText(unsafe));
    expect(expected.table.data[1][0]).not.toContain('<img');

    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    await executeNativeWhiteboardTableEffect({
      store,
      targetBinding: binding,
      input: nativeInput,
      expectedTable: expected.table,
      expectedTableDigest: expected.digest,
    });
    const nativeElement = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTTableElement;
    expect(nativeElement.data[1][0].text).toBe(escapeWhiteboardTableCellText(unsafe));

    const legacyElement = createWhiteboardTableElement({
      id: 'legacy',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      data: [[unsafe]],
    });
    expect(legacyElement?.data[0][0].text).toBe(unsafe);
  });

  it('replays the same execution without adding a second element', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedTable();
    await executeNativeWhiteboardTableEffect({
      store,
      targetBinding: binding,
      input,
      expectedTable: expected.table,
      expectedTableDigest: expected.digest,
    });
    const replay = await executeNativeWhiteboardTableEffect({
      store,
      targetBinding: binding,
      input,
      expectedTable: expected.table,
      expectedTableDigest: expected.digest,
    });

    expect(replay.replayed).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);
  });

  it('fails closed when table content, cell structure, or ownership changes', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedTable();
    await executeNativeWhiteboardTableEffect({
      store,
      targetBinding: binding,
      input,
      expectedTable: expected.table,
      expectedTableDigest: expected.digest,
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTTableElement & {
      clientEffectExecutionId?: string;
    };
    element.data[1][1].text = 'tampered';
    await expect(
      verifyNativeWhiteboardTableEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedTable: expected.table,
        expectedTableDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TABLE_MISMATCH');

    element.data[1][1].text = expected.table.data[1][1];
    element.data[0][0].id = 'unexpected-cell';
    await expect(
      verifyNativeWhiteboardTableEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedTable: expected.table,
        expectedTableDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TABLE_ELEMENT_MISMATCH');

    element.data[0][0].id = 'cell_0';
    element.clientEffectExecutionId = 'other-execution';
    await expect(
      verifyNativeWhiteboardTableEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedTable: expected.table,
        expectedTableDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
  });

  it.each([
    [{ ...input, data: [] }, 'CLIENT_EFFECT_TABLE_INPUT_INVALID'],
    [{ ...input, data: [['a'], ['b', 'c']] }, 'CLIENT_EFFECT_TABLE_DIMENSIONS_INVALID'],
    [
      { ...input, data: Array.from({ length: 13 }, () => ['x']) },
      'CLIENT_EFFECT_TABLE_INPUT_INVALID',
    ],
    [
      { ...input, data: [Array.from({ length: 9 }, () => 'x')] },
      'CLIENT_EFFECT_TABLE_DIMENSIONS_INVALID',
    ],
    [{ ...input, data: [['x'.repeat(257)]] }, 'CLIENT_EFFECT_TABLE_CELL_INVALID'],
    [{ ...input, data: [['x\tbad']] }, 'CLIENT_EFFECT_TABLE_CELL_INVALID'],
    [{ ...input, x: 900, width: 200 }, 'CLIENT_EFFECT_TABLE_BOUNDS_INVALID'],
    [
      { ...input, outline: { width: 2, style: 'dotted' as 'solid', color: '#000' } },
      'CLIENT_EFFECT_TABLE_OUTLINE_INVALID',
    ],
  ])('rejects invalid table state before mutation', async (invalid, code) => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedTable();
    await expect(
      executeNativeWhiteboardTableEffect({
        store,
        targetBinding: binding,
        input: invalid,
        expectedTable: expected.table,
        expectedTableDigest: expected.digest,
      }),
    ).rejects.toThrow(code);
    expect(store.getState().stage?.whiteboard?.[0]?.elements ?? []).toHaveLength(0);
  });

  it('rejects request/input drift and scene changes before mutation', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedTable();
    await expect(
      executeNativeWhiteboardTableEffect({
        store,
        targetBinding: binding,
        input: { ...input, data: [['different']] },
        expectedTable: expected.table,
        expectedTableDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_REQUEST_TABLE_MISMATCH');

    store.setState({ currentSceneId: 'scene-2' });
    await expect(
      executeNativeWhiteboardTableEffect({
        store,
        targetBinding: binding,
        input,
        expectedTable: expected.table,
        expectedTableDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');
  });
});
