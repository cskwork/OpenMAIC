import type { PPTChartElement } from '@openmaic/dsl';
import type { WbDrawChartAction } from '@/lib/types/action';

export const DEFAULT_WHITEBOARD_CHART_THEME_COLORS = [
  '#5b9bd5',
  '#ed7d31',
  '#a5a5a5',
  '#ffc000',
  '#4472c4',
] as const;

export type WhiteboardChartElementInput = Pick<
  WbDrawChartAction,
  'chartType' | 'x' | 'y' | 'width' | 'height' | 'data' | 'themeColors'
> & {
  id: string;
};

export function createWhiteboardChartElement(input: WhiteboardChartElementInput): PPTChartElement {
  return {
    id: input.id,
    type: 'chart',
    left: input.x,
    top: input.y,
    width: input.width,
    height: input.height,
    rotate: 0,
    chartType: input.chartType,
    data: input.data,
    themeColors: input.themeColors ?? [...DEFAULT_WHITEBOARD_CHART_THEME_COLORS],
  };
}
