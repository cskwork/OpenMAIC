'use client';

import type { PPTElement, Whiteboard } from '@openmaic/dsl';
import {
  CLIENT_QUERY_PROTOCOL_VERSION,
  CLIENT_QUERY_RESPONSE_HEADER,
  CLIENT_QUERY_TIMEOUT_MS,
  type BrowserCodeFragment,
  type BrowserElementSummary,
  type BrowserQueryIdentity,
  type ClientQueryBrowserFailure,
  type ClientQueryBrowserFailureCode,
  type ClientQueryBrowserOutcome,
  type ClientQueryBrowserSuccess,
  type ClientQueryDelivery,
  isPromptSafeId,
  serializedUtf8Bytes,
} from '@/lib/agent/runtime/client-query-contract';
import {
  normalizeWhiteboardCodeFileName,
  normalizeWhiteboardCodeLanguage,
} from '@/lib/agent/runtime/client-effect-contract';
import {
  getDefaultWhiteboardEnvironmentAuthority,
  WHITEBOARD_AUTHORITY_BYPASS,
  WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
} from '@/lib/store/whiteboard-environment-authority';

const MAX_BROWSER_QUERY_CACHE = 16;
const ELEMENT_PAGE_SEMANTIC_BYTES = 3 * 1024;
const CODE_PAGE_CONTENT_UNITS = 2_048;

export interface BrowserClientQueryRuntimeOptions {
  requestId: string;
  sessionId: string;
  readCurrentStageId: () => string | null | undefined;
  readCurrentSceneId: () => string | null | undefined;
  fetchResponse?: typeof fetch;
  now?: () => number;
}

function identity(delivery: ClientQueryDelivery): BrowserQueryIdentity {
  return {
    protocolVersion: CLIENT_QUERY_PROTOCOL_VERSION,
    queryId: delivery.request.queryId,
    requestId: delivery.request.target.requestId,
    sessionId: delivery.request.target.sessionId,
    stageId: delivery.request.target.stageId,
    sceneId: delivery.request.target.sceneId,
  };
}

function failure(
  delivery: ClientQueryDelivery,
  code: ClientQueryBrowserFailureCode,
): ClientQueryBrowserFailure {
  return { ...identity(delivery), outcome: 'failed', error: { code } };
}

function truncatePreview(value: unknown, maxUnits = 256): string {
  if (typeof value !== 'string') return '';
  let end = Math.min(value.length, maxUnits);
  if (end > 0 && end < value.length) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function bounds(element: PPTElement) {
  return {
    x: element.left,
    y: element.top,
    width: element.width,
    height: 'height' in element ? element.height : 0,
    rotate: 'rotate' in element ? element.rotate : 0,
  };
}

function projectElement(element: PPTElement): BrowserElementSummary {
  const base = { id: element.id, bounds: bounds(element) };
  switch (element.type) {
    case 'text':
      return { ...base, type: 'text', preview: truncatePreview(element.content) };
    case 'image':
      return {
        ...base,
        type: 'image',
        hasSource: Boolean(element.src),
        ...(element.name ? { altPreview: truncatePreview(element.name) } : {}),
      };
    case 'shape':
      return {
        ...base,
        type: 'shape',
        shapeKind: truncatePreview(
          element.pathFormula ?? (element.special ? 'special' : 'custom'),
          128,
        ),
        ...(element.text?.content ? { labelPreview: truncatePreview(element.text.content) } : {}),
      };
    case 'line':
      return { ...base, type: 'line', pointCount: 2, lineStyle: element.style };
    case 'chart':
      return {
        ...base,
        type: 'chart',
        chartType: element.chartType,
        seriesCount: element.data.series.length,
        labelCount: element.data.labels.length,
        labelPreview: element.data.labels.slice(0, 16).map((label) => truncatePreview(label, 128)),
      };
    case 'table':
      return {
        ...base,
        type: 'table',
        rowCount: element.data.length,
        columnCount: element.data.reduce((max, row) => Math.max(max, row.length), 0),
        cellPreview: element.data
          .flatMap((row) => row.map((cell) => truncatePreview(cell.text, 128)))
          .slice(0, 16),
      };
    case 'latex':
      return { ...base, type: 'latex', preview: truncatePreview(element.latex) };
    case 'video':
      return { ...base, type: 'video', hasSource: Boolean(element.src ?? element.mediaRef) };
    case 'audio':
      return { ...base, type: 'audio', hasSource: Boolean(element.src) };
    case 'code':
      return {
        ...base,
        type: 'code',
        language: normalizeWhiteboardCodeLanguage(element.language),
        ...(normalizeWhiteboardCodeFileName(element.fileName)
          ? { fileName: normalizeWhiteboardCodeFileName(element.fileName) }
          : {}),
        lineCount: element.lines.length,
      };
  }
}

function validateBoard(board: Whiteboard | null): void {
  if (!board) return;
  const seen = new Set<string>();
  for (const element of board.elements) {
    if (!isPromptSafeId(element.id) || seen.has(element.id)) {
      throw new Error('WHITEBOARD_STATE_INVALID');
    }
    seen.add(element.id);
    const projected = projectElement(element);
    if (
      !Object.values(projected.bounds).every(
        (value) =>
          typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000,
      ) ||
      projected.bounds.width < 0 ||
      projected.bounds.height < 0
    ) {
      throw new Error('WHITEBOARD_STATE_INVALID');
    }
    if (element.type === 'code') {
      const lineIds = new Set<string>();
      for (const line of element.lines) {
        if (!isPromptSafeId(line.id, 256) || lineIds.has(line.id)) {
          throw new Error('WHITEBOARD_STATE_INVALID');
        }
        lineIds.add(line.id);
      }
    }
    if (serializedUtf8Bytes(projected) > 4 * 1024) {
      throw new Error('WHITEBOARD_STATE_INVALID');
    }
  }
}

function elementsPage(
  board: Whiteboard | null,
  startIndex: number,
  limit: number,
): { items: BrowserElementSummary[]; nextIndex?: number } {
  const elements = board?.elements ?? [];
  const end = Math.min(elements.length, startIndex + limit);
  const items: BrowserElementSummary[] = [];
  let nextIndex = startIndex;
  while (nextIndex < end) {
    const item = projectElement(elements[nextIndex]);
    if (
      items.length > 0 &&
      serializedUtf8Bytes({ items: [...items, item] }) > ELEMENT_PAGE_SEMANTIC_BYTES
    ) {
      break;
    }
    items.push(item);
    nextIndex += 1;
  }
  return { items, ...(nextIndex < elements.length ? { nextIndex } : {}) };
}

function safeFragmentEnd(content: string, start: number, desiredEnd: number): number {
  let end = Math.min(content.length, desiredEnd);
  if (end > start && end < content.length) {
    const code = content.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return end;
}

function codePage(
  board: Whiteboard | null,
  elementId: string,
  startLine: number,
  startOffset: number,
) {
  const matches = board?.elements.filter((element) => element.id === elementId) ?? [];
  if (matches.length === 0) throw new Error('WHITEBOARD_CODE_ELEMENT_NOT_FOUND');
  if (matches.length !== 1) throw new Error('WHITEBOARD_STATE_INVALID');
  const element = matches[0];
  if (element.type !== 'code') throw new Error('WHITEBOARD_CODE_ELEMENT_NOT_FOUND');
  if (startLine > element.lines.length) throw new Error('WHITEBOARD_STATE_INVALID');
  const fragments: BrowserCodeFragment[] = [];
  let remaining = CODE_PAGE_CONTENT_UNITS;
  let lineIndex = startLine;
  let offset = startOffset;
  while (lineIndex < element.lines.length && remaining > 0) {
    const line = element.lines[lineIndex];
    if (!isPromptSafeId(line.id, 256) || offset > line.content.length) {
      throw new Error('WHITEBOARD_STATE_INVALID');
    }
    const endOffset = safeFragmentEnd(line.content, offset, offset + remaining);
    const content = line.content.slice(offset, endOffset);
    const lineComplete = endOffset === line.content.length;
    fragments.push({
      lineId: line.id,
      lineIndex,
      startOffset: offset,
      endOffset,
      content,
      lineComplete,
    });
    remaining -= Math.max(content.length, 1);
    if (!lineComplete) {
      offset = endOffset;
      break;
    }
    lineIndex += 1;
    offset = 0;
  }
  const complete = lineIndex >= element.lines.length;
  return {
    element,
    fragments,
    complete,
    nextPosition: complete ? undefined : { lineIndex, startOffset: offset },
  };
}

export class BrowserClientQueryRuntime {
  private readonly outcomes = new Map<string, ClientQueryBrowserOutcome>();
  private readonly fetchResponse: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: BrowserClientQueryRuntimeOptions) {
    this.fetchResponse = opts.fetchResponse ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  async execute(delivery: ClientQueryDelivery, signal?: AbortSignal): Promise<void> {
    let outcome = this.outcomes.get(delivery.request.queryId);
    if (!outcome) {
      outcome = this.capture(delivery);
      this.outcomes.set(delivery.request.queryId, outcome);
      while (this.outcomes.size > MAX_BROWSER_QUERY_CACHE) {
        const oldest = this.outcomes.keys().next().value;
        if (oldest) this.outcomes.delete(oldest);
        else break;
      }
    }
    const body = JSON.stringify(outcome);
    const queryTimeout = AbortSignal.timeout(
      Math.max(1, Math.min(CLIENT_QUERY_TIMEOUT_MS, delivery.request.activeQueryBudgetMs)),
    );
    const deliverySignal = signal ? AbortSignal.any([signal, queryTimeout]) : queryTimeout;
    const post = () =>
      this.fetchResponse(
        `/api/chat/pi/client-queries/${encodeURIComponent(delivery.request.queryId)}/response`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [CLIENT_QUERY_RESPONSE_HEADER]: delivery.responseToken,
          },
          body,
          signal: deliverySignal,
        },
      );
    let response: Response;
    try {
      response = await post();
    } catch (error) {
      if (deliverySignal.aborted) throw error;
      response = await post();
    }
    if (!response.ok) throw new Error(`CLIENT_QUERY_DELIVERY_FAILED:${response.status}`);
  }

  async failDelivery(
    delivery: ClientQueryDelivery,
    _cause: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const failureTimeout = AbortSignal.timeout(
      Math.max(1, Math.min(CLIENT_QUERY_TIMEOUT_MS, delivery.request.activeQueryBudgetMs)),
    );
    const deliverySignal = signal ? AbortSignal.any([signal, failureTimeout]) : failureTimeout;
    const response = await this.fetchResponse(
      `/api/chat/pi/client-queries/${encodeURIComponent(delivery.request.queryId)}/response`,
      {
        method: 'DELETE',
        headers: { [CLIENT_QUERY_RESPONSE_HEADER]: delivery.responseToken },
        signal: deliverySignal,
      },
    );
    if (!response.ok)
      throw new Error(`CLIENT_QUERY_DELIVERY_FAILURE_REPORT_FAILED:${response.status}`);
  }

  clear(): void {
    this.outcomes.clear();
  }

  private capture(delivery: ClientQueryDelivery): ClientQueryBrowserOutcome {
    const request = delivery.request;
    if (
      request.target.requestId !== this.opts.requestId ||
      request.target.sessionId !== this.opts.sessionId ||
      request.target.stageId !== this.opts.readCurrentStageId() ||
      request.target.sceneId !== this.opts.readCurrentSceneId()
    ) {
      return failure(delivery, 'WHITEBOARD_QUERY_TARGET_CHANGED');
    }
    const authority = getDefaultWhiteboardEnvironmentAuthority();
    if (!authority) return failure(delivery, 'WHITEBOARD_AUTHORITY_UNAVAILABLE');
    const query = authority.queryActiveWhiteboard();
    if (!query.ok) {
      return failure(
        delivery,
        query.code === WHITEBOARD_AUTHORITY_RESOURCE_BUSY
          ? 'WHITEBOARD_QUERY_RESOURCE_BUSY'
          : query.code === WHITEBOARD_AUTHORITY_BYPASS
            ? 'WHITEBOARD_AUTHORITY_BYPASS'
            : 'WHITEBOARD_STATE_INVALID',
      );
    }
    if (query.snapshot.stageId !== request.target.stageId) {
      return failure(delivery, 'WHITEBOARD_QUERY_TARGET_CHANGED');
    }
    try {
      validateBoard(query.value);
      const observation = {
        ...identity(delivery),
        outcome: 'succeeded' as const,
        whiteboardId: query.snapshot.activeWhiteboardId,
        revision: query.snapshot.revision,
        open: query.snapshot.open,
        capturedAt: this.now(),
      };
      switch (request.query.scope) {
        case 'summary': {
          const typeCounts: Record<string, number> = {};
          for (const element of query.value?.elements ?? []) {
            typeCounts[element.type] = (typeCounts[element.type] ?? 0) + 1;
          }
          return {
            ...observation,
            scope: 'summary',
            complete: true,
            data: {
              exists: query.value !== null,
              elementCount: query.value?.elements.length ?? 0,
              typeCounts,
            },
          } satisfies ClientQueryBrowserSuccess;
        }
        case 'elements': {
          const page = elementsPage(query.value, request.query.startIndex, request.query.limit);
          return {
            ...observation,
            scope: 'elements',
            ...(page.nextIndex === undefined
              ? { complete: true as const }
              : { complete: false as const, nextPosition: { index: page.nextIndex } }),
            data: { items: page.items },
          } satisfies ClientQueryBrowserSuccess;
        }
        case 'code': {
          const page = codePage(
            query.value,
            request.query.elementId,
            request.query.lineIndex,
            request.query.startOffset,
          );
          return {
            ...observation,
            scope: 'code',
            elementId: page.element.id,
            ...(page.complete
              ? { complete: true as const }
              : { complete: false as const, nextPosition: page.nextPosition! }),
            data: {
              language: normalizeWhiteboardCodeLanguage(page.element.language),
              ...(normalizeWhiteboardCodeFileName(page.element.fileName)
                ? { fileName: normalizeWhiteboardCodeFileName(page.element.fileName) }
                : {}),
              lineCount: page.element.lines.length,
              fragments: page.fragments,
            },
          } satisfies ClientQueryBrowserSuccess;
        }
      }
    } catch (error) {
      return failure(
        delivery,
        error instanceof Error && error.message === 'WHITEBOARD_CODE_ELEMENT_NOT_FOUND'
          ? 'WHITEBOARD_CODE_ELEMENT_NOT_FOUND'
          : 'WHITEBOARD_STATE_INVALID',
      );
    }
  }
}
