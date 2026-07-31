/**
 * Browser asset pool: an **allocated-id registry layered over a
 * content-addressed blob store**, both in one IndexedDB database.
 *
 * The reference chain is `assetId → contentHash → bytes`, deliberately neither
 * pure content-addressing nor pure allocation:
 *
 * - **Stable identity.** A document embeds the allocated `assetId`. Replacing
 *   the bytes behind an entry does not invalidate the references pointing at
 *   it, and one set of bytes may back several entries with different ids and
 *   different metadata.
 * - **Byte de-duplication.** Identical bytes occupy one `blobs` row no matter
 *   how many registry entries name them.
 * - **The hash is never a reference.** `contentHash` lives only inside the
 *   registry and is never returned, logged in an error, or accepted as an
 *   input. The threat that pure content-addressing has to defend against —
 *   "whoever knows the hash can reach the bytes" — structurally does not arise,
 *   which is what lets the blob layer stay global and metadata-free.
 *
 * Two object stores, one database, so a `put` and a `remove` that touch the
 * same bytes are serialized by IndexedDB rather than racing across two
 * databases: reference counting happens *inside* the same transaction that
 * deletes the entry, so the last entry's removal can never reclaim bytes a
 * concurrent `put` has just adopted.
 *
 * `put` deliberately reveals nothing about whether the bytes already existed —
 * see {@link BrowserAssetStore.put}.
 */
import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { contentHashOf, ObjectUrlCache, type ContentHash } from './blob.js';
import { newAssetId, type AssetId } from './id.js';

export interface BrowserAssetStoreOptions {
  /** IndexedDB factory. Defaults to the ambient `indexedDB`. Injectable for tests. */
  indexedDB?: IDBFactory;
  /** Database name. Defaults to `maic-asset-pool`. */
  dbName?: string;
}

/** Registry table: `assetId → entry`. */
const ASSETS = 'assets';
/** Blob table: `contentHash → bytes`. */
const BLOBS = 'blobs';
/** Index over {@link AssetEntry.contentHash}, the reference count `remove` reads. */
const BY_CONTENT_HASH = 'by-content-hash';

/**
 * One registry row. `mime` is a column, not a partition: images, audio and
 * video share one id space and one table, because splitting by medium is
 * exactly the fault this layer exists to remove.
 *
 * There is deliberately **no `principal` column here**. A principal is a
 * server-side concept derived from an authenticated session — the browser
 * backend has no session to derive one from, so modelling it here would mean
 * storing a value the client itself supplies, which authorizes nothing. The
 * registry gains its principal column when it gains a server backend.
 */
interface AssetEntry {
  contentHash: ContentHash;
  /** Resolved MIME type, from `meta.contentType` or the blob's own type. */
  mime: string;
  /** Caller-owned provenance (prompt, model, dimensions, filename, …). */
  meta: AssetMeta;
}

/**
 * Promisify a single IndexedDB request.
 *
 * Awaiting one of these inside a multi-step transaction cannot strand the
 * caller: aborting a transaction fires `error` at every request still in its
 * request list, and a request issued *after* the abort throws synchronously on
 * the now-inactive transaction. Either way the step settles.
 */
function reqP<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

interface AssetStores {
  assets: IDBObjectStore;
  blobs: IDBObjectStore;
}

/**
 * The exported browser backend for the DSL asset seam ({@link StorageProvider}).
 */
export class BrowserAssetStore implements StorageProvider {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private dbPromise?: Promise<IDBDatabase>;
  private readonly urls = new ObjectUrlCache();

  constructor(options: BrowserAssetStoreOptions = {}) {
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'maic-asset-pool';
  }

  private openDb(): Promise<IDBDatabase> {
    // Do NOT cache a rejected open: a transient failure (private-mode IDB, a
    // one-off VersionError) would otherwise brick the store for the whole
    // session. Clear the memo on failure so the next call retries.
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        if (!db.objectStoreNames.contains(ASSETS)) {
          const assets = db.createObjectStore(ASSETS);
          assets.createIndex(BY_CONTENT_HASH, 'contentHash', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.dbPromise = undefined;
      throw err;
    });
    return this.dbPromise;
  }

  /**
   * Run a multi-step transaction spanning both stores.
   *
   * `run` may await between requests: every await inside it settles from an
   * IndexedDB event, which keeps the transaction alive. Anything slower (a
   * `crypto.subtle.digest`, a network call) must happen *before* the
   * transaction opens, or the transaction auto-commits mid-step.
   *
   * Resolves on commit, not on request success: a write that succeeds as a
   * request can still abort at commit (e.g. `QuotaExceededError`), and
   * reporting that as success would claim durability the store never gave —
   * the same rule the blob backend follows.
   */
  private async tx<T>(
    mode: IDBTransactionMode,
    run: (stores: AssetStores) => Promise<T>,
  ): Promise<T> {
    const db = await this.openDb();
    const transaction = db.transaction([ASSETS, BLOBS], mode);
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB error'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    const outcome = await run({
      assets: transaction.objectStore(ASSETS),
      blobs: transaction.objectStore(BLOBS),
    }).then(
      (value) => ({ value }),
      (error: unknown) => {
        // Never leave a half-applied transaction open behind a thrown step.
        try {
          transaction.abort();
        } catch {
          /* already finished — nothing to abort */
        }
        return { error };
      },
    );
    if ('error' in outcome) {
      await committed.catch(() => undefined);
      throw outcome.error;
    }
    await committed;
    return outcome.value;
  }

  /**
   * Store bytes and return a **newly allocated** id for them.
   *
   * Every call allocates a fresh id and writes a fresh registry entry, whether
   * or not these bytes were already in the pool. The caller cannot learn which
   * happened: there is no branch on existence to observe. The blob write is an
   * unconditional overwrite rather than a read-then-write, so the two cases run
   * the same statements, issue the same IndexedDB requests, and return the same
   * shape — a fresh id, indistinguishable from any other. Existence inference
   * over someone else's bytes is closed at the API shape, not merely
   * discouraged.
   *
   * (Wall-clock timing is not claimed to be constant — writing bytes that are
   * already present may be cheaper at the storage layer. The contract is that
   * no *value* the caller receives, and no branch this code takes, differs.)
   */
  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetId> {
    const { contentHash, bytes } = await contentHashOf(data);
    const entry: AssetEntry = {
      contentHash,
      mime: meta?.contentType ?? data.type ?? '',
      meta: meta ?? {},
    };
    const id = newAssetId();
    await this.tx('readwrite', async ({ assets, blobs }) => {
      await reqP(blobs.put(bytes, contentHash));
      await reqP(assets.put(entry, id));
    });
    return id;
  }

  /**
   * Resolve an id to a `blob:` URL, or `null` when nothing is stored under it.
   *
   * The id is treated as an opaque string. An id this store never allocated,
   * an id from another id space, an empty string, a string with a NUL in it —
   * all are misses, none are errors. There is no id validator to disagree with
   * (see `toAssetId`).
   */
  async resolve(ref: AssetRef): Promise<string | null> {
    return this.urls.resolve(ref, () => this.readAsUrl(ref));
  }

  private readAsUrl(ref: AssetRef): Promise<string | null> {
    return this.tx('readonly', async ({ assets, blobs }) => {
      const entry = await reqP<AssetEntry | undefined>(assets.get(ref));
      if (!entry) return null;
      const bytes = await reqP<ArrayBuffer | undefined>(blobs.get(entry.contentHash));
      // A registry entry whose bytes are gone resolves to a miss rather than
      // throwing: to the caller it is the same "no asset here" as an unknown
      // id, and inventing an error would make byte reclamation observable.
      if (!bytes) return null;
      return URL.createObjectURL(new Blob([bytes], { type: entry.mime }));
    });
  }

  /**
   * Drop the registry entry for an id, reclaiming its bytes if it was the last
   * entry naming them. Idempotent: removing an unknown or already-removed id
   * is a no-op, not an error.
   *
   * The reference count is read *inside* the same transaction as the delete,
   * over the `contentHash` index. That is what makes reclamation safe against a
   * concurrent `put` of the same bytes: IndexedDB serializes readwrite
   * transactions over the same stores, so the count either already includes the
   * new entry (and the bytes stay) or the new entry's transaction has not begun
   * (and it will rewrite the bytes itself, unconditionally).
   */
  async remove(ref: AssetRef): Promise<void> {
    await this.tx('readwrite', async ({ assets, blobs }) => {
      const entry = await reqP<AssetEntry | undefined>(assets.get(ref));
      if (!entry) return;
      await reqP(assets.delete(ref));
      const remaining = await reqP<number>(assets.index(BY_CONTENT_HASH).count(entry.contentHash));
      if (remaining === 0) await reqP(blobs.delete(entry.contentHash));
    });
    await this.urls.invalidate(ref);
  }
}
