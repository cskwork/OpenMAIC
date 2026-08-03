import type { ClientQueryExecutionRequest } from './native-child-contract';

export const CLIENT_QUERY_PROTOCOL_VERSION = 'maic.client-query.v1' as const;
export const CLIENT_QUERY_RESPONSE_HEADER = 'x-maic-client-query-response';
export const CLIENT_QUERY_RESPONSE_MAX_BYTES = 48 * 1024;
export const CLIENT_QUERY_TIMEOUT_MS = 5_000;

export interface ClientQueryTarget {
  requestId: string;
  sessionId: string;
  stageId: string;
  sceneId: string;
}

export type WhiteboardReadBrowserQuery =
  | { scope: 'summary' }
  | { scope: 'elements'; startIndex: number; limit: number }
  | { scope: 'code'; elementId: string; lineIndex: number; startOffset: number };

export interface WhiteboardReadClientQueryRequest extends ClientQueryExecutionRequest {
  toolName: 'wb_read';
  queryId: string;
  target: ClientQueryTarget;
  query: WhiteboardReadBrowserQuery;
  activeQueryBudgetMs: number;
}

export type ClientQueryRequest = WhiteboardReadClientQueryRequest;

export interface ClientQueryDelivery {
  request: ClientQueryRequest;
  responseToken: string;
}

export interface BrowserQueryIdentity {
  protocolVersion: typeof CLIENT_QUERY_PROTOCOL_VERSION;
  queryId: string;
  requestId: string;
  sessionId: string;
  stageId: string;
  sceneId: string;
}

export interface BrowserObservationBase extends BrowserQueryIdentity {
  whiteboardId: string | null;
  revision: number;
  open: boolean;
  capturedAt: number;
}

export interface WhiteboardBoundsSummary {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: number;
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

export type BrowserElementSummary = {
  id: string;
  bounds: WhiteboardBoundsSummary;
} & (
  | { type: 'text'; preview: string }
  | { type: 'image'; hasSource: boolean; altPreview?: string }
  | { type: 'shape'; shapeKind: string; labelPreview?: string }
  | { type: 'line'; pointCount: number; lineStyle?: string }
  | {
      type: 'chart';
      chartType: string;
      seriesCount: number;
      labelCount: number;
      labelPreview: string[];
    }
  | { type: 'table'; rowCount: number; columnCount: number; cellPreview: string[] }
  | { type: 'latex'; preview: string }
  | { type: 'video'; hasSource: boolean }
  | { type: 'audio'; hasSource: boolean }
  | { type: 'code'; language: string; fileName?: string; lineCount: number }
);

export interface BrowserCodeFragment {
  lineId: string;
  lineIndex: number;
  startOffset: number;
  endOffset: number;
  content: string;
  lineComplete: boolean;
}

type BrowserPageCompletion<Position> =
  | { complete: true }
  | { complete: false; nextPosition: Position };

export type ClientQueryBrowserSuccess =
  | (BrowserObservationBase & {
      outcome: 'succeeded';
      scope: 'summary';
      complete: true;
      data: {
        exists: boolean;
        elementCount: number;
        typeCounts: Partial<Record<WhiteboardElementType, number>>;
      };
    })
  | (BrowserObservationBase &
      BrowserPageCompletion<{ index: number }> & {
        outcome: 'succeeded';
        scope: 'elements';
        data: { items: BrowserElementSummary[] };
      })
  | (BrowserObservationBase &
      BrowserPageCompletion<{ lineIndex: number; startOffset: number }> & {
        outcome: 'succeeded';
        scope: 'code';
        elementId: string;
        data: {
          language: string;
          fileName?: string;
          lineCount: number;
          fragments: BrowserCodeFragment[];
        };
      });

export type ClientQueryBrowserFailureCode =
  | 'WHITEBOARD_AUTHORITY_UNAVAILABLE'
  | 'WHITEBOARD_QUERY_RESOURCE_BUSY'
  | 'WHITEBOARD_AUTHORITY_BYPASS'
  | 'WHITEBOARD_QUERY_TARGET_CHANGED'
  | 'WHITEBOARD_CODE_ELEMENT_NOT_FOUND'
  | 'WHITEBOARD_STATE_INVALID';

export type ClientQueryBrowserFailure = BrowserQueryIdentity & {
  outcome: 'failed';
  error: { code: ClientQueryBrowserFailureCode };
};

export type ClientQueryBrowserOutcome = ClientQueryBrowserSuccess | ClientQueryBrowserFailure;

export type ClientQueryTerminalResult =
  | { status: 'query_completed'; outcome: ClientQueryBrowserSuccess }
  | { status: 'query_failed'; outcome?: ClientQueryBrowserFailure; code: string }
  | { status: 'cancelled'; code: string }
  | { status: 'timed_out'; code: 'CLIENT_QUERY_TIMEOUT' };

export interface ClientQueryTraceEvent {
  type: 'query_registered' | 'query_completed' | 'query_failed' | 'query_cancelled';
  queryId: string;
  childInvocationId: string;
  code?: string;
}

const FAILURE_CODES = new Set<ClientQueryBrowserFailureCode>([
  'WHITEBOARD_AUTHORITY_UNAVAILABLE',
  'WHITEBOARD_QUERY_RESOURCE_BUSY',
  'WHITEBOARD_AUTHORITY_BYPASS',
  'WHITEBOARD_QUERY_TARGET_CHANGED',
  'WHITEBOARD_CODE_ELEMENT_NOT_FOUND',
  'WHITEBOARD_STATE_INVALID',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteBound(value: unknown, nonNegative = false): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= 1_000_000 &&
    (!nonNegative || value >= 0)
  );
}

export function isPromptSafeId(value: unknown, maxLength = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedText(value: unknown, units: number, bytes: number): value is string {
  return typeof value === 'string' && value.length <= units && utf8Length(value) <= bytes;
}

function isIdentity(value: Record<string, unknown>): boolean {
  return (
    value.protocolVersion === CLIENT_QUERY_PROTOCOL_VERSION &&
    isPromptSafeId(value.queryId) &&
    isPromptSafeId(value.requestId) &&
    isPromptSafeId(value.sessionId) &&
    isPromptSafeId(value.stageId) &&
    isPromptSafeId(value.sceneId)
  );
}

function isObservation(value: Record<string, unknown>): boolean {
  return (
    isIdentity(value) &&
    (value.whiteboardId === null || isPromptSafeId(value.whiteboardId)) &&
    isSafeInteger(value.revision) &&
    typeof value.open === 'boolean' &&
    typeof value.capturedAt === 'number' &&
    Number.isFinite(value.capturedAt)
  );
}

function isBounds(value: unknown): value is WhiteboardBoundsSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['x', 'y', 'width', 'height', 'rotate']) &&
    isFiniteBound(value.x) &&
    isFiniteBound(value.y) &&
    isFiniteBound(value.width, true) &&
    isFiniteBound(value.height, true) &&
    isFiniteBound(value.rotate)
  );
}

function isPreviewArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((entry) => isBoundedText(entry, 128, 512))
  );
}

function isElementSummary(value: unknown): value is BrowserElementSummary {
  if (!isRecord(value) || !isPromptSafeId(value.id) || !isBounds(value.bounds)) return false;
  switch (value.type) {
    case 'text':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'preview']) &&
        isBoundedText(value.preview, 256, 1024)
      );
    case 'image':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'hasSource'], ['altPreview']) &&
        typeof value.hasSource === 'boolean' &&
        (value.altPreview === undefined || isBoundedText(value.altPreview, 256, 1024))
      );
    case 'shape':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'shapeKind'], ['labelPreview']) &&
        isBoundedText(value.shapeKind, 128, 512) &&
        (value.labelPreview === undefined || isBoundedText(value.labelPreview, 256, 1024))
      );
    case 'line':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'pointCount'], ['lineStyle']) &&
        isSafeInteger(value.pointCount) &&
        (value.lineStyle === undefined || isBoundedText(value.lineStyle, 64, 256))
      );
    case 'chart':
      return (
        hasExactKeys(value, [
          'id',
          'bounds',
          'type',
          'chartType',
          'seriesCount',
          'labelCount',
          'labelPreview',
        ]) &&
        isBoundedText(value.chartType, 64, 256) &&
        isSafeInteger(value.seriesCount) &&
        isSafeInteger(value.labelCount) &&
        isPreviewArray(value.labelPreview)
      );
    case 'table':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'rowCount', 'columnCount', 'cellPreview']) &&
        isSafeInteger(value.rowCount) &&
        isSafeInteger(value.columnCount) &&
        isPreviewArray(value.cellPreview)
      );
    case 'latex':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'preview']) &&
        isBoundedText(value.preview, 256, 1024)
      );
    case 'video':
    case 'audio':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'hasSource']) &&
        typeof value.hasSource === 'boolean'
      );
    case 'code':
      return (
        hasExactKeys(value, ['id', 'bounds', 'type', 'language', 'lineCount'], ['fileName']) &&
        isBoundedText(value.language, 32, 128) &&
        isSafeInteger(value.lineCount) &&
        (value.fileName === undefined || isBoundedText(value.fileName, 128, 512))
      );
    default:
      return false;
  }
}

function isCodeFragment(value: unknown): value is BrowserCodeFragment {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'lineId',
      'lineIndex',
      'startOffset',
      'endOffset',
      'content',
      'lineComplete',
    ]) &&
    isPromptSafeId(value.lineId, 256) &&
    isSafeInteger(value.lineIndex) &&
    isSafeInteger(value.startOffset) &&
    isSafeInteger(value.endOffset) &&
    value.endOffset >= value.startOffset &&
    typeof value.content === 'string' &&
    typeof value.lineComplete === 'boolean'
  );
}

export function isClientQueryBrowserOutcome(value: unknown): value is ClientQueryBrowserOutcome {
  if (!isRecord(value) || !isIdentity(value)) return false;
  if (value.outcome === 'failed') {
    return (
      hasExactKeys(value, [
        'protocolVersion',
        'queryId',
        'requestId',
        'sessionId',
        'stageId',
        'sceneId',
        'outcome',
        'error',
      ]) &&
      isRecord(value.error) &&
      hasExactKeys(value.error, ['code']) &&
      FAILURE_CODES.has(value.error.code as ClientQueryBrowserFailureCode)
    );
  }
  if (value.outcome !== 'succeeded' || !isObservation(value)) return false;
  const baseKeys = [
    'protocolVersion',
    'queryId',
    'requestId',
    'sessionId',
    'stageId',
    'sceneId',
    'whiteboardId',
    'revision',
    'open',
    'capturedAt',
    'outcome',
    'scope',
    'complete',
    'data',
  ];
  if (value.scope === 'summary') {
    if (!hasExactKeys(value, baseKeys) || value.complete !== true || !isRecord(value.data))
      return false;
    if (!hasExactKeys(value.data, ['exists', 'elementCount', 'typeCounts'])) return false;
    if (
      typeof value.data.exists !== 'boolean' ||
      !isSafeInteger(value.data.elementCount) ||
      !isRecord(value.data.typeCounts)
    )
      return false;
    return Object.entries(value.data.typeCounts).every(
      ([key, count]) =>
        [
          'text',
          'image',
          'shape',
          'line',
          'chart',
          'table',
          'latex',
          'video',
          'audio',
          'code',
        ].includes(key) && isSafeInteger(count),
    );
  }
  if (value.scope === 'elements') {
    const required = value.complete === false ? [...baseKeys, 'nextPosition'] : baseKeys;
    if (
      !hasExactKeys(value, required) ||
      typeof value.complete !== 'boolean' ||
      !isRecord(value.data) ||
      !hasExactKeys(value.data, ['items']) ||
      !Array.isArray(value.data.items) ||
      !value.data.items.every(isElementSummary)
    )
      return false;
    return (
      value.complete === true ||
      (isRecord(value.nextPosition) &&
        hasExactKeys(value.nextPosition, ['index']) &&
        isSafeInteger(value.nextPosition.index))
    );
  }
  if (value.scope === 'code') {
    const codeBase = [...baseKeys, 'elementId'];
    const required = value.complete === false ? [...codeBase, 'nextPosition'] : codeBase;
    if (
      !hasExactKeys(value, required) ||
      !isPromptSafeId(value.elementId) ||
      typeof value.complete !== 'boolean' ||
      !isRecord(value.data) ||
      !hasExactKeys(value.data, ['language', 'lineCount', 'fragments'], ['fileName']) ||
      !isBoundedText(value.data.language, 32, 128) ||
      !isSafeInteger(value.data.lineCount) ||
      (value.data.fileName !== undefined && !isBoundedText(value.data.fileName, 128, 512)) ||
      !Array.isArray(value.data.fragments) ||
      !value.data.fragments.every(isCodeFragment)
    )
      return false;
    return (
      value.complete === true ||
      (isRecord(value.nextPosition) &&
        hasExactKeys(value.nextPosition, ['lineIndex', 'startOffset']) &&
        isSafeInteger(value.nextPosition.lineIndex) &&
        isSafeInteger(value.nextPosition.startOffset))
    );
  }
  return false;
}

export function serializedUtf8Bytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}
