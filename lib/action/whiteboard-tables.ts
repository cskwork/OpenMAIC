import type { PPTTableElement } from '@openmaic/dsl';
import type { WbDrawTableAction } from '@/lib/types/action';

export type WhiteboardTableElementInput = Pick<
  WbDrawTableAction,
  'x' | 'y' | 'width' | 'height' | 'data' | 'outline' | 'theme'
> & {
  id: string;
};

export function escapeWhiteboardTableCellText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function createWhiteboardTableElement(
  input: WhiteboardTableElementInput,
): PPTTableElement | null {
  const rows = input.data.length;
  const cols = rows > 0 ? input.data[0].length : 0;
  if (rows === 0 || cols === 0) return null;

  let cellId = 0;
  return {
    id: input.id,
    type: 'table',
    left: input.x,
    top: input.y,
    width: input.width,
    height: input.height,
    rotate: 0,
    colWidths: Array(cols).fill(1 / cols) as number[],
    cellMinHeight: 36,
    data: input.data.map((row) =>
      row.map((text) => ({
        id: `cell_${cellId++}`,
        colspan: 1,
        rowspan: 1,
        text,
      })),
    ),
    outline: input.outline ?? {
      width: 2,
      style: 'solid',
      color: '#eeece1',
    },
    theme: input.theme
      ? {
          color: input.theme.color,
          rowHeader: true,
          rowFooter: false,
          colHeader: false,
          colFooter: false,
        }
      : undefined,
  } as PPTTableElement;
}
