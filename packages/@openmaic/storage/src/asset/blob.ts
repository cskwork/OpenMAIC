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
import type { AssetRef, BinaryBlob } from '@openmaic/dsl';

/** `sha256-<hex>` over the stored bytes. Internal to this package. */
export type ContentHash = string;

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
  const bytes = await data.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { contentHash: `sha256-${toHex(digest)}`, bytes };
}

/**
 * Per-backend cache of minted object URLs, keyed on whatever reference the
 * backend resolves by.
 *
 * Keyed on the *promise* so concurrent `resolve(ref)` calls share one
 * `URL.createObjectURL` (a second would be orphaned, revocable by nothing), and
 * so repeated `resolve` returns one stable URL.
 */
export class ObjectUrlCache {
  private readonly urls = new Map<AssetRef, Promise<string | null>>();

  /**
   * Return the cached resolution for `ref`, or run `read` and cache it.
   *
   * Neither a miss nor a failure is cached: a miss must not survive a later
   * `put` of the same reference, and a transient IndexedDB failure must be
   * retried by the next call rather than replayed forever.
   */
  async resolve(ref: AssetRef, read: () => Promise<string | null>): Promise<string | null> {
    const cached = this.urls.get(ref);
    if (cached) return cached;
    const pending = read();
    this.urls.set(ref, pending);
    try {
      const url = await pending;
      if (url === null) this.urls.delete(ref);
      return url;
    } catch (err) {
      this.urls.delete(ref);
      throw err;
    }
  }

  /** Revoke and forget the cached object URL for a ref, if any. */
  async invalidate(ref: AssetRef): Promise<void> {
    const pending = this.urls.get(ref);
    if (!pending) return;
    this.urls.delete(ref);
    const url = await pending.catch(() => null);
    if (url) URL.revokeObjectURL(url);
  }
}
