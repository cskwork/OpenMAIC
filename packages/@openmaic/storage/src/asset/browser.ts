/**
 * **Internal.** The standalone content-addressed blob backend — bytes in
 * IndexedDB, keyed by `sha256-<hex>` over their own content, resolved as a
 * `blob:` object URL.
 *
 * This is not the package's asset seam and is deliberately not exported:
 * consumers get {@link BrowserAssetStore}, which layers an allocated-id
 * registry over this addressing scheme. The distinction matters, because a
 * content-addressed ref *is* a statement about the bytes — putting the same
 * bytes twice yields the same ref, which is a de-duplication signal an outward
 * API must not emit. That property is fine one layer down, where a hash is a
 * private storage key nothing outside the package holds; it is not fine as a
 * reference a document embeds.
 *
 * Kept as its own type because "map bytes to a stable storage key" is the
 * pluggable half of the design — the layer an S3-compatible endpoint or a CDN
 * would replace behind the same interface, with the registry above it
 * unchanged.
 */
import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { contentHashOf, ObjectUrlCache } from './blob.js';

export interface BrowserAssetProviderOptions {
  /** IndexedDB factory. Defaults to the ambient `indexedDB`. Injectable for tests. */
  indexedDB?: IDBFactory;
  /** Database name. Defaults to `maic-assets`. */
  dbName?: string;
}

const STORE = 'assets';

interface StoredAsset {
  bytes: ArrayBuffer;
  contentType: string;
}

export class BrowserAssetProvider implements StorageProvider {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private dbPromise?: Promise<IDBDatabase>;
  private readonly urls = new ObjectUrlCache();

  constructor(options: BrowserAssetProviderOptions = {}) {
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'maic-assets';
  }

  private openDb(): Promise<IDBDatabase> {
    // Do NOT cache a rejected open: a transient failure (private-mode IDB, a
    // one-off VersionError) would otherwise brick the provider for the whole
    // session. Clear the memo on failure so the next call retries.
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.dbPromise = undefined;
      throw err;
    });
    return this.dbPromise;
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const req = run(transaction.objectStore(STORE));
      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      // Resolve on commit, not on the request success: a write that succeeds
      // as a request can still abort at commit (e.g. QuotaExceededError), and
      // reporting that as success would claim durability the store never gave.
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? req.error);
      transaction.onabort = () => reject(transaction.error ?? req.error);
    });
  }

  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef> {
    const { contentHash, bytes } = await contentHashOf(data);
    const asset: StoredAsset = { bytes, contentType: meta?.contentType ?? data.type ?? '' };
    await this.tx('readwrite', (store) => store.put(asset, contentHash));
    // A re-put with the same bytes but different metadata (e.g. a corrected
    // contentType) overwrites the stored asset; drop any cached object URL for
    // this key so resolve() reflects the latest write instead of a stale one.
    // Without this, resolved MIME would depend on cache warmth (a fresh
    // provider would see the new type, this one the old).
    await this.urls.invalidate(contentHash);
    return contentHash;
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    return this.urls.resolve(ref, () => this.readAsUrl(ref));
  }

  private async readAsUrl(ref: AssetRef): Promise<string | null> {
    const asset = await this.tx<StoredAsset | undefined>('readonly', (store) => store.get(ref));
    if (!asset) return null;
    return URL.createObjectURL(new Blob([asset.bytes], { type: asset.contentType }));
  }

  async remove(ref: AssetRef): Promise<void> {
    await this.tx('readwrite', (store) => store.delete(ref));
    await this.urls.invalidate(ref);
  }
}
