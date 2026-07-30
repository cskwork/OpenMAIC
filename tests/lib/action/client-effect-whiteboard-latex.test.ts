import { describe, expect, it } from 'vitest';
import type { PPTLatexElement } from '@openmaic/dsl';
import {
  executeNativeWhiteboardLatexEffect,
  prepareNativeWhiteboardTarget,
  verifyNativeWhiteboardLatexEffect,
  type NativeWbDrawLatexInput,
} from '@/lib/action/client-effect-whiteboard';
import {
  createWhiteboardLatexElement,
  renderLegacyWhiteboardLatexHtml,
  renderNativeWhiteboardLatexHtmlV1,
} from '@/lib/action/whiteboard-latex';
import {
  CLIENT_EFFECT_LATEX_RENDER_VERSION,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardLatexV1,
  normalizeWhiteboardLatexV1,
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

const input: NativeWbDrawLatexInput = {
  executionId: 'execution-latex-1',
  stableElementId: 'latex-1',
  latex: String.raw`\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
  x: 120,
  y: 80,
  width: 500,
  height: 100,
  color: '#2244aa',
};

async function expectedLatex(latexInput: NativeWbDrawLatexInput = input) {
  const latex = normalizeWhiteboardLatexV1(latexInput);
  const html = renderNativeWhiteboardLatexHtmlV1(latex.latex);
  return {
    latex,
    html,
    formulaDigest: await digestWhiteboardLatexV1(latex),
    htmlDigest: await digestWhiteboardLatexHtmlV1(html),
  };
}

describe('native wb_draw_latex client effect', () => {
  it.each([
    String.raw`\frac{a}{b}`,
    String.raw`\begin{matrix}a & b\\c & d\end{matrix}`,
    String.raw`\begin{cases}x+1,&x>0\\0,&x\le0\end{cases}`,
    String.raw`\text{函数}~y=2x+1`,
  ])('renders valid strict KaTeX and verifies both formula and HTML digests: %s', async (latex) => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const caseInput = { ...input, latex };
    const expected = await expectedLatex(caseInput);
    const result = await executeNativeWhiteboardLatexEffect({
      store,
      targetBinding: binding,
      input: caseInput,
      expectedLatex: expected.latex,
      expectedFormulaDigest: expected.formulaDigest,
      expectedHtmlDigest: expected.htmlDigest,
    });

    expect(result).toMatchObject({
      replayed: false,
      postcondition: {
        stableElementId: input.stableElementId,
        elementType: 'latex',
        latex,
        bounds: { x: 120, y: 80, width: 500, height: 100 },
        color: '#2244aa',
        renderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
        observedFormulaDigest: expected.formulaDigest,
        observedHtmlDigest: expected.htmlDigest,
        matchingElementCount: 1,
      },
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTLatexElement & {
      clientEffectExecutionId?: string;
      clientEffectFormulaDigest?: string;
      clientEffectHtmlDigest?: string;
    };
    expect(element).toMatchObject({
      id: input.stableElementId,
      type: 'latex',
      left: 120,
      top: 80,
      width: 500,
      height: 100,
      rotate: 0,
      latex,
      html: expected.html,
      color: '#2244aa',
      fixedRatio: true,
      clientEffectExecutionId: input.executionId,
      clientEffectFormulaDigest: expected.formulaDigest,
      clientEffectHtmlDigest: expected.htmlDigest,
    });
  });

  it('keeps Native defaults mechanically equal to the Legacy element factory', () => {
    const normalized = normalizeWhiteboardLatexV1({ latex: 'x^2', x: 10, y: 20 });
    const html = renderLegacyWhiteboardLatexHtml('x^2');
    const legacy = createWhiteboardLatexElement({
      id: 'legacy-latex',
      latex: 'x^2',
      x: 10,
      y: 20,
      html,
    });

    expect(normalized).toEqual({
      latex: 'x^2',
      bounds: { x: 10, y: 20, width: 400, height: 80 },
      color: '#000000',
      renderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
    });
    expect(legacy).toMatchObject({
      left: normalized.bounds.x,
      top: normalized.bounds.y,
      width: normalized.bounds.width,
      height: normalized.bounds.height,
      color: normalized.color,
      fixedRatio: true,
      rotate: 0,
    });
  });

  it('replays once and fails closed when source, HTML, or geometry changes', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedLatex();
    await executeNativeWhiteboardLatexEffect({
      store,
      targetBinding: binding,
      input,
      expectedLatex: expected.latex,
      expectedFormulaDigest: expected.formulaDigest,
      expectedHtmlDigest: expected.htmlDigest,
    });
    const replay = await executeNativeWhiteboardLatexEffect({
      store,
      targetBinding: binding,
      input,
      expectedLatex: expected.latex,
      expectedFormulaDigest: expected.formulaDigest,
      expectedHtmlDigest: expected.htmlDigest,
    });

    expect(replay.replayed).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);

    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTLatexElement;
    element.html = renderLegacyWhiteboardLatexHtml('x+1');
    await expect(
      verifyNativeWhiteboardLatexEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedLatex: expected.latex,
        expectedFormulaDigest: expected.formulaDigest,
        expectedHtmlDigest: expected.htmlDigest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_LATEX_MISMATCH');
  });

  it.each([
    [{ ...input, latex: '   ' }, 'CLIENT_EFFECT_LATEX_INPUT_INVALID'],
    [{ ...input, latex: 'x'.repeat(2_001) }, 'CLIENT_EFFECT_LATEX_INPUT_INVALID'],
    [{ ...input, latex: String.raw`\frac{a}{` }, 'CLIENT_EFFECT_LATEX_RENDER_INVALID'],
    [{ ...input, latex: String.raw`\notacommand{x}` }, 'CLIENT_EFFECT_LATEX_RENDER_INVALID'],
    [{ ...input, latex: '\text{x}' }, 'CLIENT_EFFECT_LATEX_INPUT_INVALID'],
    [{ ...input, x: 900, width: 200 }, 'CLIENT_EFFECT_LATEX_BOUNDS_INVALID'],
    [{ ...input, height: 0 }, 'CLIENT_EFFECT_LATEX_BOUNDS_INVALID'],
  ])('rejects invalid formula state before mutation', async (invalid, code) => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedLatex();

    await expect(
      executeNativeWhiteboardLatexEffect({
        store,
        targetBinding: binding,
        input: invalid,
        expectedLatex: expected.latex,
        expectedFormulaDigest: expected.formulaDigest,
        expectedHtmlDigest: expected.htmlDigest,
      }),
    ).rejects.toThrow(code);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(0);
  });

  it('cancels on scene change or request abort before mutation', async () => {
    const changedStore = createStore();
    const changedBinding = prepareNativeWhiteboardTarget(changedStore, target);
    const expected = await expectedLatex();
    changedStore.setState({ currentSceneId: 'scene-2' });

    await expect(
      executeNativeWhiteboardLatexEffect({
        store: changedStore,
        targetBinding: changedBinding,
        input,
        expectedLatex: expected.latex,
        expectedFormulaDigest: expected.formulaDigest,
        expectedHtmlDigest: expected.htmlDigest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');

    const abortedStore = createStore();
    const abortedBinding = prepareNativeWhiteboardTarget(abortedStore, target);
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeNativeWhiteboardLatexEffect({
        store: abortedStore,
        targetBinding: abortedBinding,
        input,
        expectedLatex: expected.latex,
        expectedFormulaDigest: expected.formulaDigest,
        expectedHtmlDigest: expected.htmlDigest,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedStore.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(0);
  });
});
