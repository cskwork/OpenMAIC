import type { PPTLineElement } from '@openmaic/dsl';
import type { WbDrawLineAction } from '@/lib/types/action';

export type WhiteboardLineElementInput = Pick<
  WbDrawLineAction,
  'startX' | 'startY' | 'endX' | 'endY' | 'color' | 'width' | 'style' | 'points'
> & {
  id: string;
};

export function createWhiteboardLineElement(input: WhiteboardLineElementInput): PPTLineElement {
  const left = Math.min(input.startX, input.endX);
  const top = Math.min(input.startY, input.endY);
  return {
    id: input.id,
    type: 'line',
    left,
    top,
    width: input.width ?? 2,
    start: [input.startX - left, input.startY - top],
    end: [input.endX - left, input.endY - top],
    style: input.style ?? 'solid',
    color: input.color ?? '#333333',
    points: input.points ?? ['', ''],
  };
}

export function readAbsoluteWhiteboardLineEndpoints(element: PPTLineElement): {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
} {
  return {
    startX: element.left + element.start[0],
    startY: element.top + element.start[1],
    endX: element.left + element.end[0],
    endY: element.top + element.end[1],
  };
}
