import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, POST } from '@/app/api/chat/pi/client-queries/[queryId]/response/route';
import {
  CLIENT_QUERY_PROTOCOL_VERSION,
  CLIENT_QUERY_RESPONSE_HEADER,
  type ClientQueryBrowserOutcome,
  type ClientQueryRequest,
} from '@/lib/agent/runtime/client-query-contract';
import { piClientQueryCoordinator } from '@/lib/agent/runtime/client-query-coordinator';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

const runtimeFlag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME';
const whiteboardFlag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD';
let originalRuntimeFlag: string | undefined;
let originalWhiteboardFlag: string | undefined;

function queryRequest(queryId: string): ClientQueryRequest {
  const now = Date.now();
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    kind: 'client_query',
    traceId: 'trace-1',
    runId: 'run-1',
    agentInvocationId: 'child-1',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: `tool-${queryId}`,
    executionId: queryId,
    idempotencyKey: `idem-${queryId}`,
    toolName: 'wb_read',
    args: { scope: 'summary' },
    argsDigest: 'sha256:test',
    issuedAt: now,
    deadlineAt: now + 10_000,
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
    revision: 0,
    open: false,
    capturedAt: 1,
    scope: 'summary',
    complete: true,
    data: { exists: false, elementCount: 0, typeCounts: {} },
  };
}

function responseRequest(
  queryId: string,
  token: string,
  body: string,
  origin = 'http://localhost',
) {
  return new NextRequest(`http://localhost/api/chat/pi/client-queries/${queryId}/response`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      [CLIENT_QUERY_RESPONSE_HEADER]: token,
    },
    body,
  });
}

function post(request: NextRequest, queryId: string) {
  return POST(request, { params: Promise.resolve({ queryId }) });
}

function reportDeliveryFailure(queryId: string, token: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/chat/pi/client-queries/${queryId}/response`, {
      method: 'DELETE',
      headers: {
        origin: 'http://localhost',
        [CLIENT_QUERY_RESPONSE_HEADER]: token,
      },
    }),
    { params: Promise.resolve({ queryId }) },
  );
}

describe('client query response route', () => {
  beforeEach(() => {
    originalRuntimeFlag = process.env[runtimeFlag];
    originalWhiteboardFlag = process.env[whiteboardFlag];
    process.env[runtimeFlag] = 'true';
    process.env[whiteboardFlag] = 'true';
  });

  afterEach(() => {
    piClientQueryCoordinator.clearForTests();
    if (originalRuntimeFlag === undefined) delete process.env[runtimeFlag];
    else process.env[runtimeFlag] = originalRuntimeFlag;
    if (originalWhiteboardFlag === undefined) delete process.env[whiteboardFlag];
    else process.env[whiteboardFlag] = originalWhiteboardFlag;
  });

  it('authenticates and applies a strict same-origin browser outcome', async () => {
    const queryId = 'query-1';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));
    const raw = JSON.stringify(success(queryId));
    const response = await post(
      responseRequest(queryId, registered.delivery.responseToken, raw),
      queryId,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      disposition: 'applied',
      state: 'completed',
    });
    await expect(registered.result).resolves.toMatchObject({ status: 'query_completed' });
  });

  it('authenticates before parsing semantic data', async () => {
    const queryId = 'query-auth';
    piClientQueryCoordinator.register(queryRequest(queryId));
    const response = await post(responseRequest(queryId, 'wrong-token', '{broken'), queryId);

    expect(response.status).toBe(401);
  });

  it('rejects cross-origin and over-limit bodies before settlement', async () => {
    const queryId = 'query-envelope';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));
    const crossOrigin = await post(
      responseRequest(
        queryId,
        registered.delivery.responseToken,
        JSON.stringify(success(queryId)),
        'https://other.example',
      ),
      queryId,
    );
    const overLimit = new NextRequest(
      `http://localhost/api/chat/pi/client-queries/${queryId}/response`,
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          'content-length': String(49 * 1024),
          [CLIENT_QUERY_RESPONSE_HEADER]: registered.delivery.responseToken,
        },
        body: JSON.stringify(success(queryId)),
      },
    );

    expect(crossOrigin.status).toBe(403);
    expect((await post(overLimit, queryId)).status).toBe(413);
    expect(piClientQueryCoordinator.authorize(queryId, registered.delivery.responseToken)).toBe(
      'authorized',
    );
  });

  it('rejects wrong identity and strict-schema extensions without settling the query', async () => {
    const queryId = 'query-invalid';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));
    const invalid = { ...success(queryId), snapshotId: 'browser-must-not-mint-this' };
    const response = await post(
      responseRequest(queryId, registered.delivery.responseToken, JSON.stringify(invalid)),
      queryId,
    );

    expect(response.status).toBe(400);
    expect(piClientQueryCoordinator.authorize(queryId, registered.delivery.responseToken)).toBe(
      'authorized',
    );
  });

  it('accepts one exact-body replay and rejects a conflicting body', async () => {
    const queryId = 'query-replay';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));
    const raw = JSON.stringify(success(queryId));
    const first = await post(
      responseRequest(queryId, registered.delivery.responseToken, raw),
      queryId,
    );
    const replay = await post(
      responseRequest(queryId, registered.delivery.responseToken, raw),
      queryId,
    );
    const conflict = await post(
      responseRequest(queryId, registered.delivery.responseToken, `${raw} `),
      queryId,
    );
    const extraReplay = await post(
      responseRequest(queryId, registered.delivery.responseToken, raw),
      queryId,
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ disposition: 'duplicate' });
    expect(conflict.status).toBe(409);
    expect(extraReplay.status).toBe(409);
  });

  it('settles an authenticated delivery failure as a same-query terminal result', async () => {
    const queryId = 'query-delivery-failure';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));

    const response = await reportDeliveryFailure(queryId, registered.delivery.responseToken);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      disposition: 'applied',
      state: 'failed',
    });
    await expect(registered.result).resolves.toEqual({
      status: 'query_failed',
      code: 'CLIENT_QUERY_DELIVERY_FAILED',
    });
  });

  it('rejects an unauthenticated delivery-failure report without settling the query', async () => {
    const queryId = 'query-delivery-failure-auth';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));

    const response = await reportDeliveryFailure(queryId, 'wrong-token');

    expect(response.status).toBe(401);
    expect(piClientQueryCoordinator.authorize(queryId, registered.delivery.responseToken)).toBe(
      'authorized',
    );
  });

  it('accepts a first authenticated late body after cancellation without changing terminal state', async () => {
    const queryId = 'query-late';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));
    piClientQueryCoordinator.cancel(queryId);
    piClientQueryCoordinator.release(queryId);

    const response = await post(
      responseRequest(queryId, registered.delivery.responseToken, JSON.stringify(success(queryId))),
      queryId,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      disposition: 'late',
      state: 'cancelled',
    });
    await expect(registered.result).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('accepts the closed browser failure union without fabricated observation fields', async () => {
    const queryId = 'query-failure';
    const registered = piClientQueryCoordinator.register(queryRequest(queryId));
    const outcome: ClientQueryBrowserOutcome = {
      protocolVersion: CLIENT_QUERY_PROTOCOL_VERSION,
      queryId,
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      outcome: 'failed',
      error: { code: 'WHITEBOARD_AUTHORITY_UNAVAILABLE' },
    };
    const response = await post(
      responseRequest(queryId, registered.delivery.responseToken, JSON.stringify(outcome)),
      queryId,
    );

    expect(response.status).toBe(200);
    await expect(registered.result).resolves.toEqual({
      status: 'query_failed',
      outcome,
      code: 'WHITEBOARD_AUTHORITY_UNAVAILABLE',
    });
  });
});
