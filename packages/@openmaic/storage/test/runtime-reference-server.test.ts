import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test } from 'vitest';
import { BrowserRuntimeStore } from '../src/runtime/browser.js';
import { HttpRuntimeStore } from '../src/runtime/http.js';
import type { RuntimeStore } from '../src/runtime/types.js';
import { createRuntimeHttpHandler } from '../src/server/index.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

const BASE_URL = 'http://runtime-reference.invalid';

function handlerFetch(
  handler: RequestListener,
  authorizationFor: (request: Request) => Promise<string | undefined>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = await authorizationFor(request);
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    if (authorization !== undefined) headers.authorization = authorization;

    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== '') yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;

    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      let responseHeaders: Record<string, string> = {};
      let responseBody: string | undefined;
      let headersSent = false;
      const fakeResponse = {
        get headersSent() {
          return headersSent;
        },
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus;
          responseHeaders = nextHeaders ?? {};
          headersSent = true;
          return this;
        },
        end(chunk?: string | Buffer) {
          responseBody = chunk === undefined ? undefined : chunk.toString();
          resolve(
            new Response(status === 204 ? null : responseBody, {
              status,
              headers: responseHeaders,
            }),
          );
          return this;
        },
        destroy(error?: Error) {
          reject(error ?? new Error('response destroyed'));
          return this;
        },
      } as unknown as ServerResponse;

      try {
        handler(fakeRequest, fakeResponse);
      } catch (error) {
        reject(error);
      }
    });
  };
}

function bearerLearner(req: IncomingMessage): { learnerKey: string } | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return undefined;
  const learnerKey = authorization.slice('Bearer '.length);
  return learnerKey === '' ? undefined : { learnerKey };
}

async function contractCredential(request: Request, store: RuntimeStore): Promise<string> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'POST' && path === '/runtime/sessions') {
    const body = (await request.clone().json()) as { learnerKey: string };
    return `Bearer ${body.learnerKey || 'invalid-envelope'}`;
  }
  const listedLearner = path.match(/^\/runtime\/stages\/[^/]+\/learners\/([^/]+)/)?.[1];
  if (listedLearner !== undefined) return `Bearer ${decodeURIComponent(listedLearner)}`;
  const sessionId = path.match(/^\/runtime\/sessions\/([^/]+)/)?.[1];
  if (sessionId !== undefined) {
    const session = await store.getSession(decodeURIComponent(sessionId));
    if (session !== undefined) return `Bearer ${session.learnerKey}`;
  }
  return 'Bearer contract-operator';
}

runRuntimeStoreContract('reference HTTP handler', () => {
  const backingStore = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
  const handler = createRuntimeHttpHandler(backingStore, {
    authenticate: async (req) => bearerLearner(req),
    authorizeMerge: async () => true,
    // The shared contract includes deleteAllRuntime, so this explicitly grants
    // its test-only operator principal access to the admin route.
    authorizeAdmin: async () => true,
  });
  return new HttpRuntimeStore({
    baseUrl: BASE_URL,
    fetch: handlerFetch(handler, (request) => contractCredential(request, backingStore)),
  });
});

describe('reference HTTP handler DELETE /runtime authorization', () => {
  function makeHarness() {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async (req) => bearerLearner(req),
      authorizeAdmin: async (principal) => principal.learnerKey === 'admin',
    });
    const request = (authorization?: string) =>
      handlerFetch(handler, async () => authorization)(`${BASE_URL}/runtime`, {
        method: 'DELETE',
      });
    return { request, store };
  }

  test('denies a learner credential with 403', async () => {
    const { request } = makeHarness();
    const response = await request('Bearer learner-1');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_ADMIN' },
    });
  });

  test('denies a missing credential with 401', async () => {
    const { request } = makeHarness();
    const response = await request();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  test('allows an admin credential and empties the runtime store', async () => {
    const { request, store } = makeHarness();
    await store.createSession(makeSession({ id: 'stage-1-session' }));
    await store.appendRecord(makeRecordInit('stage-1-session'));
    await store.createSession(makeSession({ id: 'stage-2-session', stageId: 'stage-2' }));

    const response = await request('Bearer admin');

    expect(response.status).toBe(204);
    expect(await store.getSession('stage-1-session')).toBeUndefined();
    expect(await store.getSession('stage-2-session')).toBeUndefined();
    expect(await store.listRecords('stage-1-session')).toEqual([]);
  });
});
