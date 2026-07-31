/**
 * Blob-layer primitives shared by the two IndexedDB asset backends: the
 * content hash that keys stored bytes, and the object-URL cache that hands a
 * `blob:` URL back to a renderer.
 *
 * The blob layer maps `contentHash → bytes` and nothing else. It is a storage
 * optimization, not an identity: it holds no metadata, no ownership, and no
 * reference anyone outside this package ever sees. Everything that gives an
 * asset an identity — the id, the MIME type, the provenance — lives one layer
 * up, in the registry.
 */
import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';

declare const contentHashBrand: unique symbol;

/** `sha256-<hex>` over the stored bytes. Internal to this package. */
export type ContentHash = string & { readonly [contentHashBrand]: true };

/**
 * Internal content-addressed blob-layer contract. Unlike `StorageProvider`,
 * `put` returns the key derived from the bytes and may return the same key for
 * repeated content. Function-typed properties keep the branded hash parameters
 * contravariant under `strictFunctionTypes`, so this internal store cannot be
 * substituted for the allocated-id DSL contract.
 */
export interface BlobStore {
  put: (data: BinaryBlob, meta?: AssetMeta) => Promise<ContentHash>;
  resolve: (key: ContentHash) => Promise<string | null>;
  remove: (key: ContentHash) => Promise<void>;
}

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/** Read a blob's bytes and derive the content hash they are stored under. */
export async function contentHashOf(
  data: BinaryBlob,
): Promise<{ contentHash: ContentHash; bytes: ArrayBuffer }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto crypto.subtle is unavailable; content hashing requires a secure context (HTTPS or localhost).',
    );
  }
  const bytes = await data.arrayBuffer();
  const digest = await subtle.digest('SHA-256', bytes);
  return { contentHash: `sha256-${toHex(digest)}` as ContentHash, bytes };
}

interface ResolvedObjectUrl {
  /** Identity of the exact bytes from which `url` was minted. */
  identity: ObjectUrlIdentity;
  url: string;
}

export type ObjectUrlIdentity =
  | string
  | {
      contentHash: string;
      mime: string;
    };

interface CachedObjectUrl {
  epoch: number;
  identity: ObjectUrlIdentity;
  pending: Promise<ResolvedObjectUrl | null>;
  settled?: ResolvedObjectUrl | null;
  supersededEpoch?: number;
  deliveries: number;
}

function sameIdentity(left: ObjectUrlIdentity, right: ObjectUrlIdentity): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return left.contentHash === right.contentHash && left.mime === right.mime;
}

/**
 * Per-backend cache of minted object URLs, keyed on whatever reference the
 * backend resolves by.
 *
 * Keyed on the *promise* so concurrent `resolve(ref)` calls share one
 * `URL.createObjectURL` (a second would be orphaned, revocable by nothing), and
 * so repeated `resolve` returns one stable URL. Each entry also records the
 * identity of the bytes from which it was minted. Registry-backed callers use
 * the content hash for that identity, making a warm hit conditional on exact
 * content rather than merely on the reference still existing.
 *
 * An epoch per ref separates a superseded in-flight mint from the next cache
 * generation. Such a mint remains alive for the raced caller's consistent
 * snapshot but is never installed as the current cache entry. Its URL becomes
 * an orphan, reclaimed by the next invalidation, an owner-level release, or
 * cache shutdown.
 */
export class ObjectUrlCache {
  private readonly urls = new Map<AssetRef, CachedObjectUrl>();
  private readonly epochs = new Map<AssetRef, number>();
  private readonly orphans = new Map<AssetRef, Set<string>>();
  private readonly pending = new Map<AssetRef, Set<CachedObjectUrl>>();
  private closed = false;

  /**
   * Return the cached resolution for `ref` when it has `identity`, or run
   * `read` and cache the exact identity it reports.
   *
   * Neither a miss nor a failure is cached: a miss must not survive a later
   * `put` of the same reference, and a transient IndexedDB failure must be
   * retried by the next call rather than replayed forever.
   */
  async resolve(
    ref: AssetRef,
    identity: ObjectUrlIdentity,
    read: () => Promise<ResolvedObjectUrl | null>,
  ): Promise<string | null> {
    const cached = this.urls.get(ref);
    if (
      cached &&
      sameIdentity(cached.identity, identity) &&
      cached.epoch === (this.epochs.get(ref) ?? 0)
    ) {
      return this.deliver(cached);
    }
    // `invalidate` advances and removes synchronously even though it returns a
    // Promise-shaped API. Do not yield here: the replacement entry must be
    // installed before a second resolver can miss it and start a duplicate
    // mint for the same generation.
    if (cached) void this.invalidate(ref);

    const entry: CachedObjectUrl = {
      epoch: this.epochs.get(ref) ?? 0,
      identity,
      pending: Promise.resolve(null),
      deliveries: 0,
    };
    this.addPending(ref, entry);
    entry.pending = read().then(
      (resolved) => {
        entry.settled = resolved;
        if (resolved) entry.identity = resolved.identity;
        if (this.urls.get(ref) !== entry) {
          if (resolved) {
            if (this.closed) {
              URL.revokeObjectURL(resolved.url);
            } else {
              this.addOrphan(ref, resolved.url);
            }
            if (!this.closed && (this.epochs.get(ref) ?? 0) > (entry.supersededEpoch ?? 0)) {
              // A later invalidation already occurred while this mint was
              // pending. Reclaim after promise delivery, never before the
              // raced caller can observe its consistent snapshot.
              setTimeout(() => {
                this.revokeOrphan(ref, resolved.url);
                this.pruneEpoch(ref);
              }, 0);
            }
          }
        } else if (resolved === null) {
          this.urls.delete(ref);
        }
        this.removePending(ref, entry);
        this.pruneEpoch(ref);
        return resolved;
      },
      (error: unknown) => {
        if (this.urls.get(ref) === entry) this.urls.delete(ref);
        this.removePending(ref, entry);
        this.pruneEpoch(ref);
        throw error;
      },
    );
    this.urls.set(ref, entry);
    return this.deliver(entry);
  }

  private async deliver(entry: CachedObjectUrl): Promise<string | null> {
    entry.deliveries += 1;
    try {
      return (await entry.pending)?.url ?? null;
    } finally {
      entry.deliveries -= 1;
    }
  }

  private addPending(ref: AssetRef, entry: CachedObjectUrl): void {
    let entries = this.pending.get(ref);
    if (!entries) {
      entries = new Set();
      this.pending.set(ref, entries);
    }
    entries.add(entry);
  }

  private removePending(ref: AssetRef, entry: CachedObjectUrl): void {
    const entries = this.pending.get(ref);
    if (!entries?.delete(entry)) return;
    if (entries.size === 0) this.pending.delete(ref);
  }

  private hasState(ref: AssetRef): boolean {
    return this.urls.has(ref) || this.pending.has(ref) || this.orphans.has(ref);
  }

  private pruneEpoch(ref: AssetRef): void {
    if (!this.hasState(ref)) this.epochs.delete(ref);
  }

  private addOrphan(ref: AssetRef, url: string): void {
    let urls = this.orphans.get(ref);
    if (!urls) {
      urls = new Set();
      this.orphans.set(ref, urls);
    }
    urls.add(url);
  }

  private revokeOrphans(ref: AssetRef): void {
    const urls = this.orphans.get(ref);
    if (!urls) return;
    this.orphans.delete(ref);
    for (const url of urls) URL.revokeObjectURL(url);
  }

  private revokeOrphan(ref: AssetRef, url: string): void {
    const urls = this.orphans.get(ref);
    if (!urls?.delete(url)) return;
    URL.revokeObjectURL(url);
    if (urls.size === 0) this.orphans.delete(ref);
  }

  /**
   * Advance a ref's cache generation and forget its current entry.
   *
   * Settled superseded URLs are revoked immediately unless an active resolve
   * is still delivering them. Pending or actively delivered URLs become
   * orphans and remain alive until a later invalidation, owner-level release,
   * or shutdown.
   */
  async invalidate(ref: AssetRef): Promise<void> {
    const entry = this.urls.get(ref);
    if (!this.hasState(ref)) return;
    this.epochs.set(ref, (this.epochs.get(ref) ?? 0) + 1);
    this.revokeOrphans(ref);
    if (entry) {
      this.urls.delete(ref);
      entry.supersededEpoch = this.epochs.get(ref);
      if (entry.settled) {
        if (entry.deliveries > 0) this.addOrphan(ref, entry.settled.url);
        else URL.revokeObjectURL(entry.settled.url);
      }
    }
    this.pruneEpoch(ref);
  }

  /** Force-revoke every URL for one owner-controlled ref. */
  async release(ref: AssetRef): Promise<void> {
    if (!this.hasState(ref)) return;
    this.epochs.set(ref, (this.epochs.get(ref) ?? 0) + 1);
    this.revokeOrphans(ref);
    const entry = this.urls.get(ref);
    if (entry) {
      this.urls.delete(ref);
      entry.supersededEpoch = this.epochs.get(ref);
    }
    const entries = new Set(this.pending.get(ref) ?? []);
    if (entry) entries.add(entry);
    const resolved = await Promise.all(
      [...entries].map((pendingEntry) => pendingEntry.pending.catch(() => null)),
    );
    for (const result of resolved) {
      if (result) URL.revokeObjectURL(result.url);
    }
    this.revokeOrphans(ref);
    this.pruneEpoch(ref);
  }

  /** Force-revoke all cached, in-flight, and orphaned URLs. */
  async close(): Promise<void> {
    this.closed = true;
    const refs = new Set([...this.urls.keys(), ...this.pending.keys(), ...this.orphans.keys()]);
    await Promise.all([...refs].map((ref) => this.release(ref)));
    this.urls.clear();
    this.pending.clear();
    this.orphans.clear();
    this.epochs.clear();
  }
}
