/**
 * KV scope. `account` values are user/account data that a server-backed
 * deployment syncs across devices (provider/model config, profile). `device`
 * values are machine-local UI state (theme, locale, layout) that must never
 * leave the device — every backend honours that, so a `device` write stays
 * local even when `account` writes go to a server.
 */
export type KVScope = 'device' | 'account';

/**
 * Small keyed values not owned by the DSL. The scope defaults to `account`;
 * pass `device` for machine-local preferences. Values must be JSON-serializable
 * — the store owns (de)serialization so callers pass and receive plain values.
 */
export interface KVStore {
  get<T>(key: string, scope?: KVScope): Promise<T | null>;
  set<T>(key: string, value: T, scope?: KVScope): Promise<void>;
  remove(key: string, scope?: KVScope): Promise<void>;
  keys(prefix?: string, scope?: KVScope): Promise<string[]>;
}

/**
 * A `KVStore` whose `device` scope never leaves the device.
 *
 * This is the capability that actually matters when a caller wants to persist
 * `device`-scoped state: not "is the whole store local", but "does a `device`
 * write stay on this machine". Two kinds of store honour it — one that is
 * entirely local, and a composite that routes `device` to a local backend while
 * sending `account` to a server — and both are safe to hand a `device` scope.
 *
 * The brand exists because `KVStore` alone cannot express it. A remote store
 * structurally satisfies `KVStore` — that is the point of the interface — so a
 * `KVStore`-typed parameter asking for a device-safe store would happily accept
 * a pure network transport, and the device-never-leaves-the-device invariant
 * would rest on the caller's good intentions. A store that does *not* keep
 * `device` local cannot acquire this brand by accident: the account-only
 * transport declares itself `false`, which is not assignable to the `true` this
 * requires, so claiming the capability would mean writing the lie out by hand.
 */
export interface DeviceSafeKVStore extends KVStore {
  readonly servesDeviceScopeLocally: true;
}

/**
 * A `KVStore` that keeps *every* value on the machine it runs on — strictly
 * stronger than {@link DeviceSafeKVStore}, which only promises it for `device`.
 *
 * This is what a composite store demands of the backend it injects for the
 * `device` scope: that backend has no second, networked scope to route
 * elsewhere, so nothing it holds can leave. A device-safe composite would not
 * do — nesting one inside another is a loop of routers with no local floor.
 */
export interface LocalKVStore extends DeviceSafeKVStore {
  readonly isLocalKVStore: true;
}

/** The default scope used when a caller omits one. */
export const DEFAULT_KV_SCOPE: KVScope = 'account';

/**
 * A scope a store was asked to serve and cannot. Its own class because the two
 * cases it covers are refusals to route data, not transport failures: an
 * unrecognized scope, and a `device` scope handed to a backend that only serves
 * `account`.
 */
export class KVScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KVScopeViolationError';
  }
}

/**
 * Narrow an untrusted scope to the two the primitive defines, failing closed.
 *
 * Scopes reach backends as ordinary values (the zustand adapter passes one
 * straight through), so a typo like `'Device'` is a runtime possibility even
 * though the type forbids it. Backends must not guess: treating "not `device`"
 * as `account` sends a mistyped device write to a server, and treating "not
 * `account`" as `device` silently strands account data. Both failure modes are
 * worse than throwing.
 */
export function assertKVScope(scope: KVScope): KVScope {
  switch (scope) {
    case 'device':
    case 'account':
      return scope;
    default:
      throw new KVScopeViolationError(
        `@openmaic/storage: unknown KV scope ${JSON.stringify(scope as string)}`,
      );
  }
}

/**
 * Upper bound on a key, in UTF-8 bytes rather than characters, so a multi-byte
 * key cannot exceed the limit while appearing to comply. Keys become URL path
 * segments and server-side index entries; an unbounded key is a
 * denial-of-service knob and an index-size hazard.
 */
export const MAX_KV_KEY_BYTES = 512;

const UTF8 = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * The key domain, enforced by **every** backend.
 *
 * A key is an **opaque string**. Callers compose keys from unconstrained DSL
 * identifiers — a `stageId` may legitimately be `stage/one` — so this must not
 * reject a key merely for containing `/`, `\`, `:`, or other characters that
 * look like structure. It once did, and that broke every caller whose key
 * embeds an id; the fix is the same one the asset ref took: keep the key opaque,
 * and defend against path traversal by *encoding*, not by rejecting.
 *
 * Encoding is where traversal protection lives. The HTTP client percent-encodes
 * the whole key into a single path segment (`stage/one` → `stage%2Fone`), so a
 * separator can never open a new segment on the wire, and the contract requires
 * the server to treat the decoded key as an opaque bound value — never a path
 * component. The browser backend stores the key verbatim, where a separator is
 * just a character.
 *
 * The few rules that remain are the ones encoding cannot cover, and none of
 * them can be produced by a caller composing `prefix + id`: an empty key and a
 * whole-key `.` / `..` have no percent-encoding that survives URL path
 * normalization, and NUL or an unpaired surrogate does not survive the
 * transports underneath at all. Enforced by every backend so a key that round-
 * trips in the browser round-trips over HTTP too.
 */
export function assertKVKey(key: string): void {
  if (key === '') {
    throw new Error('@openmaic/storage: kv key must not be empty');
  }
  if (key === '.' || key === '..') {
    throw new Error(`@openmaic/storage: URL path segment must not be ${JSON.stringify(key)}`);
  }
  assertKVKeyCharacters(key, 'kv key');
  const bytes = UTF8.encode(key).length;
  if (bytes > MAX_KV_KEY_BYTES) {
    throw new Error(
      `@openmaic/storage: kv key exceeds ${MAX_KV_KEY_BYTES} UTF-8 bytes (got ${bytes})`,
    );
  }
}

function assertKVKeyCharacters(value: string, label: string): void {
  if (value.includes('\u0000')) {
    throw new Error(`@openmaic/storage: ${label} must not contain the NUL code point (\\u0000)`);
  }
  if (LONE_SURROGATE.test(value)) {
    throw new Error(`@openmaic/storage: ${label} must not contain an unpaired UTF-16 surrogate`);
  }
}

/**
 * A `keys()` prefix is held to the key rules it is a prefix *of*, minus the
 * requirements that only make sense for a whole key: it may be empty (that is
 * what "list everything" means) and, like a key, it is opaque — a `/` is a
 * legitimate prefix character, not structure. Only the transport-fatal
 * characters and the length bound remain.
 */
export function assertKVKeyPrefix(prefix: string): void {
  if (prefix === '') return;
  assertKVKeyCharacters(prefix, 'kv key prefix');
  const bytes = UTF8.encode(prefix).length;
  if (bytes > MAX_KV_KEY_BYTES) {
    throw new Error(
      `@openmaic/storage: kv key prefix exceeds ${MAX_KV_KEY_BYTES} UTF-8 bytes (got ${bytes})`,
    );
  }
}
