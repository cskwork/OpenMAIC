import { describe, expect, it } from 'vitest';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_RENDER_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  digestWhiteboardChartV1,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardLatexV1,
  normalizeWhiteboardChartV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardTableIntentV1,
  normalizeWhiteboardTableV1,
} from '@/lib/agent/runtime/client-effect-contract';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedDrawChartDigests,
  createRevisionedDrawLatexDigests,
  createRevisionedDrawTableDigests,
  isRevisionedWhiteboardCommittedReceiptForExpected,
  isRevisionedWhiteboardEffectDelivery,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedWhiteboardExpectedDescriptor,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  deriveRevisionedElementId,
  deriveRevisionedWhiteboardId,
  digestRevisionedWhiteboardTableStateV2Sync,
  digestWhiteboardChartV1Sync,
  digestWhiteboardLatexHtmlV1Sync,
  digestWhiteboardLatexV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import {
  createWhiteboardLatexElement,
  renderNativeWhiteboardLatexHtmlV1,
} from '@/lib/action/whiteboard-latex';
import { createWhiteboardTableElement } from '@/lib/action/whiteboard-tables';

const expectedBinding = { stageId: 'stage-1', whiteboardId: null, revision: 0 } as const;
const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
} as const;

describe('Stage 3B Batch 2 strict renderer-backed contracts', () => {
  it('keeps LaTeX formula and rendered HTML sync digests equal to the v1 digests', async () => {
    const spec = normalizeWhiteboardLatexV1({
      latex: '\\frac{a}{b}',
      x: 20,
      y: 30,
      width: 300,
      height: 80,
      color: '#123456',
    });
    const html = renderNativeWhiteboardLatexHtmlV1(spec.latex);
    expect(digestWhiteboardLatexV1Sync(spec)).toBe(await digestWhiteboardLatexV1(spec));
    expect(digestWhiteboardLatexHtmlV1Sync(html)).toBe(await digestWhiteboardLatexHtmlV1(html));
    expect(
      createWhiteboardLatexElement({
        id: 'latex-1',
        latex: spec.latex,
        x: spec.bounds.x,
        y: spec.bounds.y,
        width: spec.bounds.width,
        height: spec.bounds.height,
        color: spec.color,
        html,
      }).html,
    ).toBe(html);
  });

  it('keeps canonical Table wire text unescaped and escapes it exactly once in the element spec', () => {
    const input = {
      data: [['<b>&', 'A\r\nB']],
      x: 10,
      y: 20,
      width: 400,
      height: 100,
    };
    const intent = normalizeWhiteboardTableIntentV1(input);
    expect(intent.data).toEqual([['<b>&', 'A\nB']]);
    const spec = normalizeWhiteboardTableV1({
      data: intent.data,
      x: intent.bounds.x,
      y: intent.bounds.y,
      width: intent.bounds.width,
      height: intent.bounds.height,
      outline: intent.outline,
      theme: intent.theme,
    });
    expect(spec.data).toEqual([['&lt;b&gt;&amp;', 'A\nB']]);
    expect(normalizeWhiteboardTableV1(input)).toEqual(spec);
  });

  it('binds the v2 Table state digest to ordered deterministic cell identities', () => {
    const spec = normalizeWhiteboardTableV1({
      data: [
        ['A', 'B'],
        ['1', '2'],
      ],
      x: 10,
      y: 20,
      width: 400,
      height: 120,
    });
    const element = createWhiteboardTableElement({
      id: 'table-1',
      x: spec.bounds.x,
      y: spec.bounds.y,
      width: spec.bounds.width,
      height: spec.bounds.height,
      data: spec.data,
      outline: spec.outline,
    });
    expect(element).not.toBeNull();
    const digest = digestRevisionedWhiteboardTableStateV2Sync(element!);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const forged = structuredClone(element!);
    forged.data[0][0].id = 'cell-forged';
    expect(() => digestRevisionedWhiteboardTableStateV2Sync(forged)).toThrow(
      'REVISIONED_WHITEBOARD_TABLE_STATE_INVALID',
    );
  });

  it('preserves canonical Chart color alpha in the sync digest', async () => {
    const chart = normalizeWhiteboardChartV1({
      chartType: 'bar',
      x: 0,
      y: 0,
      width: 600,
      height: 300,
      data: { labels: ['A'], legends: ['S'], series: [[1]] },
      themeColors: ['#ed7d31', 'rgba(68, 114, 196, 0.1234)'],
    });
    expect(chart.themeColors[1]).toBe('rgba(68, 114, 196, 0.1234)');
    expect(digestWhiteboardChartV1Sync(chart)).toBe(await digestWhiteboardChartV1(chart));
  });

  it.each(['wb_draw_latex', 'wb_draw_table', 'wb_draw_chart'] as const)(
    'requires the exact %s descriptor before registration',
    (toolName) => {
      const coordinator = new RevisionedWhiteboardCoordinator();
      expect(() =>
        coordinator.register({
          executionId: 'missing-' + toolName,
          requestDigest: 'sha256:' + 'a'.repeat(64),
          toolName,
          expectedBinding,
          authenticatedTarget,
          deadlineAt: Date.now() + 10_000,
          intentDigest: 'sha256:' + 'b'.repeat(64),
          observationAuthorizationDigest: 'sha256:' + 'c'.repeat(64),
        }),
      ).toThrow('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
    },
  );

  it('strictly correlates the three new delivery discriminants with canonical request digests', () => {
    const deadlineAt = Date.now() + 10_000;
    const latex = createRevisionedDrawLatexDigests({
      executionId: 'latex-delivery',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: { latex: 'x^2', x: 10, y: 20 },
    })!;
    const table = createRevisionedDrawTableDigests({
      executionId: 'table-delivery',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: { data: [['<x>']], x: 10, y: 20, width: 300, height: 100 },
    })!;
    const chart = createRevisionedDrawChartDigests({
      executionId: 'chart-delivery',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: {
        chartType: 'bar',
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        data: { labels: ['A'], legends: ['S'], series: [[1]] },
      },
    })!;
    const deliveries = [
      {
        executionId: 'latex-delivery',
        requestDigest: latex.requestDigest,
        toolName: 'wb_draw_latex',
        intent: latex.normalizedIntent,
      },
      {
        executionId: 'table-delivery',
        requestDigest: table.requestDigest,
        toolName: 'wb_draw_table',
        intent: table.normalizedIntent,
      },
      {
        executionId: 'chart-delivery',
        requestDigest: chart.requestDigest,
        toolName: 'wb_draw_chart',
        intent: chart.normalizedIntent,
      },
    ] as const;
    for (const delivery of deliveries) {
      const complete = {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        ...delivery,
        expectedBinding,
        authenticatedTarget,
        deadlineAt,
        acknowledgementToken: 'ack-token',
      };
      expect(isRevisionedWhiteboardEffectDelivery(complete)).toBe(true);
      expect(
        isRevisionedWhiteboardEffectDelivery({
          ...complete,
          intent: { ...complete.intent, x: 11 },
        }),
      ).toBe(false);
    }
    expect(table.normalizedIntent.data).toEqual([['<x>']]);
    expect(deriveRevisionedElementId('table-delivery')).toContain('client-effect-');
  });

  it.each([
    {
      toolName: 'wb_draw_latex',
      descriptorKind: 'wb_draw_latex_v2',
      deltaKind: 'whiteboard_latex_created_v2',
      postconditionKind: 'whiteboard_latex_exists_v2',
      normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
      elementType: 'latex',
      expectedDigests: {
        expectedFormulaDigest: `sha256:${'1'.repeat(64)}`,
        expectedHtmlDigest: `sha256:${'2'.repeat(64)}`,
      },
      observedDigests: {
        renderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
        observedFormulaDigest: `sha256:${'1'.repeat(64)}`,
        observedHtmlDigest: `sha256:${'2'.repeat(64)}`,
      },
      forgedDigests: {
        renderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
        observedFormulaDigest: `sha256:${'3'.repeat(64)}`,
        observedHtmlDigest: `sha256:${'2'.repeat(64)}`,
      },
    },
    {
      toolName: 'wb_draw_table',
      descriptorKind: 'wb_draw_table_v2',
      deltaKind: 'whiteboard_table_created_v2',
      postconditionKind: 'whiteboard_table_exists_v2',
      normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
      elementType: 'table',
      expectedDigests: { expectedTableDigest: `sha256:${'4'.repeat(64)}` },
      observedDigests: { observedTableDigest: `sha256:${'4'.repeat(64)}` },
      forgedDigests: { observedTableDigest: `sha256:${'5'.repeat(64)}` },
    },
    {
      toolName: 'wb_draw_chart',
      descriptorKind: 'wb_draw_chart_v2',
      deltaKind: 'whiteboard_chart_created_v2',
      postconditionKind: 'whiteboard_chart_exists_v2',
      normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
      elementType: 'chart',
      expectedDigests: { expectedChartDigest: `sha256:${'6'.repeat(64)}` },
      observedDigests: { observedChartDigest: `sha256:${'6'.repeat(64)}` },
      forgedDigests: { observedChartDigest: `sha256:${'7'.repeat(64)}` },
    },
  ] as const)(
    'accepts only the exact $toolName committed receipt and deterministic board binding',
    (fixture) => {
      const executionId = `exact-${fixture.toolName}`;
      const stableElementId = deriveRevisionedElementId(executionId);
      const descriptor = {
        kind: fixture.descriptorKind,
        intentDigest: `sha256:${'a'.repeat(64)}`,
        stableElementId,
        ...fixture.expectedDigests,
      } as RevisionedWhiteboardExpectedDescriptor;
      const makeReceipt = (
        observedDigests: Readonly<Record<string, string | undefined>>,
        previousBinding: { stageId: string; whiteboardId: string | null; revision: number },
        whiteboardId: string,
        createdWhiteboard: boolean,
      ) =>
        verifyRevisionedWhiteboardAuthorityReceipt({
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          outcome: 'committed',
          executionId,
          requestDigest: `sha256:${'b'.repeat(64)}`,
          toolName: fixture.toolName,
          previousBinding,
          currentBinding: {
            stageId: previousBinding.stageId,
            whiteboardId,
            revision: previousBinding.revision + 1,
          },
          changed: true,
          mutationMayHaveCommitted: false,
          delta: {
            kind: fixture.deltaKind,
            normalizationVersion: fixture.normalizationVersion,
            whiteboardId,
            stableElementId,
            createdWhiteboard,
            visibilityChanged: previousBinding.whiteboardId === null,
            elementCountBefore: previousBinding.whiteboardId === null ? 0 : 1,
            elementCountAfter: previousBinding.whiteboardId === null ? 1 : 2,
          },
          postcondition: {
            kind: fixture.postconditionKind,
            normalizationVersion: fixture.normalizationVersion,
            whiteboardId,
            stableElementId,
            elementType: fixture.elementType,
            ...observedDigests,
            matchingElementCount: 1,
          },
        });

      const existingBinding = { stageId: 'stage-1', whiteboardId: 'board-a', revision: 7 } as const;
      const exact = makeReceipt(fixture.observedDigests, existingBinding, 'board-a', false);
      const forgedDigest = makeReceipt(fixture.forgedDigests, existingBinding, 'board-a', false);
      const switchedBoard = makeReceipt(fixture.observedDigests, existingBinding, 'board-b', false);
      const nullBinding = { stageId: 'stage-1', whiteboardId: null, revision: 0 } as const;
      const deterministicCreate = makeReceipt(
        fixture.observedDigests,
        nullBinding,
        deriveRevisionedWhiteboardId(executionId),
        true,
      );
      if (!exact || !forgedDigest || !switchedBoard || !deterministicCreate) {
        throw new Error('Expected shape-valid Batch 2 receipt fixtures.');
      }

      expect(isRevisionedWhiteboardCommittedReceiptForExpected(exact, descriptor)).toBe(true);
      expect(isRevisionedWhiteboardCommittedReceiptForExpected(forgedDigest, descriptor)).toBe(
        false,
      );
      expect(isRevisionedWhiteboardCommittedReceiptForExpected(switchedBoard, descriptor)).toBe(
        false,
      );
      expect(
        isRevisionedWhiteboardCommittedReceiptForExpected(deterministicCreate, descriptor),
      ).toBe(true);
    },
  );
});
