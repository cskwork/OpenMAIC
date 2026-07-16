import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import type { RuntimeRecordInit, RuntimeSessionStatus } from '@openmaic/dsl';
import { BrowserRuntimeStore } from '../src/runtime/browser.js';
import type { RuntimeSessionInit, RuntimeStore } from '../src/runtime/types.js';

export interface HttpConformanceServer {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export interface HttpConformanceServerOptions {
  /** Bind a loopback TCP port. Tests can disable this in network-restricted sandboxes. */
  listen?: boolean;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) throw new Error('request body must be JSON');
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function errorResponse(error: unknown): { status: number; body: ErrorBody } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError) {
    return { status: 400, body: { error: { code: 'VALIDATION_FAILED', message } } };
  }
  if (/newer than this client's/i.test(message)) {
    return { status: 409, body: { error: { code: 'FUTURE_VERSION', message } } };
  }
  if (/already exists/i.test(message)) {
    return { status: 409, body: { error: { code: 'SESSION_ALREADY_EXISTS', message } } };
  }
  if (/no session/i.test(message)) {
    return { status: 404, body: { error: { code: 'SESSION_NOT_FOUND', message } } };
  }
  if (
    /invalid|must be|may only be appended|non-empty|request body|unexpected|does not match/i.test(
      message,
    )
  ) {
    return { status: 400, body: { error: { code: 'VALIDATION_FAILED', message } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } };
}

function pathParts(req: IncomingMessage): { parts: string[]; url: URL } {
  const url = new URL(req.url ?? '/', 'http://conformance.invalid');
  return {
    parts: url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part)),
    url,
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: RuntimeStore,
): Promise<void> {
  const { parts, url } = pathParts(req);
  const method = req.method ?? 'GET';

  if (parts[0] !== 'runtime') {
    sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'route not found' } });
    return;
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'sessions') {
    const init = await readJson<RuntimeSessionInit & { runtimeDslVersion?: unknown }>(req);
    if (Object.hasOwn(init, 'runtimeDslVersion')) {
      throw new Error('invalid runtime session: request body must not include runtimeDslVersion');
    }
    sendJson(res, 201, await store.createSession(init));
    return;
  }

  if (parts[1] === 'sessions' && parts.length >= 3) {
    const sessionId = parts[2]!;
    if (method === 'GET' && parts.length === 3) {
      const session = await store.getSession(sessionId);
      if (session === undefined) {
        sendJson(res, 404, {
          error: {
            code: 'SESSION_NOT_FOUND',
            message: `@openmaic/storage: no session ${JSON.stringify(sessionId)}`,
          },
        });
      } else {
        sendJson(res, 200, session);
      }
      return;
    }
    if (method === 'PATCH' && parts.length === 4 && parts[3] === 'status') {
      const body = await readJson<{ status: RuntimeSessionStatus; updatedAt: string }>(req);
      await store.setSessionStatus(sessionId, body.status, body.updatedAt);
      sendNoContent(res);
      return;
    }
    if (method === 'DELETE' && parts.length === 3) {
      await store.deleteSession(sessionId);
      sendNoContent(res);
      return;
    }
    if (method === 'POST' && parts.length === 4 && parts[3] === 'records') {
      const init = await readJson<RuntimeRecordInit & { seq?: unknown }>(req);
      if (Object.hasOwn(init, 'seq')) {
        throw new Error('invalid runtime record: append request body must not include seq');
      }
      if (init.sessionId !== sessionId) {
        throw new Error('invalid runtime record: body sessionId does not match the request path');
      }
      sendJson(res, 201, await store.appendRecord(init));
      return;
    }
    if (method === 'GET' && parts.length === 4 && parts[3] === 'records') {
      const sceneId = url.searchParams.get('sceneId');
      sendJson(
        res,
        200,
        await store.listRecords(sessionId, sceneId === null ? undefined : { sceneId }),
      );
      return;
    }
  }

  if (
    parts[1] === 'stages' &&
    parts.length === 6 &&
    parts[3] === 'learners' &&
    parts[5] === 'sessions' &&
    method === 'GET'
  ) {
    sendJson(res, 200, await store.listSessions(parts[2]!, parts[4]!));
    return;
  }

  if (parts[1] === 'learners' && parts[2] === 'merge' && parts.length === 3 && method === 'POST') {
    const body = await readJson<{ fromLearnerKey: string; toLearnerKey: string }>(req);
    sendJson(res, 200, {
      moved: await store.mergeLearner(body.fromLearnerKey, body.toLearnerKey),
    });
    return;
  }

  if (
    parts[1] === 'stages' &&
    parts.length === 5 &&
    parts[3] === 'learners' &&
    method === 'DELETE'
  ) {
    await store.deleteLearnerRuntime(parts[2]!, parts[4]!);
    sendNoContent(res);
    return;
  }

  if (parts[1] === 'stages' && parts.length === 3 && method === 'DELETE') {
    await store.deleteStageRuntime(parts[2]!);
    sendNoContent(res);
    return;
  }

  sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'route not found' } });
}

/**
 * Start a test-only HTTP adapter. Each `x-runtime-store-id` value selects a
 * fresh BrowserRuntimeStore so factories used by the shared contract remain
 * isolated without duplicating any persistence logic in this server.
 */
export async function startHttpConformanceServer(
  options: HttpConformanceServerOptions = {},
): Promise<HttpConformanceServer> {
  const stores = new Map<string, RuntimeStore>();
  const storeFor = (req: IncomingMessage): RuntimeStore => {
    const id = req.headers['x-runtime-store-id'];
    const namespace = typeof id === 'string' && id !== '' ? id : 'default';
    let store = stores.get(namespace);
    if (!store) {
      store = new BrowserRuntimeStore({
        indexedDB: new IDBFactory(),
        dbName: `http-runtime-${namespace}`,
      });
      stores.set(namespace, store);
    }
    return store;
  };

  const server = createServer((req, res) => {
    void route(req, res, storeFor(req)).catch((error: unknown) => {
      const mapped = errorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    });
  });

  let baseUrl = 'http://runtime-conformance.invalid';
  if (options.listen !== false) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('HTTP conformance server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  const injectedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const requestBody = await request.text();
    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      async *[Symbol.asyncIterator]() {
        if (requestBody !== '') yield Buffer.from(requestBody);
      },
    } as unknown as IncomingMessage;

    let status = 200;
    let responseHeaders: Record<string, string> = {};
    let responseBody: string | undefined;
    const fakeResponse = {
      writeHead(nextStatus: number, headers?: Record<string, string>) {
        status = nextStatus;
        responseHeaders = headers ?? {};
        return this;
      },
      end(chunk?: string) {
        responseBody = chunk;
        return this;
      },
    } as unknown as ServerResponse;

    try {
      await route(fakeRequest, fakeResponse, storeFor(fakeRequest));
    } catch (error) {
      const mapped = errorResponse(error);
      status = mapped.status;
      responseHeaders = { 'content-type': 'application/json' };
      responseBody = JSON.stringify(mapped.body);
    }
    return new Response(status === 204 ? null : responseBody, {
      status,
      headers: responseHeaders,
    });
  };

  return {
    baseUrl,
    fetch: injectedFetch,
    close: () =>
      server.listening
        ? new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
        : Promise.resolve(),
  };
}
