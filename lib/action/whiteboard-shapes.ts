import type { WbDrawShapeAction } from '@/lib/types/action';

export const WHITEBOARD_SHAPE_PATHS = {
  rectangle: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
  circle: 'M 500 0 A 500 500 0 1 1 499 0 Z',
  triangle: 'M 500 0 L 1000 1000 L 0 1000 Z',
} as const satisfies Record<WbDrawShapeAction['shape'], string>;
