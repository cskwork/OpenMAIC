import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
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

function assertAddressableSegment(value: string): void {
  if (value === '.' || value === '..') {
    throw new Error(`@openmaic/storage: URL path segment must not be ${JSON.stringify(value)}`);
  }
}

function segment(value: string): string {
  assertAddressableSegment(value);
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
    if (init.contentType !== undefined) headers['content-type'] ??= init.contentType;

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

  /**
   * A resolved URL is either absolute (a signed URL, which must be handed back
   * byte-for-byte or its signature breaks) or a root-relative path a proxying
   * deployment serves itself. Only the latter is joined to the base URL.
   */
  private absolutize(url: string, status: number): string {
    if (ABSOLUTE_URL.test(url)) return url;
    if (!url.startsWith('/')) {
      throw new HttpAssetProviderError(
        status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: asset resolve url must be absolute or start with "/"',
      );
    }
    // An app-mounted deployment may be configured with a path-only base URL
    // (e.g. `/api/persistence`); the browser resolves the path against the
    // document itself, so leave it alone rather than inventing an origin.
    if (!ABSOLUTE_URL.test(this.baseUrl)) return url;
    return new URL(url, this.baseUrl).toString();
  }

  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef> {
    const { ref, bytes } = await computeAssetRef(data);
    const contentType = meta?.contentType ?? data.type ?? '';
    await this.send('PUT', `/assets/${segment(ref)}`, {
      body: bytes,
      contentType: contentType === '' ? UNKNOWN_CONTENT_TYPE : contentType,
    });
    return ref;
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    const pending = this.inFlight.get(ref);
    if (pending) return pending;
    const request = this.requestUrl(ref).finally(() => {
      this.inFlight.delete(ref);
    });
    this.inFlight.set(ref, request);
    return request;
  }

  private async requestUrl(ref: AssetRef): Promise<string | null> {
    let response: Response;
    try {
      response = await this.send('GET', `/assets/${segment(ref)}/url`);
    } catch (error) {
      if (error instanceof HttpAssetProviderError && error.code === 'ASSET_NOT_FOUND') return null;
      throw error;
    }
    const body: unknown = await response.json();
    const url =
      typeof body === 'object' && body !== null && 'url' in body
        ? (body as { url: unknown }).url
        : undefined;
    if (typeof url !== 'string' || url === '') {
      throw new HttpAssetProviderError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: asset resolve response must carry a non-empty url string',
      );
    }
    return this.absolutize(url, response.status);
  }

  async remove(ref: AssetRef): Promise<void> {
    await this.send('DELETE', `/assets/${segment(ref)}`);
  }
}
