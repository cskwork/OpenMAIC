import { describe, expect, it } from 'vitest';
import type { ChartData, ChartType, PPTChartElement } from '@openmaic/dsl';
import {
  executeNativeWhiteboardChartEffect,
  prepareNativeWhiteboardTarget,
  verifyNativeWhiteboardChartEffect,
  type NativeWbDrawChartInput,
} from '@/lib/action/client-effect-whiteboard';
import {
  createWhiteboardChartElement,
  DEFAULT_WHITEBOARD_CHART_THEME_COLORS,
} from '@/lib/action/whiteboard-charts';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  digestWhiteboardChartV1,
  normalizeWhiteboardChartV1,
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

const input: NativeWbDrawChartInput = {
  executionId: 'execution-chart-1',
  stableElementId: 'chart-1',
  chartType: 'bar',
  x: 80,
  y: 60,
  width: 600,
  height: 300,
  data: {
    labels: ['第一组', '第二组'],
    legends: ['k', 'b'],
    series: [
      [2, -1],
      [3, 4],
    ],
  },
  themeColors: ['#4472c4', 'rgb(237, 125, 49)'],
};

async function expectedChart(chartInput: NativeWbDrawChartInput = input) {
  const chart = normalizeWhiteboardChartV1(chartInput);
  return { chart, digest: await digestWhiteboardChartV1(chart) };
}

function validData(chartType: ChartType): ChartData {
  if (chartType === 'pie' || chartType === 'ring') {
    return { labels: ['A', 'B'], legends: ['占比'], series: [[40, 60]] };
  }
  if (chartType === 'radar') {
    return {
      labels: ['理解', '应用', '迁移'],
      legends: ['甲', '乙'],
      series: [
        [3, 4, 5],
        [4, 3, 5],
      ],
    };
  }
  if (chartType === 'scatter') {
    return {
      labels: ['P1', 'P2', 'P3'],
      legends: ['x', 'y'],
      series: [
        [1, 2, 3],
        [3, 1, 4],
      ],
    };
  }
  return {
    labels: ['一月', '二月'],
    legends: ['甲', '乙'],
    series: [
      [1, 2],
      [3, 4],
    ],
  };
}

describe('native wb_draw_chart client effect', () => {
  it('creates the exact Legacy chart shape with the frozen default theme', () => {
    expect(
      createWhiteboardChartElement({
        id: 'legacy-chart',
        chartType: 'line',
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        data: validData('line'),
      }),
    ).toEqual({
      id: 'legacy-chart',
      type: 'chart',
      left: 10,
      top: 20,
      width: 300,
      height: 200,
      rotate: 0,
      chartType: 'line',
      data: validData('line'),
      themeColors: [...DEFAULT_WHITEBOARD_CHART_THEME_COLORS],
    });
  });

  it('renders one deterministic chart and verifies its complete trusted spec', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedChart();
    const result = await executeNativeWhiteboardChartEffect({
      store,
      targetBinding: binding,
      input,
      expectedChart: expected.chart,
      expectedChartDigest: expected.digest,
    });

    expect(result).toEqual({
      replayed: false,
      postcondition: {
        stableElementId: input.stableElementId,
        elementType: 'chart',
        normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
        observedChartDigest: expected.digest,
        matchingElementCount: 1,
      },
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTChartElement & {
      clientEffectExecutionId?: string;
      clientEffectChartDigest?: string;
    };
    expect(element).toMatchObject({
      id: input.stableElementId,
      type: 'chart',
      left: 80,
      top: 60,
      width: 600,
      height: 300,
      rotate: 0,
      chartType: 'bar',
      data: expected.chart.data,
      themeColors: expected.chart.themeColors,
      clientEffectExecutionId: input.executionId,
      clientEffectChartDigest: expected.digest,
    });
  });

  it.each<ChartType>(['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter'])(
    'normalizes a renderer-compatible %s chart',
    (chartType) => {
      expect(
        normalizeWhiteboardChartV1({
          chartType,
          x: 0,
          y: 0,
          width: 500,
          height: 300,
          data: validData(chartType),
        }),
      ).toMatchObject({
        chartType,
        data: validData(chartType),
        bounds: { x: 0, y: 0, width: 500, height: 300 },
        rotate: 0,
      });
    },
  );

  it('canonicalizes text, negative zero, and an omitted theme before digesting', async () => {
    const first = normalizeWhiteboardChartV1({
      chartType: 'line',
      x: -0,
      y: 0,
      width: 500,
      height: 300,
      data: {
        labels: ['  A\u00a0'],
        legends: [' Ｋ '],
        series: [[-0]],
      },
    });
    const second = normalizeWhiteboardChartV1({
      chartType: 'line',
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      data: {
        labels: ['A'],
        legends: ['Ｋ'],
        series: [[0]],
      },
      themeColors: [...DEFAULT_WHITEBOARD_CHART_THEME_COLORS],
    });
    expect(first).toEqual(second);
    await expect(digestWhiteboardChartV1(first)).resolves.toBe(
      await digestWhiteboardChartV1(second),
    );
  });

  it('accepts strict CSS colors and canonicalizes them to renderer-safe values', () => {
    expect(
      normalizeWhiteboardChartV1({
        ...input,
        themeColors: ['#ABC', 'rgb(237, 125, 49)', 'rgba(68, 114, 196, 0.5)', 'red'],
      }).themeColors,
    ).toEqual(['#aabbcc', '#ed7d31', 'rgba(68, 114, 196, 0.5)', '#ff0000']);
  });

  it('preserves alpha precision and gives equivalent alpha forms the same digest', async () => {
    const precise = normalizeWhiteboardChartV1({
      ...input,
      themeColors: ['rgba(68, 114, 196, 0.1234)', '#11223344', '#abcd'],
    });
    expect(precise.themeColors).toEqual([
      'rgba(68, 114, 196, 0.1234)',
      'rgba(17, 34, 51, 0.26666666666666666)',
      'rgba(170, 187, 204, 0.8666666666666667)',
    ]);

    const hexAlpha = normalizeWhiteboardChartV1({
      ...input,
      themeColors: ['#11223344'],
    });
    const rgbaAlpha = normalizeWhiteboardChartV1({
      ...input,
      themeColors: ['rgba(17, 34, 51, 0.26666666666666666)'],
    });
    await expect(digestWhiteboardChartV1(hexAlpha)).resolves.toBe(
      await digestWhiteboardChartV1(rgbaAlpha),
    );
  });

  it('replays the same execution without adding a second element', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedChart();
    await executeNativeWhiteboardChartEffect({
      store,
      targetBinding: binding,
      input,
      expectedChart: expected.chart,
      expectedChartDigest: expected.digest,
    });
    const replay = await executeNativeWhiteboardChartEffect({
      store,
      targetBinding: binding,
      input,
      expectedChart: expected.chart,
      expectedChartDigest: expected.digest,
    });

    expect(replay.replayed).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);
  });

  it('fails closed when chart content, derived state, or ownership changes', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedChart();
    await executeNativeWhiteboardChartEffect({
      store,
      targetBinding: binding,
      input,
      expectedChart: expected.chart,
      expectedChartDigest: expected.digest,
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTChartElement & {
      clientEffectExecutionId?: string;
      options?: unknown;
    };
    element.data.series[0][0] = 99;
    await expect(
      verifyNativeWhiteboardChartEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedChart: expected.chart,
        expectedChartDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CHART_MISMATCH');

    element.data.series[0][0] = expected.chart.data.series[0][0];
    element.options = {};
    await expect(
      verifyNativeWhiteboardChartEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedChart: expected.chart,
        expectedChartDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CHART_ELEMENT_MISMATCH');

    delete element.options;
    element.clientEffectExecutionId = 'other-execution';
    await expect(
      verifyNativeWhiteboardChartEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedChart: expected.chart,
        expectedChartDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
  });

  it.each([
    [
      { ...input, data: { labels: ['A'], legends: ['甲', '乙'], series: [[1]] } },
      'CLIENT_EFFECT_CHART_DIMENSIONS_INVALID',
    ],
    [
      {
        ...input,
        chartType: 'pie' as const,
        data: { labels: ['A', 'B'], legends: ['占比'], series: [[0, -1]] },
      },
      'CLIENT_EFFECT_CHART_VALUE_INVALID',
    ],
    [
      {
        ...input,
        chartType: 'scatter' as const,
        data: { labels: ['A'], legends: ['x'], series: [[1], [2]] },
      },
      'CLIENT_EFFECT_CHART_DIMENSIONS_INVALID',
    ],
    [
      { ...input, data: { labels: ['A\tbad'], legends: ['甲'], series: [[1]] } },
      'CLIENT_EFFECT_CHART_TEXT_INVALID',
    ],
    [
      { ...input, data: { labels: ['A'], legends: ['甲'], series: [[Number.NaN]] } },
      'CLIENT_EFFECT_CHART_VALUE_INVALID',
    ],
    [{ ...input, x: 900, width: 200 }, 'CLIENT_EFFECT_CHART_BOUNDS_INVALID'],
    [{ ...input, themeColors: ['not-a-color'] }, 'CLIENT_EFFECT_CHART_THEME_INVALID'],
    [{ ...input, themeColors: ['fff'] }, 'CLIENT_EFFECT_CHART_THEME_INVALID'],
    [{ ...input, themeColors: ['ff0000'] }, 'CLIENT_EFFECT_CHART_THEME_INVALID'],
    [{ ...input, themeColors: ['rgb 255 0 0'] }, 'CLIENT_EFFECT_CHART_THEME_INVALID'],
    [{ ...input, themeColors: ['rgb(255 0 0 / 50%)'] }, 'CLIENT_EFFECT_CHART_THEME_INVALID'],
    [{ ...input, themeColors: ['rgba(255, 0, 0, 50%)'] }, 'CLIENT_EFFECT_CHART_THEME_INVALID'],
    [
      {
        ...input,
        data: {
          labels: Array.from({ length: 64 }, (_, index) => `${index}${'汉'.repeat(78)}`),
          legends: Array.from({ length: 8 }, (_, index) => `系列${index}`),
          series: Array.from({ length: 8 }, () => Array.from({ length: 64 }, () => 1)),
        },
      },
      'CLIENT_EFFECT_CHART_PAYLOAD_INVALID',
    ],
  ])('rejects invalid chart state before mutation', async (invalid, code) => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedChart();
    await expect(
      executeNativeWhiteboardChartEffect({
        store,
        targetBinding: binding,
        input: invalid,
        expectedChart: expected.chart,
        expectedChartDigest: expected.digest,
      }),
    ).rejects.toThrow(code);
    expect(store.getState().stage?.whiteboard?.[0]?.elements ?? []).toHaveLength(0);
  });

  it('rejects request/input drift and scene changes before mutation', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedChart();
    await expect(
      executeNativeWhiteboardChartEffect({
        store,
        targetBinding: binding,
        input: { ...input, data: validData('bar') },
        expectedChart: expected.chart,
        expectedChartDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_REQUEST_CHART_MISMATCH');

    store.setState({ currentSceneId: 'scene-2' });
    await expect(
      executeNativeWhiteboardChartEffect({
        store,
        targetBinding: binding,
        input,
        expectedChart: expected.chart,
        expectedChartDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');
  });
});
