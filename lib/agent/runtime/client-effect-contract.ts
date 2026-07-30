import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ToolExecutionEnvelope,
} from './native-child-contract';

export const CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION = 'maic.visible-text.v1' as const;
export const CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION = 'maic.whiteboard-shape.v1' as const;
export const CLIENT_EFFECT_LINE_NORMALIZATION_VERSION = 'maic.whiteboard-line.v1' as const;
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

export type ClientEffectRequest =
  | WhiteboardTextClientEffectRequest
  | WhiteboardShapeClientEffectRequest
  | WhiteboardLineClientEffectRequest;

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
      status: 'presentation_paused' | 'presentation_resumed';
    })
  | (ClientEffectAckBase & {
      status: 'effect_committed';
      targetBinding: AcceptedTargetBinding;
      postcondition:
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
          } & WhiteboardLineSpec);
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
      return (
        hasExactKeys(ack, [
          'protocolVersion',
          'executionId',
          'idempotencyKey',
          'clientEventId',
          'observedAt',
          'status',
          'targetBinding',
        ]) && isTargetBinding(ack.targetBinding)
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
