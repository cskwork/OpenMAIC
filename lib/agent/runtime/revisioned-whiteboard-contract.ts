import {
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  normalizeWhiteboardRendererColorV1,
} from './client-effect-contract';
import { digestRevisionedValue } from './revisioned-whiteboard-digest';

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

export type RevisionedDrawTextExpectedDescriptor = {
  kind: 'wb_draw_text_v2';
  intentDigest: string;
  stableElementId: string;
  expectedContentDigest: string;
};

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

export type RevisionedDrawTextRequestDigestInput = {
  executionId: string;
  expectedBinding: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intent: RevisionedDrawTextIntent;
};

export type RevisionedWhiteboardEffectDelivery = {
  protocolVersion: typeof REVISIONED_WHITEBOARD_PROTOCOL_VERSION;
  executionId: string;
  requestDigest: string;
  toolName: 'wb_draw_text';
  expectedBinding: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intent: RevisionedDrawTextIntent;
  acknowledgementToken: string;
};

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

export function createRevisionedDrawTextDigests(input: RevisionedDrawTextRequestDigestInput): {
  normalizedIntent: Readonly<RevisionedDrawTextIntent>;
  intentDigest: string;
  requestDigest: string;
} | null {
  const normalizedIntent = normalizeRevisionedDrawTextIntent(input.intent);
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
    toolName: 'wb_draw_text',
    executionId: input.executionId,
    expectedBinding: input.expectedBinding,
    authenticatedTarget: input.authenticatedTarget,
    deadlineAt: input.deadlineAt,
    normalizedIntent,
  });
  return { normalizedIntent, intentDigest, requestDigest };
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
    hasExactKeys(delta, [
      'kind',
      'normalizationVersion',
      'whiteboardId',
      'stableElementId',
      'createdWhiteboard',
      'visibilityChanged',
      'elementCountBefore',
      'elementCountAfter',
    ]) &&
    delta.kind === 'whiteboard_text_created_v2' &&
    delta.normalizationVersion === CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION &&
    isSafeId(delta.whiteboardId) &&
    delta.stableElementId === expected.stableElementId &&
    typeof delta.createdWhiteboard === 'boolean' &&
    typeof delta.visibilityChanged === 'boolean' &&
    isNonNegativeSafeInteger(delta.elementCountBefore) &&
    isNonNegativeSafeInteger(delta.elementCountAfter) &&
    delta.elementCountAfter === delta.elementCountBefore + 1 &&
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
    receipt.currentBinding.stageId === receipt.previousBinding.stageId &&
    receipt.currentBinding.whiteboardId === delta.whiteboardId &&
    receipt.currentBinding.revision === receipt.previousBinding.revision + 1 &&
    (receipt.previousBinding.whiteboardId === null
      ? delta.createdWhiteboard === true
      : delta.createdWhiteboard === false)
  );
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
    value.toolName !== 'wb_draw_text' ||
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
  const digests = createRevisionedDrawTextDigests({
    executionId: value.executionId,
    expectedBinding: value.expectedBinding,
    authenticatedTarget: value.authenticatedTarget,
    deadlineAt: value.deadlineAt,
    intent: value.intent as RevisionedDrawTextIntent,
  });
  return digests !== null && digests.requestDigest === value.requestDigest;
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
