'use client';

import { useMemo } from 'react';
import type { PPTTableElement } from '../../types/slides';
import { getTableSubThemeColor } from '../../utils/element';
import { getTextStyle, formatText, getHiddenCells } from './tableUtils';

interface StaticTableProps {
  elementInfo: PPTTableElement;
}

export function StaticTable({ elementInfo }: StaticTableProps) {
  const { width, data, colWidths, cellMinHeight, rowHeights, outline, theme } = elementInfo;

  const hiddenCells = useMemo(() => getHiddenCells(data), [data]);

  const [subThemeDark, subThemeLight] = useMemo(() => {
    if (!theme) return ['', ''];
    return getTableSubThemeColor(theme.color);
  }, [theme]);

  const borderStyle = useMemo(() => {
    if (!outline) return 'none';
    const w = outline.width ?? 1;
    const c = outline.color ?? '#000';
    const s = outline.style === 'dashed' ? 'dashed' : 'solid';
    return `${w}px ${s} ${c}`;
  }, [outline]);

  const getCellBg = (
    rowIdx: number,
    colIdx: number,
    cellBackcolor?: string,
  ): string | undefined => {
    if (cellBackcolor) return cellBackcolor;
    if (!theme) return undefined;

    const rowCount = data.length;
    const colCount = data[0]?.length ?? 0;

    if (theme.rowHeader && rowIdx === 0) return theme.color;
    if (theme.rowFooter && rowIdx === rowCount - 1) return theme.color;
    if (theme.colHeader && colIdx === 0) return subThemeDark;
    if (theme.colFooter && colIdx === colCount - 1) return subThemeDark;

    const effectiveRow = theme.rowHeader ? rowIdx - 1 : rowIdx;
    if (effectiveRow >= 0 && effectiveRow % 2 === 0) return subThemeLight;

    return undefined;
  };

  const getHeaderTextColor = (rowIdx: number): string | undefined => {
    if (!theme) return undefined;
    const rowCount = data.length;
    if (theme.rowHeader && rowIdx === 0) return '#fff';
    if (theme.rowFooter && rowIdx === rowCount - 1) return '#fff';
    return undefined;
  };

  return (
    <table
      className="slide-renderer-prose"
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
      }}
    >
      <colgroup>
        {colWidths.map((w, i) => (
          <col key={i} style={{ width: `${w * width}px` }} />
        ))}
      </colgroup>
      <tbody>
        {data.map((row, rowIdx) => (
          <tr
            key={rowIdx}
            style={{ height: `${rowHeights?.[rowIdx] ?? cellMinHeight}px` }}
          >
            {row.map((cell, colIdx) => {
              if (hiddenCells.has(`${rowIdx}_${colIdx}`)) return null;

              const bgColor = getCellBg(rowIdx, colIdx, cell.style?.backcolor);
              const headerColor = getHeaderTextColor(rowIdx);
              const textStyle = getTextStyle(cell.style);

              if (headerColor && !cell.style?.color) {
                textStyle.color = headerColor;
              }

              return (
                <td
                  key={cell.id}
                  colSpan={cell.colspan > 1 ? cell.colspan : undefined}
                  rowSpan={cell.rowspan > 1 ? cell.rowspan : undefined}
                  style={{
                    border: borderStyle,
                    backgroundColor: bgColor,
                    ...textStyle,
                  }}
                >
                  <div
                    className="slide-renderer-cell-text"
                    style={{
                      minHeight: `${(rowHeights?.[rowIdx] ?? cellMinHeight) - 4}px`,
                      padding: cell.padding,
                      display: 'flex',
                      flexDirection: 'column',
                      lineHeight: 1,
                      justifyContent:
                        cell.vAlign === 'top'
                          ? 'flex-start'
                          : cell.vAlign === 'bottom'
                            ? 'flex-end'
                            : cell.vAlign === 'middle'
                              ? 'center'
                              : undefined,
                    }}
                    dangerouslySetInnerHTML={{ __html: formatText(cell.text) }}
                  />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
