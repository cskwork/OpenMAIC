// Test-only HTTP adapter implementing the KV HTTP contract, so the shared
// contract suite can run against the real client over a real request / response
// boundary. It keeps its state in memory: the server-side Postgres backend is a
// separate part, and this file must not quietly become one.
//
// It is a conformance harness, not a reference server. Its credential handling
// exists to exercise the contract's authentication and authorization responses;
// it is not an authentication model. Deriving a principal from an authenticated
// session belongs to the reference server.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { assertJsonValue } from '../src/runtime/json-value.js';

export interface KvConformanceServer {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export interface KvConformanceServerOptions {
  /** Bind a loopback TCP port. Tests can disable this in network-restricted sandboxes. */
  listen?: boolean;
  /** Request body ceiling; a larger body is rejected with `413`. */
  maxBodyBytes?: number;
  /** Return false to answer `401 UNAUTHENTICATED`. Defaults to allowing everything. */
  authenticate?: (req: IncomingMessage) => boolean;
  /** Return false to answer `403`. Defaults to allowing everything. */
  authorize?: (req: IncomingMessage, area: 'kv') => boolean;
}

/** One principal's view. The namespace header stands in for a principal. */
interface Namespace {
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

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

/**
 * The contract requires reads to be uncacheable, so the harness has to send the
 * header itself — otherwise the suite would pass against an implementation that
 * omits it, which is precisely the implementation the requirement exists to
 * catch.
 */
const NO_STORE = { 'cache-control': 'no-store' };

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof ConformanceHttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  // Never echo an internal failure's message: the contract's INTERNAL_ERROR row
  // promises the handler does not expose internal details.
  return {
    status: 500,
    body: {
      error: { code: 'INTERNAL_ERROR', message: '@openmaic/storage: internal server error' },
    },
  };
}

async function readBytes(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new ConformanceHttpError(
        413,
        'PAYLOAD_TOO_LARGE',
        `@openmaic/storage: request body exceeds ${maxBodyBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage, maxBodyBytes: number): Promise<T> {
  const raw = await readBytes(req, maxBodyBytes);
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

const MAX_IDENTIFIER_BYTES = 512;

/**
 * The server-side half of the contract's "a key is never structure" rule. Keys
 * arrive percent-decoded, so `a%2F..%2F..%2Fb` becomes something with separators
 * here; a backend that joined it to a path or interpolated it into a query would
 * inherit that. Reject the shape at the boundary so no later storage layer can be
 * the first to look.
 */
function assertAddressableKey(value: string, label: string): void {
  if (value === '') {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: ${label} must not be empty`,
    );
  }
  if (value === '.' || value === '..') {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: URL path segment must not be ${JSON.stringify(value)}`,
    );
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: ${label} ${JSON.stringify(value)} must not contain '/' or '\\'`,
    );
  }
  if (value.includes('\u0000')) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: ${label} must not contain the NUL code point`,
    );
  }
  if (/[\uD800-\uDFFF]/u.test(value)) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: ${label} must not contain an unpaired UTF-16 surrogate`,
    );
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: ${label} exceeds ${MAX_IDENTIFIER_BYTES} UTF-8 bytes (got ${bytes})`,
    );
  }
}

/**
 * A `keys()` prefix is not a path segment — it arrives in the query string — so
 * it is held to the key rules minus the two that only make sense for a segment:
 * it may be empty (that is what "list everything" means) and it may be `.` or
 * `..`, which are legal prefixes of legal keys such as `.hidden`. Reusing the
 * key validator here would reject prefixes the client rightly allows.
 */
function assertAddressablePrefix(prefix: string): void {
  if (prefix === '') return;
  if (prefix.includes('/') || prefix.includes('\\')) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: kv key prefix ${JSON.stringify(prefix)} must not contain '/' or '\\'`,
    );
  }
  if (prefix.includes('\u0000')) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: kv key prefix must not contain the NUL code point',
    );
  }
  if (/[\uD800-\uDFFF]/u.test(prefix)) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: kv key prefix must not contain an unpaired UTF-16 surrogate',
    );
  }
  const bytes = Buffer.byteLength(prefix, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: kv key prefix exceeds ${MAX_IDENTIFIER_BYTES} UTF-8 bytes (got ${bytes})`,
    );
  }
}

function routeNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'route not found' } });
}

function pathParts(req: IncomingMessage): { parts: string[]; url: URL } {
  const target = req.url ?? '/';
  const url = new URL(target, 'http://conformance.invalid');
  // Split the RAW request target, not `url.pathname`. The WHATWG parser resolves
  // dot segments before anything here can look, and it treats `%2e` as one — so
  // `/kv/entries/%2e%2e` arrives already collapsed, and a validator reading the
  // parsed path would be inspecting a request nobody sent. The rules exist to
  // reject what was *received*, so the segments come from the wire.
  const rawPath = target.split(/[?#]/, 1)[0] ?? '/';
  const rawParts = rawPath.split('/');
  if (rawParts[0] === '') rawParts.shift();
  const parts: string[] = [];
  for (const part of rawParts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      // A malformed escape (`%`, `%zz`, a surrogate encoding) is a bad request,
      // not a server fault; the native URIError would otherwise surface as the
      // contract's INTERNAL_ERROR row.
      throw new ConformanceHttpError(
        400,
        'VALIDATION_FAILED',
        '@openmaic/storage: request path is not valid percent-encoded UTF-8',
      );
    }
    parts.push(decoded);
  }
  return { parts, url };
}

/**
 * The contract has no scope anywhere on the wire, so a client that invents one
 * has to fail loud rather than have its intent silently discarded. That covers
 * every channel a scope could hide in, not just the body.
 */
function assertNoScopeChannel(req: IncomingMessage, url: URL): void {
  if (url.searchParams.has('scope')) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: kv requests must not carry a scope query parameter — this contract is ' +
        'account-scoped and the principal is derived server-side',
    );
  }
  if (req.headers['x-scope'] !== undefined) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: kv requests must not carry a scope header',
    );
  }
}

interface RouteContext {
  state: Namespace;
  parts: string[];
  url: URL;
  maxBodyBytes: number;
}

async function routeKv(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext,
): Promise<boolean> {
  const { state, parts, url, maxBodyBytes } = context;
  const method = req.method ?? 'GET';
  assertNoScopeChannel(req, url);

  if (method === 'GET' && parts.length === 2 && parts[1] === 'keys') {
    const prefix = url.searchParams.get('prefix') ?? '';
    // The prefix is caller-controlled and reaches the same place a key does, so
    // it is held to the same rules. A server trusting the client to have checked
    // is trusting a client it does not control.
    assertAddressablePrefix(prefix);
    // A literal, byte-for-byte prefix comparison. Spelled out because the
    // obvious SQL translation is `LIKE prefix || '%'`, where an unescaped `%`
    // or `_` in a caller-supplied prefix silently becomes a wildcard.
    sendJson(
      res,
      200,
      [...state.kv.keys()].filter((key) => key.startsWith(prefix)),
      NO_STORE,
    );
    return true;
  }

  if (parts.length === 3 && parts[1] === 'entries') {
    const key = parts[2]!;
    assertAddressableKey(key, 'kv key');

    if (method === 'GET') {
      const raw = state.kv.get(key);
      if (raw === undefined) {
        throw new ConformanceHttpError(
          404,
          'KEY_NOT_FOUND',
          `@openmaic/storage: no kv entry ${JSON.stringify(key)}`,
        );
      }
      sendJson(res, 200, { value: JSON.parse(raw) as unknown }, NO_STORE);
      return true;
    }
    if (method === 'PUT') {
      const body = await readJson<{ value?: unknown }>(req, maxBodyBytes);
      if (!('value' in body)) {
        throw new ConformanceHttpError(
          400,
          'VALIDATION_FAILED',
          '@openmaic/storage: kv write body must carry "value"',
        );
      }
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
      // A bodyless method, so a body is refused outright rather than parsed for
      // the scope it might be smuggling. Checking only the query and the header
      // left the body as the one channel a delete could still describe a scope
      // through, and a server that ignores it discards the caller's intent
      // exactly as silently as one that ignores a scope field on a write.
      const body = await readBytes(req, maxBodyBytes);
      if (body.length > 0) {
        throw new ConformanceHttpError(
          400,
          'VALIDATION_FAILED',
          '@openmaic/storage: DELETE must not carry a request body — this contract is ' +
            'account-scoped and the principal is derived server-side',
        );
      }
      state.kv.delete(key);
      sendNoContent(res);
      return true;
    }
  }

  return false;
}

/**
 * Start a test-only HTTP adapter. Each `x-storage-namespace` header selects a
 * fresh in-memory namespace, so factories used by the shared contract suite stay
 * isolated.
 */
export async function startKvConformanceServer(
  options: KvConformanceServerOptions = {},
): Promise<KvConformanceServer> {
  const namespaces = new Map<string, Namespace>();
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const authenticate = options.authenticate ?? (() => true);
  const authorize = options.authorize ?? (() => true);

  const namespaceFor = (name: string): Namespace => {
    let state = namespaces.get(name);
    if (!state) {
      state = { kv: new Map() };
      namespaces.set(name, state);
    }
    return state;
  };

  const namespaceNameFor = (req: IncomingMessage): string => {
    const header = req.headers['x-storage-namespace'];
    return typeof header === 'string' && header !== '' ? header : 'default';
  };

  let baseUrl = 'http://kv-conformance.invalid';

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { parts, url } = pathParts(req);
    if (parts[0] !== 'kv') {
      routeNotFound(res);
      return;
    }
    if (!authenticate(req)) {
      throw new ConformanceHttpError(
        401,
        'UNAUTHENTICATED',
        '@openmaic/storage: missing or invalid credential',
      );
    }
    if (!authorize(req, 'kv')) {
      throw new ConformanceHttpError(
        403,
        'FORBIDDEN_KV',
        '@openmaic/storage: principal may not perform this operation',
      );
    }
    const context: RouteContext = {
      state: namespaceFor(namespaceNameFor(req)),
      parts,
      url,
      maxBodyBytes,
    };
    if (!(await routeKv(req, res, context))) routeNotFound(res);
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
      throw new Error('KV conformance server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  const injectedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const requestBody = Buffer.from(await request.arrayBuffer());
    // Recover the raw request target when the caller passed a string. `Request`
    // normalizes dot segments — including `%2e` — exactly as `URL` does, so
    // building the target from the parsed URL would hide from this server the
    // very inputs a real client can put on the wire.
    const rawTarget =
      typeof input === 'string'
        ? input.slice(url.origin.length) || '/'
        : `${url.pathname}${url.search}`;
    const fakeRequest = {
      method: request.method,
      url: rawTarget,
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
