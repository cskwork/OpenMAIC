import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_RENDER_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  assertWhiteboardChartSpecV1,
  assertWhiteboardCodeSpecV1,
  assertWhiteboardEditableCodeStateV1,
  assertWhiteboardTableSpecV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeVisibleTextV1,
  type WhiteboardChartSpec,
  type WhiteboardCodeSpec,
  type WhiteboardEditableCodeState,
  type WhiteboardLatexSpec,
  type WhiteboardLineSpec,
  type WhiteboardShapeSpec,
} from './client-effect-contract';
import type { PPTCodeElement, PPTTableElement } from '@openmaic/dsl';

export const REVISIONED_WHITEBOARD_TABLE_STATE_VERSION = 'maic.whiteboard-table-state.v2' as const;

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('REVISIONED_CANONICAL_VALUE_INVALID');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('REVISIONED_CANONICAL_VALUE_CYCLIC');
    ancestors.add(value);
    const normalized = Array.from({ length: value.length }, (_, index) =>
      index in value && value[index] !== undefined ? canonicalize(value[index], ancestors) : null,
    );
    ancestors.delete(value);
    return normalized;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error('REVISIONED_CANONICAL_VALUE_INVALID');
  }
  if (ancestors.has(value)) throw new Error('REVISIONED_CANONICAL_VALUE_CYCLIC');
  ancestors.add(value);
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry, ancestors)]),
  );
  ancestors.delete(value);
  return normalized;
}

export function canonicalRevisionedJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function digestRevisionedValue(value: unknown): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalRevisionedJson(value))))}`;
}

function deepFreezeRevisioned<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeRevisioned(child);
  }
  return Object.freeze(value);
}

export function immutableRevisionedSnapshot<T>(value: T): Readonly<T> {
  return deepFreezeRevisioned(JSON.parse(canonicalRevisionedJson(value)) as T);
}

export function digestOpaqueRevisionedToken(token: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(token)))}`;
}

export function digestVisibleTextV1Sync(value: string): string {
  const normalized = normalizeVisibleTextV1(value);
  return `sha256:${bytesToHex(
    sha256(utf8ToBytes(`${CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION}\n${normalized}`)),
  )}`;
}

export function digestWhiteboardShapeV1Sync(value: WhiteboardShapeSpec): string {
  const normalized = normalizeWhiteboardShapeV1({
    shape: value.shape,
    ...value.bounds,
    fillColor: value.fillColor,
  });
  return `sha256:${bytesToHex(
    sha256(
      utf8ToBytes(`${CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION}\n${JSON.stringify(normalized)}`),
    ),
  )}`;
}

export function digestWhiteboardLineV1Sync(value: WhiteboardLineSpec): string {
  const normalized = normalizeWhiteboardLineV1({
    startX: value.start.x,
    startY: value.start.y,
    endX: value.end.x,
    endY: value.end.y,
    color: value.strokeColor,
    width: value.strokeWidth,
    style: value.strokeStyle,
    points: value.markers,
  });
  return `sha256:${bytesToHex(
    sha256(
      utf8ToBytes(`${CLIENT_EFFECT_LINE_NORMALIZATION_VERSION}\n${JSON.stringify(normalized)}`),
    ),
  )}`;
}

export function digestWhiteboardLatexV1Sync(value: WhiteboardLatexSpec): string {
  const normalized = normalizeWhiteboardLatexV1({
    latex: value.latex,
    ...value.bounds,
    color: value.color,
  });
  return (
    'sha256:' +
    bytesToHex(
      sha256(
        utf8ToBytes(CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION + '\n' + JSON.stringify(normalized)),
      ),
    )
  );
}

export function digestWhiteboardLatexHtmlV1Sync(html: string): string {
  if (typeof html !== 'string' || !html) {
    throw new Error('CLIENT_EFFECT_LATEX_HTML_INVALID');
  }
  return (
    'sha256:' + bytesToHex(sha256(utf8ToBytes(CLIENT_EFFECT_LATEX_RENDER_VERSION + '\n' + html)))
  );
}

export function digestWhiteboardChartV1Sync(value: WhiteboardChartSpec): string {
  const canonical = assertWhiteboardChartSpecV1(value);
  return (
    'sha256:' +
    bytesToHex(
      sha256(
        utf8ToBytes(CLIENT_EFFECT_CHART_NORMALIZATION_VERSION + '\n' + JSON.stringify(canonical)),
      ),
    )
  );
}

export function digestWhiteboardCodeV1Sync(value: WhiteboardCodeSpec): string {
  const canonical = assertWhiteboardCodeSpecV1(value);
  return (
    'sha256:' +
    bytesToHex(
      sha256(
        utf8ToBytes(CLIENT_EFFECT_CODE_NORMALIZATION_VERSION + '\n' + JSON.stringify(canonical)),
      ),
    )
  );
}

export function digestWhiteboardEditableCodeStateV1Sync(
  value: WhiteboardEditableCodeState,
): string {
  const canonical = assertWhiteboardEditableCodeStateV1(value);
  return (
    'sha256:' +
    bytesToHex(
      sha256(
        utf8ToBytes(
          CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION + '\n' + JSON.stringify(canonical),
        ),
      ),
    )
  );
}

export function editableCodeStateFromElementV1(
  element: PPTCodeElement,
): WhiteboardEditableCodeState {
  if (
    element.type !== 'code' ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    typeof element.height !== 'number' ||
    !Array.isArray(element.lines)
  ) {
    throw new Error('REVISIONED_WHITEBOARD_CODE_ELEMENT_INVALID');
  }
  try {
    return assertWhiteboardEditableCodeStateV1({
      language: element.language,
      lines: element.lines,
      ...(element.fileName !== undefined ? { fileName: element.fileName } : {}),
      bounds: {
        x: element.left,
        y: element.top,
        width: element.width,
        height: element.height,
      },
      showLineNumbers: element.showLineNumbers ?? true,
      fontSize: element.fontSize ?? 14,
      rotate: element.rotate,
    });
  } catch (error) {
    throw new Error('REVISIONED_WHITEBOARD_CODE_ELEMENT_INVALID', { cause: error });
  }
}

export function canonicalRevisionedWhiteboardTableStateV2(element: PPTTableElement) {
  try {
    if (
      element.type !== 'table' ||
      typeof element.id !== 'string' ||
      !element.id ||
      typeof element.left !== 'number' ||
      typeof element.top !== 'number' ||
      typeof element.width !== 'number' ||
      typeof element.height !== 'number' ||
      element.rotate !== 0 ||
      element.rowHeights !== undefined ||
      !Array.isArray(element.data) ||
      element.data.length === 0 ||
      !Array.isArray(element.data[0]) ||
      element.data[0].length === 0 ||
      !Array.isArray(element.colWidths) ||
      element.cellMinHeight !== 36 ||
      !element.outline ||
      typeof element.outline.width !== 'number' ||
      (element.outline.style !== 'solid' && element.outline.style !== 'dashed') ||
      typeof element.outline.color !== 'string'
    ) {
      throw new Error('REVISIONED_WHITEBOARD_TABLE_STATE_INVALID');
    }
    let ordinal = 0;
    const cells = element.data.map((row) =>
      row.map((cell) => {
        const expectedId = 'cell_' + ordinal++;
        if (
          cell.id !== expectedId ||
          cell.colspan !== 1 ||
          cell.rowspan !== 1 ||
          typeof cell.text !== 'string' ||
          cell.style !== undefined ||
          cell.padding !== undefined ||
          cell.vAlign !== undefined ||
          cell.borders !== undefined
        ) {
          throw new Error('REVISIONED_WHITEBOARD_TABLE_STATE_INVALID');
        }
        return {
          id: cell.id,
          colspan: 1 as const,
          rowspan: 1 as const,
          text: cell.text,
        };
      }),
    );
    const spec = assertWhiteboardTableSpecV1({
      data: cells.map((row) => row.map(({ text }) => text)),
      bounds: {
        x: element.left,
        y: element.top,
        width: element.width,
        height: element.height,
      },
      outline: {
        width: element.outline.width,
        style: element.outline.style,
        color: element.outline.color,
      },
      ...(element.theme
        ? {
            theme: {
              color: element.theme.color,
              rowHeader: element.theme.rowHeader as true,
              rowFooter: element.theme.rowFooter as false,
              colHeader: element.theme.colHeader as false,
              colFooter: element.theme.colFooter as false,
            },
          }
        : {}),
      colWidths: [...element.colWidths],
      cellMinHeight: 36,
    });
    return immutableRevisionedSnapshot({
      stateVersion: REVISIONED_WHITEBOARD_TABLE_STATE_VERSION,
      normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
      stableElementId: element.id,
      elementType: 'table' as const,
      bounds: spec.bounds,
      rotate: 0 as const,
      cells,
      colWidths: spec.colWidths,
      cellMinHeight: spec.cellMinHeight,
      outline: spec.outline,
      ...(spec.theme ? { theme: spec.theme } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'REVISIONED_WHITEBOARD_TABLE_STATE_INVALID') {
      throw error;
    }
    throw new Error('REVISIONED_WHITEBOARD_TABLE_STATE_INVALID', { cause: error });
  }
}

export function digestRevisionedWhiteboardTableStateV2Sync(element: PPTTableElement): string {
  return digestRevisionedValue(canonicalRevisionedWhiteboardTableStateV2(element));
}

function executionSuffix(executionId: string): string {
  return bytesToHex(sha256(utf8ToBytes(executionId)));
}

export function deriveRevisionedWhiteboardId(executionId: string): string {
  return `whiteboard-${executionSuffix(executionId)}`;
}

export function deriveRevisionedElementId(executionId: string): string {
  return `client-effect-${executionSuffix(executionId)}`;
}

export function deriveRevisionedCodeEditLineId(executionId: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 200) {
    throw new Error('REVISIONED_WHITEBOARD_CODE_LINE_ORDINAL_INVALID');
  }
  return `CE2_${executionSuffix(executionId)}_${ordinal}`;
}

export function revisionedCodeEditLineIdPrefix(executionId: string): string {
  return `CE2_${executionSuffix(executionId)}_`;
}
