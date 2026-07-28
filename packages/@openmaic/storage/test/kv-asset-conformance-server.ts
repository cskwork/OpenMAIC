// Test-only HTTP adapter implementing the KV and asset HTTP contracts, so the
// shared contract suites can run against the real clients over a real request /
// response boundary. It keeps its state in memory: the server-side Postgres and
// filesystem/object-storage backends are a separate part, and this file must
// not quietly become one.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { assertJsonValue } from '../src/runtime/json-value.js';
import { assetRefForBytes, isContentAssetRef } from '../src/asset/content-ref.js';

/** How the server chooses to hand back a loadable URL from `resolve`. */
export type AssetResolveMode = 'proxy' | 'signed';

export interface KvAssetConformanceServer {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export interface KvAssetConformanceServerOptions {
  /** Bind a loopback TCP port. Tests can disable this in network-restricted sandboxes. */
  listen?: boolean;
  /**
   * `proxy` returns a root-relative path this server also serves; `signed`
   * returns an absolute, single-use URL. Both deployment shapes have to satisfy
   * the same contract.
   */
  resolveMode?: AssetResolveMode;
}

interface StoredAsset {
  bytes: Buffer;
  contentType: string;
}

interface Namespace {
  assets: Map<string, StoredAsset>;
  kv: Map<string, string>;
}

class ConformanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConformanceHttpError) {
    return { status: error.status, body: { error: { code: error.code, message } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } };
}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBytes(req);
  if (raw.length === 0) {
    throw new ConformanceHttpError(400, 'VALIDATION_FAILED', 'request body must be a JSON object');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConformanceHttpError(400, 'VALIDATION_FAILED', message);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConformanceHttpError(400, 'VALIDATION_FAILED', 'request body must be a JSON object');
  }
  return body as T;
}

function assertAddressableSegment(value: string): void {
  if (value === '.' || value === '..') {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: URL path segment must not be ${JSON.stringify(value)}`,
    );
  }
}

function routeNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'route not found' } });
}

function pathParts(req: IncomingMessage): { parts: string[]; url: URL } {
  const url = new URL(req.url ?? '/', 'http://conformance.invalid');
  const parts = url.pathname.split('/');
  if (parts[0] === '') parts.shift();
  return { parts: parts.map((part) => decodeURIComponent(part)), url };
}

async function routeAssets(
  req: IncomingMessage,
  res: ServerResponse,
  state: Namespace,
  parts: string[],
  url: URL,
  baseUrl: string,
  resolveMode: AssetResolveMode,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (parts.length < 2) return false;
  const ref = parts[1]!;
  assertAddressableSegment(ref);

  if (method === 'PUT' && parts.length === 2) {
    // Content addressing is enforced here, not merely assumed: the ref in the
    // path must be the hash of the bytes that arrived, so no client (or proxy,
    // or retry) can bind arbitrary bytes to someone else's ref.
    if (!isContentAssetRef(ref)) {
      throw new ConformanceHttpError(
        400,
        'VALIDATION_FAILED',
        `@openmaic/storage: asset ref ${JSON.stringify(ref)} must be sha256-<64 lowercase hex>`,
      );
    }
    const bytes = await readBytes(req);
    const view = new Uint8Array(bytes);
    const computed = await assetRefForBytes(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    );
    if (computed !== ref) {
      throw new ConformanceHttpError(
        400,
        'ASSET_REF_MISMATCH',
        `@openmaic/storage: asset bytes hash to ${JSON.stringify(computed)}, not to the ` +
          `requested ref ${JSON.stringify(ref)}`,
      );
    }
    const header = req.headers['content-type'];
    state.assets.set(ref, {
      bytes,
      contentType: typeof header === 'string' ? header : 'application/octet-stream',
    });
    sendNoContent(res);
    return true;
  }

  if (method === 'GET' && parts.length === 3 && parts[2] === 'url') {
    if (!state.assets.has(ref)) {
      throw new ConformanceHttpError(
        404,
        'ASSET_NOT_FOUND',
        `@openmaic/storage: no asset ${JSON.stringify(ref)}`,
      );
    }
    const path = `/assets/${encodeURIComponent(ref)}/content`;
    // A distinct nonce per call is what makes the signed shape a real test of
    // resolve()'s in-flight coalescing: two uncoalesced calls would visibly
    // return different URLs.
    const signed = `${baseUrl}${path}?token=${Math.random().toString(36).slice(2)}`;
    sendJson(res, 200, { url: resolveMode === 'signed' ? signed : path });
    return true;
  }

  if (method === 'GET' && parts.length === 3 && parts[2] === 'content') {
    const asset = state.assets.get(ref);
    if (!asset) {
      throw new ConformanceHttpError(
        404,
        'ASSET_NOT_FOUND',
        `@openmaic/storage: no asset ${JSON.stringify(ref)}`,
      );
    }
    if (resolveMode === 'signed' && url.searchParams.get('token') === null) {
      throw new ConformanceHttpError(
        403,
        'FORBIDDEN_ASSETS',
        '@openmaic/storage: asset content requires a signed url',
      );
    }
    res.writeHead(200, { 'content-type': asset.contentType });
    res.end(asset.bytes);
    return true;
  }

  if (method === 'DELETE' && parts.length === 2) {
    state.assets.delete(ref);
    sendNoContent(res);
    return true;
  }

  return false;
}

async function routeKv(
  req: IncomingMessage,
  res: ServerResponse,
  state: Namespace,
  parts: string[],
  url: URL,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (method === 'GET' && parts.length === 2 && parts[1] === 'keys') {
    const prefix = url.searchParams.get('prefix') ?? '';
    sendJson(
      res,
      200,
      [...state.kv.keys()].filter((key) => key.startsWith(prefix)),
    );
    return true;
  }

  if (parts.length === 3 && parts[1] === 'entries') {
    const key = parts[2]!;
    assertAddressableSegment(key);

    if (method === 'GET') {
      const raw = state.kv.get(key);
      if (raw === undefined) {
        throw new ConformanceHttpError(
          404,
          'KEY_NOT_FOUND',
          `@openmaic/storage: no kv entry ${JSON.stringify(key)}`,
        );
      }
      sendJson(res, 200, { value: JSON.parse(raw) as unknown });
      return true;
    }
    if (method === 'PUT') {
      const body = await readJson<{ value?: unknown }>(req);
      if (!('value' in body)) {
        throw new ConformanceHttpError(
          400,
          'VALIDATION_FAILED',
          '@openmaic/storage: kv write body must carry "value"',
        );
      }
      // The wire has no scope field at all; a body that invents one is a client
      // trying to describe a scope this contract does not have.
      if ('scope' in body) {
        throw new ConformanceHttpError(
          400,
          'VALIDATION_FAILED',
          '@openmaic/storage: kv write body must not carry a scope — this contract is ' +
            'account-scoped and the principal is derived server-side',
        );
      }
      try {
        assertJsonValue(body.value, `kv value for key ${JSON.stringify(key)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ConformanceHttpError(400, 'VALIDATION_FAILED', message);
      }
      state.kv.set(key, JSON.stringify(body.value));
      sendNoContent(res);
      return true;
    }
    if (method === 'DELETE') {
      state.kv.delete(key);
      sendNoContent(res);
      return true;
    }
  }

  return false;
}

/**
 * Start a test-only HTTP adapter. Each `x-storage-namespace` value selects a
 * fresh in-memory namespace, so factories used by the shared contract suites
 * stay isolated. It implements no authentication or authorization model;
 * deriving the principal from an authenticated session belongs to the reference
 * server.
 */
export async function startKvAssetConformanceServer(
  options: KvAssetConformanceServerOptions = {},
): Promise<KvAssetConformanceServer> {
  const namespaces = new Map<string, Namespace>();
  const resolveMode = options.resolveMode ?? 'proxy';
  const stateFor = (req: IncomingMessage): Namespace => {
    const id = req.headers['x-storage-namespace'];
    const name = typeof id === 'string' && id !== '' ? id : 'default';
    let state = namespaces.get(name);
    if (!state) {
      state = { assets: new Map(), kv: new Map() };
      namespaces.set(name, state);
    }
    return state;
  };

  let baseUrl = 'http://kv-asset-conformance.invalid';

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { parts, url } = pathParts(req);
    const state = stateFor(req);
    if (parts[0] === 'assets') {
      if (await routeAssets(req, res, state, parts, url, baseUrl, resolveMode)) return;
    } else if (parts[0] === 'kv') {
      if (await routeKv(req, res, state, parts, url)) return;
    }
    routeNotFound(res);
  };

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      const mapped = errorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    });
  });

  if (options.listen !== false) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('KV/asset conformance server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  const injectedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const requestBody = Buffer.from(await request.arrayBuffer());
    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      async *[Symbol.asyncIterator]() {
        if (requestBody.length > 0) yield requestBody;
      },
    } as unknown as IncomingMessage;

    let status = 200;
    let responseHeaders: Record<string, string> = {};
    let responseBody: string | Uint8Array<ArrayBuffer> | undefined;
    const fakeResponse = {
      writeHead(nextStatus: number, headers?: Record<string, string>) {
        status = nextStatus;
        responseHeaders = headers ?? {};
        return this;
      },
      end(chunk?: string | Buffer) {
        // Copy into a plain Uint8Array: a Node `Buffer` is one structurally but
        // does not satisfy `BodyInit` under the DOM lib's narrowing.
        responseBody =
          typeof chunk === 'string' || chunk === undefined ? chunk : new Uint8Array(chunk);
        return this;
      },
    } as unknown as ServerResponse;

    try {
      await route(fakeRequest, fakeResponse);
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
