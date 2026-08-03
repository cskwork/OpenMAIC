import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserClientQueryRuntime } from '@/lib/agent/client/client-query-runtime';
import {
  CLIENT_QUERY_PROTOCOL_VERSION,
  type ClientQueryBrowserOutcome,
  type ClientQueryDelivery,
} from '@/lib/agent/runtime/client-query-contract';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import { setStageStoreStateThroughAuthority } from '@/tests/helpers/whiteboard-authority';

function stage(elements: Whiteboard['elements']): Stage {
  return {
    id: 'stage-1',
    name: 'Stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: [
      {
        id: 'board-1',
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        elements,
      },
    ],
  };
}

function delivery(
  query: ClientQueryDelivery['request']['query'],
  queryId = 'query-1',
): ClientQueryDelivery {
  return {
    responseToken: 'response-token',
    request: {
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
      args: {},
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
      query,
      activeQueryBudgetMs: 5_000,
    },
  };
}

afterEach(() => {
  useCanvasStore.getState().setWhiteboardOpen(false);
  useStageStore.getState().clearStore();
});

describe('BrowserClientQueryRuntime', () => {
  it('reads the current Authority state and never exposes raw media sources', async () => {
    setStageStoreStateThroughAuthority({
      stage: stage([
        {
          id: 'image-1',
          type: 'image',
          left: 1,
          top: 2,
          width: 3,
          height: 4,
          rotate: 0,
          fixedRatio: true,
          src: 'https://private.example/image.png',
        },
      ]),
      currentSceneId: 'scene-1',
    });
    const bodies: ClientQueryBrowserOutcome[] = [];
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as ClientQueryBrowserOutcome);
        return new Response('{}', { status: 200 });
      }),
      now: () => 100,
    });

    await runtime.execute(delivery({ scope: 'elements', startIndex: 0, limit: 64 }));

    expect(bodies).toEqual([
      expect.objectContaining({
        protocolVersion: CLIENT_QUERY_PROTOCOL_VERSION,
        outcome: 'succeeded',
        scope: 'elements',
        complete: true,
        data: {
          items: [expect.objectContaining({ id: 'image-1', type: 'image', hasSource: true })],
        },
      }),
    ]);
    expect(JSON.stringify(bodies)).not.toContain('private.example');
  });

  it('replays an exact cached body for duplicate delivery without recapturing', async () => {
    setStageStoreStateThroughAuthority({ stage: stage([]), currentSceneId: 'scene-1' });
    const bodies: string[] = [];
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (_input, init) => {
        bodies.push(String(init?.body));
        return new Response('{}', { status: 200 });
      }),
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });
    const event = delivery({ scope: 'summary' });

    await runtime.execute(event);
    useCanvasStore.getState().setWhiteboardOpen(true);
    await runtime.execute(event);

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('captures newer Authority state for a new query ID', async () => {
    setStageStoreStateThroughAuthority({ stage: stage([]), currentSceneId: 'scene-1' });
    const bodies: Array<Extract<ClientQueryBrowserOutcome, { outcome: 'succeeded' }>> = [];
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }),
    });

    await runtime.execute(delivery({ scope: 'summary' }, 'query-before'));
    useCanvasStore.getState().setWhiteboardOpen(true);
    await runtime.execute(delivery({ scope: 'summary' }, 'query-after'));

    expect(bodies.map((entry) => entry.open)).toEqual([false, true]);
    expect(bodies[1].revision).toBeGreaterThan(bodies[0].revision);
  });

  it('retries the exact response body once after response loss', async () => {
    setStageStoreStateThroughAuthority({ stage: stage([]), currentSceneId: 'scene-1' });
    const bodies: string[] = [];
    const fetchResponse = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        bodies.push(String(init?.body));
        throw new Error('response lost');
      })
      .mockImplementationOnce(async (_input, init) => {
        bodies.push(String(init?.body));
        return new Response('{}', { status: 200 });
      });
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse,
    });

    await runtime.execute(delivery({ scope: 'summary' }));

    expect(fetchResponse).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('does not retry after its bounded delivery signal aborts', async () => {
    setStageStoreStateThroughAuthority({ stage: stage([]), currentSceneId: 'scene-1' });
    const controller = new AbortController();
    const fetchResponse = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw new DOMException('Operation aborted', 'AbortError');
    });
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse,
    });

    await expect(
      runtime.execute(delivery({ scope: 'summary' }), controller.signal),
    ).rejects.toThrow('Operation aborted');
    expect(fetchResponse).toHaveBeenCalledOnce();
  });

  it('reports a delivery failure through the authenticated control path', async () => {
    setStageStoreStateThroughAuthority({ stage: stage([]), currentSceneId: 'scene-1' });
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse,
    });
    const event = delivery({ scope: 'summary' });

    await runtime.failDelivery(event, new Error('response delivery failed'));

    expect(fetchResponse).toHaveBeenCalledWith(
      '/api/chat/pi/client-queries/query-1/response',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'x-maic-client-query-response': 'response-token' },
      }),
    );
  });

  it('reads an authoritative empty board state without creating a board', async () => {
    const emptyStage: Stage = {
      id: 'stage-1',
      name: 'Stage',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [],
    };
    setStageStoreStateThroughAuthority({ stage: emptyStage, currentSceneId: 'scene-1' });
    let body!: Extract<ClientQueryBrowserOutcome, { outcome: 'succeeded'; scope: 'summary' }>;
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response('{}', { status: 200 });
      }),
    });

    await runtime.execute(delivery({ scope: 'summary' }));

    expect(body).toMatchObject({
      whiteboardId: null,
      open: false,
      data: { exists: false, elementCount: 0 },
    });
    expect(useStageStore.getState().stage?.whiteboard).toEqual([]);
  });

  it('returns a strict target-changed failure instead of stale state', async () => {
    setStageStoreStateThroughAuthority({ stage: stage([]), currentSceneId: 'scene-other' });
    let body!: ClientQueryBrowserOutcome;
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body)) as ClientQueryBrowserOutcome;
        return new Response('{}', { status: 200 });
      }),
    });

    await runtime.execute(delivery({ scope: 'summary' }));

    expect(body).toEqual({
      protocolVersion: CLIENT_QUERY_PROTOCOL_VERSION,
      queryId: 'query-1',
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      outcome: 'failed',
      error: { code: 'WHITEBOARD_QUERY_TARGET_CHANGED' },
    });
  });

  it('paginates code without splitting surrogate pairs', async () => {
    const content = '😀'.repeat(2_000);
    setStageStoreStateThroughAuthority({
      stage: stage([
        {
          id: 'code-1',
          type: 'code',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          rotate: 0,
          language: 'typescript',
          lines: [{ id: 'L1', content }],
        },
      ]),
      currentSceneId: 'scene-1',
    });
    let body!: Extract<ClientQueryBrowserOutcome, { outcome: 'succeeded'; scope: 'code' }>;
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response('{}', { status: 200 });
      }),
    });

    await runtime.execute(
      delivery({ scope: 'code', elementId: 'code-1', lineIndex: 0, startOffset: 0 }),
    );

    expect(body.complete).toBe(false);
    if (body.complete) throw new Error('Expected a paginated code observation.');
    expect(body.data.fragments[0].content.endsWith('\ud83d')).toBe(false);
    expect(body.nextPosition).toEqual({ lineIndex: 0, startOffset: 2_048 });
  });

  it('returns the frozen missing-code failure instead of a generic state error', async () => {
    setStageStoreStateThroughAuthority({ stage: stage([]), currentSceneId: 'scene-1' });
    let body!: ClientQueryBrowserOutcome;
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response('{}', { status: 200 });
      }),
    });

    await runtime.execute(
      delivery({ scope: 'code', elementId: 'missing-code', lineIndex: 0, startOffset: 0 }),
    );

    expect(body).toMatchObject({
      outcome: 'failed',
      error: { code: 'WHITEBOARD_CODE_ELEMENT_NOT_FOUND' },
    });
  });
});
