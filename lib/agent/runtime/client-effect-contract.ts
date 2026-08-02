import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ToolExecutionEnvelope,
} from './native-child-contract';
import type { ChartData, ChartType, CodeLine, PPTElement } from '@openmaic/dsl';
import tinycolor from 'tinycolor2';
import { DEFAULT_WHITEBOARD_CHART_THEME_COLORS } from '@/lib/action/whiteboard-charts';
import { createWhiteboardCodeLines } from '@/lib/action/whiteboard-code';
import { escapeWhiteboardTableCellText } from '@/lib/action/whiteboard-tables';

export const CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION = 'maic.visible-text.v1' as const;
export const CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION = 'maic.whiteboard-shape.v1' as const;
export const CLIENT_EFFECT_LINE_NORMALIZATION_VERSION = 'maic.whiteboard-line.v1' as const;
export const CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION = 'maic.whiteboard-latex.v1' as const;
export const CLIENT_EFFECT_LATEX_RENDER_VERSION = 'maic.katex-html.v1' as const;
export const CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION = 'maic.whiteboard-table.v1' as const;
export const CLIENT_EFFECT_CHART_NORMALIZATION_VERSION = 'maic.whiteboard-chart.v1' as const;
export const CLIENT_EFFECT_CODE_NORMALIZATION_VERSION = 'maic.whiteboard-code.v1' as const;
export const CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION =
  'maic.whiteboard-code-edit.v1' as const;
export const CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION = 'maic.whiteboard-delete.v1' as const;
export const CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION = 'maic.whiteboard-visibility.v1' as const;
export const CLIENT_EFFECT_ACK_HEADER = 'x-maic-effect-token';
export const CLIENT_EFFECT_ACK_MAX_BYTES = 8 * 1024;

export type ClientEffectStatus =
  | 'pending'
  | 'accepted'
  | 'effect_committed'
  | 'effect_failed'
  | 'timed_out'
  | 'cancelled';

export type ClientEffectTerminalStatus = Extract<
  ClientEffectStatus,
  'effect_committed' | 'effect_failed' | 'timed_out' | 'cancelled'
>;

export interface ClientEffectTarget {
  requestId: string;
  sessionId: string;
  stageId: string;
  sceneId: string;
  messageId: string;
}

export interface WhiteboardOpenPostcondition {
  kind: 'whiteboard_open';
  normalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION;
  desiredOpen: true;
}

export interface WhiteboardOpenCommittedObservation {
  kind: 'whiteboard_open';
  normalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION;
  whiteboardId: string;
  desiredOpen: true;
  observedOpen: true;
  created: boolean;
  visibilityChanged: boolean;
}

export interface WhiteboardClosePostcondition {
  kind: 'whiteboard_closed';
  normalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION;
  desiredOpen: false;
}

export interface WhiteboardCloseCommittedObservation {
  kind: 'whiteboard_closed';
  normalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION;
  desiredOpen: false;
  observedOpen: false;
  visibilityChanged: boolean;
}

export type WhiteboardElementType =
  | 'text'
  | 'image'
  | 'shape'
  | 'line'
  | 'chart'
  | 'table'
  | 'latex'
  | 'video'
  | 'audio'
  | 'code';

export const CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION = 'maic.whiteboard-clear.v1' as const;
export const CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION = 'maic.whiteboard-membership.v1' as const;
export const CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION = 'maic.whiteboard-content.v1' as const;

export const CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST =
  'sha256:e30d867b451745648162038b847a467dfc7d36998a544fccfb3d6f384af73f01' as const;
export const CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST =
  'sha256:2c71ae6c2e19e4eb3796a6af2d744046bff4087c7b43500226c10d4528e69287' as const;

/**
 * Browser-only execution receipts persisted on otherwise user-visible elements.
 * Keep this exact allowlist centralized: unknown future fields remain part of the
 * board-content digest until they are deliberately classified and tested here.
 */
export const CLIENT_EFFECT_ELEMENT_METADATA_KEYS = [
  'clientEffectExecutionId',
  'clientEffectNormalizationVersion',
  'clientEffectContentDigest',
  'clientEffectShapeDigest',
  'clientEffectShapeKind',
  'clientEffectLineDigest',
  'clientEffectFormulaDigest',
  'clientEffectHtmlDigest',
  'clientEffectRenderVersion',
  'clientEffectTableDigest',
  'clientEffectChartDigest',
  'clientEffectCodeDigest',
  'clientEffectLastEditExecutionId',
  'clientEffectLastEditBeforeDigest',
  'clientEffectLastEditAfterDigest',
  'clientEffectEditNormalizationVersion',
] as const;

export interface WhiteboardClearPostcondition {
  kind: 'whiteboard_empty';
  normalizationVersion: typeof CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION;
  membershipNormalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION;
  boardContentNormalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION;
  expectedWhiteboardId: string;
  expectedElementCount: number;
  expectedMembershipDigest: string;
}

interface WhiteboardClearCommittedObservationBase {
  kind: 'whiteboard_empty';
  normalizationVersion: typeof CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION;
  membershipNormalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION;
  boardContentNormalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION;
  whiteboardId: string;
  observedOpen: boolean;
  visibilityChanged: boolean;
}

export type WhiteboardClearCommittedObservation =
  | (WhiteboardClearCommittedObservationBase & {
      cleared: true;
      elementCountBefore: number;
      elementCountAfter: 0;
      observedMembershipDigestBefore: string;
      boardContentDigestAtAccepted: string;
      boardContentDigestBeforeMutation: string;
      observedBoardContentDigestAfter: typeof CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST;
      historySnapshotDigest: string;
      observedOpen: true;
    })
  | (WhiteboardClearCommittedObservationBase & {
      cleared: false;
      elementCountBefore: 0;
      elementCountAfter: 0;
      observedMembershipDigestBefore: typeof CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST;
      verifiedEmptyBoardContentDigest: typeof CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST;
      visibilityChanged: false;
    });

const CLIENT_EFFECT_ELEMENT_METADATA_KEY_SET = new Set<string>(CLIENT_EFFECT_ELEMENT_METADATA_KEYS);

export function isPromptSafeWhiteboardIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)
  );
}

function canonicalizeJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CLIENT_EFFECT_BOARD_CONTENT_NUMBER_INVALID');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('CLIENT_EFFECT_BOARD_CONTENT_CYCLE');
    ancestors.add(value);
    // Match JSON serialization semantics for non-visible array gaps: both a
    // sparse hole and an explicit undefined item serialize as null. Keeping
    // that equivalence explicit avoids runtime-dependent map/JSON behavior.
    const normalized = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value) || value[index] === undefined) return null;
      return canonicalizeJsonValue(value[index], ancestors);
    });
    ancestors.delete(value);
    return normalized;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('CLIENT_EFFECT_BOARD_CONTENT_OBJECT_INVALID');
    }
    if (ancestors.has(value)) throw new Error('CLIENT_EFFECT_BOARD_CONTENT_CYCLE');
    ancestors.add(value);
    const normalized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // Optional undefined object fields are not persisted or visible in
        // JSON-backed whiteboard state, so canonicalize them as absent.
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCanonicalStrings(left, right))
        .map(([key, entry]) => [key, canonicalizeJsonValue(entry, ancestors)]),
    );
    ancestors.delete(value);
    return normalized;
  }
  throw new Error('CLIENT_EFFECT_BOARD_CONTENT_VALUE_INVALID');
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeWhiteboardContentV1(elements: PPTElement[]): string {
  const normalizedElements = elements.map((element) => {
    const visibleElement = Object.fromEntries(
      Object.entries(element as unknown as Record<string, unknown>).filter(
        ([key]) => !CLIENT_EFFECT_ELEMENT_METADATA_KEY_SET.has(key),
      ),
    );
    return canonicalizeJsonValue(visibleElement, new Set());
  });
  return JSON.stringify({
    version: CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
    elements: normalizedElements,
  });
}

export function canonicalizeWhiteboardMembershipV1(
  elements: Array<{ id: string; type: WhiteboardElementType }>,
): string {
  const normalized = elements
    .map(({ id, type }) => {
      if (!isPromptSafeWhiteboardIdentifier(id) || !isWhiteboardElementType(type)) {
        throw new Error('CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_INVALID');
      }
      return [id, type] as const;
    })
    .sort(([leftId, leftType], [rightId, rightType]) =>
      leftId === rightId
        ? compareCanonicalStrings(leftType, rightType)
        : compareCanonicalStrings(leftId, rightId),
    );
  return JSON.stringify({
    version: CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
    elements: normalized,
  });
}

async function digestCanonicalClientEffectValue(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function digestCanonicalWhiteboardContentV1(canonicalContent: string): Promise<string> {
  return digestCanonicalClientEffectValue(canonicalContent);
}

export function digestWhiteboardContentV1(elements: PPTElement[]): Promise<string> {
  return digestCanonicalWhiteboardContentV1(canonicalizeWhiteboardContentV1(elements));
}

export function digestWhiteboardMembershipV1(
  elements: Array<{ id: string; type: WhiteboardElementType }>,
): Promise<string> {
  return digestCanonicalClientEffectValue(canonicalizeWhiteboardMembershipV1(elements));
}

export interface WhiteboardDeletePostcondition {
  kind: 'whiteboard_element_absent';
  normalizationVersion: typeof CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION;
  stableElementId: string;
  expectedWhiteboardId: string;
  expectedElementType: WhiteboardElementType;
}

export interface WhiteboardDeleteCommittedObservation {
  kind: 'whiteboard_element_absent';
  normalizationVersion: typeof CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION;
  stableElementId: string;
  whiteboardId: string;
  observedElementType: WhiteboardElementType;
  matchingElementCountBefore: 1;
  matchingElementCountAfter: 0;
  elementCountBefore: number;
  elementCountAfter: number;
  deleted: true;
}

export interface WhiteboardTextPostcondition {
  kind: 'whiteboard_text_exists';
  stableElementId: string;
  elementType: 'text';
  normalizationVersion: typeof CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION;
  expectedContentDigest: string;
}

export type WhiteboardShapeKind = 'rectangle' | 'circle' | 'triangle';

export interface WhiteboardShapeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WhiteboardShapeSpec {
  shape: WhiteboardShapeKind;
  bounds: WhiteboardShapeBounds;
  fillColor: string;
}

export interface WhiteboardShapePostcondition extends WhiteboardShapeSpec {
  kind: 'whiteboard_shape_exists';
  stableElementId: string;
  elementType: 'shape';
  normalizationVersion: typeof CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION;
  expectedShapeDigest: string;
}

export type WhiteboardLineStyle = 'solid' | 'dashed';
export type WhiteboardLineMarker = '' | 'arrow';

export interface WhiteboardLineCoordinate {
  x: number;
  y: number;
}

export interface WhiteboardLineSpec {
  start: WhiteboardLineCoordinate;
  end: WhiteboardLineCoordinate;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: WhiteboardLineStyle;
  markers: [WhiteboardLineMarker, WhiteboardLineMarker];
}

export interface WhiteboardLinePostcondition extends WhiteboardLineSpec {
  kind: 'whiteboard_line_exists';
  stableElementId: string;
  elementType: 'line';
  normalizationVersion: typeof CLIENT_EFFECT_LINE_NORMALIZATION_VERSION;
  expectedLineDigest: string;
}

export interface WhiteboardLatexBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WhiteboardLatexSpec {
  latex: string;
  bounds: WhiteboardLatexBounds;
  color: string;
  renderVersion: typeof CLIENT_EFFECT_LATEX_RENDER_VERSION;
}

export interface WhiteboardLatexPostcondition extends WhiteboardLatexSpec {
  kind: 'whiteboard_latex_exists';
  stableElementId: string;
  elementType: 'latex';
  normalizationVersion: typeof CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION;
  expectedFormulaDigest: string;
  expectedHtmlDigest: string;
}

export interface WhiteboardTableBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WhiteboardTableOutline {
  width: number;
  style: 'solid' | 'dashed';
  color: string;
}

export interface WhiteboardTableTheme {
  color: string;
  rowHeader: true;
  rowFooter: false;
  colHeader: false;
  colFooter: false;
}

export interface WhiteboardTableSpec {
  data: string[][];
  bounds: WhiteboardTableBounds;
  outline: WhiteboardTableOutline;
  theme?: WhiteboardTableTheme;
  colWidths: number[];
  cellMinHeight: 36;
}

export interface WhiteboardTablePostcondition extends WhiteboardTableSpec {
  kind: 'whiteboard_table_exists';
  stableElementId: string;
  elementType: 'table';
  normalizationVersion: typeof CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION;
  expectedTableDigest: string;
}

export interface WhiteboardChartBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WhiteboardChartSpec {
  chartType: ChartType;
  data: ChartData;
  bounds: WhiteboardChartBounds;
  themeColors: string[];
  rotate: 0;
}

export interface WhiteboardChartPostcondition extends WhiteboardChartSpec {
  kind: 'whiteboard_chart_exists';
  stableElementId: string;
  elementType: 'chart';
  normalizationVersion: typeof CLIENT_EFFECT_CHART_NORMALIZATION_VERSION;
  expectedChartDigest: string;
}

export interface WhiteboardCodeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WhiteboardCodeSpec {
  language: string;
  lines: CodeLine[];
  fileName?: string;
  bounds: WhiteboardCodeBounds;
  showLineNumbers: true;
  fontSize: 14;
  rotate: 0;
}

export interface WhiteboardCodePostcondition extends WhiteboardCodeSpec {
  kind: 'whiteboard_code_exists';
  stableElementId: string;
  elementType: 'code';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_NORMALIZATION_VERSION;
  expectedCodeDigest: string;
}

export interface WhiteboardEditableCodeState {
  language: string;
  lines: CodeLine[];
  fileName?: string;
  bounds: WhiteboardCodeBounds;
  showLineNumbers: boolean;
  fontSize: number;
  rotate: number;
}

export type WhiteboardCodeEditIntent =
  | {
      elementId: string;
      operation: 'insert_after' | 'insert_before';
      lineId: string;
      content: string;
    }
  | {
      elementId: string;
      operation: 'delete_lines';
      lineIds: string[];
    }
  | {
      elementId: string;
      operation: 'replace_lines';
      lineIds: string[];
      content: string;
    };

export interface WhiteboardCodeEditPostcondition {
  kind: 'whiteboard_code_edited';
  stableElementId: string;
  elementType: 'code';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION;
  expectedWhiteboardId: string;
  expectedBeforeCodeDigest: string;
  expectedAfterCodeDigest: string;
  expectedAfterCodeState: WhiteboardEditableCodeState;
  noOp: boolean;
}

interface ClientEffectRequestBase extends ToolExecutionEnvelope {
  kind: 'client_effect';
  target: ClientEffectTarget;
  activeEffectBudgetMs: number;
}

export type WhiteboardTextClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_draw_text';
  postcondition: WhiteboardTextPostcondition;
};

export type WhiteboardShapeClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_draw_shape';
  postcondition: WhiteboardShapePostcondition;
};

export type WhiteboardLineClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_draw_line';
  postcondition: WhiteboardLinePostcondition;
};

export type WhiteboardLatexClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_draw_latex';
  postcondition: WhiteboardLatexPostcondition;
};

export type WhiteboardTableClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_draw_table';
  postcondition: WhiteboardTablePostcondition;
};

export type WhiteboardChartClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_draw_chart';
  postcondition: WhiteboardChartPostcondition;
};

export type WhiteboardCodeClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_draw_code';
  postcondition: WhiteboardCodePostcondition;
};

export type WhiteboardCodeEditClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_edit_code';
  postcondition: WhiteboardCodeEditPostcondition;
};

export type WhiteboardOpenClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_open';
  postcondition: WhiteboardOpenPostcondition;
};

export type WhiteboardCloseClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_close';
  postcondition: WhiteboardClosePostcondition;
};

export type WhiteboardDeleteClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_delete';
  postcondition: WhiteboardDeletePostcondition;
};

export type WhiteboardClearClientEffectRequest = ClientEffectRequestBase & {
  toolName: 'wb_clear';
  postcondition: WhiteboardClearPostcondition;
};

export type ClientEffectRequest =
  | WhiteboardOpenClientEffectRequest
  | WhiteboardCloseClientEffectRequest
  | WhiteboardClearClientEffectRequest
  | WhiteboardDeleteClientEffectRequest
  | WhiteboardTextClientEffectRequest
  | WhiteboardShapeClientEffectRequest
  | WhiteboardLineClientEffectRequest
  | WhiteboardLatexClientEffectRequest
  | WhiteboardTableClientEffectRequest
  | WhiteboardChartClientEffectRequest
  | WhiteboardCodeClientEffectRequest
  | WhiteboardCodeEditClientEffectRequest;

export interface ClientEffectDelivery {
  request: ClientEffectRequest;
  acknowledgementToken: string;
}

export interface AcceptedTargetBinding {
  requestId: string;
  sessionId: string;
  stageId: string;
  sceneId: string;
  whiteboardId: string;
  bindingVersion: number;
}

/** Stage/scene visibility target for lifecycle effects that do not require a whiteboard entity. */
export interface WhiteboardVisibilityTarget {
  requestId: string;
  sessionId: string;
  stageId: string;
  sceneId: string;
  bindingVersion: number;
}

interface ClientEffectAckBase {
  protocolVersion: ClientEffectRequest['protocolVersion'];
  executionId: string;
  idempotencyKey: string;
  clientEventId: string;
  observedAt: number;
}

export type ClientEffectAck =
  | (ClientEffectAckBase & {
      status: 'accepted';
      targetBinding: AcceptedTargetBinding;
    })
  | (ClientEffectAckBase & {
      status: 'accepted';
      visibilityTarget: WhiteboardVisibilityTarget;
    })
  | (ClientEffectAckBase & {
      status: 'presentation_paused' | 'presentation_resumed';
    })
  | (ClientEffectAckBase & {
      status: 'effect_committed';
      targetBinding: AcceptedTargetBinding;
      postcondition:
        | WhiteboardOpenCommittedObservation
        | WhiteboardClearCommittedObservation
        | WhiteboardDeleteCommittedObservation
        | {
            stableElementId: string;
            elementType: 'text';
            normalizationVersion: typeof CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION;
            observedContentDigest: string;
            matchingElementCount: 1;
          }
        | ({
            stableElementId: string;
            elementType: 'shape';
            normalizationVersion: typeof CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION;
            observedShapeDigest: string;
            matchingElementCount: 1;
          } & WhiteboardShapeSpec)
        | ({
            stableElementId: string;
            elementType: 'line';
            normalizationVersion: typeof CLIENT_EFFECT_LINE_NORMALIZATION_VERSION;
            observedLineDigest: string;
            matchingElementCount: 1;
          } & WhiteboardLineSpec)
        | ({
            stableElementId: string;
            elementType: 'latex';
            normalizationVersion: typeof CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION;
            observedFormulaDigest: string;
            observedHtmlDigest: string;
            matchingElementCount: 1;
          } & WhiteboardLatexSpec)
        | {
            stableElementId: string;
            elementType: 'table';
            normalizationVersion: typeof CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION;
            observedTableDigest: string;
            matchingElementCount: 1;
          }
        | {
            stableElementId: string;
            elementType: 'chart';
            normalizationVersion: typeof CLIENT_EFFECT_CHART_NORMALIZATION_VERSION;
            observedChartDigest: string;
            matchingElementCount: 1;
          }
        | {
            stableElementId: string;
            elementType: 'code';
            normalizationVersion: typeof CLIENT_EFFECT_CODE_NORMALIZATION_VERSION;
            observedCodeDigest: string;
            matchingElementCount: 1;
          }
        | {
            stableElementId: string;
            elementType: 'code';
            normalizationVersion: typeof CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION;
            expectedWhiteboardId: string;
            observedBeforeCodeDigest: string;
            observedAfterCodeDigest: string;
            matchingElementCount: 1;
            noOp: boolean;
          };
    })
  | (ClientEffectAckBase & {
      status: 'effect_committed';
      visibilityTarget: WhiteboardVisibilityTarget;
      postcondition: WhiteboardCloseCommittedObservation;
    })
  | (ClientEffectAckBase & {
      status: 'effect_failed' | 'cancelled';
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    });

export interface ClientEffectTerminalResult {
  executionId: string;
  status: ClientEffectTerminalStatus;
  isError: boolean;
  completedAt: number;
  targetBinding?: AcceptedTargetBinding;
  visibilityTarget?: WhiteboardVisibilityTarget;
  committedObservation?:
    | WhiteboardOpenCommittedObservation
    | WhiteboardCloseCommittedObservation
    | WhiteboardClearCommittedObservation
    | WhiteboardDeleteCommittedObservation;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface ClientEffectCoordinatorSnapshot {
  executionId: string;
  idempotencyKey: string;
  status: ClientEffectStatus;
  paused: boolean;
  activeRemainingMs: number;
  deadlineAt: number;
  targetBinding?: AcceptedTargetBinding;
  visibilityTarget?: WhiteboardVisibilityTarget;
  terminalResult?: ClientEffectTerminalResult;
}

export interface ClientEffectTraceEvent {
  type:
    | 'registered'
    | 'duplicate_delivery'
    | 'ack_applied'
    | 'ack_duplicate'
    | 'ack_late'
    | 'ack_rejected'
    | 'settled'
    | 'cleaned_up';
  at: number;
  traceId: string;
  runId: string;
  agentInvocationId: string;
  toolCallId: string;
  executionId: string;
  status: ClientEffectStatus;
  ackStatus?: ClientEffectAck['status'];
  code?: string;
}

export function normalizeVisibleTextV1(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC')
    .trim();
}

export async function digestVisibleTextV1(value: string): Promise<string> {
  const normalized = normalizeVisibleTextV1(value);
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION}\n${normalized}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function normalizeWhiteboardShapeV1(input: {
  shape: unknown;
  x: unknown;
  y: unknown;
  width: unknown;
  height: unknown;
  fillColor?: unknown;
}): WhiteboardShapeSpec {
  const { shape, x, y, width, height } = input;
  const fillColor = input.fillColor ?? '#5b9bd5';
  if (
    (shape !== 'rectangle' && shape !== 'circle' && shape !== 'triangle') ||
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    typeof fillColor !== 'string' ||
    !fillColor.trim() ||
    fillColor.length > 64
  ) {
    throw new Error('CLIENT_EFFECT_SHAPE_INPUT_INVALID');
  }
  const bounds = {
    x: canonicalNumber(x),
    y: canonicalNumber(y),
    width: canonicalNumber(width),
    height: canonicalNumber(height),
  };
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1000 ||
    bounds.y + bounds.height > 563
  ) {
    throw new Error('CLIENT_EFFECT_SHAPE_BOUNDS_INVALID');
  }
  return {
    shape,
    bounds,
    fillColor: fillColor.trim(),
  };
}

export async function digestWhiteboardShapeV1(input: WhiteboardShapeSpec): Promise<string> {
  const normalized = normalizeWhiteboardShapeV1({
    shape: input.shape,
    ...input.bounds,
    fillColor: input.fillColor,
  });
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION}\n${JSON.stringify(normalized)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function normalizeWhiteboardLineV1(input: {
  startX: unknown;
  startY: unknown;
  endX: unknown;
  endY: unknown;
  color?: unknown;
  width?: unknown;
  style?: unknown;
  points?: unknown;
}): WhiteboardLineSpec {
  const { startX, startY, endX, endY } = input;
  const color = input.color ?? '#333333';
  const width = input.width ?? 2;
  const style = input.style ?? 'solid';
  const points = input.points ?? ['', ''];
  if (
    typeof startX !== 'number' ||
    !Number.isFinite(startX) ||
    typeof startY !== 'number' ||
    !Number.isFinite(startY) ||
    typeof endX !== 'number' ||
    !Number.isFinite(endX) ||
    typeof endY !== 'number' ||
    !Number.isFinite(endY) ||
    typeof color !== 'string' ||
    !color.trim() ||
    color.length > 64 ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    (style !== 'solid' && style !== 'dashed') ||
    !Array.isArray(points) ||
    points.length !== 2 ||
    !points.every((marker) => marker === '' || marker === 'arrow')
  ) {
    throw new Error('CLIENT_EFFECT_LINE_INPUT_INVALID');
  }
  const start = { x: canonicalNumber(startX), y: canonicalNumber(startY) };
  const end = { x: canonicalNumber(endX), y: canonicalNumber(endY) };
  if (
    start.x < 0 ||
    start.x > 1000 ||
    end.x < 0 ||
    end.x > 1000 ||
    start.y < 0 ||
    start.y > 562 ||
    end.y < 0 ||
    end.y > 562
  ) {
    throw new Error('CLIENT_EFFECT_LINE_BOUNDS_INVALID');
  }
  if (start.x === end.x && start.y === end.y) {
    throw new Error('CLIENT_EFFECT_LINE_ZERO_LENGTH');
  }
  if (width < 1 || width > 100) {
    throw new Error('CLIENT_EFFECT_LINE_STROKE_INVALID');
  }
  return {
    start,
    end,
    strokeColor: color.trim(),
    strokeWidth: canonicalNumber(width),
    strokeStyle: style,
    markers: [points[0] as WhiteboardLineMarker, points[1] as WhiteboardLineMarker],
  };
}

export async function digestWhiteboardLineV1(input: WhiteboardLineSpec): Promise<string> {
  const normalized = normalizeWhiteboardLineV1({
    startX: input.start.x,
    startY: input.start.y,
    endX: input.end.x,
    endY: input.end.y,
    color: input.strokeColor,
    width: input.strokeWidth,
    style: input.strokeStyle,
    points: input.markers,
  });
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_LINE_NORMALIZATION_VERSION}\n${JSON.stringify(normalized)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function normalizeWhiteboardLatexV1(input: {
  latex: unknown;
  x: unknown;
  y: unknown;
  width?: unknown;
  height?: unknown;
  color?: unknown;
}): WhiteboardLatexSpec {
  const { latex, x, y } = input;
  const width = input.width ?? 400;
  const height = input.height ?? 80;
  const color = input.color ?? '#000000';
  if (
    typeof latex !== 'string' ||
    !latex.trim() ||
    latex.length > 2_000 ||
    new TextEncoder().encode(JSON.stringify(latex)).byteLength > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(latex) ||
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    typeof color !== 'string' ||
    !color.trim() ||
    color.length > 64
  ) {
    throw new Error('CLIENT_EFFECT_LATEX_INPUT_INVALID');
  }
  const bounds = {
    x: canonicalNumber(x),
    y: canonicalNumber(y),
    width: canonicalNumber(width),
    height: canonicalNumber(height),
  };
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1000 ||
    bounds.y + bounds.height > 563
  ) {
    throw new Error('CLIENT_EFFECT_LATEX_BOUNDS_INVALID');
  }
  return {
    latex,
    bounds,
    color: color.trim(),
    renderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
  };
}

export async function digestWhiteboardLatexV1(input: WhiteboardLatexSpec): Promise<string> {
  const normalized = normalizeWhiteboardLatexV1({
    latex: input.latex,
    ...input.bounds,
    color: input.color,
  });
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION}\n${JSON.stringify(normalized)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export async function digestWhiteboardLatexHtmlV1(html: string): Promise<string> {
  if (typeof html !== 'string' || !html) {
    throw new Error('CLIENT_EFFECT_LATEX_HTML_INVALID');
  }
  const bytes = new TextEncoder().encode(`${CLIENT_EFFECT_LATEX_RENDER_VERSION}\n${html}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

const WHITEBOARD_TABLE_MAX_ROWS = 12;
const WHITEBOARD_TABLE_MAX_COLUMNS = 8;
const WHITEBOARD_TABLE_MAX_CELLS = 96;
const WHITEBOARD_TABLE_MAX_CELL_CHARACTERS = 256;
const WHITEBOARD_TABLE_MAX_RAW_BYTES = 12 * 1024;

function normalizeWhiteboardTableCell(value: unknown): string {
  if (typeof value !== 'string' || value.length > WHITEBOARD_TABLE_MAX_CELL_CHARACTERS) {
    throw new Error('CLIENT_EFFECT_TABLE_CELL_INVALID');
  }
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC');
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(normalized)) {
    throw new Error('CLIENT_EFFECT_TABLE_CELL_INVALID');
  }
  return escapeWhiteboardTableCellText(normalized);
}

export function normalizeWhiteboardTableV1(input: {
  data: unknown;
  x: unknown;
  y: unknown;
  width: unknown;
  height: unknown;
  outline?: unknown;
  theme?: unknown;
}): WhiteboardTableSpec {
  if (
    !Array.isArray(input.data) ||
    input.data.length === 0 ||
    input.data.length > WHITEBOARD_TABLE_MAX_ROWS ||
    new TextEncoder().encode(JSON.stringify(input.data)).byteLength > WHITEBOARD_TABLE_MAX_RAW_BYTES
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_INPUT_INVALID');
  }
  const firstRow = input.data[0];
  if (
    !Array.isArray(firstRow) ||
    firstRow.length === 0 ||
    firstRow.length > WHITEBOARD_TABLE_MAX_COLUMNS ||
    input.data.length * firstRow.length > WHITEBOARD_TABLE_MAX_CELLS ||
    !input.data.every((row) => Array.isArray(row) && row.length === firstRow.length)
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_DIMENSIONS_INVALID');
  }
  const data = input.data.map((row) => row.map(normalizeWhiteboardTableCell));

  const { x, y, width, height } = input;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_INPUT_INVALID');
  }
  const bounds = {
    x: canonicalNumber(x),
    y: canonicalNumber(y),
    width: canonicalNumber(width),
    height: canonicalNumber(height),
  };
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1000 ||
    bounds.y + bounds.height > 563
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_BOUNDS_INVALID');
  }

  let outline: WhiteboardTableOutline = {
    width: 2,
    style: 'solid',
    color: '#eeece1',
  };
  if (input.outline !== undefined) {
    if (!input.outline || typeof input.outline !== 'object' || Array.isArray(input.outline)) {
      throw new Error('CLIENT_EFFECT_TABLE_OUTLINE_INVALID');
    }
    const rawOutline = input.outline as Record<string, unknown>;
    if (
      !hasExactKeys(rawOutline, ['width', 'style', 'color']) ||
      typeof rawOutline.width !== 'number' ||
      !Number.isFinite(rawOutline.width) ||
      rawOutline.width < 0 ||
      rawOutline.width > 20 ||
      (rawOutline.style !== 'solid' && rawOutline.style !== 'dashed') ||
      typeof rawOutline.color !== 'string' ||
      !rawOutline.color.trim() ||
      rawOutline.color.length > 64
    ) {
      throw new Error('CLIENT_EFFECT_TABLE_OUTLINE_INVALID');
    }
    outline = {
      width: canonicalNumber(rawOutline.width),
      style: rawOutline.style,
      color: rawOutline.color.trim(),
    };
  }

  let theme: WhiteboardTableTheme | undefined;
  if (input.theme !== undefined) {
    if (!input.theme || typeof input.theme !== 'object' || Array.isArray(input.theme)) {
      throw new Error('CLIENT_EFFECT_TABLE_THEME_INVALID');
    }
    const rawTheme = input.theme as Record<string, unknown>;
    if (
      !hasExactKeys(rawTheme, ['color']) ||
      typeof rawTheme.color !== 'string' ||
      !rawTheme.color.trim() ||
      rawTheme.color.length > 64
    ) {
      throw new Error('CLIENT_EFFECT_TABLE_THEME_INVALID');
    }
    theme = {
      color: rawTheme.color.trim(),
      rowHeader: true,
      rowFooter: false,
      colHeader: false,
      colFooter: false,
    };
  }

  return {
    data,
    bounds,
    outline,
    ...(theme ? { theme } : {}),
    colWidths: Array(firstRow.length).fill(1 / firstRow.length) as number[],
    cellMinHeight: 36,
  };
}

export function assertWhiteboardTableSpecV1(input: WhiteboardTableSpec): WhiteboardTableSpec {
  if (
    !input ||
    typeof input !== 'object' ||
    !Array.isArray(input.data) ||
    input.data.length === 0 ||
    !Array.isArray(input.data[0]) ||
    input.data[0].length === 0 ||
    input.data.length > WHITEBOARD_TABLE_MAX_ROWS ||
    input.data[0].length > WHITEBOARD_TABLE_MAX_COLUMNS ||
    input.data.length * input.data[0].length > WHITEBOARD_TABLE_MAX_CELLS ||
    !input.data.every(
      (row) =>
        Array.isArray(row) &&
        row.length === input.data[0].length &&
        row.every(
          (cell) =>
            typeof cell === 'string' &&
            cell.length <= WHITEBOARD_TABLE_MAX_CELL_CHARACTERS * 6 &&
            !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(cell),
        ),
    ) ||
    !input.bounds ||
    !input.outline ||
    input.cellMinHeight !== 36 ||
    !Array.isArray(input.colWidths) ||
    input.colWidths.length !== input.data[0].length ||
    !input.colWidths.every((width) => width === 1 / input.data[0].length)
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_SPEC_INVALID');
  }
  const { bounds, outline, theme } = input;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1000 ||
    bounds.y + bounds.height > 563 ||
    !Number.isFinite(outline.width) ||
    outline.width < 0 ||
    outline.width > 20 ||
    (outline.style !== 'solid' && outline.style !== 'dashed') ||
    typeof outline.color !== 'string' ||
    !outline.color ||
    outline.color.length > 64 ||
    (theme !== undefined &&
      (typeof theme.color !== 'string' ||
        !theme.color ||
        theme.color.length > 64 ||
        theme.rowHeader !== true ||
        theme.rowFooter !== false ||
        theme.colHeader !== false ||
        theme.colFooter !== false))
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_SPEC_INVALID');
  }
  return input;
}

export async function digestWhiteboardTableV1(input: WhiteboardTableSpec): Promise<string> {
  const canonical = assertWhiteboardTableSpecV1(input);
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION}\n${JSON.stringify(canonical)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function whiteboardTableSpecsEqual(
  left: WhiteboardTableSpec,
  right: WhiteboardTableSpec,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const WHITEBOARD_CHART_MAX_RAW_BYTES = 16 * 1024;
const WHITEBOARD_CHART_MAX_TEXT_CHARACTERS = 80;
const WHITEBOARD_CHART_MAX_ABSOLUTE_VALUE = 1_000_000_000_000;
const WHITEBOARD_CHART_MAX_THEME_COLORS = 10;
const WHITEBOARD_CHART_CARTESIAN_TYPES = new Set<ChartType>(['bar', 'column', 'line', 'area']);
const WHITEBOARD_CHART_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const WHITEBOARD_CHART_CSS_NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const WHITEBOARD_CHART_RGB_CHANNEL = `${WHITEBOARD_CHART_CSS_NUMBER}%?`;
const WHITEBOARD_CHART_ALPHA = WHITEBOARD_CHART_CSS_NUMBER;
const WHITEBOARD_CHART_HUE = WHITEBOARD_CHART_CSS_NUMBER;
const WHITEBOARD_CHART_PERCENTAGE = `${WHITEBOARD_CHART_CSS_NUMBER}%`;
const WHITEBOARD_CHART_RGB_COLOR = new RegExp(
  `^rgb\\(\\s*${WHITEBOARD_CHART_RGB_CHANNEL}\\s*,\\s*${WHITEBOARD_CHART_RGB_CHANNEL}\\s*,\\s*${WHITEBOARD_CHART_RGB_CHANNEL}\\s*\\)$`,
  'i',
);
const WHITEBOARD_CHART_RGBA_COLOR = new RegExp(
  `^rgba\\(\\s*${WHITEBOARD_CHART_RGB_CHANNEL}\\s*,\\s*${WHITEBOARD_CHART_RGB_CHANNEL}\\s*,\\s*${WHITEBOARD_CHART_RGB_CHANNEL}\\s*,\\s*${WHITEBOARD_CHART_ALPHA}\\s*\\)$`,
  'i',
);
const WHITEBOARD_CHART_HSL_COLOR = new RegExp(
  `^hsl\\(\\s*${WHITEBOARD_CHART_HUE}\\s*,\\s*${WHITEBOARD_CHART_PERCENTAGE}\\s*,\\s*${WHITEBOARD_CHART_PERCENTAGE}\\s*\\)$`,
  'i',
);
const WHITEBOARD_CHART_HSLA_COLOR = new RegExp(
  `^hsla\\(\\s*${WHITEBOARD_CHART_HUE}\\s*,\\s*${WHITEBOARD_CHART_PERCENTAGE}\\s*,\\s*${WHITEBOARD_CHART_PERCENTAGE}\\s*,\\s*${WHITEBOARD_CHART_ALPHA}\\s*\\)$`,
  'i',
);
const WHITEBOARD_CHART_TYPES = new Set<ChartType>([
  ...WHITEBOARD_CHART_CARTESIAN_TYPES,
  'pie',
  'ring',
  'radar',
  'scatter',
]);

function normalizeWhiteboardChartText(value: unknown): string {
  if (typeof value !== 'string' || value.length > WHITEBOARD_CHART_MAX_TEXT_CHARACTERS) {
    throw new Error('CLIENT_EFFECT_CHART_TEXT_INVALID');
  }
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC')
    .trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('CLIENT_EFFECT_CHART_TEXT_INVALID');
  }
  return normalized;
}

function normalizeWhiteboardChartValue(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > WHITEBOARD_CHART_MAX_ABSOLUTE_VALUE
  ) {
    throw new Error('CLIENT_EFFECT_CHART_VALUE_INVALID');
  }
  return canonicalNumber(value);
}

function normalizeWhiteboardChartColor(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw new Error('CLIENT_EFFECT_CHART_THEME_INVALID');
  }
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  const isNamedColor =
    lower === 'transparent' || Object.prototype.hasOwnProperty.call(tinycolor.names, lower);
  const hasStrictRendererSyntax =
    WHITEBOARD_CHART_HEX_COLOR.test(normalized) ||
    isNamedColor ||
    WHITEBOARD_CHART_RGB_COLOR.test(normalized) ||
    WHITEBOARD_CHART_RGBA_COLOR.test(normalized) ||
    WHITEBOARD_CHART_HSL_COLOR.test(normalized) ||
    WHITEBOARD_CHART_HSLA_COLOR.test(normalized);
  const parsed = tinycolor(normalized);
  if (
    !normalized ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    !hasStrictRendererSyntax ||
    !parsed.isValid()
  ) {
    throw new Error('CLIENT_EFFECT_CHART_THEME_INVALID');
  }
  const alpha = parsed.getAlpha();
  if (alpha === 1) return parsed.toHexString();
  const { r, g, b } = parsed.toRgb();
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function normalizeWhiteboardChartV1(input: {
  chartType: unknown;
  x: unknown;
  y: unknown;
  width: unknown;
  height: unknown;
  data: unknown;
  themeColors?: unknown;
}): WhiteboardChartSpec {
  let rawPayload: string;
  try {
    rawPayload = JSON.stringify({
      chartType: input.chartType,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      data: input.data,
      ...(input.themeColors !== undefined ? { themeColors: input.themeColors } : {}),
    });
  } catch {
    throw new Error('CLIENT_EFFECT_CHART_PAYLOAD_INVALID');
  }
  if (
    new TextEncoder().encode(rawPayload).byteLength > WHITEBOARD_CHART_MAX_RAW_BYTES ||
    typeof input.chartType !== 'string' ||
    !WHITEBOARD_CHART_TYPES.has(input.chartType as ChartType)
  ) {
    throw new Error('CLIENT_EFFECT_CHART_PAYLOAD_INVALID');
  }

  const { x, y, width, height } = input;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    throw new Error('CLIENT_EFFECT_CHART_INPUT_INVALID');
  }
  const bounds = {
    x: canonicalNumber(x),
    y: canonicalNumber(y),
    width: canonicalNumber(width),
    height: canonicalNumber(height),
  };
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1000 ||
    bounds.y + bounds.height > 563
  ) {
    throw new Error('CLIENT_EFFECT_CHART_BOUNDS_INVALID');
  }

  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
    throw new Error('CLIENT_EFFECT_CHART_DATA_INVALID');
  }
  const rawData = input.data as Record<string, unknown>;
  if (
    !hasExactKeys(rawData, ['labels', 'legends', 'series']) ||
    !Array.isArray(rawData.labels) ||
    !Array.isArray(rawData.legends) ||
    !Array.isArray(rawData.series)
  ) {
    throw new Error('CLIENT_EFFECT_CHART_DATA_INVALID');
  }
  const labels = rawData.labels.map(normalizeWhiteboardChartText);
  const legends = rawData.legends.map(normalizeWhiteboardChartText);
  const series = rawData.series.map((row) => {
    if (!Array.isArray(row)) throw new Error('CLIENT_EFFECT_CHART_DATA_INVALID');
    return row.map(normalizeWhiteboardChartValue);
  });
  const chartType = input.chartType as ChartType;

  if (WHITEBOARD_CHART_CARTESIAN_TYPES.has(chartType)) {
    if (
      labels.length < 1 ||
      labels.length > 24 ||
      legends.length < 1 ||
      legends.length > 8 ||
      series.length !== legends.length ||
      series.some((row) => row.length !== labels.length)
    ) {
      throw new Error('CLIENT_EFFECT_CHART_DIMENSIONS_INVALID');
    }
  } else if (chartType === 'radar') {
    if (
      labels.length < 3 ||
      labels.length > 12 ||
      legends.length < 1 ||
      legends.length > 8 ||
      series.length !== legends.length ||
      series.some((row) => row.length !== labels.length)
    ) {
      throw new Error('CLIENT_EFFECT_CHART_DIMENSIONS_INVALID');
    }
  } else if (chartType === 'pie' || chartType === 'ring') {
    if (
      labels.length < 1 ||
      labels.length > 16 ||
      legends.length !== 1 ||
      series.length !== 1 ||
      series[0].length !== labels.length
    ) {
      throw new Error('CLIENT_EFFECT_CHART_DIMENSIONS_INVALID');
    }
    if (series[0].some((value) => value < 0) || !series[0].some((value) => value > 0)) {
      throw new Error('CLIENT_EFFECT_CHART_VALUE_INVALID');
    }
  } else if (
    labels.length < 1 ||
    labels.length > 64 ||
    legends.length !== 2 ||
    series.length !== 2 ||
    series[0].length !== labels.length ||
    series[1].length !== labels.length
  ) {
    throw new Error('CLIENT_EFFECT_CHART_DIMENSIONS_INVALID');
  }

  let themeColors: string[];
  if (input.themeColors === undefined) {
    themeColors = [...DEFAULT_WHITEBOARD_CHART_THEME_COLORS];
  } else {
    if (
      !Array.isArray(input.themeColors) ||
      input.themeColors.length < 1 ||
      input.themeColors.length > WHITEBOARD_CHART_MAX_THEME_COLORS
    ) {
      throw new Error('CLIENT_EFFECT_CHART_THEME_INVALID');
    }
    themeColors = input.themeColors.map(normalizeWhiteboardChartColor);
  }

  return {
    chartType,
    data: { labels, legends, series },
    bounds,
    themeColors,
    rotate: 0,
  };
}

export function assertWhiteboardChartSpecV1(input: WhiteboardChartSpec): WhiteboardChartSpec {
  if (!input || typeof input !== 'object' || input.rotate !== 0 || !input.bounds) {
    throw new Error('CLIENT_EFFECT_CHART_SPEC_INVALID');
  }
  try {
    return normalizeWhiteboardChartV1({
      chartType: input.chartType,
      x: input.bounds.x,
      y: input.bounds.y,
      width: input.bounds.width,
      height: input.bounds.height,
      data: input.data,
      themeColors: input.themeColors,
    });
  } catch {
    throw new Error('CLIENT_EFFECT_CHART_SPEC_INVALID');
  }
}

export async function digestWhiteboardChartV1(input: WhiteboardChartSpec): Promise<string> {
  const canonical = assertWhiteboardChartSpecV1(input);
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_CHART_NORMALIZATION_VERSION}\n${JSON.stringify(canonical)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function whiteboardChartSpecsEqual(
  left: WhiteboardChartSpec,
  right: WhiteboardChartSpec,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const WHITEBOARD_CODE_MAX_RAW_BYTES = 16 * 1024;
const WHITEBOARD_CODE_MAX_LINES = 200;
const WHITEBOARD_CODE_MAX_LINE_CHARACTERS = 1_000;
const WHITEBOARD_CODE_MAX_LANGUAGE_CHARACTERS = 32;
const WHITEBOARD_CODE_MAX_FILE_NAME_CHARACTERS = 128;
const WHITEBOARD_CODE_LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9_+#.-]*$/;
const WHITEBOARD_CODE_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cjs: 'javascript',
  cts: 'typescript',
  'c++': 'cpp',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  plaintext: 'text',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  ts: 'typescript',
  txt: 'text',
  yml: 'yaml',
  zsh: 'bash',
};
const WHITEBOARD_CODE_DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function normalizeWhiteboardCodeLanguage(value: unknown): string {
  if (typeof value !== 'string' || value.length > WHITEBOARD_CODE_MAX_LANGUAGE_CHARACTERS) {
    throw new Error('CLIENT_EFFECT_CODE_LANGUAGE_INVALID');
  }
  const normalized = value.normalize('NFC').trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > WHITEBOARD_CODE_MAX_LANGUAGE_CHARACTERS ||
    !WHITEBOARD_CODE_LANGUAGE_PATTERN.test(normalized)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_LANGUAGE_INVALID');
  }
  return WHITEBOARD_CODE_LANGUAGE_ALIASES[normalized] ?? normalized;
}

function normalizeWhiteboardCodeFileName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > WHITEBOARD_CODE_MAX_FILE_NAME_CHARACTERS) {
    throw new Error('CLIENT_EFFECT_CODE_FILE_NAME_INVALID');
  }
  const normalized = value.normalize('NFC').trim();
  if (
    !normalized ||
    normalized.length > WHITEBOARD_CODE_MAX_FILE_NAME_CHARACTERS ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_FILE_NAME_INVALID');
  }
  return normalized;
}

export function normalizeWhiteboardCodeV1(input: {
  language: unknown;
  code: unknown;
  x: unknown;
  y: unknown;
  width?: unknown;
  height?: unknown;
  fileName?: unknown;
}): WhiteboardCodeSpec {
  let rawPayload: string;
  try {
    rawPayload = JSON.stringify({
      language: input.language,
      code: input.code,
      x: input.x,
      y: input.y,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    });
  } catch {
    throw new Error('CLIENT_EFFECT_CODE_PAYLOAD_INVALID');
  }
  if (
    new TextEncoder().encode(rawPayload).byteLength > WHITEBOARD_CODE_MAX_RAW_BYTES ||
    typeof input.code !== 'string'
  ) {
    throw new Error('CLIENT_EFFECT_CODE_PAYLOAD_INVALID');
  }

  const normalizedCode = input.code.replace(/\r\n?/g, '\n');
  if (!normalizedCode.trim() || WHITEBOARD_CODE_DISALLOWED_CONTROL.test(normalizedCode)) {
    throw new Error('CLIENT_EFFECT_CODE_CONTENT_INVALID');
  }
  const lines = createWhiteboardCodeLines(normalizedCode);
  if (
    lines.length > WHITEBOARD_CODE_MAX_LINES ||
    lines.some((line) => line.content.length > WHITEBOARD_CODE_MAX_LINE_CHARACTERS)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_CONTENT_INVALID');
  }

  const width = input.width ?? 500;
  const height = input.height ?? 300;
  if (
    typeof input.x !== 'number' ||
    !Number.isFinite(input.x) ||
    typeof input.y !== 'number' ||
    !Number.isFinite(input.y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_INPUT_INVALID');
  }
  const bounds = {
    x: canonicalNumber(input.x),
    y: canonicalNumber(input.y),
    width: canonicalNumber(width),
    height: canonicalNumber(height),
  };
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x + bounds.width > 1000 ||
    bounds.y + bounds.height > 563
  ) {
    throw new Error('CLIENT_EFFECT_CODE_BOUNDS_INVALID');
  }

  const fileName = normalizeWhiteboardCodeFileName(input.fileName);
  return {
    language: normalizeWhiteboardCodeLanguage(input.language),
    lines,
    ...(fileName ? { fileName } : {}),
    bounds,
    showLineNumbers: true,
    fontSize: 14,
    rotate: 0,
  };
}

export function assertWhiteboardCodeSpecV1(input: WhiteboardCodeSpec): WhiteboardCodeSpec {
  if (
    !input ||
    typeof input !== 'object' ||
    !Array.isArray(input.lines) ||
    input.lines.length === 0 ||
    input.showLineNumbers !== true ||
    input.fontSize !== 14 ||
    input.rotate !== 0 ||
    !input.bounds ||
    input.lines.some(
      (line, index) =>
        !line ||
        typeof line !== 'object' ||
        line.id !== `L${index + 1}` ||
        typeof line.content !== 'string',
    )
  ) {
    throw new Error('CLIENT_EFFECT_CODE_SPEC_INVALID');
  }
  let normalized: WhiteboardCodeSpec;
  try {
    normalized = normalizeWhiteboardCodeV1({
      language: input.language,
      code: input.lines.map((line) => line.content).join('\n'),
      x: input.bounds.x,
      y: input.bounds.y,
      width: input.bounds.width,
      height: input.bounds.height,
      fileName: input.fileName,
    });
  } catch {
    throw new Error('CLIENT_EFFECT_CODE_SPEC_INVALID');
  }
  if (!whiteboardCodeSpecsEqual(input, normalized)) {
    throw new Error('CLIENT_EFFECT_CODE_SPEC_INVALID');
  }
  return input;
}

export async function digestWhiteboardCodeV1(input: WhiteboardCodeSpec): Promise<string> {
  const canonical = assertWhiteboardCodeSpecV1(input);
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_CODE_NORMALIZATION_VERSION}\n${JSON.stringify(canonical)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function whiteboardCodeSpecsEqual(
  left: WhiteboardCodeSpec,
  right: WhiteboardCodeSpec,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const WHITEBOARD_CODE_MAX_LINE_ID_CHARACTERS = 256;
const WHITEBOARD_CODE_STATE_MAX_RAW_BYTES = 24 * 1024;
const WHITEBOARD_CODE_METADATA_DISALLOWED_CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const WHITEBOARD_CODE_LINE_DISALLOWED_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]/;
const WHITEBOARD_CODE_EDIT_CONTENT_DISALLOWED_CONTROL =
  /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/;

function assertEditableCodeMetadataString(
  value: unknown,
  maxLength: number,
  code: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    WHITEBOARD_CODE_METADATA_DISALLOWED_CONTROL.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function assertEditableCodeLineContent(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > WHITEBOARD_CODE_MAX_LINE_CHARACTERS ||
    WHITEBOARD_CODE_LINE_DISALLOWED_CONTROL.test(value)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_CONTENT_INVALID');
  }
  return value;
}

export function assertWhiteboardEditableCodeStateV1(
  input: WhiteboardEditableCodeState,
): WhiteboardEditableCodeState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_STATE_INVALID');
  }
  const language = assertEditableCodeMetadataString(
    input.language,
    WHITEBOARD_CODE_MAX_LANGUAGE_CHARACTERS,
    'CLIENT_EFFECT_CODE_EDIT_LANGUAGE_INVALID',
  );
  const fileName =
    input.fileName === undefined
      ? undefined
      : assertEditableCodeMetadataString(
          input.fileName,
          WHITEBOARD_CODE_MAX_FILE_NAME_CHARACTERS,
          'CLIENT_EFFECT_CODE_EDIT_FILE_NAME_INVALID',
          { allowEmpty: true },
        );
  if (
    !Array.isArray(input.lines) ||
    input.lines.length > WHITEBOARD_CODE_MAX_LINES ||
    !input.bounds ||
    typeof input.bounds !== 'object' ||
    input.showLineNumbers !== Boolean(input.showLineNumbers) ||
    typeof input.fontSize !== 'number' ||
    !Number.isFinite(input.fontSize) ||
    input.fontSize <= 0 ||
    input.fontSize > 256 ||
    typeof input.rotate !== 'number' ||
    !Number.isFinite(input.rotate)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_STATE_INVALID');
  }

  const lineIds = new Set<string>();
  const lines = input.lines.map((line) => {
    if (!line || typeof line !== 'object') {
      throw new Error('CLIENT_EFFECT_CODE_EDIT_LINE_INVALID');
    }
    const id = assertEditableCodeMetadataString(
      line.id,
      WHITEBOARD_CODE_MAX_LINE_ID_CHARACTERS,
      'CLIENT_EFFECT_CODE_EDIT_LINE_ID_INVALID',
    );
    if (lineIds.has(id)) throw new Error('CLIENT_EFFECT_CODE_EDIT_LINE_ID_DUPLICATE');
    lineIds.add(id);
    const content = assertEditableCodeLineContent(line.content);
    return { id, content };
  });

  const bounds = {
    x: canonicalNumber(input.bounds.x),
    y: canonicalNumber(input.bounds.y),
    width: canonicalNumber(input.bounds.width),
    height: canonicalNumber(input.bounds.height),
  };
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_BOUNDS_INVALID');
  }

  const canonical: WhiteboardEditableCodeState = {
    language,
    lines,
    ...(fileName !== undefined ? { fileName } : {}),
    bounds,
    showLineNumbers: input.showLineNumbers,
    fontSize: canonicalNumber(input.fontSize),
    rotate: canonicalNumber(input.rotate),
  };
  if (
    new TextEncoder().encode(JSON.stringify(canonical)).byteLength >
    WHITEBOARD_CODE_STATE_MAX_RAW_BYTES
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_STATE_TOO_LARGE');
  }
  return canonical;
}

export async function digestWhiteboardEditableCodeStateV1(
  input: WhiteboardEditableCodeState,
): Promise<string> {
  const canonical = assertWhiteboardEditableCodeStateV1(input);
  const bytes = new TextEncoder().encode(
    `${CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION}\n${JSON.stringify(canonical)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function whiteboardEditableCodeStatesEqual(
  left: WhiteboardEditableCodeState,
  right: WhiteboardEditableCodeState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeEditContent(value: string): string[] {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > WHITEBOARD_CODE_MAX_RAW_BYTES
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_CONTENT_INVALID');
  }
  const normalized = value.replace(/\r\n?/g, '\n');
  if (WHITEBOARD_CODE_EDIT_CONTENT_DISALLOWED_CONTROL.test(normalized)) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_CONTENT_INVALID');
  }
  const lines = normalized.split('\n');
  if (
    lines.length > WHITEBOARD_CODE_MAX_LINES ||
    lines.some((line) => line.length > WHITEBOARD_CODE_MAX_LINE_CHARACTERS)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_CONTENT_INVALID');
  }
  return lines;
}

function assertUniqueTargetLineIds(value: unknown, beforeLineIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_TARGET_INVALID');
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    const id = assertEditableCodeMetadataString(
      candidate,
      WHITEBOARD_CODE_MAX_LINE_ID_CHARACTERS,
      'CLIENT_EFFECT_CODE_EDIT_TARGET_INVALID',
    );
    if (seen.has(id)) throw new Error('CLIENT_EFFECT_CODE_EDIT_TARGET_DUPLICATE');
    if (!beforeLineIds.has(id)) throw new Error('CLIENT_EFFECT_CODE_EDIT_LINE_NOT_FOUND');
    seen.add(id);
    return id;
  });
}

function generatedEditLineId(executionId: string, outputOrdinal: number): string {
  const id = `CE_${executionId}_${outputOrdinal}`;
  return assertEditableCodeMetadataString(
    id,
    WHITEBOARD_CODE_MAX_LINE_ID_CHARACTERS,
    'CLIENT_EFFECT_CODE_EDIT_GENERATED_LINE_ID_INVALID',
  );
}

export function applyWhiteboardCodeEditV1(opts: {
  before: WhiteboardEditableCodeState;
  intent: WhiteboardCodeEditIntent;
  executionId: string;
}): {
  after: WhiteboardEditableCodeState;
  newLineIds: string[];
  noOp: boolean;
} {
  const before = assertWhiteboardEditableCodeStateV1(opts.before);
  const elementId = assertEditableCodeMetadataString(
    opts.intent.elementId,
    512,
    'CLIENT_EFFECT_CODE_EDIT_ELEMENT_ID_INVALID',
  );
  void elementId;
  const executionId = assertEditableCodeMetadataString(
    opts.executionId,
    512,
    'CLIENT_EFFECT_CODE_EDIT_EXECUTION_ID_INVALID',
  );
  const beforeLineIds = new Set(before.lines.map((line) => line.id));
  let nextLines = before.lines.map((line) => ({ ...line }));
  const newLineIds: string[] = [];

  if (opts.intent.operation === 'insert_after' || opts.intent.operation === 'insert_before') {
    const lineId = assertEditableCodeMetadataString(
      opts.intent.lineId,
      WHITEBOARD_CODE_MAX_LINE_ID_CHARACTERS,
      'CLIENT_EFFECT_CODE_EDIT_TARGET_INVALID',
    );
    const targetIndex = nextLines.findIndex((line) => line.id === lineId);
    if (targetIndex < 0) throw new Error('CLIENT_EFFECT_CODE_EDIT_LINE_NOT_FOUND');
    const contentLines = normalizeEditContent(opts.intent.content);
    const insertionIndex = opts.intent.operation === 'insert_after' ? targetIndex + 1 : targetIndex;
    const insertedLines = contentLines.map((content, offset) => {
      const id = generatedEditLineId(executionId, insertionIndex + offset + 1);
      if (beforeLineIds.has(id) || newLineIds.includes(id)) {
        throw new Error('CLIENT_EFFECT_CODE_EDIT_GENERATED_LINE_ID_CONFLICT');
      }
      newLineIds.push(id);
      return { id, content };
    });
    nextLines.splice(insertionIndex, 0, ...insertedLines);
  } else if (opts.intent.operation === 'delete_lines') {
    const targetIds = assertUniqueTargetLineIds(opts.intent.lineIds, beforeLineIds);
    const deleteIds = new Set(targetIds);
    nextLines = nextLines.filter((line) => !deleteIds.has(line.id));
  } else if (opts.intent.operation === 'replace_lines') {
    const targetIds = assertUniqueTargetLineIds(opts.intent.lineIds, beforeLineIds);
    const anchorIndex = before.lines.findIndex((line) => line.id === targetIds[0]);
    const targetIdSet = new Set(targetIds);
    const insertionIndex = before.lines
      .slice(0, anchorIndex)
      .filter((line) => !targetIdSet.has(line.id)).length;
    const retained = nextLines.filter((line) => !targetIdSet.has(line.id));
    const contentLines = normalizeEditContent(opts.intent.content);
    const replacement = contentLines.map((content, offset) => {
      const reusableId = targetIds[offset];
      if (reusableId) return { id: reusableId, content };
      const id = generatedEditLineId(executionId, insertionIndex + offset + 1);
      if (beforeLineIds.has(id) || newLineIds.includes(id)) {
        throw new Error('CLIENT_EFFECT_CODE_EDIT_GENERATED_LINE_ID_CONFLICT');
      }
      newLineIds.push(id);
      return { id, content };
    });
    retained.splice(insertionIndex, 0, ...replacement);
    nextLines = retained;
  } else {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_OPERATION_INVALID');
  }

  const after = assertWhiteboardEditableCodeStateV1({ ...before, lines: nextLines });
  return {
    after,
    newLineIds,
    noOp: whiteboardEditableCodeStatesEqual(before, after),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isWhiteboardElementType(value: unknown): value is WhiteboardElementType {
  return (
    value === 'text' ||
    value === 'image' ||
    value === 'shape' ||
    value === 'line' ||
    value === 'chart' ||
    value === 'table' ||
    value === 'latex' ||
    value === 'video' ||
    value === 'audio' ||
    value === 'code'
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isTargetBinding(value: unknown): value is AcceptedTargetBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    hasExactKeys(target, [
      'requestId',
      'sessionId',
      'stageId',
      'sceneId',
      'whiteboardId',
      'bindingVersion',
    ]) &&
    isNonEmptyString(target.requestId) &&
    isNonEmptyString(target.sessionId) &&
    isNonEmptyString(target.stageId) &&
    isNonEmptyString(target.sceneId) &&
    isNonEmptyString(target.whiteboardId) &&
    Number.isInteger(target.bindingVersion) &&
    Number(target.bindingVersion) > 0
  );
}

function isVisibilityTarget(value: unknown): value is WhiteboardVisibilityTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    hasExactKeys(target, ['requestId', 'sessionId', 'stageId', 'sceneId', 'bindingVersion']) &&
    isNonEmptyString(target.requestId) &&
    isNonEmptyString(target.sessionId) &&
    isNonEmptyString(target.stageId) &&
    isNonEmptyString(target.sceneId) &&
    Number.isInteger(target.bindingVersion) &&
    Number(target.bindingVersion) > 0
  );
}

export function isClientEffectAck(value: unknown): value is ClientEffectAck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ack = value as Record<string, unknown>;
  if (
    ack.protocolVersion !== TOOL_EXECUTION_PROTOCOL_VERSION ||
    !isNonEmptyString(ack.executionId) ||
    !isNonEmptyString(ack.idempotencyKey) ||
    !isNonEmptyString(ack.clientEventId) ||
    typeof ack.observedAt !== 'number' ||
    !Number.isFinite(ack.observedAt)
  ) {
    return false;
  }

  switch (ack.status) {
    case 'accepted':
      if (
        hasExactKeys(ack, [
          'protocolVersion',
          'executionId',
          'idempotencyKey',
          'clientEventId',
          'observedAt',
          'status',
          'targetBinding',
        ])
      ) {
        return isTargetBinding(ack.targetBinding);
      }
      return (
        hasExactKeys(ack, [
          'protocolVersion',
          'executionId',
          'idempotencyKey',
          'clientEventId',
          'observedAt',
          'status',
          'visibilityTarget',
        ]) && isVisibilityTarget(ack.visibilityTarget)
      );
    case 'presentation_paused':
    case 'presentation_resumed':
      return hasExactKeys(ack, [
        'protocolVersion',
        'executionId',
        'idempotencyKey',
        'clientEventId',
        'observedAt',
        'status',
      ]);
    case 'effect_committed': {
      if (
        hasExactKeys(ack, [
          'protocolVersion',
          'executionId',
          'idempotencyKey',
          'clientEventId',
          'observedAt',
          'status',
          'visibilityTarget',
          'postcondition',
        ])
      ) {
        if (
          !isVisibilityTarget(ack.visibilityTarget) ||
          !ack.postcondition ||
          typeof ack.postcondition !== 'object' ||
          Array.isArray(ack.postcondition)
        ) {
          return false;
        }
        const postcondition = ack.postcondition as Record<string, unknown>;
        return (
          hasExactKeys(postcondition, [
            'kind',
            'normalizationVersion',
            'desiredOpen',
            'observedOpen',
            'visibilityChanged',
          ]) &&
          postcondition.kind === 'whiteboard_closed' &&
          postcondition.normalizationVersion === CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION &&
          postcondition.desiredOpen === false &&
          postcondition.observedOpen === false &&
          typeof postcondition.visibilityChanged === 'boolean'
        );
      }
      if (
        !hasExactKeys(ack, [
          'protocolVersion',
          'executionId',
          'idempotencyKey',
          'clientEventId',
          'observedAt',
          'status',
          'targetBinding',
          'postcondition',
        ])
      ) {
        return false;
      }
      if (!isTargetBinding(ack.targetBinding)) return false;
      if (
        !ack.postcondition ||
        typeof ack.postcondition !== 'object' ||
        Array.isArray(ack.postcondition)
      ) {
        return false;
      }
      const postcondition = ack.postcondition as Record<string, unknown>;
      if (postcondition.kind === 'whiteboard_empty') {
        const commonKeys = [
          'kind',
          'normalizationVersion',
          'membershipNormalizationVersion',
          'boardContentNormalizationVersion',
          'whiteboardId',
          'cleared',
          'elementCountBefore',
          'elementCountAfter',
          'observedMembershipDigestBefore',
          'observedOpen',
          'visibilityChanged',
        ];
        const commonValid =
          postcondition.normalizationVersion === CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION &&
          postcondition.membershipNormalizationVersion ===
            CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION &&
          postcondition.boardContentNormalizationVersion ===
            CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION &&
          isNonEmptyString(postcondition.whiteboardId) &&
          Number.isInteger(postcondition.elementCountBefore) &&
          postcondition.elementCountAfter === 0 &&
          isNonEmptyString(postcondition.observedMembershipDigestBefore) &&
          typeof postcondition.observedOpen === 'boolean' &&
          typeof postcondition.visibilityChanged === 'boolean';
        if (!commonValid) return false;
        if (postcondition.cleared === true) {
          return (
            hasExactKeys(postcondition, [
              ...commonKeys,
              'boardContentDigestAtAccepted',
              'boardContentDigestBeforeMutation',
              'observedBoardContentDigestAfter',
              'historySnapshotDigest',
            ]) &&
            Number(postcondition.elementCountBefore) > 0 &&
            postcondition.observedOpen === true &&
            isNonEmptyString(postcondition.boardContentDigestAtAccepted) &&
            isNonEmptyString(postcondition.boardContentDigestBeforeMutation) &&
            postcondition.observedBoardContentDigestAfter ===
              CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST &&
            isNonEmptyString(postcondition.historySnapshotDigest)
          );
        }
        if (postcondition.cleared === false) {
          return (
            hasExactKeys(postcondition, [...commonKeys, 'verifiedEmptyBoardContentDigest']) &&
            postcondition.elementCountBefore === 0 &&
            postcondition.observedMembershipDigestBefore ===
              CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST &&
            postcondition.verifiedEmptyBoardContentDigest ===
              CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST &&
            postcondition.visibilityChanged === false
          );
        }
        return false;
      }
      if (
        postcondition.kind === 'whiteboard_element_absent' &&
        hasExactKeys(postcondition, [
          'kind',
          'normalizationVersion',
          'stableElementId',
          'whiteboardId',
          'observedElementType',
          'matchingElementCountBefore',
          'matchingElementCountAfter',
          'elementCountBefore',
          'elementCountAfter',
          'deleted',
        ])
      ) {
        return (
          postcondition.normalizationVersion === CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION &&
          isNonEmptyString(postcondition.stableElementId) &&
          isNonEmptyString(postcondition.whiteboardId) &&
          isWhiteboardElementType(postcondition.observedElementType) &&
          postcondition.matchingElementCountBefore === 1 &&
          postcondition.matchingElementCountAfter === 0 &&
          Number.isInteger(postcondition.elementCountBefore) &&
          Number(postcondition.elementCountBefore) > 0 &&
          Number.isInteger(postcondition.elementCountAfter) &&
          Number(postcondition.elementCountAfter) >= 0 &&
          Number(postcondition.elementCountAfter) ===
            Number(postcondition.elementCountBefore) - 1 &&
          postcondition.deleted === true
        );
      }
      if (
        postcondition.kind === 'whiteboard_open' &&
        hasExactKeys(postcondition, [
          'kind',
          'normalizationVersion',
          'whiteboardId',
          'desiredOpen',
          'observedOpen',
          'created',
          'visibilityChanged',
        ])
      ) {
        return (
          postcondition.normalizationVersion === CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION &&
          isNonEmptyString(postcondition.whiteboardId) &&
          postcondition.desiredOpen === true &&
          postcondition.observedOpen === true &&
          typeof postcondition.created === 'boolean' &&
          typeof postcondition.visibilityChanged === 'boolean'
        );
      }
      if (
        postcondition.elementType === 'text' &&
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedContentDigest',
          'matchingElementCount',
        ])
      ) {
        return (
          isNonEmptyString(postcondition.stableElementId) &&
          postcondition.normalizationVersion === CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION &&
          isNonEmptyString(postcondition.observedContentDigest) &&
          postcondition.matchingElementCount === 1
        );
      }
      if (
        postcondition.elementType === 'shape' &&
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedShapeDigest',
          'matchingElementCount',
          'shape',
          'bounds',
          'fillColor',
        ])
      ) {
        if (
          !isNonEmptyString(postcondition.stableElementId) ||
          postcondition.normalizationVersion !== CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION ||
          !isNonEmptyString(postcondition.observedShapeDigest) ||
          postcondition.matchingElementCount !== 1 ||
          !postcondition.bounds ||
          typeof postcondition.bounds !== 'object' ||
          Array.isArray(postcondition.bounds)
        ) {
          return false;
        }
        const bounds = postcondition.bounds as Record<string, unknown>;
        if (!hasExactKeys(bounds, ['x', 'y', 'width', 'height'])) return false;
        try {
          normalizeWhiteboardShapeV1({
            shape: postcondition.shape,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            fillColor: postcondition.fillColor,
          });
          return true;
        } catch {
          return false;
        }
      }
      if (
        postcondition.elementType === 'latex' &&
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedFormulaDigest',
          'observedHtmlDigest',
          'matchingElementCount',
          'latex',
          'bounds',
          'color',
          'renderVersion',
        ])
      ) {
        if (
          !isNonEmptyString(postcondition.stableElementId) ||
          postcondition.normalizationVersion !== CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION ||
          postcondition.renderVersion !== CLIENT_EFFECT_LATEX_RENDER_VERSION ||
          !isNonEmptyString(postcondition.observedFormulaDigest) ||
          !isNonEmptyString(postcondition.observedHtmlDigest) ||
          postcondition.matchingElementCount !== 1 ||
          !postcondition.bounds ||
          typeof postcondition.bounds !== 'object' ||
          Array.isArray(postcondition.bounds)
        ) {
          return false;
        }
        const bounds = postcondition.bounds as Record<string, unknown>;
        if (!hasExactKeys(bounds, ['x', 'y', 'width', 'height'])) return false;
        try {
          normalizeWhiteboardLatexV1({
            latex: postcondition.latex,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            color: postcondition.color,
          });
          return true;
        } catch {
          return false;
        }
      }
      if (
        postcondition.elementType === 'table' &&
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedTableDigest',
          'matchingElementCount',
        ])
      ) {
        return (
          isNonEmptyString(postcondition.stableElementId) &&
          postcondition.normalizationVersion === CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION &&
          isNonEmptyString(postcondition.observedTableDigest) &&
          postcondition.matchingElementCount === 1
        );
      }
      if (
        postcondition.elementType === 'chart' &&
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedChartDigest',
          'matchingElementCount',
        ])
      ) {
        return (
          isNonEmptyString(postcondition.stableElementId) &&
          postcondition.normalizationVersion === CLIENT_EFFECT_CHART_NORMALIZATION_VERSION &&
          isNonEmptyString(postcondition.observedChartDigest) &&
          postcondition.matchingElementCount === 1
        );
      }
      if (
        postcondition.elementType === 'code' &&
        postcondition.normalizationVersion === CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION &&
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'expectedWhiteboardId',
          'observedBeforeCodeDigest',
          'observedAfterCodeDigest',
          'matchingElementCount',
          'noOp',
        ])
      ) {
        return (
          isNonEmptyString(postcondition.stableElementId) &&
          isNonEmptyString(postcondition.expectedWhiteboardId) &&
          isNonEmptyString(postcondition.observedBeforeCodeDigest) &&
          isNonEmptyString(postcondition.observedAfterCodeDigest) &&
          postcondition.matchingElementCount === 1 &&
          typeof postcondition.noOp === 'boolean'
        );
      }
      if (
        postcondition.elementType === 'code' &&
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedCodeDigest',
          'matchingElementCount',
        ])
      ) {
        return (
          isNonEmptyString(postcondition.stableElementId) &&
          postcondition.normalizationVersion === CLIENT_EFFECT_CODE_NORMALIZATION_VERSION &&
          isNonEmptyString(postcondition.observedCodeDigest) &&
          postcondition.matchingElementCount === 1
        );
      }
      if (
        postcondition.elementType !== 'line' ||
        !hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedLineDigest',
          'matchingElementCount',
          'start',
          'end',
          'strokeColor',
          'strokeWidth',
          'strokeStyle',
          'markers',
        ]) ||
        !isNonEmptyString(postcondition.stableElementId) ||
        postcondition.normalizationVersion !== CLIENT_EFFECT_LINE_NORMALIZATION_VERSION ||
        !isNonEmptyString(postcondition.observedLineDigest) ||
        postcondition.matchingElementCount !== 1 ||
        !postcondition.start ||
        typeof postcondition.start !== 'object' ||
        Array.isArray(postcondition.start) ||
        !postcondition.end ||
        typeof postcondition.end !== 'object' ||
        Array.isArray(postcondition.end)
      ) {
        return false;
      }
      const start = postcondition.start as Record<string, unknown>;
      const end = postcondition.end as Record<string, unknown>;
      if (!hasExactKeys(start, ['x', 'y']) || !hasExactKeys(end, ['x', 'y'])) return false;
      try {
        normalizeWhiteboardLineV1({
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          color: postcondition.strokeColor,
          width: postcondition.strokeWidth,
          style: postcondition.strokeStyle,
          points: postcondition.markers,
        });
        return true;
      } catch {
        return false;
      }
    }
    case 'effect_failed':
    case 'cancelled': {
      if (
        !hasExactKeys(ack, [
          'protocolVersion',
          'executionId',
          'idempotencyKey',
          'clientEventId',
          'observedAt',
          'status',
          'error',
        ]) ||
        !ack.error ||
        typeof ack.error !== 'object' ||
        Array.isArray(ack.error)
      ) {
        return false;
      }
      const error = ack.error as Record<string, unknown>;
      return (
        hasExactKeys(error, ['code', 'message', 'retryable']) &&
        isNonEmptyString(error.code) &&
        isNonEmptyString(error.message) &&
        typeof error.retryable === 'boolean'
      );
    }
    default:
      return false;
  }
}

export function resolveActiveEffectBudget(opts: {
  configuredActiveEffectBudgetMs: number;
  deadlineAt: number;
  now: number;
  settlementSafetyMarginMs: number;
}): number | null {
  const values = [
    opts.configuredActiveEffectBudgetMs,
    opts.deadlineAt,
    opts.now,
    opts.settlementSafetyMarginMs,
  ];
  if (values.some((value) => !Number.isFinite(value)) || opts.settlementSafetyMarginMs <= 0) {
    throw new Error('Client effect timing values must be finite with a positive safety margin.');
  }
  const remaining = opts.deadlineAt - opts.now - opts.settlementSafetyMarginMs;
  const budget = Math.min(opts.configuredActiveEffectBudgetMs, remaining);
  return budget > 0 ? budget : null;
}
