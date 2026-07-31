import { afterAll, describe, expect, it } from 'vitest';
import type { ChartData, ChartType } from '@openmaic/dsl';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import { LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { getChartOption } from '@/components/slide-renderer/components/element/ChartElement/chartOption';
import { DEFAULT_WHITEBOARD_CHART_THEME_COLORS } from '@/lib/action/whiteboard-charts';
import { normalizeWhiteboardChartV1 } from '@/lib/agent/runtime/client-effect-contract';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  LegendComponent,
  SVGRenderer,
]);

const instances: echarts.ECharts[] = [];

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

afterAll(() => {
  for (const instance of instances) instance.dispose();
});

describe('whiteboard chart renderer contract', () => {
  it.each<ChartType>(['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter'])(
    'renders the frozen valid %s payload through the production ECharts option builder',
    (chartType) => {
      const option = getChartOption({
        type: chartType,
        data: validData(chartType),
        themeColors: [...DEFAULT_WHITEBOARD_CHART_THEME_COLORS],
      });
      expect(option).not.toBeNull();

      const instance = echarts.init(null, undefined, {
        renderer: 'svg',
        ssr: true,
        width: 600,
        height: 300,
      });
      instances.push(instance);
      instance.setOption(option!);
      const svg = instance.renderToSVGString();
      expect(svg).toContain('<svg');
      expect(svg).toMatch(/<(path|text|polyline|polygon)\b/);
    },
  );

  it('renders an explicitly supplied legal theme after canonicalization', () => {
    const chart = normalizeWhiteboardChartV1({
      chartType: 'bar',
      x: 0,
      y: 0,
      width: 600,
      height: 300,
      data: validData('bar'),
      themeColors: ['rgb(237, 125, 49)', 'rgba(68, 114, 196, 0.1234)'],
    });
    expect(chart.themeColors).toEqual(['#ed7d31', 'rgba(68, 114, 196, 0.1234)']);

    const option = getChartOption({
      type: chart.chartType,
      data: chart.data,
      themeColors: chart.themeColors,
    });
    expect(option).not.toBeNull();
    const instance = echarts.init(null, undefined, {
      renderer: 'svg',
      ssr: true,
      width: chart.bounds.width,
      height: chart.bounds.height,
    });
    instances.push(instance);
    instance.setOption(option!);
    const svg = instance.renderToSVGString();
    expect(svg).toContain('<svg');
    expect(svg).toContain('#ed7d31');
    expect(svg).toMatch(/(?:fill|stroke)-opacity="0\.1234"/);
  });
});
