import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { assertJsonValue } from '../runtime/json-value.js';
import { computeAssetRef } from './content-ref.js';

export interface HttpAssetHeadersContext {
  method: string;
  path: string;
}

export type HttpAssetHeadersHook = (
  context: HttpAssetHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpAssetProviderOptions {
  /** Root URL before the contract's `/assets/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpAssetHeadersHook;
}

interface ErrorResponseBody {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

/** A server-side asset failure, retaining its machine-readable HTTP identity. */
export class HttpAssetProviderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpAssetProviderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The media type sent when the caller has no content type for the bytes. */
const UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

/** A URL carrying an explicit scheme, i.e. one this client must not rewrite. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Origin used only to ask the URL parser whether a relative reference stays on
 * the origin it was resolved against. Never fetched, and never returned.
 */
const PROBE_ORIGIN = 'https://asset-url-probe.invalid';

/**
 * Schemes a resolved asset URL may use. A ref resolves into something the
 * application hands to an `<img>` / `<audio>` / `<video>` `src`, so a server
 * (or anything that can answer for one) returning `javascript:` or `data:`
 * turns asset resolution into script execution in the app's own origin.
 */
const RESOLVABLE_SCHEMES = new Set(['http:', 'https:']);

/**
 * Upper bound on a ref, in UTF-8 bytes. Long past any digest, and the same
 * reasoning as the KV key bound: refs become URL segments and server-side keys.
 */
const MAX_ASSET_REF_BYTES = 512;

const UTF8 = new TextEncoder();

/**
 * Constrain a ref to something that survives a URL round trip and can never be
 * mistaken for structure by a server.
 *
 * The read path accepts refs this package did not issue (a document may carry a
 * ref from a future scheme), so shape is not enforced here — but safety is. `/`
 * and `\` are refused because a decoded ref must not be able to introduce a
 * path segment: `..%2F..%2Fetc%2Fpasswd` decodes to a traversal, and a server
 * that used the ref as a filename would inherit it.
 */
function assertAddressableRef(ref: string): void {
  // Rejects NUL and lone surrogates, the latter of which would otherwise make
  // encodeURIComponent throw a bare URIError instead of a storage error.
  assertJsonValue(ref, `asset ref ${JSON.stringify(ref)}`);
  if (ref === '') {
    throw new Error('@openmaic/storage: asset ref must not be empty');
  }
  if (ref === '.' || ref === '..') {
    throw new Error(`@openmaic/storage: URL path segment must not be ${JSON.stringify(ref)}`);
  }
  if (ref.includes('/') || ref.includes('\\')) {
    throw new Error(
      `@openmaic/storage: asset ref ${JSON.stringify(ref)} must not contain '/' or '\\'`,
    );
  }
  const bytes = UTF8.encode(ref).length;
  if (bytes > MAX_ASSET_REF_BYTES) {
    throw new Error(
      `@openmaic/storage: asset ref exceeds ${MAX_ASSET_REF_BYTES} UTF-8 bytes (got ${bytes})`,
    );
  }
}

function segment(value: string): string {
  assertAddressableRef(value);
  return encodeURIComponent(value);
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  const set = (name: string, value: string): void => {
    normalized[name.toLowerCase()] = value;
  };

  if (init === undefined) return normalized;
  if (Array.isArray(init)) {
    for (const [name, value] of init) set(name, value);
    return normalized;
  }
  if (typeof (init as Headers).forEach === 'function') {
    (init as Headers).forEach((value, name) => set(name, value));
    return normalized;
  }
  for (const [name, value] of Object.entries(init)) set(name, value);
  return normalized;
}

/**
 * `StorageProvider` client for the JSON HTTP asset contract.
 *
 * The ref is computed on the client from the bytes (the same rule every backend
 * uses) and *is* the address the bytes are written to, so content addressing is
 * an end-to-end property: the server re-hashes what it received and refuses a
 * body that does not match the ref in the path. Uploads are therefore
 * idempotent, and a ref minted by the browser backend addresses the same asset
 * here.
 */
export class HttpAssetProvider implements StorageProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersHook: HttpAssetHeadersHook | undefined;
  /**
   * ref → the in-flight resolution. Concurrent `resolve(ref)` calls share one
   * request and therefore one URL, matching `BrowserAssetProvider`. The entry is
   * dropped once it settles: unlike an object URL, a resolved HTTP URL may be a
   * short-lived signed URL, and handing back an expired one later would be
   * worse than asking the server again.
   */
  private readonly inFlight = new Map<AssetRef, Promise<string | null>>();

  constructor(options: HttpAssetProviderOptions) {
    if (options.baseUrl === '') {
      throw new Error('@openmaic/storage: HttpAssetProvider baseUrl must be non-empty');
    }
    // Bind explicitly: browsers require fetch to be invoked with
    // `this === globalThis` (calling a stored reference as `this.fetchImpl(...)`
    // throws "Illegal invocation"), while node's undici does not care — which is
    // exactly why node-only test suites cannot catch the unbound form.
    // Validate BEFORE binding: .bind on a non-function throws a native
    // TypeError that would preempt the documented error below.
    const selectedFetch = options.fetch ?? globalThis.fetch;
    if (typeof selectedFetch !== 'function') {
      throw new Error('@openmaic/storage: HttpAssetProvider requires a fetch implementation');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = selectedFetch.bind(globalThis);
    this.headersHook = options.headers;
  }

  private async send(
    method: string,
    path: string,
    init: { body?: BodyInit; contentType?: string } = {},
  ): Promise<Response> {
    const headers = normalizeHeaders(await this.headersHook?.({ method, path }));
    if (init.contentType !== undefined) {
      // On an upload the Content-Type is not transport decoration, it is the
      // asset's recorded media type. Letting an authentication hook win here
      // would silently mislabel stored bytes — an `image/png` filed as
      // `application/json` renders nowhere and there is nothing to notice. A
      // hook that sets it is misconfigured, so say so rather than pick a winner.
      if (headers['content-type'] !== undefined) {
        throw new HttpAssetProviderError(
          // No exchange happened, so there is no status to report.
          0,
          'CONTENT_TYPE_CONFLICT',
          '@openmaic/storage: the headers hook must not set Content-Type on an asset upload — ' +
            "it carries the asset's media type",
        );
      }
      headers['content-type'] = init.contentType;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (!response.ok) throw await this.toError(response);
    return response;
  }

  private async toError(response: Response): Promise<HttpAssetProviderError> {
    let errorBody: ErrorResponseBody | undefined;
    try {
      errorBody = (await response.json()) as ErrorResponseBody;
    } catch {
      // A non-conforming server still becomes a useful typed HTTP error.
    }
    const code = typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'HTTP_ERROR';
    const message =
      typeof errorBody?.error?.message === 'string'
        ? errorBody.error.message
        : `@openmaic/storage: asset HTTP request failed with status ${response.status}`;
    return new HttpAssetProviderError(response.status, code, message, errorBody?.error?.details);
  }

  private malformed(message: string, status: number): HttpAssetProviderError {
    return new HttpAssetProviderError(
      status,
      'MALFORMED_RESPONSE',
      `@openmaic/storage: ${message}`,
    );
  }

  /**
   * Validate a resolved URL and, when it is a path, join it to the base URL.
   *
   * Everything here is decided by *parsing*, not by inspecting the text. Text
   * checks are the wrong tool for this: the URL parser strips ASCII tab, LF and
   * CR before it parses, so `/\t/evil.example/x` passes a "does it start with
   * //" test and then loads cross-origin anyway; and a bare `https:host/x` is
   * read as a relative path when the page shares its scheme, so a prefix test
   * and a browser disagree about where it points. A prefix test can only be
   * patched one bypass at a time, so the parser decides instead.
   *
   * It matters because the result goes into a media `src`. A URL that resolves
   * somewhere other than the deployment is an exfiltration channel, and a
   * `javascript:` or `data:` URL is script execution in the app's own origin.
   */
  private absolutize(url: string, status: number): string {
    // Strip-then-parse is the parser's own first step, so any of these makes
    // the text and the parse disagree. Refuse before that can happen.
    if (/[\t\n\r]/.test(url)) {
      throw this.malformed(
        'asset resolve url must not contain a tab, newline or carriage return',
        status,
      );
    }

    if (ABSOLUTE_URL.test(url)) {
      // Require the unambiguous `scheme://host` form. `https:cdn.example/x`
      // parses standalone as host `cdn.example`, but a browser resolving it
      // against a same-scheme page reads it as a relative path — two different
      // destinations for one string, so it is not a URL this client will hand on.
      if (!/^https?:\/\//i.test(url)) {
        throw this.malformed(
          'absolute asset resolve url must use the http(s) scheme and the "scheme://" form',
          status,
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw this.malformed('asset resolve url is not a parseable absolute URL', status);
      }
      if (!RESOLVABLE_SCHEMES.has(parsed.protocol)) {
        throw this.malformed(
          `asset resolve url scheme ${JSON.stringify(parsed.protocol)} is not http(s)`,
          status,
        );
      }
      if (parsed.host === '') {
        throw this.malformed('absolute asset resolve url must carry a host', status);
      }
      // Returned as received: re-serializing can normalize a signed URL into
      // one whose signature no longer verifies.
      return url;
    }

    if (!url.startsWith('/')) {
      throw this.malformed('asset resolve url must be absolute or start with "/"', status);
    }
    // Resolve against a probe origin to ask the parser the only question that
    // matters: is this actually a same-origin path? `//host/x`, `/\host/x` and
    // anything else that reaches for an authority lands on a different origin
    // and is refused here, whatever it looked like as text.
    let probed: URL;
    try {
      probed = new URL(url, PROBE_ORIGIN);
    } catch {
      throw this.malformed('asset resolve url is not a parseable path', status);
    }
    if (probed.origin !== PROBE_ORIGIN) {
      throw this.malformed(
        'asset resolve url must be a path, not a reference to another origin',
        status,
      );
    }

    // An app-mounted deployment may be configured with a path-only base URL
    // (e.g. `/api/persistence`); the browser resolves the path against the
    // document itself, so leave it alone rather than inventing an origin.
    if (!ABSOLUTE_URL.test(this.baseUrl)) return url;
    const resolved = new URL(url, this.baseUrl);
    // Belt and braces: whatever the parser did with the path, the result must
    // still be the origin this client is configured to talk to.
    if (resolved.origin !== new URL(this.baseUrl).origin) {
      throw this.malformed(
        `asset resolve url resolved to ${JSON.stringify(resolved.origin)}, not the base origin`,
        status,
      );
    }
    return resolved.toString();
  }

  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef> {
    const { ref, bytes } = await computeAssetRef(data);
    const contentType = meta?.contentType ?? data.type ?? '';
    await this.send('PUT', `/assets/${segment(ref)}`, {
      body: bytes,
      contentType: contentType === '' ? UNKNOWN_CONTENT_TYPE : contentType,
    });
    this.invalidate(ref);
    return ref;
  }

  /**
   * Drop any in-flight resolution for a ref that has just been mutated. A
   * resolve started before the write would otherwise be shared with callers
   * arriving after it — handing back `null` for bytes that now exist, or a URL
   * for bytes that no longer do. Mirrors `BrowserAssetProvider`, which revokes
   * its cached object URL for the same reason.
   */
  private invalidate(ref: AssetRef): void {
    this.inFlight.delete(ref);
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    const pending = this.inFlight.get(ref);
    if (pending) return pending;
    const request = this.requestUrl(ref);
    // Only clear the memo if it is still ours: a mutation may have replaced or
    // dropped it while this request was in flight, and re-deleting then would
    // evict a newer resolution.
    const memo = request.finally(() => {
      if (this.inFlight.get(ref) === memo) this.inFlight.delete(ref);
    });
    this.inFlight.set(ref, memo);
    return memo;
  }

  private async requestUrl(ref: AssetRef): Promise<string | null> {
    let response: Response;
    try {
      response = await this.send('GET', `/assets/${segment(ref)}/url`);
    } catch (error) {
      if (error instanceof HttpAssetProviderError && error.code === 'ASSET_NOT_FOUND') return null;
      throw error;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A 2xx with an unparseable body is a broken response, not a native
      // SyntaxError for the caller to decode.
      throw this.malformed('asset resolve response body was not valid JSON', response.status);
    }
    const url =
      typeof body === 'object' && body !== null && 'url' in body
        ? (body as { url: unknown }).url
        : undefined;
    if (typeof url !== 'string' || url === '') {
      throw this.malformed(
        'asset resolve response must carry a non-empty url string',
        response.status,
      );
    }
    return this.absolutize(url, response.status);
  }

  async remove(ref: AssetRef): Promise<void> {
    await this.send('DELETE', `/assets/${segment(ref)}`);
    this.invalidate(ref);
  }
}
