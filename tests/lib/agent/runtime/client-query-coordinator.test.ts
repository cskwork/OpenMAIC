import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_QUERY_PROTOCOL_VERSION,
  type ClientQueryBrowserOutcome,
  type ClientQueryRequest,
} from '@/lib/agent/runtime/client-query-contract';
import { ClientQueryCoordinator } from '@/lib/agent/runtime/client-query-coordinator';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

let tokenSequence = 0;
const coordinators: ClientQueryCoordinator[] = [];

function request(queryId: string, childInvocationId = 'child-1'): ClientQueryRequest {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    kind: 'client_query',
    traceId: 'trace-1',
    runId: 'run-1',
    agentInvocationId: childInvocationId,
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: `tool-${queryId}`,
    executionId: queryId,
    idempotencyKey: `idem-${queryId}`,
    toolName: 'wb_read',
    args: { scope: 'summary' },
    argsDigest: 'sha256:test',
    issuedAt: 0,
    deadlineAt: 10_000,
    attempt: 1,
    queryId,
    target: {
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
    },
    query: { scope: 'summary' },
    activeQueryBudgetMs: 5_000,
  };
}

function success(queryId: string): ClientQueryBrowserOutcome {
  return {
    protocolVersion: CLIENT_QUERY_PROTOCOL_VERSION,
    queryId,
    requestId: 'request-1',
    sessionId: 'session-1',
    stageId: 'stage-1',
    sceneId: 'scene-1',
    outcome: 'succeeded',
    whiteboardId: null,
    revision: 1,
    open: false,
    capturedAt: 1,
    scope: 'summary',
    complete: true,
    data: { exists: false, elementCount: 0, typeCounts: {} },
  };
}

function coordinator(overrides: ConstructorParameters<typeof ClientQueryCoordinator>[0] = {}) {
  const value = new ClientQueryCoordinator({
    now: () => 0,
    createToken: () => `token-${++tokenSequence}`,
    ...overrides,
  });
  coordinators.push(value);
  return value;
}

afterEach(() => {
  for (const value of coordinators.splice(0)) value.clearForTests();
  vi.useRealTimers();
});

describe('ClientQueryCoordinator', () => {
  it('authenticates, applies once and rejects a conflicting replay', async () => {
    const value = coordinator();
    const registered = value.register(request('query-1'));
    const body = JSON.stringify(success('query-1'));

    expect(value.authorize('query-1', registered.delivery.responseToken)).toBe('authorized');
    expect(
      value.respond('query-1', registered.delivery.responseToken, body, success('query-1')),
    ).toMatchObject({ kind: 'applied', status: 'completed' });
    await expect(registered.result).resolves.toMatchObject({ status: 'query_completed' });
    expect(
      value.respond('query-1', registered.delivery.responseToken, body, success('query-1')),
    ).toMatchObject({ kind: 'duplicate' });
    expect(
      value.respond('query-1', registered.delivery.responseToken, body, success('query-1')),
    ).toMatchObject({ kind: 'invalid', reason: 'CLIENT_QUERY_RESPONSE_CONFLICT' });
    expect(
      value.respond('query-1', registered.delivery.responseToken, `${body} `, success('query-1')),
    ).toMatchObject({ kind: 'invalid', reason: 'CLIENT_QUERY_RESPONSE_CONFLICT' });
  });

  it('settles a reportable browser delivery failure without waiting for timeout', async () => {
    const value = coordinator();
    const registered = value.register(request('query-delivery-failed'));

    expect(
      value.failDelivery('query-delivery-failed', registered.delivery.responseToken),
    ).toMatchObject({ kind: 'applied', status: 'failed' });
    await expect(registered.result).resolves.toEqual({
      status: 'query_failed',
      code: 'CLIENT_QUERY_DELIVERY_FAILED',
    });
    expect(
      value.failDelivery('query-delivery-failed', registered.delivery.responseToken),
    ).toMatchObject({ kind: 'late', status: 'failed' });
  });

  it('classifies the first authenticated body after cancellation as late and bounds replay', () => {
    const value = coordinator();
    const registered = value.register(request('query-late'));
    const outcome = success('query-late');
    const body = JSON.stringify(outcome);
    value.cancel('query-late');
    value.release('query-late');

    expect(
      value.respond('query-late', registered.delivery.responseToken, body, outcome),
    ).toMatchObject({ kind: 'late', status: 'cancelled' });
    expect(
      value.respond('query-late', registered.delivery.responseToken, body, outcome),
    ).toMatchObject({ kind: 'late', status: 'cancelled' });
    expect(
      value.respond('query-late', registered.delivery.responseToken, body, outcome),
    ).toMatchObject({ kind: 'invalid', reason: 'CLIENT_QUERY_RESPONSE_CONFLICT' });
  });

  it('keeps a browser failure structured and terminal', async () => {
    const value = coordinator();
    const registered = value.register(request('query-failure'));
    const outcome: ClientQueryBrowserOutcome = {
      protocolVersion: CLIENT_QUERY_PROTOCOL_VERSION,
      queryId: 'query-failure',
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      outcome: 'failed',
      error: { code: 'WHITEBOARD_QUERY_RESOURCE_BUSY' },
    };
    value.respond(
      'query-failure',
      registered.delivery.responseToken,
      JSON.stringify(outcome),
      outcome,
    );

    await expect(registered.result).resolves.toEqual({
      status: 'query_failed',
      outcome,
      code: 'WHITEBOARD_QUERY_RESOURCE_BUSY',
    });
  });

  it('rejects an over-limit direct response before caching or settlement', () => {
    const value = coordinator();
    const registered = value.register(request('query-too-large'));
    const outcome = success('query-too-large');

    expect(
      value.respond(
        'query-too-large',
        registered.delivery.responseToken,
        'x'.repeat(48 * 1024 + 1),
        outcome,
      ),
    ).toMatchObject({ kind: 'invalid', reason: 'CLIENT_QUERY_RESPONSE_INVALID' });
    expect(value.authorize('query-too-large', registered.delivery.responseToken)).toBe(
      'authorized',
    );
  });

  it('reserves enough cache for the legal eight-read Gate and rejects the ninth before delivery', () => {
    const value = coordinator();
    for (let index = 0; index < 8; index += 1) value.register(request(`query-${index}`));
    expect(value.getCountsForTests()).toEqual({ live: 8, tombstones: 0 });
    expect(() => value.register(request('query-9'))).toThrow(
      'CLIENT_QUERY_COORDINATOR_CAPACITY_EXCEEDED',
    );
  });

  it('enforces the module-global live-entry cap without evicting live queries', () => {
    const value = coordinator({ maxGlobalLive: 1, maxGlobalCacheBytes: 1024 * 1024 });
    value.register(request('query-1', 'child-1'));
    expect(() => value.register(request('query-2', 'child-2'))).toThrow(
      'CLIENT_QUERY_COORDINATOR_CAPACITY_EXCEEDED',
    );
    expect(value.getCountsForTests().live).toBe(1);
  });

  it('drops exact bodies on release and bounds tombstones', async () => {
    let now = 0;
    const value = coordinator({
      now: () => now,
      maxGlobalTombstones: 1,
      maxTombstonesPerChild: 1,
      replayGraceMs: 30,
    });
    for (const queryId of ['query-1', 'query-2']) {
      const registered = value.register(request(queryId));
      const outcome = success(queryId);
      value.respond(queryId, registered.delivery.responseToken, JSON.stringify(outcome), outcome);
      await registered.result;
      value.release(queryId);
    }
    expect(value.getCountsForTests()).toEqual({ live: 0, tombstones: 1 });
    now = 31;
    expect(value.getCountsForTests()).toEqual({ live: 0, tombstones: 0 });
  });

  it('expires tombstones with its bounded timer without another coordinator operation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const value = coordinator({ now: Date.now, replayGraceMs: 30 });
    const registered = value.register(request('query-timer'));
    const outcome = success('query-timer');
    value.respond(
      'query-timer',
      registered.delivery.responseToken,
      JSON.stringify(outcome),
      outcome,
    );
    await registered.result;
    value.release('query-timer');
    expect(value.peekCountsForTests()).toEqual({ live: 0, tombstones: 1 });

    await vi.advanceTimersByTimeAsync(31);

    expect(value.peekCountsForTests()).toEqual({ live: 0, tombstones: 0 });
  });
});
