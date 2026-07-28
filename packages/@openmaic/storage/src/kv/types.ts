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
 * A `KVStore` that keeps every value on the machine it runs on.
 *
 * The brand exists because `KVStore` alone is not enough to express "somewhere
 * local". A remote store structurally satisfies `KVStore` — that is the point
 * of the interface — so a backend asking for a local store to hold `device`
 * values would happily accept a networked one, and the device-never-leaves-the-
 * device invariant would rest on the caller's good intentions. A remote store
 * cannot acquire this brand by accident; claiming it requires writing the lie
 * out by hand.
 */
export interface LocalKVStore extends KVStore {
  readonly isLocalKVStore: true;
}

/** The default scope used when a caller omits one. */
export const DEFAULT_KV_SCOPE: KVScope = 'account';

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
      throw new Error(`@openmaic/storage: unknown KV scope ${JSON.stringify(scope as string)}`);
  }
}
