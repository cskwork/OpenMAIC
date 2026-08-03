import { describe, expect, it } from 'vitest';
import {
  CLIENT_QUERY_PROTOCOL_VERSION,
  isClientQueryBrowserOutcome,
  type BrowserQueryIdentity,
  type ClientQueryBrowserOutcome,
} from '@/lib/agent/runtime/client-query-contract';

const identity: BrowserQueryIdentity = {
  protocolVersion: CLIENT_QUERY_PROTOCOL_VERSION,
  queryId: 'query-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  stageId: 'stage-1',
  sceneId: 'scene-1',
};

function observation() {
  return {
    ...identity,
    outcome: 'succeeded' as const,
    whiteboardId: 'board-1',
    revision: 3,
    open: true,
    capturedAt: 100,
  };
}

describe('client query contract', () => {
  it.each([
    'WHITEBOARD_AUTHORITY_UNAVAILABLE',
    'WHITEBOARD_QUERY_RESOURCE_BUSY',
    'WHITEBOARD_AUTHORITY_BYPASS',
    'WHITEBOARD_QUERY_TARGET_CHANGED',
    'WHITEBOARD_CODE_ELEMENT_NOT_FOUND',
    'WHITEBOARD_STATE_INVALID',
  ] as const)('accepts the closed browser failure code %s', (code) => {
    expect(isClientQueryBrowserOutcome({ ...identity, outcome: 'failed', error: { code } })).toBe(
      true,
    );
  });

  it('rejects failure observations, arbitrary text and Runtime-owned handles', () => {
    const failure = {
      ...identity,
      outcome: 'failed',
      error: { code: 'WHITEBOARD_AUTHORITY_UNAVAILABLE' },
    };
    expect(isClientQueryBrowserOutcome({ ...failure, revision: 0 })).toBe(false);
    expect(isClientQueryBrowserOutcome({ ...failure, message: 'anything' })).toBe(false);
    expect(isClientQueryBrowserOutcome({ ...failure, snapshotId: 'forged' })).toBe(false);
    expect(
      isClientQueryBrowserOutcome({ ...failure, error: { code: 'UNKNOWN', text: 'forged' } }),
    ).toBe(false);
  });

  it('enforces mutually exclusive complete/progress branches', () => {
    const complete: ClientQueryBrowserOutcome = {
      ...observation(),
      scope: 'elements',
      complete: true,
      data: { items: [] },
    };
    const incomplete: ClientQueryBrowserOutcome = {
      ...observation(),
      scope: 'elements',
      complete: false,
      nextPosition: { index: 1 },
      data: {
        items: [
          {
            id: 'element-1',
            type: 'text',
            bounds: { x: 0, y: 0, width: 10, height: 10, rotate: 0 },
            preview: 'safe',
          },
        ],
      },
    };
    expect(isClientQueryBrowserOutcome(complete)).toBe(true);
    expect(isClientQueryBrowserOutcome({ ...complete, nextPosition: { index: 1 } })).toBe(false);
    expect(isClientQueryBrowserOutcome(incomplete)).toBe(true);
    const { nextPosition: _nextPosition, ...missingProgress } = incomplete;
    expect(isClientQueryBrowserOutcome(missingProgress)).toBe(false);
  });

  it('rejects unsafe IDs and raw source fields in element summaries', () => {
    const base = {
      ...observation(),
      scope: 'elements',
      complete: true,
      data: {
        items: [
          {
            id: 'safe-id',
            type: 'image',
            bounds: { x: 0, y: 0, width: 10, height: 10, rotate: 0 },
            hasSource: true,
          },
        ],
      },
    };
    expect(isClientQueryBrowserOutcome(base)).toBe(true);
    expect(
      isClientQueryBrowserOutcome({
        ...base,
        data: { items: [{ ...base.data.items[0], id: 'bad\nID' }] },
      }),
    ).toBe(false);
    expect(
      isClientQueryBrowserOutcome({
        ...base,
        data: { items: [{ ...base.data.items[0], src: 'https://secret.example' }] },
      }),
    ).toBe(false);
  });
});
