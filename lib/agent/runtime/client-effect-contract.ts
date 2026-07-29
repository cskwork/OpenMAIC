import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type ToolExecutionEnvelope,
} from './native-child-contract';

export const CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION = 'maic.visible-text.v1' as const;
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

export interface ClientEffectRequest extends ToolExecutionEnvelope {
  kind: 'client_effect';
  toolName: 'wb_draw_text';
  target: ClientEffectTarget;
  activeEffectBudgetMs: number;
  postcondition: WhiteboardTextPostcondition;
}

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
      postcondition: {
        stableElementId: string;
        elementType: 'text';
        normalizationVersion: typeof CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION;
        observedContentDigest: string;
        matchingElementCount: 1;
      };
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
      return (
        hasExactKeys(postcondition, [
          'stableElementId',
          'elementType',
          'normalizationVersion',
          'observedContentDigest',
          'matchingElementCount',
        ]) &&
        isNonEmptyString(postcondition.stableElementId) &&
        postcondition.elementType === 'text' &&
        postcondition.normalizationVersion === CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION &&
        isNonEmptyString(postcondition.observedContentDigest) &&
        postcondition.matchingElementCount === 1
      );
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
