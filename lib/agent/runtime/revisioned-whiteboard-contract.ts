import {
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardRendererColorV1,
  normalizeWhiteboardShapeV1,
  type WhiteboardLineMarker,
  type WhiteboardLineStyle,
  type WhiteboardShapeKind,
} from './client-effect-contract';
import {
  deriveRevisionedWhiteboardId,
  digestRevisionedValue,
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

export type RevisionedWhiteboardExpectedDescriptor =
  | RevisionedDrawTextExpectedDescriptor
  | RevisionedDrawShapeExpectedDescriptor
  | RevisionedDrawLineExpectedDescriptor;

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

export type RevisionedDrawShapeRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawShapeIntent;
};

export type RevisionedDrawLineRequestDigestInput = RevisionedWhiteboardRequestDigestBase & {
  intent: RevisionedDrawLineIntent;
};

export type RevisionedWhiteboardMutationDigestInput =
  | (RevisionedDrawTextRequestDigestInput & { toolName: 'wb_draw_text' })
  | (RevisionedDrawShapeRequestDigestInput & { toolName: 'wb_draw_shape' })
  | (RevisionedDrawLineRequestDigestInput & { toolName: 'wb_draw_line' });

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

export type RevisionedDrawShapeEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_shape';
  intent: RevisionedDrawShapeIntent;
};

export type RevisionedDrawLineEffectDelivery = RevisionedWhiteboardEffectDeliveryBase & {
  toolName: 'wb_draw_line';
  intent: RevisionedDrawLineIntent;
};

export type RevisionedWhiteboardEffectDelivery =
  | RevisionedDrawTextEffectDelivery
  | RevisionedDrawShapeEffectDelivery
  | RevisionedDrawLineEffectDelivery;

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

type ImplementedRevisionedWhiteboardIntent =
  | RevisionedDrawTextIntent
  | RevisionedDrawShapeIntent
  | RevisionedDrawLineIntent;

function normalizeRevisionedWhiteboardMutationIntent(
  toolName: RevisionedWhiteboardMutationDigestInput['toolName'],
  value: unknown,
): Readonly<ImplementedRevisionedWhiteboardIntent> | null {
  switch (toolName) {
    case 'wb_draw_text':
      return normalizeRevisionedDrawTextIntent(value);
    case 'wb_draw_shape':
      return normalizeRevisionedDrawShapeIntent(value);
    case 'wb_draw_line':
      return normalizeRevisionedDrawLineIntent(value);
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
    case 'wb_draw_text':
      return createRevisionedDrawTextDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_shape':
      return createRevisionedDrawShapeDigests({ ...common, intent: delivery.intent });
    case 'wb_draw_line':
      return createRevisionedDrawLineDigests({ ...common, intent: delivery.intent });
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

export function isRevisionedWhiteboardExpectedDescriptor(
  value: unknown,
): value is RevisionedWhiteboardExpectedDescriptor {
  if (!isRecord(value) || !isSha256Digest(value.intentDigest) || !isSafeId(value.stableElementId)) {
    return false;
  }
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
    default:
      return false;
  }
}

function isRevisionedDrawDelta(
  value: Record<string, unknown>,
  expected: RevisionedWhiteboardExpectedDescriptor,
  kind:
    | RevisionedDrawTextDelta['kind']
    | RevisionedDrawShapeDelta['kind']
    | RevisionedDrawLineDelta['kind'],
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

export function isRevisionedWhiteboardCommittedReceiptForExpected(
  receipt: ShapeValidatedRevisionedWhiteboardReceipt,
  expected: RevisionedWhiteboardExpectedDescriptor,
): receipt is ShapeValidatedRevisionedWhiteboardReceipt & RevisionedWhiteboardCommittedReceipt {
  switch (expected.kind) {
    case 'wb_draw_text_v2':
      return isRevisionedDrawTextCommittedReceipt(receipt, expected);
    case 'wb_draw_shape_v2':
      return isRevisionedDrawShapeCommittedReceipt(receipt, expected);
    case 'wb_draw_line_v2':
      return isRevisionedDrawLineCommittedReceipt(receipt, expected);
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
    (value.toolName !== 'wb_draw_text' &&
      value.toolName !== 'wb_draw_shape' &&
      value.toolName !== 'wb_draw_line') ||
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
