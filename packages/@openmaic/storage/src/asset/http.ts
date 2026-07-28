import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { ABSOLUTE_URL, assertHttpBaseUrl, RESOLVABLE_SCHEMES } from '../http/base-url.js';
import { assertAssetRef, computeAssetRef } from './content-ref.js';

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
  /**
   * Passed straight to `fetch`. A cookie-authenticated deployment whose base URL
   * is on another origin needs `'include'`: `fetch` sends no cookies
   * cross-origin by default, and the headers hook cannot compensate because
   * `Cookie` is a forbidden header name the browser refuses to let scripts set.
   * Such a deployment also owns the CORS side — the server must answer with
   * `Access-Control-Allow-Credentials` and a concrete origin.
   */
  credentials?: RequestCredentials;
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

/**
 * Origin used only to ask the URL parser whether a relative reference stays on
 * the origin it was resolved against. Never fetched, and never returned.
 */
const PROBE_ORIGIN = 'https://asset-url-probe.invalid';

function segment(value: string): string {
  assertAssetRef(value);
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
  private readonly credentials: RequestCredentials | undefined;
  /**
   * ref → the in-flight resolution. Concurrent `resolve(ref)` calls share one
   * request and therefore one URL, matching `BrowserAssetProvider`. The entry is
   * dropped once it settles, and again whenever the ref is mutated — so this is
   * a request-coalescing window, not a cache. Unlike an object URL, a resolved
   * HTTP URL may be a short-lived signed URL; keeping one to hand out later
   * would trade a second request for an expired URL.
   */
  private readonly inFlight = new Map<AssetRef, Promise<string | null>>();

  constructor(options: HttpAssetProviderOptions) {
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
    this.baseUrl = assertHttpBaseUrl(options.baseUrl, 'HttpAssetProvider');
    this.fetchImpl = selectedFetch.bind(globalThis);
    this.headersHook = options.headers;
    this.credentials = options.credentials;
  }

  private async send(
    method: string,
    path: string,
    init: { body?: BodyInit; contentType?: string; cache?: RequestCache } = {},
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
      ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
      ...(init.cache === undefined ? {} : { cache: init.cache }),
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
    if (probed.origin !== PROBE_ORIGIN || url[1] === '/' || url[1] === '\\') {
      // Two checks, because neither is sufficient alone. The origin comparison
      // asks "did this stay where I put it", and a URL naming the probe host
      // passes it by coincidence — `//<probe host>/x` and its backslash
      // spellings are protocol-relative, so against the *real* base they land
      // somewhere else entirely. Refusing any second character that can open an
      // authority closes that off without the probe host having to be
      // unguessable: a path-absolute reference always inherits the base's
      // origin, so once no authority can be introduced, the comparison cannot
      // be satisfied by a cross-origin reference.
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
    // Same allowlist as the absolute branch: a join can only ever produce the
    // base URL's scheme, and the constructor already refused a base that is not
    // http(s), but the media element does not care which code path built the URL.
    if (!RESOLVABLE_SCHEMES.has(resolved.protocol)) {
      throw this.malformed(
        `asset resolve url resolved to scheme ${JSON.stringify(resolved.protocol)}, not http(s)`,
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
      // Never served from a cache. A resolution is a fresh statement about a
      // mutable fact — whether this principal holds a claim, and what URL is
      // valid right now — and the in-flight coalescing above cannot reach the
      // HTTP cache layer. A cached hit would hand back an expired signed URL, or
      // replay a negatively-cached 404 for an asset that has since been written.
      response = await this.send('GET', `/assets/${segment(ref)}/url`, { cache: 'no-store' });
    } catch (error) {
      // Both conditions, deliberately. A proxy or gateway that answers 401, 403
      // or 500 while echoing the body's error code must not have that answer
      // read as "no such asset" — `null` tells the caller the asset is gone,
      // which would make an outage look like a deletion.
      if (
        error instanceof HttpAssetProviderError &&
        error.status === 404 &&
        error.code === 'ASSET_NOT_FOUND'
      ) {
        return null;
      }
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
