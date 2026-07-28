import { assertJsonValue } from '../runtime/json-value.js';
import {
  assertKVScope,
  DEFAULT_KV_SCOPE,
  type KVScope,
  type KVStore,
  type LocalKVStore,
} from './types.js';

export interface HttpKVHeadersContext {
  method: string;
  path: string;
}

export type HttpKVHeadersHook = (
  context: HttpKVHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpAccountKVOptions {
  /** Root URL before the contract's `/kv/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpKVHeadersHook;
}

export interface HttpKVStoreOptions extends HttpAccountKVOptions {
  /**
   * Backend that owns the `device` scope. Required, and typed as a
   * {@link LocalKVStore} rather than a `KVStore`: a networked store satisfies
   * `KVStore` structurally, so accepting one here would reopen the exact seam
   * this class exists to close. There is deliberately no default — a `KVStore`
   * must be able to answer `device` reads and writes, this client structurally
   * cannot carry them, and "where does this device keep its state" has no
   * sensible guess. Pass the deployment's local backend (e.g.
   * `BrowserKVStore`). Only its `device` scope is ever used.
   */
  deviceStore: LocalKVStore;
}

interface ErrorResponseBody {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

/** A server-side KV failure, retaining its machine-readable HTTP identity. */
export class HttpKVStoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpKVStoreError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Upper bound on a key, in UTF-8 bytes. Keys become URL path segments and,
 * server-side, index entries; an unbounded key is both a denial-of-service knob
 * and an index-size hazard. A configuration key needing more than this is a
 * sign the caller is modelling something that does not belong in KV.
 */
const MAX_KV_KEY_BYTES = 512;

const UTF8 = new TextEncoder();

/**
 * Constrain a key to something that survives a URL round trip and can never be
 * mistaken for structure by a server. `/` and `\` are refused because a decoded
 * key must not be able to introduce a path segment: the reason dot segments are
 * refused applies verbatim to separators, and a server that used the key as a
 * path component would otherwise inherit a traversal.
 */
function assertAddressableKey(key: string): void {
  assertJsonValue(key, `kv key ${JSON.stringify(key)}`);
  if (key === '') {
    throw new Error('@openmaic/storage: kv key must not be empty');
  }
  if (key === '.' || key === '..') {
    throw new Error(`@openmaic/storage: URL path segment must not be ${JSON.stringify(key)}`);
  }
  if (key.includes('/') || key.includes('\\')) {
    throw new Error(
      `@openmaic/storage: kv key ${JSON.stringify(key)} must not contain '/' or '\\'`,
    );
  }
  const bytes = UTF8.encode(key).length;
  if (bytes > MAX_KV_KEY_BYTES) {
    throw new Error(
      `@openmaic/storage: kv key exceeds ${MAX_KV_KEY_BYTES} UTF-8 bytes (got ${bytes})`,
    );
  }
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
 * Wire client for the account-scoped KV HTTP contract.
 *
 * `device` values never leave the device — that is part of the KV primitive,
 * not a deployment setting — so this type makes shipping one *inexpressible*
 * rather than merely refusing it at runtime. No method here takes a scope, the
 * contract it speaks has no scope path segment, query parameter or body field,
 * and every request it can construct is an account request. A caller holding
 * this object has no vocabulary for `device`, so there is no call to audit, no
 * flag to misconfigure, and no branch that could regress into sending one.
 *
 * The scope decision lives one level up, in {@link HttpKVStore}, which routes
 * `device` to a local backend and only ever reaches this transport for
 * `account`.
 */
export class HttpAccountKV {
  /**
   * Anti-brand, and the reason `HttpKVStore` asks for a `LocalKVStore` rather
   * than a `KVStore`. This class satisfies `KVStore` structurally — every method
   * is the same method minus an optional parameter, and TypeScript accepts a
   * shorter signature where a longer one is expected — and no member added here
   * can change that, since extra members never block assignment to a narrower
   * interface. So the barrier is placed on the other side: the branded
   * `LocalKVStore` this class declares itself *not* to be, backed by a runtime
   * check for the `as` that would erase the difference. Without it, injecting
   * this transport as a `deviceStore` type-checks and puts device values on the
   * wire through the one seam the types were meant to close.
   */
  readonly isLocalKVStore = false as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersHook: HttpKVHeadersHook | undefined;

  constructor(options: HttpAccountKVOptions) {
    if (options.baseUrl === '') {
      throw new Error('@openmaic/storage: HttpKVStore baseUrl must be non-empty');
    }
    // Bind explicitly: browsers require fetch to be invoked with
    // `this === globalThis` (calling a stored reference as `this.fetchImpl(...)`
    // throws "Illegal invocation"), while node's undici does not care — which is
    // exactly why node-only test suites cannot catch the unbound form.
    // Validate BEFORE binding: .bind on a non-function throws a native
    // TypeError that would preempt the documented error below.
    const selectedFetch = options.fetch ?? globalThis.fetch;
    if (typeof selectedFetch !== 'function') {
      throw new Error('@openmaic/storage: HttpKVStore requires a fetch implementation');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = selectedFetch.bind(globalThis);
    this.headersHook = options.headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ body: T; status: number }> {
    const headers = normalizeHeaders(await this.headersHook?.({ method, path }));
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers['content-type'] ??= 'application/json';
      serializedBody = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
    if (!response.ok) {
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
          : `@openmaic/storage: KVStore HTTP request failed with status ${response.status}`;
      throw new HttpKVStoreError(response.status, code, message, errorBody?.error?.details);
    }
    if (response.status === 204) return { body: undefined as T, status: response.status };
    try {
      return { body: (await response.json()) as T, status: response.status };
    } catch {
      // A 2xx with an unparseable body is a broken response, not a native
      // SyntaxError for the caller to decode.
      throw new HttpKVStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: KVStore HTTP response body was not valid JSON',
      );
    }
  }

  /** Read one account value, or `null` when the server holds no entry. */
  async get<T>(key: string): Promise<T | null> {
    assertAddressableKey(key);
    let response: { body: unknown; status: number };
    try {
      response = await this.request<unknown>('GET', `/kv/entries/${encodeURIComponent(key)}`);
    } catch (error) {
      if (error instanceof HttpKVStoreError && error.code === 'KEY_NOT_FOUND') return null;
      throw error;
    }
    const body = response.body;
    if (typeof body !== 'object' || body === null || !('value' in body)) {
      throw new HttpKVStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: KVStore HTTP get response must be an object carrying "value"',
      );
    }
    return (body as { value: T | null }).value;
  }

  /** Write one account value. */
  async set<T>(key: string, value: T): Promise<void> {
    assertAddressableKey(key);
    // A value with no JSON representation at all (`undefined`, a function, a
    // symbol) is a removal, matching `BrowserKVStore`, which would otherwise
    // store the literal string "undefined" and throw on the next read.
    //
    // The test inspects the value directly instead of probing it with
    // `JSON.stringify`. A probe executes caller code (`toJSON`, getters), which
    // both undermines the JSON gate below — a stateful getter can show the probe
    // one value and the real serialization another — and quietly reclassifies
    // values the gate must reject, such as `{ toJSON: () => undefined }`, as
    // deletions.
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return this.remove(key);
    }
    assertJsonValue(value, `kv value for key ${JSON.stringify(key)}`);
    await this.request<void>('PUT', `/kv/entries/${encodeURIComponent(key)}`, { value });
  }

  /** Delete one account value. Absent keys succeed. */
  async remove(key: string): Promise<void> {
    assertAddressableKey(key);
    await this.request<void>('DELETE', `/kv/entries/${encodeURIComponent(key)}`);
  }

  /** List the account keys, optionally restricted to those under `prefix`. */
  async keys(prefix = ''): Promise<string[]> {
    assertJsonValue(prefix, 'kv key prefix');
    const query = prefix === '' ? '' : `?prefix=${encodeURIComponent(prefix)}`;
    const response = await this.request<unknown>('GET', `/kv/keys${query}`);
    if (!Array.isArray(response.body) || response.body.some((key) => typeof key !== 'string')) {
      throw new HttpKVStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: KVStore HTTP keys response must be an array of strings',
      );
    }
    return response.body as string[];
  }
}

/**
 * `KVStore` over the HTTP contract for `account` values, with `device` values
 * served by the injected local backend.
 *
 * The split is the point. `account` is the scope a server-backed deployment
 * syncs across devices; `device` is machine-local state that must never leave
 * the machine. This class is the only place the two scopes are told apart, and
 * the only object it can reach the network through — {@link HttpAccountKV} —
 * cannot express a device request at all.
 */
export class HttpKVStore implements KVStore {
  /** Anti-brand: a client of a remote store is not somewhere local. */
  readonly isLocalKVStore = false as const;
  private readonly account: HttpAccountKV;
  private readonly device: LocalKVStore;

  constructor(options: HttpKVStoreOptions) {
    const { deviceStore, ...accountOptions } = options;
    // The type already refuses a remote store here, but one `as` at a call site
    // would undo it — and what it would undo is the last thing standing between
    // a device value and the network. Check at runtime as well.
    if (
      deviceStore instanceof HttpAccountKV ||
      deviceStore instanceof HttpKVStore ||
      (deviceStore as LocalKVStore | undefined)?.isLocalKVStore !== true
    ) {
      throw new Error(
        '@openmaic/storage: HttpKVStore deviceStore must be a local KVStore (isLocalKVStore) — ' +
          'device values never leave the device, so a remote store cannot hold them',
      );
    }
    this.account = new HttpAccountKV(accountOptions);
    this.device = deviceStore;
  }

  /**
   * Route by scope, failing closed. An unknown scope is never folded into the
   * account path: that would send a value the caller believed was device-local
   * to a server, the single outcome this class exists to prevent.
   */
  private isDeviceScope(scope: KVScope): boolean {
    return assertKVScope(scope) === 'device';
  }

  async get<T>(key: string, scope: KVScope = DEFAULT_KV_SCOPE): Promise<T | null> {
    return this.isDeviceScope(scope) ? this.device.get<T>(key, 'device') : this.account.get<T>(key);
  }

  async set<T>(key: string, value: T, scope: KVScope = DEFAULT_KV_SCOPE): Promise<void> {
    return this.isDeviceScope(scope)
      ? this.device.set<T>(key, value, 'device')
      : this.account.set<T>(key, value);
  }

  async remove(key: string, scope: KVScope = DEFAULT_KV_SCOPE): Promise<void> {
    return this.isDeviceScope(scope) ? this.device.remove(key, 'device') : this.account.remove(key);
  }

  async keys(prefix = '', scope: KVScope = DEFAULT_KV_SCOPE): Promise<string[]> {
    return this.isDeviceScope(scope)
      ? this.device.keys(prefix, 'device')
      : this.account.keys(prefix);
  }
}
