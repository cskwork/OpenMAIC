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
import type { AssetMeta, BinaryBlob } from '@openmaic/dsl';
import { contentHashOf, ObjectUrlCache, type BlobStore, type ContentHash } from './blob.js';

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

export class BrowserAssetProvider implements BlobStore {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private dbPromise?: Promise<IDBDatabase>;
  private readonly urls = new ObjectUrlCache<ContentHash>((left, right) => left === right);

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

  put = async (data: BinaryBlob, meta?: AssetMeta): Promise<ContentHash> => {
    const { contentHash, bytes } = await contentHashOf(data);
    const asset: StoredAsset = { bytes, contentType: meta?.contentType ?? data.type ?? '' };
    await this.tx('readwrite', (store) => store.put(asset, contentHash));
    // A re-put with the same bytes but different metadata (e.g. a corrected
    // contentType) overwrites the stored asset; retire the current object URL
    // for this key so future resolve() calls reflect the latest write. The old
    // URL remains a live snapshot until owner-level cache reclamation.
    await this.urls.invalidate(contentHash);
    return contentHash;
  };

  resolve = async (ref: ContentHash): Promise<string | null> => {
    return this.urls.resolve(ref, ref, () => this.readAsUrl(ref));
  };

  private async readAsUrl(
    ref: ContentHash,
  ): Promise<{ identity: ContentHash; url: string } | null> {
    const asset = await this.tx<StoredAsset | undefined>('readonly', (store) => store.get(ref));
    if (!asset) return null;
    // Mint only after the readonly transaction commits, so an aborted read
    // cannot leak an object URL that no caller ever receives.
    return {
      identity: ref,
      url: URL.createObjectURL(new Blob([asset.bytes], { type: asset.contentType })),
    };
  }

  remove = async (ref: ContentHash): Promise<void> => {
    await this.tx('readwrite', (store) => store.delete(ref));
    await this.urls.invalidate(ref);
  };
}
