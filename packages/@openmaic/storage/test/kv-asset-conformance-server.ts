// Test-only HTTP adapter implementing the KV and asset HTTP contracts, so the
// shared contract suites can run against the real clients over a real request /
// response boundary. It keeps its state in memory: the server-side Postgres and
// filesystem/object-storage backends are a separate part, and this file must
// not quietly become one.
//
// It is a conformance harness, not a reference server. Its credential handling
// exists to exercise the contract's authentication and authorization responses
// (and, for the proxied asset shape, to prove the resolved URL is loadable with
// nothing but ambient browser credentials); it is not an authentication model.
// Deriving a principal from an authenticated session belongs to the reference
// server.
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
   * `proxy` returns a root-relative path this server also serves, authorized by
   * the session cookie a browser sends on its own; `signed` returns an absolute
   * URL bearing a short-lived token. Both deployment shapes have to satisfy the
   * same contract.
   */
  resolveMode?: AssetResolveMode;
  /** Lifetime of a minted signed-URL token. `0` produces already-expired tokens. */
  signedTtlMs?: number;
  /** Request body ceiling; a larger body is rejected with `413`. */
  maxBodyBytes?: number;
  /** Return false to answer `401 UNAUTHENTICATED`. Defaults to allowing everything. */
  authenticate?: (req: IncomingMessage) => boolean;
  /** Return false to answer `403`. Defaults to allowing everything. */
  authorize?: (req: IncomingMessage, area: 'assets' | 'kv') => boolean;
}

/**
 * Bytes are stored once per ref and shared, which is the whole point of content
 * addressing — and exactly the arrangement the claim model exists to make safe.
 */
interface SharedAsset {
  bytes: Buffer;
  /** Principals holding a claim, each with the media type it uploaded under. */
  claims: Map<string, string>;
}

/** One principal's view. The namespace header/cookie stands in for a principal. */
interface Namespace {
  kv: Map<string, string>;
}

interface SignedToken {
  ref: string;
  /** The principal the URL was minted for; a signed URL carries its own claim. */
  principal: string;
  /**
   * A signed URL identifies the object completely — that is what makes it
   * loadable by a browser carrying no credentials at all — so the namespace
   * travels in the minted token rather than in a header the media load could
   * never send.
   */
  namespace: string;
  expiresAt: number;
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

/**
 * Media types served back as themselves. Deliberately narrow: these are the
 * types a browser renders in an <img>/<audio>/<video> without being able to
 * execute anything. `image/svg+xml` is absent on purpose — it is a document
 * format, and serving one from the application's origin is a scripting
 * surface, not an image.
 */
const RENDERABLE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

const OPAQUE_MEDIA_TYPE = 'application/octet-stream';

/** Strip any parameters (`; charset=…`) and normalize for the allowlist check. */
function mediaTypeOf(header: string | undefined): string {
  if (typeof header !== 'string') return OPAQUE_MEDIA_TYPE;
  return header.split(';')[0]!.trim().toLowerCase();
}

const MAX_IDENTIFIER_BYTES = 512;

/**
 * The server-side half of the contract's "an identifier is never structure"
 * rule. Refs and keys arrive percent-decoded, so `..%2F..%2Fetc%2Fpasswd`
 * becomes a traversal here; a backend that joined it to a filesystem path or
 * interpolated it into a query would inherit that. Reject the shape at the
 * boundary so no later storage layer can be the first to look.
 */
function assertAddressableIdentifier(value: string, label: string): void {
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

function routeNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'route not found' } });
}

function pathParts(req: IncomingMessage): { parts: string[]; url: URL } {
  const url = new URL(req.url ?? '/', 'http://conformance.invalid');
  const parts = url.pathname.split('/');
  if (parts[0] === '') parts.shift();
  try {
    return { parts: parts.map((part) => decodeURIComponent(part)), url };
  } catch {
    // A malformed escape (`%`, `%zz`) is a bad request, not a server fault; the
    // native URIError would otherwise surface as the contract's 500 row.
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: request path is not valid percent-encoded UTF-8',
    );
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
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
  /** The principal, for the claim model. The namespace header/cookie stands in. */
  namespaceName: string;
  namespaceFor: (name: string) => Namespace;
  assets: Map<string, SharedAsset>;
  parts: string[];
  url: URL;
  baseUrl: string;
  resolveMode: AssetResolveMode;
  signedTtlMs: number;
  maxBodyBytes: number;
  tokens: Map<string, SignedToken>;
}

async function routeAssets(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext,
): Promise<boolean> {
  const { parts, url, baseUrl, resolveMode, signedTtlMs, maxBodyBytes, tokens, assets } = context;
  const principal = context.namespaceName;
  const method = req.method ?? 'GET';
  if (parts.length < 2) return false;
  const ref = parts[1]!;
  assertAddressableIdentifier(ref, 'asset ref');

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
    const bytes = await readBytes(req, maxBodyBytes);
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
    const mediaType = mediaTypeOf(req.headers['content-type']);
    const existing = assets.get(ref);
    if (existing) {
      // Bytes are already here (content addressing guarantees they are the same
      // bytes). What the PUT establishes is this principal's claim, and the
      // media type it filed them under — per principal, so re-uploading cannot
      // rewrite what anyone else's document resolves to.
      existing.claims.set(principal, mediaType);
    } else {
      assets.set(ref, { bytes, claims: new Map([[principal, mediaType]]) });
    }
    sendNoContent(res);
    return true;
  }

  if (method === 'GET' && parts.length === 3 && parts[2] === 'url') {
    // Holding no claim is indistinguishable from the asset not existing:
    // knowing a ref is not authorization, so a ref copied out of a shared
    // document does not read back someone else's asset.
    if (!assets.get(ref)?.claims.has(principal)) {
      throw new ConformanceHttpError(
        404,
        'ASSET_NOT_FOUND',
        `@openmaic/storage: no asset ${JSON.stringify(ref)}`,
      );
    }
    const path = `/assets/${encodeURIComponent(ref)}/content`;
    if (resolveMode === 'proxy') {
      sendJson(res, 200, { url: path });
      return true;
    }
    // A distinct token per call is also what makes the signed shape a real test
    // of resolve()'s in-flight coalescing: two uncoalesced calls would visibly
    // return different URLs.
    const token = `tok-${tokens.size}-${Math.random().toString(36).slice(2)}`;
    tokens.set(token, {
      ref,
      principal,
      namespace: principal,
      expiresAt: Date.now() + signedTtlMs,
    });
    sendJson(res, 200, { url: `${baseUrl}${path}?token=${encodeURIComponent(token)}` });
    return true;
  }

  if (method === 'GET' && parts.length === 3 && parts[2] === 'content') {
    let claimant = principal;
    if (resolveMode === 'signed') {
      // Validate the token for real. A server that only checked for presence
      // would let any string through, and the contract's "short-lived" promise
      // would be untested decoration.
      const token = url.searchParams.get('token');
      const minted = token === null ? undefined : tokens.get(token);
      if (minted === undefined || minted.ref !== ref || minted.expiresAt <= Date.now()) {
        throw new ConformanceHttpError(
          403,
          'FORBIDDEN_ASSETS',
          '@openmaic/storage: asset content requires a valid, unexpired signed url',
        );
      }
      claimant = minted.principal;
    } else if (cookieValue(req, 'session') === undefined) {
      // The proxied shape is only sound where the browser can authenticate the
      // media load by itself. A media element sends cookies, never the client's
      // headers hook, so this route accepts exactly what a browser would send.
      throw new ConformanceHttpError(
        401,
        'UNAUTHENTICATED',
        '@openmaic/storage: proxied asset content requires a session cookie',
      );
    }
    const asset = assets.get(ref);
    const mediaType = asset?.claims.get(claimant);
    if (!asset || mediaType === undefined) {
      throw new ConformanceHttpError(
        404,
        'ASSET_NOT_FOUND',
        `@openmaic/storage: no asset ${JSON.stringify(ref)}`,
      );
    }
    // Only an allowlisted type is served as itself. Anything else — including
    // the octet-stream a metadata-less upload lands on — is served opaquely and
    // marked as a download, so a `text/html` upload cannot come back as a
    // document in the application's own origin.
    const renderable = RENDERABLE_MEDIA_TYPES.has(mediaType);
    res.writeHead(200, {
      'content-type': renderable ? mediaType : OPAQUE_MEDIA_TYPE,
      // The stored type is caller-influenced, so the browser must not be able to
      // sniff its way to a different one.
      'x-content-type-options': 'nosniff',
      ...(renderable ? {} : { 'content-disposition': 'attachment' }),
    });
    res.end(asset.bytes);
    return true;
  }

  if (method === 'DELETE' && parts.length === 2) {
    const asset = assets.get(ref);
    if (asset) {
      asset.claims.delete(principal);
      // Reclaim the bytes once nobody holds a claim. Until then one principal's
      // delete must not break another principal's document.
      if (asset.claims.size === 0) assets.delete(ref);
    }
    sendNoContent(res);
    return true;
  }

  return false;
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
    // A literal, byte-for-byte prefix comparison. Spelled out because the
    // obvious SQL translation is `LIKE prefix || '%'`, where an unescaped `%`
    // or `_` in a caller-supplied prefix silently becomes a wildcard.
    sendJson(
      res,
      200,
      [...state.kv.keys()].filter((key) => key.startsWith(prefix)),
    );
    return true;
  }

  if (parts.length === 3 && parts[1] === 'entries') {
    const key = parts[2]!;
    assertAddressableIdentifier(key, 'kv key');

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
      state.kv.delete(key);
      sendNoContent(res);
      return true;
    }
  }

  return false;
}

/**
 * Start a test-only HTTP adapter. Each `x-storage-namespace` header (or
 * `session` cookie, which is all a browser media load can send) selects a fresh
 * in-memory namespace, so factories used by the shared contract suites stay
 * isolated.
 */
export async function startKvAssetConformanceServer(
  options: KvAssetConformanceServerOptions = {},
): Promise<KvAssetConformanceServer> {
  const namespaces = new Map<string, Namespace>();
  // Bytes are shared across principals by ref; claims live inside each entry.
  const assets = new Map<string, SharedAsset>();
  const tokens = new Map<string, SignedToken>();
  const resolveMode = options.resolveMode ?? 'proxy';
  const signedTtlMs = options.signedTtlMs ?? 60_000;
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
    const id = typeof header === 'string' && header !== '' ? header : cookieValue(req, 'session');
    return id === undefined || id === '' ? 'default' : id;
  };

  let baseUrl = 'http://kv-asset-conformance.invalid';

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { parts, url } = pathParts(req);
    const area = parts[0] === 'assets' ? 'assets' : parts[0] === 'kv' ? 'kv' : undefined;
    if (area === undefined) {
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
    if (!authorize(req, area)) {
      throw new ConformanceHttpError(
        403,
        area === 'assets' ? 'FORBIDDEN_ASSETS' : 'FORBIDDEN_KV',
        '@openmaic/storage: principal may not perform this operation',
      );
    }
    const namespaceName = namespaceNameFor(req);
    const context: RouteContext = {
      state: namespaceFor(namespaceName),
      namespaceName,
      namespaceFor,
      assets,
      parts,
      url,
      baseUrl,
      resolveMode,
      signedTtlMs,
      maxBodyBytes,
      tokens,
    };
    const handled =
      area === 'assets' ? await routeAssets(req, res, context) : await routeKv(req, res, context);
    if (!handled) routeNotFound(res);
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
