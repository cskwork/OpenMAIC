import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createRevisionedDrawChartDigests,
  createRevisionedDrawLatexDigests,
  createRevisionedDrawTableDigests,
  type RevisionedDrawChartIntent,
  type RevisionedDrawLatexIntent,
  type RevisionedDrawTableIntent,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { digestRevisionedWhiteboardTableStateV2Sync } from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { renderNativeWhiteboardLatexHtmlV1 } from '@/lib/action/whiteboard-latex';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { PPTTableElement } from '@openmaic/dsl';

function board(id: string, elements: Whiteboard['elements'] = []): Whiteboard {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements,
    background: { type: 'solid', color: '#ffffff' },
    animations: [],
  };
}

function stage(whiteboards: Whiteboard[] = [board('board-1'), board('board-2')]): Stage {
  return {
    id: 'stage-1',
    name: 'Preserve non-whiteboard fields',
    createdAt: 1,
    updatedAt: 2,
    whiteboard: whiteboards,
  };
}

function harness(whiteboards?: Whiteboard[]) {
  let open = false;
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: stage(whiteboards) }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
  return { store, authority, readOpen: () => open };
}

const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
};

function expected(authority: WhiteboardEnvironmentAuthority) {
  const snapshot = authority.querySnapshot();
  if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
  return {
    stageId: snapshot.value.stageId,
    whiteboardId: snapshot.value.activeWhiteboardId,
    revision: snapshot.value.revision,
  };
}

describe('WhiteboardEnvironmentAuthority Stage 3B Batch 2 Draw tools', () => {
  it('derives strict LaTeX HTML and both exact digests inside the Authority transaction', () => {
    const { store, authority } = harness();
    const expectedBinding = expected(authority);
    const executionId = 'latex-authority';
    const deadlineAt = Date.now() + 10_000;
    const intent: RevisionedDrawLatexIntent = {
      latex: '\\frac{x}{2}',
      x: 20,
      y: 30,
      width: 300,
      height: 80,
      color: '#123456',
    };
    const digests = createRevisionedDrawLatexDigests({
      executionId,
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent,
    })!;
    const result = authority.transactRevisionedDrawLatex({
      executionId,
      requestDigest: digests.requestDigest,
      expected: expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intentDigest: digests.intentDigest,
      intent: digests.normalizedIntent,
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.receipt).toMatchObject({
      outcome: 'committed',
      toolName: 'wb_draw_latex',
      delta: { kind: 'whiteboard_latex_created_v2', elementCountAfter: 1 },
      postcondition: {
        kind: 'whiteboard_latex_exists_v2',
        elementType: 'latex',
        matchingElementCount: 1,
      },
    });
    const element = store.getState().stage?.whiteboard?.[0].elements[0];
    expect(element).toMatchObject({
      type: 'latex',
      latex: '\\frac{x}{2}',
      html: renderNativeWhiteboardLatexHtmlV1('\\frac{x}{2}'),
      fixedRatio: true,
    });
  });

  it('rejects invalid KaTeX before any Authority write or revision change', () => {
    const { store, authority, readOpen } = harness();
    const before = structuredClone(store.getState().stage);
    const expectedBinding = expected(authority);
    const executionId = 'latex-invalid';
    const deadlineAt = Date.now() + 10_000;
    const digests = createRevisionedDrawLatexDigests({
      executionId,
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: { latex: '\\frac{', x: 10, y: 10 },
    })!;
    const result = authority.transactRevisionedDrawLatex({
      executionId,
      requestDigest: digests.requestDigest,
      expected: expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intentDigest: digests.intentDigest,
      intent: digests.normalizedIntent,
    });
    expect(result).toMatchObject({ ok: false, code: 'MUTATION_REQUEST_INVALID' });
    expect(store.getState().stage).toEqual(before);
    expect(readOpen()).toBe(false);
    expect(authority.querySnapshot()).toMatchObject({ ok: true, value: { revision: 0 } });
  });

  it('escapes Table text once and binds the receipt digest to cell_0..cell_n', () => {
    const { store, authority } = harness();
    const expectedBinding = expected(authority);
    const executionId = 'table-authority';
    const deadlineAt = Date.now() + 10_000;
    const intent: RevisionedDrawTableIntent = {
      data: [
        ['<b>&', 'Value'],
        ['A', '1'],
      ],
      x: 10,
      y: 20,
      width: 400,
      height: 120,
    };
    const digests = createRevisionedDrawTableDigests({
      executionId,
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent,
    })!;
    const input = {
      executionId,
      requestDigest: digests.requestDigest,
      expected: expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intentDigest: digests.intentDigest,
      intent: digests.normalizedIntent,
    };
    const result = authority.transactRevisionedDrawTable(input);
    if (!result.ok) throw new Error(result.code);
    const element = store.getState().stage?.whiteboard?.[0].elements[0] as PPTTableElement;
    expect(element.data.flat().map(({ id }) => id)).toEqual([
      'cell_0',
      'cell_1',
      'cell_2',
      'cell_3',
    ]);
    expect(element.data[0][0].text).toBe('&lt;b&gt;&amp;');
    expect(element.data[0][0].text).not.toContain('&amp;lt;');
    expect(result.receipt).toMatchObject({
      outcome: 'committed',
      toolName: 'wb_draw_table',
      postcondition: {
        kind: 'whiteboard_table_exists_v2',
        observedTableDigest: digestRevisionedWhiteboardTableStateV2Sync(element),
      },
    });
    expect(authority.transactRevisionedDrawTable(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: result.receipt,
    });
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
  });

  it('preserves exact Chart alpha/theme data and unrelated Stage state', () => {
    const { store, authority } = harness();
    const before = structuredClone(store.getState().stage!);
    const expectedBinding = expected(authority);
    const executionId = 'chart-authority';
    const deadlineAt = Date.now() + 10_000;
    const intent: RevisionedDrawChartIntent = {
      chartType: 'bar',
      x: 10,
      y: 20,
      width: 500,
      height: 300,
      data: { labels: ['A'], legends: ['S'], series: [[1]] },
      themeColors: ['rgb(237, 125, 49)', 'rgba(68, 114, 196, 0.1234)'],
    };
    const digests = createRevisionedDrawChartDigests({
      executionId,
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent,
    })!;
    const result = authority.transactRevisionedDrawChart({
      executionId,
      requestDigest: digests.requestDigest,
      expected: expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intentDigest: digests.intentDigest,
      intent: digests.normalizedIntent,
    });
    if (!result.ok) throw new Error(result.code);
    const after = store.getState().stage!;
    expect({ ...after, whiteboard: undefined }).toEqual({ ...before, whiteboard: undefined });
    expect(after.whiteboard?.[1]).toEqual(before.whiteboard?.[1]);
    expect(after.whiteboard?.[0].elements[0]).toMatchObject({
      type: 'chart',
      themeColors: ['#ed7d31', 'rgba(68, 114, 196, 0.1234)'],
    });
    expect(result.receipt).toMatchObject({
      outcome: 'committed',
      toolName: 'wb_draw_chart',
      currentBinding: { revision: 1 },
      postcondition: {
        kind: 'whiteboard_chart_exists_v2',
        elementType: 'chart',
        matchingElementCount: 1,
      },
    });
  });
});
