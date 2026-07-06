import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';

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

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Browser `StorageProvider` backend: bytes live in IndexedDB, and `resolve`
 * hands back a `blob:` object URL for use as a media `src`. Refs are
 * content-addressed (`sha256-<hex>`), so identical bytes de-duplicate to one
 * stored asset and one stable ref.
 */
export class BrowserAssetProvider implements StorageProvider {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private dbPromise?: Promise<IDBDatabase>;
  /** ref → object URL, so repeated `resolve` returns one stable URL per asset. */
  private readonly urls = new Map<AssetRef, string>();

  constructor(options: BrowserAssetProviderOptions = {}) {
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'maic-assets';
  }

  private openDb(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private async computeRef(data: BinaryBlob): Promise<{ ref: AssetRef; bytes: ArrayBuffer }> {
    const bytes = await data.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { ref: `sha256-${toHex(digest)}`, bytes };
  }

  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef> {
    const { ref, bytes } = await this.computeRef(data);
    const asset: StoredAsset = { bytes, contentType: meta?.contentType ?? data.type ?? '' };
    await this.tx('readwrite', (store) => store.put(asset, ref));
    return ref;
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    const cached = this.urls.get(ref);
    if (cached) return cached;
    const asset = await this.tx<StoredAsset | undefined>('readonly', (store) => store.get(ref));
    if (!asset) return null;
    const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.contentType }));
    this.urls.set(ref, url);
    return url;
  }

  async remove(ref: AssetRef): Promise<void> {
    await this.tx('readwrite', (store) => store.delete(ref));
    const url = this.urls.get(ref);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(ref);
    }
  }
}
