import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_RENDER_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
  normalizeWhiteboardChartV1,
  normalizeWhiteboardCodeEditIntentV1,
  normalizeWhiteboardCodeV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardRendererColorV1,
  normalizeWhiteboardShapeV1,
  normalizeWhiteboardTableIntentV1,
  type WhiteboardChartSpec,
  type WhiteboardCodeEditIntent,
  type WhiteboardLineMarker,
  type WhiteboardLineStyle,
  type WhiteboardShapeKind,
  type WhiteboardTableOutline,
} from './client-effect-contract';
import {
  deriveRevisionedCodeEditLineId,
  deriveRevisionedWhiteboardId,
  digestRevisionedValue,
  revisionedCodeEditLineIdPrefix,
} from './revisioned-whiteboard-digest';

export const REVISIONED_WHITEBOARD_PROTOCOL_VERSION = 'maic.whiteboard-mutation.v2' as const;
export const REVISIONED_WHITEBOARD_ACK_HEADER = 'x-maic-revisioned-effect-token' as const;

export const MAX_REVISIONED_WHITEBOARD_RECEIPT_BYTES = 64 * 1024;
export const MAX_REVISIONED_WHITEBOARD_ACK_BYTES = 68 * 1024;
export const MAX_REVISIONED_WHITEBOARD_JSON_DEPTH = 32;
export const MAX_REVISIONED_WHITEBOARD_JSON_ENTRIES = 4096;
export const MAX_REVISIONED_WHITEBOARD_JSON_STRING_BYTES = 48 * 1024;

export const REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_line',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_chart',
  'wb_draw_code',
  'wb_edit_code',
  'wb_delete',
  'wb_clear',
] as const;

export type RevisionedWhiteboardMutationToolName =
  (typeof REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES)[number];

export type RevisionedWhiteboardBinding = {
  stageId: string;
  whiteboardId: string | null;
  revision: number;
};

export type RevisionedWhiteboardAcceptedBinding = {
  stageId: string;
  whiteboardId: string | null;
  observedRevision: number;
};

export type RevisionedWhiteboardEnvironmentBinding = {
  stageId: string | null;
  whiteboardId: string | null;
  revision: number;
};

export type RevisionedWhiteboardAuthenticatedTarget = {
  childInvocationId: string;
  requestId: string;
  sessionId: string;
  sceneId: string;
};

export type RevisionedDrawTextIntent = {
  content: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
  color?: string;
};

export type RevisionedDrawShapeIntent = {
  shape: WhiteboardShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
};

export type RevisionedDrawLineIntent = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color?: string;
  width?: number;
  style?: WhiteboardLineStyle;
  points?: [WhiteboardLineMarker, WhiteboardLineMarker];
};

export type RevisionedDrawLatexIntent = {
  latex: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
};

export type RevisionedDrawTableIntent = {
  data: string[][];
  x: number;
  y: number;
  width: number;
  height: number;
  outline?: WhiteboardTableOutline;
  theme?: { color: string };
};

export type RevisionedDrawChartIntent = {
  chartType: WhiteboardChartSpec['chartType'];
  x: number;
  y: number;
  width: number;
  height: number;
  data: WhiteboardChartSpec['data'];
  themeColors?: string[];
};

export type RevisionedDrawCodeIntent = {
  language: string;
  code: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fileName?: string;
};

export type RevisionedEditCodeIntent = WhiteboardCodeEditIntent;

export type RevisionedWhiteboardLifecycleIntent = Record<string, never>;

export type RevisionedOpenExpectedDescriptor = {
  kind: 'wb_open_v2';
  intentDigest: string;
};

export type RevisionedCloseExpectedDescriptor = {
  kind: 'wb_close_v2';
  intentDigest: string;
};

export type RevisionedDrawTextExpectedDescriptor = {
  kind: 'wb_draw_text_v2';
  intentDigest: string;
  stableElementId: string;
  expectedContentDigest: string;
};

export type RevisionedDrawShapeExpectedDescriptor = {
  kind: 'wb_draw_shape_v2';
  intentDigest: string;
  stableElementId: string;
  expectedShapeDigest: string;
};

export type RevisionedDrawLineExpectedDescriptor = {
  kind: 'wb_draw_line_v2';
  intentDigest: string;
  stableElementId: string;
  expectedLineDigest: string;
};

export type RevisionedDrawLatexExpectedDescriptor = {
  kind: 'wb_draw_latex_v2';
  intentDigest: string;
  stableElementId: string;
  expectedFormulaDigest: string;
  expectedHtmlDigest: string;
};

export type RevisionedDrawTableExpectedDescriptor = {
  kind: 'wb_draw_table_v2';
  intentDigest: string;
  stableElementId: string;
  expectedTableDigest: string;
};

export type RevisionedDrawChartExpectedDescriptor = {
  kind: 'wb_draw_chart_v2';
  intentDigest: string;
  stableElementId: string;
  expectedChartDigest: string;
};

export type RevisionedDrawCodeExpectedDescriptor = {
  kind: 'wb_draw_code_v2';
  intentDigest: string;
  stableElementId: string;
  expectedCodeDigest: string;
  expectedLineIds: string[];
};

export type RevisionedEditCodeExpectedDescriptor = {
  kind: 'wb_edit_code_v2';
  intentDigest: string;
  stableElementId: string;
  expectedNewLineIds: string[];
};

export type RevisionedWhiteboardExpectedDescriptor =
  | RevisionedOpenExpectedDescriptor
  | RevisionedCloseExpectedDescriptor
  | RevisionedDrawTextExpectedDescriptor
  | RevisionedDrawShapeExpectedDescriptor
  | RevisionedDrawLineExpectedDescriptor
  | RevisionedDrawLatexExpectedDescriptor
  | RevisionedDrawTableExpectedDescriptor
  | RevisionedDrawChartExpectedDescriptor
  | RevisionedDrawCodeExpectedDescriptor
  | RevisionedEditCodeExpectedDescriptor;

export type RevisionedOpenDelta = {
  kind: 'whiteboard_opened_v2';
  previousOpen: boolean;
  currentOpen: true;
  created: boolean;
  visibilityChanged: boolean;
};

export type RevisionedCloseDelta = {
  kind: 'whiteboard_closed_v2';
  previousOpen: boolean;
  currentOpen: false;
  visibilityChanged: boolean;
};

export type RevisionedPreservedExistingVisibilityPostcondition = {
  kind: 'whiteboard_visibility_observed_v2';
  boardState: 'preserved_existing';
  normalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION;
  whiteboardId: string;
  observedOpen: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
  boardContentDigestBefore: string;
  boardContentDigestAfter: string;
};

export type RevisionedCreatedEmptyVisibilityPostcondition = {
  kind: 'whiteboard_visibility_observed_v2';
  boardState: 'created_empty';
  normalizationVersion: typeof CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION;
  whiteboardId: string;
  observedOpen: true;
  elementCountAfter: 0;
  boardContentDigestAfter: string;
};

export type RevisionedNoBoardVisibilityPostcondition = {
  kind: 'whiteboard_visibility_observed_v2';
  boardState: 'no_board';
  whiteboardId: null;
  observedOpen: false;
};

export type RevisionedVisibilityPostcondition =
  | RevisionedPreservedExistingVisibilityPostcondition
  | RevisionedCreatedEmptyVisibilityPostcondition
  | RevisionedNoBoardVisibilityPostcondition;

export type RevisionedDrawTextDelta = {
  kind: 'whiteboard_text_created_v2';
  normalizationVersion: typeof CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  createdWhiteboard: boolean;
  visibilityChanged: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedDrawTextPostcondition = {
  kind: 'whiteboard_text_exists_v2';
  normalizationVersion: typeof CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'text';
  observedContentDigest: string;
  matchingElementCount: 1;
};

export type RevisionedDrawShapeDelta = {
  kind: 'whiteboard_shape_created_v2';
  normalizationVersion: typeof CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  createdWhiteboard: boolean;
  visibilityChanged: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedDrawShapePostcondition = {
  kind: 'whiteboard_shape_exists_v2';
  normalizationVersion: typeof CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'shape';
  observedShapeDigest: string;
  matchingElementCount: 1;
};

export type RevisionedDrawLineDelta = {
  kind: 'whiteboard_line_created_v2';
  normalizationVersion: typeof CLIENT_EFFECT_LINE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  createdWhiteboard: boolean;
  visibilityChanged: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedDrawLinePostcondition = {
  kind: 'whiteboard_line_exists_v2';
  normalizationVersion: typeof CLIENT_EFFECT_LINE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'line';
  observedLineDigest: string;
  matchingElementCount: 1;
};

export type RevisionedDrawLatexDelta = {
  kind: 'whiteboard_latex_created_v2';
  normalizationVersion: typeof CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  createdWhiteboard: boolean;
  visibilityChanged: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedDrawLatexPostcondition = {
  kind: 'whiteboard_latex_exists_v2';
  normalizationVersion: typeof CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION;
  renderVersion: typeof CLIENT_EFFECT_LATEX_RENDER_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'latex';
  observedFormulaDigest: string;
  observedHtmlDigest: string;
  matchingElementCount: 1;
};

export type RevisionedDrawTableDelta = {
  kind: 'whiteboard_table_created_v2';
  normalizationVersion: typeof CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  createdWhiteboard: boolean;
  visibilityChanged: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedDrawTablePostcondition = {
  kind: 'whiteboard_table_exists_v2';
  normalizationVersion: typeof CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'table';
  observedTableDigest: string;
  matchingElementCount: 1;
};

export type RevisionedDrawChartDelta = {
  kind: 'whiteboard_chart_created_v2';
  normalizationVersion: typeof CLIENT_EFFECT_CHART_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  createdWhiteboard: boolean;
  visibilityChanged: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedDrawChartPostcondition = {
  kind: 'whiteboard_chart_exists_v2';
  normalizationVersion: typeof CLIENT_EFFECT_CHART_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'chart';
  observedChartDigest: string;
  matchingElementCount: 1;
};

export type RevisionedDrawCodeDelta = {
  kind: 'whiteboard_code_created_v2';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  createdWhiteboard: boolean;
  visibilityChanged: boolean;
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedDrawCodePostcondition = {
  kind: 'whiteboard_code_exists_v2';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'code';
  observedCodeDigest: string;
  orderedLineIds: string[];
  matchingElementCount: 1;
};

export type RevisionedEditCodeDelta = {
  kind: 'whiteboard_code_edited_v2';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  codeChanged: boolean;
  visibilityChanged: boolean;
  newLineIds: string[];
  elementCountBefore: number;
  elementCountAfter: number;
};

export type RevisionedEditCodePostcondition = {
  kind: 'whiteboard_code_state_observed_v2';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION;
  whiteboardId: string;
  stableElementId: string;
  elementType: 'code';
  observedBeforeCodeDigest: string;
  observedAfterCodeDigest: string;
  orderedLineIds: string[];
  matchingElementCountBefore: 1;
  matchingElementCountAfter: 1;
};

export type RevisionedDrawTextRequestDigestInput = {
  executionId: string;
  expectedBinding: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intent: RevisionedDrawTextIntent;
};

type RevisionedWhiteboardRequestDigestBase = {
  executionId: string;
  expectedBinding: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
};

export type RevisionedLifecycleRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedWhiteboardLifecycleIntent;
};

export type RevisionedDrawShapeRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawShapeIntent;
};

export type RevisionedDrawLineRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawLineIntent;
};

export type RevisionedDrawLatexRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawLatexIntent;
};

export type RevisionedDrawTableRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawTableIntent;
};

export type RevisionedDrawChartRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawChartIntent;
};

export type RevisionedDrawCodeRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawCodeIntent;
};

export type RevisionedEditCodeRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedEditCodeIntent;
};

export type RevisionedWhiteboardMutationDigestInput =
  | (RevisionedLifecycleRequestDigestInput & { toolName: 'wb_open' | 'wb_close' })
  | (RevisionedDrawTextRequestDigestInput & { toolName: 'wb_draw_text' })
  | (RevisionedDrawShapeRequestDigestInput & { toolName: 'wb_draw_shape' })
  | (RevisionedDrawLineRequestDigestInput & { toolName: 'wb_draw_line' })
  | (RevisionedDrawLatexRequestDigestInput & { toolName: 'wb_draw_latex' })
  | (RevisionedDrawTableRequestDigestInput & { toolName: 'wb_draw_table' })
  | (RevisionedDrawChartRequestDigestInput & { toolName: 'wb_draw_chart' })
  | (RevisionedDrawCodeRequestDigestInput & { toolName: 'wb_draw_code' })
  | (RevisionedEditCodeRequestDigestInput & { toolName: 'wb_edit_code' });

type RevisionedWhiteboardEffectDeliveryBase = {
  protocolVersion: typeof REVISIONED_WHITEBOARD_PROTOCOL_VERSION;
  executionId: string;
  requestDigest: string;
  expectedBinding: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  acknowledgementToken: string;
};

export type RevisionedDrawTextEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_text';
  intent: RevisionedDrawTextIntent;
};

export type RevisionedOpenEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_open';
  intent: RevisionedWhiteboardLifecycleIntent;
};

export type RevisionedCloseEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_close';
  intent: RevisionedWhiteboardLifecycleIntent;
};

export type RevisionedDrawShapeEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_shape';
  intent: RevisionedDrawShapeIntent;
};

export type RevisionedDrawLineEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_line';
  intent: RevisionedDrawLineIntent;
};

export type RevisionedDrawLatexEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_latex';
  intent: RevisionedDrawLatexIntent;
};

export type RevisionedDrawTableEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_table';
  intent: RevisionedDrawTableIntent;
};

export type RevisionedDrawChartEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_chart';
  intent: RevisionedDrawChartIntent;
};

export type RevisionedDrawCodeEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_code';
  intent: RevisionedDrawCodeIntent;
};

export type RevisionedEditCodeEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_edit_code';
  intent: RevisionedEditCodeIntent;
};

export type RevisionedWhiteboardEffectDelivery =
  | RevisionedOpenEffectDelivery
  | RevisionedCloseEffectDelivery
  | RevisionedDrawTextEffectDelivery
  | RevisionedDrawShapeEffectDelivery
  | RevisionedDrawLineEffectDelivery
  | RevisionedDrawLatexEffectDelivery
  | RevisionedDrawTableEffectDelivery
  | RevisionedDrawChartEffectDelivery
  | RevisionedDrawCodeEffectDelivery
  | RevisionedEditCodeEffectDelivery;

export type RevisionedWhiteboardRejectedCode =
  | 'AUTHENTICATED_TARGET_CHANGED'
  | 'TARGET_CHANGED'
  | 'STALE_STATE'
  | 'TARGET_PRECONDITION_FAILED'
  | 'WHITEBOARD_AUTHORITY_BYPASS_DETECTED'
  | 'EXECUTION_ID_CONFLICT';

export type RevisionedWhiteboardMutationError = {
  code: RevisionedWhiteboardRejectedCode | 'POSTCONDITION_UNCERTAIN';
};

type ReceiptIdentity = {
  protocolVersion: typeof REVISIONED_WHITEBOARD_PROTOCOL_VERSION;
  executionId: string;
  requestDigest: string;
  toolName: RevisionedWhiteboardMutationToolName;
  previousBinding: RevisionedWhiteboardEnvironmentBinding;
  currentBinding: RevisionedWhiteboardEnvironmentBinding;
  changed: boolean;
};

export type RevisionedWhiteboardCommittedReceipt = ReceiptIdentity & {
  outcome: 'committed';
  mutationMayHaveCommitted: false;
  delta: JsonValue;
  postcondition: JsonValue;
};

export type RevisionedWhiteboardRejectedReceipt = ReceiptIdentity & {
  outcome: 'rejected';
  mutationMayHaveCommitted: false;
  error: { code: RevisionedWhiteboardRejectedCode };
};

export type RevisionedWhiteboardUncertainReceipt = ReceiptIdentity & {
  outcome: 'uncertain';
  mutationMayHaveCommitted: true;
  error: { code: 'POSTCONDITION_UNCERTAIN' };
};

export type RevisionedWhiteboardAuthorityReceipt =
  | RevisionedWhiteboardCommittedReceipt
  | RevisionedWhiteboardRejectedReceipt
  | RevisionedWhiteboardUncertainReceipt;

export type RevisionedWhiteboardMutationAck =
  | {
      protocolVersion: typeof REVISIONED_WHITEBOARD_PROTOCOL_VERSION;
      status: 'accepted';
      executionId: string;
      requestDigest: string;
      targetBinding: RevisionedWhiteboardAcceptedBinding;
    }
  | {
      protocolVersion: typeof REVISIONED_WHITEBOARD_PROTOCOL_VERSION;
      status: 'effect_committed';
      executionId: string;
      requestDigest: string;
      receipt: RevisionedWhiteboardCommittedReceipt;
    }
  | {
      protocolVersion: typeof REVISIONED_WHITEBOARD_PROTOCOL_VERSION;
      status: 'effect_rejected';
      executionId: string;
      requestDigest: string;
      receipt: RevisionedWhiteboardRejectedReceipt;
    }
  | {
      protocolVersion: typeof REVISIONED_WHITEBOARD_PROTOCOL_VERSION;
      status: 'effect_uncertain';
      executionId: string;
      requestDigest: string;
      receipt: RevisionedWhiteboardUncertainReceipt;
    };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const shapeValidatedReceiptBrand: unique symbol = Symbol(
  'shapeValidatedRevisionedWhiteboardReceipt',
);

export type ShapeValidatedRevisionedWhiteboardReceipt = RevisionedWhiteboardAuthorityReceipt & {
  readonly [shapeValidatedReceiptBrand]: true;
};

function freezeJsonSnapshot<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeJsonSnapshot(child);
  }
  return Object.freeze(value);
}

function immutableJsonSnapshot<T>(value: T): T {
  return freezeJsonSnapshot(JSON.parse(JSON.stringify(value)) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const allowed = new Set(required);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
  );
}

function isSafeText(value: unknown, minLength: number, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/u.test(value)
  );
}

function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  exclusiveMinimum = false,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (exclusiveMinimum ? value > minimum : value >= minimum) &&
    value <= maximum
  );
}

export function normalizeRevisionedDrawTextIntent(
  value: unknown,
): Readonly<RevisionedDrawTextIntent> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['content', 'x', 'y', 'width', 'height', 'fontSize', 'color']);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'content') ||
    !Object.prototype.hasOwnProperty.call(value, 'x') ||
    !Object.prototype.hasOwnProperty.call(value, 'y') ||
    !isSafeText(value.content, 1, 2_000) ||
    !isFiniteInRange(value.x, 40, 560) ||
    !isFiniteInRange(value.y, 40, 323) ||
    (value.width !== undefined && !isFiniteInRange(value.width, 0, 400, true)) ||
    (value.height !== undefined && !isFiniteInRange(value.height, 0, 200, true)) ||
    (value.fontSize !== undefined && !isFiniteInRange(value.fontSize, 1, 512)) ||
    (value.color !== undefined && !isSafeText(value.color, 1, 64))
  ) {
    return null;
  }
  let color: string | undefined;
  if (value.color !== undefined) {
    try {
      color = normalizeWhiteboardRendererColorV1(value.color);
    } catch {
      return null;
    }
  }
  return Object.freeze({
    content: value.content,
    x: Object.is(value.x, -0) ? 0 : value.x,
    y: Object.is(value.y, -0) ? 0 : value.y,
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
    ...(value.fontSize !== undefined ? { fontSize: value.fontSize } : {}),
    ...(color !== undefined ? { color } : {}),
  });
}

export function normalizeRevisionedDrawShapeIntent(
  value: unknown,
): Readonly<RevisionedDrawShapeIntent> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['shape', 'x', 'y', 'width', 'height', 'fillColor']);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'shape') ||
    !Object.prototype.hasOwnProperty.call(value, 'x') ||
    !Object.prototype.hasOwnProperty.call(value, 'y') ||
    !Object.prototype.hasOwnProperty.call(value, 'width') ||
    !Object.prototype.hasOwnProperty.call(value, 'height')
  ) {
    return null;
  }
  try {
    const normalized = normalizeWhiteboardShapeV1({
      shape: value.shape,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      fillColor: value.fillColor,
    });
    return immutableJsonSnapshot({
      shape: normalized.shape,
      x: normalized.bounds.x,
      y: normalized.bounds.y,
      width: normalized.bounds.width,
      height: normalized.bounds.height,
      fillColor: normalized.fillColor,
    });
  } catch {
    return null;
  }
}

export function normalizeRevisionedDrawLineIntent(
  value: unknown,
): Readonly<RevisionedDrawLineIntent> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    'startX',
    'startY',
    'endX',
    'endY',
    'color',
    'width',
    'style',
    'points',
  ]);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'startX') ||
    !Object.prototype.hasOwnProperty.call(value, 'startY') ||
    !Object.prototype.hasOwnProperty.call(value, 'endX') ||
    !Object.prototype.hasOwnProperty.call(value, 'endY')
  ) {
    return null;
  }
  try {
    const normalized = normalizeWhiteboardLineV1({
      startX: value.startX,
      startY: value.startY,
      endX: value.endX,
      endY: value.endY,
      color: value.color,
      width: value.width,
      style: value.style,
      points: value.points,
    });
    return immutableJsonSnapshot({
      startX: normalized.start.x,
      startY: normalized.start.y,
      endX: normalized.end.x,
      endY: normalized.end.y,
      color: normalized.strokeColor,
      width: normalized.strokeWidth,
      style: normalized.strokeStyle,
      points: normalized.markers,
    });
  } catch {
    return null;
  }
}

export function normalizeRevisionedDrawLatexIntent(
  value: unknown,
): Readonly<RevisionedDrawLatexIntent> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['latex', 'x', 'y', 'width', 'height', 'color']);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'latex') ||
    !Object.prototype.hasOwnProperty.call(value, 'x') ||
    !Object.prototype.hasOwnProperty.call(value, 'y')
  ) {
    return null;
  }
  try {
    const normalized = normalizeWhiteboardLatexV1({
      latex: value.latex,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      color: value.color,
    });
    return immutableJsonSnapshot({
      latex: normalized.latex,
      x: normalized.bounds.x,
      y: normalized.bounds.y,
      width: normalized.bounds.width,
      height: normalized.bounds.height,
      color: normalized.color,
    });
  } catch {
    return null;
  }
}

export function normalizeRevisionedDrawTableIntent(
  value: unknown,
): Readonly<RevisionedDrawTableIntent> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['data', 'x', 'y', 'width', 'height', 'outline', 'theme']);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'data') ||
    !Object.prototype.hasOwnProperty.call(value, 'x') ||
    !Object.prototype.hasOwnProperty.call(value, 'y') ||
    !Object.prototype.hasOwnProperty.call(value, 'width') ||
    !Object.prototype.hasOwnProperty.call(value, 'height')
  ) {
    return null;
  }
  try {
    const normalized = normalizeWhiteboardTableIntentV1({
      data: value.data,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      outline: value.outline,
      theme: value.theme,
    });
    return immutableJsonSnapshot({
      data: normalized.data,
      x: normalized.bounds.x,
      y: normalized.bounds.y,
      width: normalized.bounds.width,
      height: normalized.bounds.height,
      outline: normalized.outline,
      ...(normalized.theme ? { theme: normalized.theme } : {}),
    });
  } catch {
    return null;
  }
}

export function normalizeRevisionedDrawChartIntent(
  value: unknown,
): Readonly<RevisionedDrawChartIntent> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['chartType', 'x', 'y', 'width', 'height', 'data', 'themeColors']);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'chartType') ||
    !Object.prototype.hasOwnProperty.call(value, 'x') ||
    !Object.prototype.hasOwnProperty.call(value, 'y') ||
    !Object.prototype.hasOwnProperty.call(value, 'width') ||
    !Object.prototype.hasOwnProperty.call(value, 'height') ||
    !Object.prototype.hasOwnProperty.call(value, 'data')
  ) {
    return null;
  }
  try {
    const normalized = normalizeWhiteboardChartV1({
      chartType: value.chartType,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      data: value.data,
      themeColors: value.themeColors,
    });
    return immutableJsonSnapshot({
      chartType: normalized.chartType,
      x: normalized.bounds.x,
      y: normalized.bounds.y,
      width: normalized.bounds.width,
      height: normalized.bounds.height,
      data: normalized.data,
      themeColors: normalized.themeColors,
    });
  } catch {
    return null;
  }
}

export function normalizeRevisionedDrawCodeIntent(
  value: unknown,
): Readonly<RevisionedDrawCodeIntent> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['language', 'code', 'x', 'y', 'width', 'height', 'fileName']);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'language') ||
    !Object.prototype.hasOwnProperty.call(value, 'code') ||
    !Object.prototype.hasOwnProperty.call(value, 'x') ||
    !Object.prototype.hasOwnProperty.call(value, 'y')
  ) {
    return null;
  }
  try {
    const normalized = normalizeWhiteboardCodeV1({
      language: value.language,
      code: value.code,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      fileName: value.fileName,
    });
    return immutableJsonSnapshot({
      language: normalized.language,
      code: normalized.lines.map((line) => line.content).join('\n'),
      x: normalized.bounds.x,
      y: normalized.bounds.y,
      width: normalized.bounds.width,
      height: normalized.bounds.height,
      ...(normalized.fileName !== undefined ? { fileName: normalized.fileName } : {}),
    });
  } catch {
    return null;
  }
}

export function normalizeRevisionedEditCodeIntent(
  value: unknown,
): Readonly<RevisionedEditCodeIntent> | null {
  try {
    return immutableJsonSnapshot(normalizeWhiteboardCodeEditIntentV1(value));
  } catch {
    return null;
  }
}

export function expectedRevisionedCodeEditNewLineIds(
  executionId: string,
  intent: RevisionedEditCodeIntent,
): string[] | null {
  const normalized = normalizeRevisionedEditCodeIntent(intent);
  if (!normalized || !isSafeId(executionId)) return null;
  const count = (() => {
    if (normalized.operation === 'insert_after' || normalized.operation === 'insert_before') {
      return normalized.content.split('\n').length;
    }
    if (normalized.operation === 'replace_lines') {
      return Math.max(0, normalized.content.split('\n').length - normalized.lineIds.length);
    }
    return 0;
  })();
  try {
    return Object.freeze(
      Array.from({ length: count }, (_, index) =>
        deriveRevisionedCodeEditLineId(executionId, index + 1),
      ),
    ) as unknown as string[];
  } catch {
    return null;
  }
}

export function normalizeRevisionedWhiteboardLifecycleIntent(
  value: unknown,
): Readonly<RevisionedWhiteboardLifecycleIntent> | null {
  return isRecord(value) && hasExactKeys(value, [])
    ? (Object.freeze({}) as Readonly<RevisionedWhiteboardLifecycleIntent>)
    : null;
}

type ImplementedRevisionedWhiteboardIntent =
  | RevisionedWhiteboardLifecycleIntent
  | RevisionedDrawTextIntent
  | RevisionedDrawShapeIntent
  | RevisionedDrawLineIntent
  | RevisionedDrawLatexIntent
  | RevisionedDrawTableIntent
  | RevisionedDrawChartIntent
  | RevisionedDrawCodeIntent
  | RevisionedEditCodeIntent;

function normalizeRevisionedWhiteboardMutationIntent(
  toolName: RevisionedWhiteboardMutationDigestInput['toolName'],
  value: unknown,
): Readonly<ImplementedRevisionedWhiteboardIntent> | null {
  switch (toolName) {
    case 'wb_open':
    case 'wb_close':
      return normalizeRevisionedWhiteboardLifecycleIntent(value);
    case 'wb_draw_text':
      return normalizeRevisionedDrawTextIntent(value);
    case 'wb_draw_shape':
      return normalizeRevisionedDrawShapeIntent(value);
    case 'wb_draw_line':
      return normalizeRevisionedDrawLineIntent(value);
    case 'wb_draw_latex':
      return normalizeRevisionedDrawLatexIntent(value);
    case 'wb_draw_table':
      return normalizeRevisionedDrawTableIntent(value);
    case 'wb_draw_chart':
      return normalizeRevisionedDrawChartIntent(value);
    case 'wb_draw_code':
      return normalizeRevisionedDrawCodeIntent(value);
    case 'wb_edit_code':
      return normalizeRevisionedEditCodeIntent(value);
  }
}

export function createRevisionedWhiteboardMutationDigests(
  input: RevisionedWhiteboardMutationDigestInput,
): {
  normalizedIntent: Readonly<ImplementedRevisionedWhiteboardIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const normalizedIntent = normalizeRevisionedWhiteboardMutationIntent(
    input.toolName,
    input.intent,
  );
  if (
    !normalizedIntent ||
    !isSafeId(input.executionId) ||
    !isBinding(input.expectedBinding) ||
    !isRevisionedWhiteboardAuthenticatedTarget(input.authenticatedTarget) ||
    !Number.isFinite(input.deadlineAt)
  ) {
    return null;
  }
  const intentDigest = digestRevisionedValue(normalizedIntent);
  const requestDigest = digestRevisionedValue({
    protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
    toolName: input.toolName,
    executionId: input.executionId,
    expectedBinding: input.expectedBinding,
    authenticatedTarget: input.authenticatedTarget,
    deadlineAt: input.deadlineAt,
    normalizedIntent,
  });
  return { normalizedIntent, intentDigest, requestDigest };
}

export function createRevisionedOpenDigests(input: RevisionedLifecycleRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedWhiteboardLifecycleIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({ ...input, toolName: 'wb_open' });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedWhiteboardLifecycleIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedCloseDigests(input: RevisionedLifecycleRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedWhiteboardLifecycleIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({ ...input, toolName: 'wb_close' });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedWhiteboardLifecycleIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedDrawTextDigests(input: RevisionedDrawTextRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawTextIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_draw_text',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedDrawTextIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedDrawShapeDigests(input: RevisionedDrawShapeRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawShapeIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_draw_shape',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedDrawShapeIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedDrawLineDigests(input: RevisionedDrawLineRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawLineIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_draw_line',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedDrawLineIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedDrawLatexDigests(input: RevisionedDrawLatexRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawLatexIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_draw_latex',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedDrawLatexIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedDrawTableDigests(input: RevisionedDrawTableRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawTableIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_draw_table',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedDrawTableIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedDrawChartDigests(input: RevisionedDrawChartRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawChartIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_draw_chart',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedDrawChartIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedDrawCodeDigests(input: RevisionedDrawCodeRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawCodeIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_draw_code',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedDrawCodeIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedEditCodeDigests(input: RevisionedEditCodeRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedEditCodeIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const result = createRevisionedWhiteboardMutationDigests({
    ...input,
    toolName: 'wb_edit_code',
  });
  return result
    ? {
        normalizedIntent: result.normalizedIntent as Readonly<RevisionedEditCodeIntent>,
        intentDigest: result.intentDigest,
        requestDigest: result.requestDigest,
      }
    : null;
}

export function createRevisionedWhiteboardEffectDeliveryDigests(
  delivery: RevisionedWhiteboardEffectDelivery,
) {
  const common = {
    executionId: delivery.executionId,
    expectedBinding: delivery.expectedBinding,
    authenticatedTarget: delivery.authenticatedTarget,
    deadlineAt: delivery.deadlineAt,
  };
  switch (delivery.toolName) {
    case 'wb_open':
      return createRevisionedOpenDigests({ ...common, intent: delivery.intent });
    case 'wb_close':
      return createRevisionedCloseDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_text':
      return createRevisionedDrawTextDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_shape':
      return createRevisionedDrawShapeDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_line':
      return createRevisionedDrawLineDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_latex':
      return createRevisionedDrawLatexDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_table':
      return createRevisionedDrawTableDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_chart':
      return createRevisionedDrawChartDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_code':
      return createRevisionedDrawCodeDigests({ ...common, intent: delivery.intent });
    case 'wb_edit_code':
      return createRevisionedEditCodeDigests({ ...common, intent: delivery.intent });
  }
}

export function isRevisionedWhiteboardAuthenticatedTarget(
  value: unknown,
): value is RevisionedWhiteboardAuthenticatedTarget {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['childInvocationId', 'requestId', 'sessionId', 'sceneId']) &&
    isSafeId(value.childInvocationId) &&
    isSafeId(value.requestId) &&
    isSafeId(value.sessionId) &&
    isSafeId(value.sceneId)
  );
}

function isRequestDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBinding(value: unknown): value is RevisionedWhiteboardBinding {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['stageId', 'whiteboardId', 'revision']) &&
    isSafeId(value.stageId) &&
    (value.whiteboardId === null || isSafeId(value.whiteboardId)) &&
    isRevision(value.revision)
  );
}

function isAcceptedBinding(value: unknown): value is RevisionedWhiteboardAcceptedBinding {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['stageId', 'whiteboardId', 'observedRevision']) &&
    isSafeId(value.stageId) &&
    (value.whiteboardId === null || isSafeId(value.whiteboardId)) &&
    isRevision(value.observedRevision)
  );
}

export function isRevisionedWhiteboardMutationIdentity(value: {
  executionId: unknown;
  requestDigest: unknown;
  toolName: unknown;
  expectedBinding: unknown;
}): boolean {
  return (
    isSafeId(value.executionId) &&
    isRequestDigest(value.requestDigest) &&
    REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES.includes(
      value.toolName as RevisionedWhiteboardMutationToolName,
    ) &&
    isBinding(value.expectedBinding)
  );
}

function isEnvironmentBinding(value: unknown): value is RevisionedWhiteboardEnvironmentBinding {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['stageId', 'whiteboardId', 'revision']) &&
    (value.stageId === null || isSafeId(value.stageId)) &&
    (value.whiteboardId === null || isSafeId(value.whiteboardId)) &&
    (value.stageId !== null || value.whiteboardId === null) &&
    isRevision(value.revision)
  );
}

export function isRevisionedWhiteboardJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let entries = 0;
  const encoder = new TextEncoder();

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entry = current.value;
    if (entry === null || typeof entry === 'boolean') continue;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return false;
      continue;
    }
    if (typeof entry === 'string') {
      if (encoder.encode(entry).byteLength > MAX_REVISIONED_WHITEBOARD_JSON_STRING_BYTES) {
        return false;
      }
      continue;
    }
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return false;
    if (current.depth >= MAX_REVISIONED_WHITEBOARD_JSON_DEPTH) return false;
    if (
      !Array.isArray(entry) &&
      Object.getPrototypeOf(entry) !== Object.prototype &&
      Object.getPrototypeOf(entry) !== null
    ) {
      return false;
    }
    seen.add(entry);
    const children = Array.isArray(entry) ? entry : Object.values(entry as Record<string, unknown>);
    entries += children.length;
    if (entries > MAX_REVISIONED_WHITEBOARD_JSON_ENTRIES) return false;
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

export function revisionedWhiteboardWireBytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function isReceiptIdentity(value: Record<string, unknown>): boolean {
  return (
    value.protocolVersion === REVISIONED_WHITEBOARD_PROTOCOL_VERSION &&
    isSafeId(value.executionId) &&
    isRequestDigest(value.requestDigest) &&
    REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES.includes(
      value.toolName as RevisionedWhiteboardMutationToolName,
    ) &&
    isEnvironmentBinding(value.previousBinding) &&
    isEnvironmentBinding(value.currentBinding) &&
    typeof value.changed === 'boolean'
  );
}

function isError(
  value: unknown,
  allowedCodes: ReadonlySet<RevisionedWhiteboardMutationError['code']>,
): value is RevisionedWhiteboardMutationError {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code']) &&
    typeof value.code === 'string' &&
    allowedCodes.has(value.code as RevisionedWhiteboardMutationError['code'])
  );
}

const REJECTED_CODES = new Set<RevisionedWhiteboardMutationError['code']>([
  'AUTHENTICATED_TARGET_CHANGED',
  'TARGET_CHANGED',
  'STALE_STATE',
  'TARGET_PRECONDITION_FAILED',
  'WHITEBOARD_AUTHORITY_BYPASS_DETECTED',
  'EXECUTION_ID_CONFLICT',
]);

const UNCERTAIN_CODES = new Set<RevisionedWhiteboardMutationError['code']>([
  'POSTCONDITION_UNCERTAIN',
]);

export function isRevisionedWhiteboardAuthorityReceipt(
  value: unknown,
): value is RevisionedWhiteboardAuthorityReceipt {
  if (!isRecord(value) || !isReceiptIdentity(value)) return false;
  switch (value.outcome) {
    case 'committed':
      return (
        hasExactKeys(value, [
          'protocolVersion',
          'outcome',
          'executionId',
          'requestDigest',
          'toolName',
          'previousBinding',
          'currentBinding',
          'changed',
          'mutationMayHaveCommitted',
          'delta',
          'postcondition',
        ]) &&
        value.mutationMayHaveCommitted === false &&
        isRevisionedWhiteboardJsonValue(value.delta) &&
        isRevisionedWhiteboardJsonValue(value.postcondition) &&
        isRevisionedWhiteboardReceiptWithinWireLimit(value)
      );
    case 'rejected':
      return (
        hasExactKeys(value, [
          'protocolVersion',
          'outcome',
          'executionId',
          'requestDigest',
          'toolName',
          'previousBinding',
          'currentBinding',
          'changed',
          'mutationMayHaveCommitted',
          'error',
        ]) &&
        value.changed === false &&
        value.mutationMayHaveCommitted === false &&
        isError(value.error, REJECTED_CODES) &&
        isRevisionedWhiteboardReceiptWithinWireLimit(value)
      );
    case 'uncertain':
      return (
        hasExactKeys(value, [
          'protocolVersion',
          'outcome',
          'executionId',
          'requestDigest',
          'toolName',
          'previousBinding',
          'currentBinding',
          'changed',
          'mutationMayHaveCommitted',
          'error',
        ]) &&
        value.mutationMayHaveCommitted === true &&
        isError(value.error, UNCERTAIN_CODES) &&
        isRevisionedWhiteboardReceiptWithinWireLimit(value)
      );
    default:
      return false;
  }
}

export function isRevisionedWhiteboardReceiptWithinWireLimit(value: unknown): boolean {
  const bytes = revisionedWhiteboardWireBytes(value);
  return bytes !== null && bytes <= MAX_REVISIONED_WHITEBOARD_RECEIPT_BYTES;
}

export function verifyRevisionedWhiteboardAuthorityReceipt(
  value: unknown,
): ShapeValidatedRevisionedWhiteboardReceipt | null {
  return isRevisionedWhiteboardAuthorityReceipt(value)
    ? (immutableJsonSnapshot(value) as ShapeValidatedRevisionedWhiteboardReceipt)
    : null;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeLineId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
  );
}

function isUniqueLineIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every(isSafeLineId) &&
    new Set(value).size === value.length
  );
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isRevisionedWhiteboardExpectedDescriptor(
  value: unknown,
): value is RevisionedWhiteboardExpectedDescriptor {
  if (!isRecord(value) || !isSha256Digest(value.intentDigest)) {
    return false;
  }
  if (value.kind === 'wb_open_v2' || value.kind === 'wb_close_v2') {
    return hasExactKeys(value, ['kind', 'intentDigest']);
  }
  if (!isSafeId(value.stableElementId)) return false;
  switch (value.kind) {
    case 'wb_draw_text_v2':
      return (
        hasExactKeys(value, ['kind', 'intentDigest', 'stableElementId', 'expectedContentDigest']) &&
        isSha256Digest(value.expectedContentDigest)
      );
    case 'wb_draw_shape_v2':
      return (
        hasExactKeys(value, ['kind', 'intentDigest', 'stableElementId', 'expectedShapeDigest']) &&
        isSha256Digest(value.expectedShapeDigest)
      );
    case 'wb_draw_line_v2':
      return (
        hasExactKeys(value, ['kind', 'intentDigest', 'stableElementId', 'expectedLineDigest']) &&
        isSha256Digest(value.expectedLineDigest)
      );
    case 'wb_draw_latex_v2':
      return (
        hasExactKeys(value, [
          'kind',
          'intentDigest',
          'stableElementId',
          'expectedFormulaDigest',
          'expectedHtmlDigest',
        ]) &&
        isSha256Digest(value.expectedFormulaDigest) &&
        isSha256Digest(value.expectedHtmlDigest)
      );
    case 'wb_draw_table_v2':
      return (
        hasExactKeys(value, ['kind', 'intentDigest', 'stableElementId', 'expectedTableDigest']) &&
        isSha256Digest(value.expectedTableDigest)
      );
    case 'wb_draw_chart_v2':
      return (
        hasExactKeys(value, ['kind', 'intentDigest', 'stableElementId', 'expectedChartDigest']) &&
        isSha256Digest(value.expectedChartDigest)
      );
    case 'wb_draw_code_v2':
      return (
        hasExactKeys(value, [
          'kind',
          'intentDigest',
          'stableElementId',
          'expectedCodeDigest',
          'expectedLineIds',
        ]) &&
        isSha256Digest(value.expectedCodeDigest) &&
        isUniqueLineIdArray(value.expectedLineIds) &&
        value.expectedLineIds.length >= 1 &&
        value.expectedLineIds.every((lineId, index) => lineId === `L${index + 1}`)
      );
    case 'wb_edit_code_v2':
      return (
        hasExactKeys(value, ['kind', 'intentDigest', 'stableElementId', 'expectedNewLineIds']) &&
        isUniqueLineIdArray(value.expectedNewLineIds)
      );
    default:
      return false;
  }
}

function isRevisionedDrawDelta(
  value: Record<string, unknown>,
  expected: Exclude<
    RevisionedWhiteboardExpectedDescriptor,
    RevisionedOpenExpectedDescriptor | RevisionedCloseExpectedDescriptor
  >,
  kind:
    | RevisionedDrawTextDelta['kind']
    | RevisionedDrawShapeDelta['kind']
    | RevisionedDrawLineDelta['kind']
    | RevisionedDrawLatexDelta['kind']
    | RevisionedDrawTableDelta['kind']
    | RevisionedDrawChartDelta['kind']
    | RevisionedDrawCodeDelta['kind'],
  normalizationVersion: string,
): boolean {
  return (
    hasExactKeys(value, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'createdWhiteboard',
      'visibilityChanged',
      'elementCountBefore',
      'elementCountAfter',
    ]) &&
    value.kind === kind &&
    value.normalizationVersion === normalizationVersion &&
    isSafeId(value.whiteboardId) &&
    value.stableElementId === expected.stableElementId &&
    typeof value.createdWhiteboard === 'boolean' &&
    typeof value.visibilityChanged === 'boolean' &&
    isNonNegativeSafeInteger(value.elementCountBefore) &&
    isNonNegativeSafeInteger(value.elementCountAfter) &&
    value.elementCountAfter === value.elementCountBefore + 1
  );
}

function hasRevisionedDrawBindingInvariants(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt,
  delta: Record<string, unknown>,
): boolean {
  const expectedWhiteboardId =
    receipt.previousBinding.whiteboardId ?? deriveRevisionedWhiteboardId(receipt.executionId);
  return (
    receipt.currentBinding.stageId === receipt.previousBinding.stageId &&
    receipt.currentBinding.whiteboardId === expectedWhiteboardId &&
    receipt.currentBinding.whiteboardId === delta.whiteboardId &&
    receipt.currentBinding.revision === receipt.previousBinding.revision + 1 &&
    (receipt.previousBinding.whiteboardId === null
      ? delta.createdWhiteboard === true
      : delta.createdWhiteboard === false)
  );
}

export function isRevisionedDrawTextCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedDrawTextExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_draw_text' ||
    receipt.changed !== true ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  return (
    isRevisionedDrawDelta(
      delta,
      expected,
      'whiteboard_text_created_v2',
      CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
    ) &&
    hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedContentDigest',
      'matchingElementCount',
    ]) &&
    postcondition.kind === 'whiteboard_text_exists_v2' &&
    postcondition.normalizationVersion === CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION &&
    postcondition.whiteboardId === delta.whiteboardId &&
    postcondition.stableElementId === expected.stableElementId &&
    postcondition.elementType === 'text' &&
    postcondition.observedContentDigest === expected.expectedContentDigest &&
    isSha256Digest(postcondition.observedContentDigest) &&
    postcondition.matchingElementCount === 1 &&
    hasRevisionedDrawBindingInvariants(receipt, delta)
  );
}

export function isRevisionedDrawShapeCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedDrawShapeExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_draw_shape' ||
    receipt.changed !== true ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  return (
    isRevisionedDrawDelta(
      delta,
      expected,
      'whiteboard_shape_created_v2',
      CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
    ) &&
    hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedShapeDigest',
      'matchingElementCount',
    ]) &&
    postcondition.kind === 'whiteboard_shape_exists_v2' &&
    postcondition.normalizationVersion === CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION &&
    postcondition.whiteboardId === delta.whiteboardId &&
    postcondition.stableElementId === expected.stableElementId &&
    postcondition.elementType === 'shape' &&
    postcondition.observedShapeDigest === expected.expectedShapeDigest &&
    isSha256Digest(postcondition.observedShapeDigest) &&
    postcondition.matchingElementCount === 1 &&
    hasRevisionedDrawBindingInvariants(receipt, delta)
  );
}

export function isRevisionedDrawLineCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedDrawLineExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_draw_line' ||
    receipt.changed !== true ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  return (
    isRevisionedDrawDelta(
      delta,
      expected,
      'whiteboard_line_created_v2',
      CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
    ) &&
    hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedLineDigest',
      'matchingElementCount',
    ]) &&
    postcondition.kind === 'whiteboard_line_exists_v2' &&
    postcondition.normalizationVersion === CLIENT_EFFECT_LINE_NORMALIZATION_VERSION &&
    postcondition.whiteboardId === delta.whiteboardId &&
    postcondition.stableElementId === expected.stableElementId &&
    postcondition.elementType === 'line' &&
    postcondition.observedLineDigest === expected.expectedLineDigest &&
    isSha256Digest(postcondition.observedLineDigest) &&
    postcondition.matchingElementCount === 1 &&
    hasRevisionedDrawBindingInvariants(receipt, delta)
  );
}

export function isRevisionedDrawLatexCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedDrawLatexExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_draw_latex' ||
    receipt.changed !== true ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  return (
    isRevisionedDrawDelta(
      delta,
      expected,
      'whiteboard_latex_created_v2',
      CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
    ) &&
    hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'renderVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedFormulaDigest',
      'observedHtmlDigest',
      'matchingElementCount',
    ]) &&
    postcondition.kind === 'whiteboard_latex_exists_v2' &&
    postcondition.normalizationVersion === CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION &&
    postcondition.renderVersion === CLIENT_EFFECT_LATEX_RENDER_VERSION &&
    postcondition.whiteboardId === delta.whiteboardId &&
    postcondition.stableElementId === expected.stableElementId &&
    postcondition.elementType === 'latex' &&
    postcondition.observedFormulaDigest === expected.expectedFormulaDigest &&
    postcondition.observedHtmlDigest === expected.expectedHtmlDigest &&
    isSha256Digest(postcondition.observedFormulaDigest) &&
    isSha256Digest(postcondition.observedHtmlDigest) &&
    postcondition.matchingElementCount === 1 &&
    hasRevisionedDrawBindingInvariants(receipt, delta)
  );
}

export function isRevisionedDrawTableCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedDrawTableExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_draw_table' ||
    receipt.changed !== true ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  return (
    isRevisionedDrawDelta(
      delta,
      expected,
      'whiteboard_table_created_v2',
      CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
    ) &&
    hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedTableDigest',
      'matchingElementCount',
    ]) &&
    postcondition.kind === 'whiteboard_table_exists_v2' &&
    postcondition.normalizationVersion === CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION &&
    postcondition.whiteboardId === delta.whiteboardId &&
    postcondition.stableElementId === expected.stableElementId &&
    postcondition.elementType === 'table' &&
    postcondition.observedTableDigest === expected.expectedTableDigest &&
    isSha256Digest(postcondition.observedTableDigest) &&
    postcondition.matchingElementCount === 1 &&
    hasRevisionedDrawBindingInvariants(receipt, delta)
  );
}

export function isRevisionedDrawChartCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedDrawChartExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_draw_chart' ||
    receipt.changed !== true ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  return (
    isRevisionedDrawDelta(
      delta,
      expected,
      'whiteboard_chart_created_v2',
      CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
    ) &&
    hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedChartDigest',
      'matchingElementCount',
    ]) &&
    postcondition.kind === 'whiteboard_chart_exists_v2' &&
    postcondition.normalizationVersion === CLIENT_EFFECT_CHART_NORMALIZATION_VERSION &&
    postcondition.whiteboardId === delta.whiteboardId &&
    postcondition.stableElementId === expected.stableElementId &&
    postcondition.elementType === 'chart' &&
    postcondition.observedChartDigest === expected.expectedChartDigest &&
    isSha256Digest(postcondition.observedChartDigest) &&
    postcondition.matchingElementCount === 1 &&
    hasRevisionedDrawBindingInvariants(receipt, delta)
  );
}

export function isRevisionedDrawCodeCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedDrawCodeExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_draw_code' ||
    receipt.changed !== true ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  return (
    isRevisionedDrawDelta(
      delta,
      expected,
      'whiteboard_code_created_v2',
      CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
    ) &&
    hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedCodeDigest',
      'orderedLineIds',
      'matchingElementCount',
    ]) &&
    postcondition.kind === 'whiteboard_code_exists_v2' &&
    postcondition.normalizationVersion === CLIENT_EFFECT_CODE_NORMALIZATION_VERSION &&
    postcondition.whiteboardId === delta.whiteboardId &&
    postcondition.stableElementId === expected.stableElementId &&
    postcondition.elementType === 'code' &&
    postcondition.observedCodeDigest === expected.expectedCodeDigest &&
    isSha256Digest(postcondition.observedCodeDigest) &&
    isUniqueLineIdArray(postcondition.orderedLineIds) &&
    stringArraysEqual(postcondition.orderedLineIds, expected.expectedLineIds) &&
    postcondition.matchingElementCount === 1 &&
    hasRevisionedDrawBindingInvariants(receipt, delta)
  );
}

export function isRevisionedEditCodeCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedEditCodeExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== 'wb_edit_code' ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition)
  ) {
    return false;
  }
  const delta = receipt.delta;
  const postcondition = receipt.postcondition;
  if (
    !hasExactKeys(delta, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'codeChanged',
      'visibilityChanged',
      'newLineIds',
      'elementCountBefore',
      'elementCountAfter',
    ]) ||
    delta.kind !== 'whiteboard_code_edited_v2' ||
    delta.normalizationVersion !== CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION ||
    !isSafeId(delta.whiteboardId) ||
    delta.stableElementId !== expected.stableElementId ||
    typeof delta.codeChanged !== 'boolean' ||
    typeof delta.visibilityChanged !== 'boolean' ||
    !isUniqueLineIdArray(delta.newLineIds) ||
    !stringArraysEqual(delta.newLineIds, expected.expectedNewLineIds) ||
    !isNonNegativeSafeInteger(delta.elementCountBefore) ||
    delta.elementCountAfter !== delta.elementCountBefore ||
    !hasExactKeys(postcondition, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'elementType',
      'observedBeforeCodeDigest',
      'observedAfterCodeDigest',
      'orderedLineIds',
      'matchingElementCountBefore',
      'matchingElementCountAfter',
    ]) ||
    postcondition.kind !== 'whiteboard_code_state_observed_v2' ||
    postcondition.normalizationVersion !== CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION ||
    postcondition.whiteboardId !== delta.whiteboardId ||
    postcondition.stableElementId !== expected.stableElementId ||
    postcondition.elementType !== 'code' ||
    !isSha256Digest(postcondition.observedBeforeCodeDigest) ||
    !isSha256Digest(postcondition.observedAfterCodeDigest) ||
    !isUniqueLineIdArray(postcondition.orderedLineIds) ||
    postcondition.matchingElementCountBefore !== 1 ||
    postcondition.matchingElementCountAfter !== 1
  ) {
    return false;
  }
  const codeChanged =
    postcondition.observedBeforeCodeDigest !== postcondition.observedAfterCodeDigest;
  const expectedPrefix = revisionedCodeEditLineIdPrefix(receipt.executionId);
  const orderedCounts = new Map<string, number>();
  for (const lineId of postcondition.orderedLineIds) {
    orderedCounts.set(lineId, (orderedCounts.get(lineId) ?? 0) + 1);
    if (lineId.startsWith(expectedPrefix) && !expected.expectedNewLineIds.includes(lineId)) {
      return false;
    }
  }
  if (
    expected.expectedNewLineIds.some((lineId) => orderedCounts.get(lineId) !== 1) ||
    (!codeChanged && expected.expectedNewLineIds.length !== 0) ||
    delta.codeChanged !== codeChanged ||
    receipt.changed !== (codeChanged || delta.visibilityChanged) ||
    receipt.previousBinding.stageId !== receipt.currentBinding.stageId ||
    receipt.previousBinding.whiteboardId === null ||
    receipt.currentBinding.whiteboardId !== receipt.previousBinding.whiteboardId ||
    receipt.currentBinding.whiteboardId !== delta.whiteboardId ||
    receipt.currentBinding.revision !==
      receipt.previousBinding.revision + (receipt.changed ? 1 : 0) ||
    (!receipt.changed &&
      (receipt.currentBinding.stageId !== receipt.previousBinding.stageId ||
        receipt.currentBinding.whiteboardId !== receipt.previousBinding.whiteboardId))
  ) {
    return false;
  }
  return true;
}

function isRevisionedVisibilityPostcondition(
  value: Record<string, unknown>,
  expectedOpen: boolean,
  expectedBoardState: RevisionedVisibilityPostcondition['boardState'],
  expectedWhiteboardId: string | null,
): boolean {
  if (
    value.kind !== 'whiteboard_visibility_observed_v2' ||
    value.boardState !== expectedBoardState ||
    value.whiteboardId !== expectedWhiteboardId ||
    value.observedOpen !== expectedOpen
  ) {
    return false;
  }
  switch (expectedBoardState) {
    case 'preserved_existing':
      return (
        hasExactKeys(value, [
          'kind',
          'boardState',
          'normalizationVersion',
          'whiteboardId',
          'observedOpen',
          'elementCountBefore',
          'elementCountAfter',
          'boardContentDigestBefore',
          'boardContentDigestAfter',
        ]) &&
        value.normalizationVersion === CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION &&
        isSafeId(value.whiteboardId) &&
        isNonNegativeSafeInteger(value.elementCountBefore) &&
        value.elementCountAfter === value.elementCountBefore &&
        isSha256Digest(value.boardContentDigestBefore) &&
        value.boardContentDigestAfter === value.boardContentDigestBefore
      );
    case 'created_empty':
      return (
        hasExactKeys(value, [
          'kind',
          'boardState',
          'normalizationVersion',
          'whiteboardId',
          'observedOpen',
          'elementCountAfter',
          'boardContentDigestAfter',
        ]) &&
        value.normalizationVersion === CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION &&
        isSafeId(value.whiteboardId) &&
        value.elementCountAfter === 0 &&
        value.boardContentDigestAfter === CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1
      );
    case 'no_board':
      return hasExactKeys(value, ['kind', 'boardState', 'whiteboardId', 'observedOpen']);
  }
}

export function isRevisionedLifecycleCommittedReceipt(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedOpenExpectedDescriptor | RevisionedCloseExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  const isOpen = expected.kind === 'wb_open_v2';
  if (
    receipt.outcome !== 'committed' ||
    receipt.toolName !== (isOpen ? 'wb_open' : 'wb_close') ||
    receipt.mutationMayHaveCommitted !== false ||
    !isRecord(receipt.delta) ||
    !isRecord(receipt.postcondition) ||
    receipt.currentBinding.stageId !== receipt.previousBinding.stageId
  ) {
    return false;
  }
  const delta = receipt.delta;
  const previousOpen = delta.previousOpen;
  const currentOpen = delta.currentOpen;
  const visibilityChanged = delta.visibilityChanged;
  if (
    typeof previousOpen !== 'boolean' ||
    currentOpen !== isOpen ||
    typeof visibilityChanged !== 'boolean' ||
    visibilityChanged !== (previousOpen !== currentOpen)
  ) {
    return false;
  }

  const previousWhiteboardId = receipt.previousBinding.whiteboardId;
  const currentWhiteboardId = receipt.currentBinding.whiteboardId;
  let expectedChanged: boolean;
  let expectedBoardState: RevisionedVisibilityPostcondition['boardState'];

  if (isOpen) {
    if (
      !hasExactKeys(delta, [
        'kind',
        'previousOpen',
        'currentOpen',
        'created',
        'visibilityChanged',
      ]) ||
      delta.kind !== 'whiteboard_opened_v2' ||
      typeof delta.created !== 'boolean'
    ) {
      return false;
    }
    if (previousWhiteboardId === null) {
      const expectedCreatedId = deriveRevisionedWhiteboardId(receipt.executionId);
      if (delta.created !== true || currentWhiteboardId !== expectedCreatedId) return false;
      expectedChanged = true;
      expectedBoardState = 'created_empty';
    } else {
      if (delta.created !== false || currentWhiteboardId !== previousWhiteboardId) return false;
      expectedChanged = visibilityChanged;
      expectedBoardState = 'preserved_existing';
    }
  } else {
    if (
      !hasExactKeys(delta, ['kind', 'previousOpen', 'currentOpen', 'visibilityChanged']) ||
      delta.kind !== 'whiteboard_closed_v2' ||
      currentWhiteboardId !== previousWhiteboardId
    ) {
      return false;
    }
    expectedChanged = visibilityChanged;
    expectedBoardState = previousWhiteboardId === null ? 'no_board' : 'preserved_existing';
  }

  return (
    receipt.changed === expectedChanged &&
    receipt.currentBinding.revision ===
      receipt.previousBinding.revision + (expectedChanged ? 1 : 0) &&
    isRevisionedVisibilityPostcondition(
      receipt.postcondition,
      isOpen,
      expectedBoardState,
      currentWhiteboardId,
    )
  );
}

export function isRevisionedWhiteboardCommittedReceiptForExpected(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedWhiteboardExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  switch (expected.kind) {
    case 'wb_open_v2':
    case 'wb_close_v2':
      return isRevisionedLifecycleCommittedReceipt(receipt, expected);
    case 'wb_draw_text_v2':
      return isRevisionedDrawTextCommittedReceipt(receipt, expected);
    case 'wb_draw_shape_v2':
      return isRevisionedDrawShapeCommittedReceipt(receipt, expected);
    case 'wb_draw_line_v2':
      return isRevisionedDrawLineCommittedReceipt(receipt, expected);
    case 'wb_draw_latex_v2':
      return isRevisionedDrawLatexCommittedReceipt(receipt, expected);
    case 'wb_draw_table_v2':
      return isRevisionedDrawTableCommittedReceipt(receipt, expected);
    case 'wb_draw_chart_v2':
      return isRevisionedDrawChartCommittedReceipt(receipt, expected);
    case 'wb_draw_code_v2':
      return isRevisionedDrawCodeCommittedReceipt(receipt, expected);
    case 'wb_edit_code_v2':
      return isRevisionedEditCodeCommittedReceipt(receipt, expected);
  }
}

export function isRevisionedWhiteboardEffectDelivery(
  value: unknown,
): value is RevisionedWhiteboardEffectDelivery {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'protocolVersion',
      'executionId',
      'requestDigest',
      'toolName',
      'expectedBinding',
      'authenticatedTarget',
      'deadlineAt',
      'intent',
      'acknowledgementToken',
    ]) ||
    value.protocolVersion !== REVISIONED_WHITEBOARD_PROTOCOL_VERSION ||
    (value.toolName !== 'wb_open' &&
      value.toolName !== 'wb_close' &&
      value.toolName !== 'wb_draw_text' &&
      value.toolName !== 'wb_draw_shape' &&
      value.toolName !== 'wb_draw_line' &&
      value.toolName !== 'wb_draw_latex' &&
      value.toolName !== 'wb_draw_table' &&
      value.toolName !== 'wb_draw_chart' &&
      value.toolName !== 'wb_draw_code' &&
      value.toolName !== 'wb_edit_code') ||
    !isSafeId(value.executionId) ||
    !isRequestDigest(value.requestDigest) ||
    !isBinding(value.expectedBinding) ||
    !isRevisionedWhiteboardAuthenticatedTarget(value.authenticatedTarget) ||
    typeof value.deadlineAt !== 'number' ||
    !Number.isFinite(value.deadlineAt) ||
    !isSafeId(value.acknowledgementToken)
  ) {
    return false;
  }
  const delivery = value as RevisionedWhiteboardEffectDelivery;
  const digests = createRevisionedWhiteboardEffectDeliveryDigests(delivery);
  return (
    digests !== null &&
    digests.requestDigest === value.requestDigest &&
    digestRevisionedValue(value.intent) === digests.intentDigest
  );
}

export function isRevisionedWhiteboardMutationAck(
  value: unknown,
): value is RevisionedWhiteboardMutationAck {
  if (
    !isRecord(value) ||
    value.protocolVersion !== REVISIONED_WHITEBOARD_PROTOCOL_VERSION ||
    !isSafeId(value.executionId) ||
    !isRequestDigest(value.requestDigest)
  ) {
    return false;
  }
  if (value.status === 'accepted') {
    return (
      hasExactKeys(value, [
        'protocolVersion',
        'status',
        'executionId',
        'requestDigest',
        'targetBinding',
      ]) && isAcceptedBinding(value.targetBinding)
    );
  }
  if (
    value.status !== 'effect_committed' &&
    value.status !== 'effect_rejected' &&
    value.status !== 'effect_uncertain'
  ) {
    return false;
  }
  if (
    !hasExactKeys(value, [
      'protocolVersion',
      'status',
      'executionId',
      'requestDigest',
      'receipt',
    ]) ||
    !isRevisionedWhiteboardAuthorityReceipt(value.receipt)
  ) {
    return false;
  }
  return (
    value.receipt.executionId === value.executionId &&
    value.receipt.requestDigest === value.requestDigest &&
    ((value.status === 'effect_committed' && value.receipt.outcome === 'committed') ||
      (value.status === 'effect_rejected' && value.receipt.outcome === 'rejected') ||
      (value.status === 'effect_uncertain' && value.receipt.outcome === 'uncertain'))
  );
}

export function createRevisionedWhiteboardAcceptedAck(input: {
  executionId: string;
  requestDigest: string;
  targetBinding: RevisionedWhiteboardAcceptedBinding;
}): RevisionedWhiteboardMutationAck {
  return {
    protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
    status: 'accepted',
    ...input,
  };
}

export function createRevisionedWhiteboardTerminalAck(
  receipt: RevisionedWhiteboardAuthorityReceipt,
): RevisionedWhiteboardMutationAck {
  return {
    protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
    status:
      receipt.outcome === 'committed'
        ? 'effect_committed'
        : receipt.outcome === 'rejected'
          ? 'effect_rejected'
          : 'effect_uncertain',
    executionId: receipt.executionId,
    requestDigest: receipt.requestDigest,
    receipt,
  } as RevisionedWhiteboardMutationAck;
}
