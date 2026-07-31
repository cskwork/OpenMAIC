import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test, vi } from 'vitest';
import { BrowserAssetStore, newAssetId, toAssetId } from '../src/index.js';
import { ASSET_ID_PREFIX } from '../src/asset/id.js';
import { blobForObjectUrl } from './setup.js';
import { runAssetStoreContract } from './asset-contract.js';

const readObjectUrl = async (url: string): Promise<Uint8Array> => {
  const b = blobForObjectUrl(url);
  if (!b) throw new Error(`no blob registered for object URL ${url}`);
  return new Uint8Array(await b.arrayBuffer());
};

runAssetStoreContract(
  'BrowserAssetStore',
  () => new BrowserAssetStore({ indexedDB: new IDBFactory(), dbName: 'test-asset-pool' }),
  readObjectUrl,
);

// ---------------------------------------------------------------------------
// Internal view: assertions the outward contract deliberately cannot make,
// because "the bytes are stored once" and "the bytes were reclaimed" are
// exactly the facts the outward API must not disclose. They are still the
// design's load-bearing claims, so they are checked here, against the rows.
// ---------------------------------------------------------------------------

function openRaw(idb: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(dbName, 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rowCount(idb: IDBFactory, dbName: string, store: string): Promise<number> {
  const db = await openRaw(idb, dbName);
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function entryRow(idb: IDBFactory, dbName: string, id: string): Promise<unknown> {
  const db = await openRaw(idb, dbName);
  return new Promise((resolve, reject) => {
    const req = db.transaction('assets', 'readonly').objectStore('assets').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rowKeys(idb: IDBFactory, dbName: string, store: string): Promise<IDBValidKey[]> {
  const db = await openRaw(idb, dbName);
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dropBlobRows(idb: IDBFactory, dbName: string): Promise<void> {
  const db = await openRaw(idb, dbName);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

interface Pool {
  idb: IDBFactory;
  dbName: string;
  store: BrowserAssetStore;
  /** A second instance over the same database — no shared in-memory URL cache. */
  cold: () => BrowserAssetStore;
  assets: () => Promise<number>;
  blobs: () => Promise<number>;
}

function makePool(dbName: string): Pool {
  const idb = new IDBFactory();
  return {
    idb,
    dbName,
    store: new BrowserAssetStore({ indexedDB: idb, dbName }),
    cold: () => new BrowserAssetStore({ indexedDB: idb, dbName }),
    assets: () => rowCount(idb, dbName, 'assets'),
    blobs: () => rowCount(idb, dbName, 'blobs'),
  };
}

const blob = (s: string, type = 'text/plain'): Blob => new Blob([s], { type });
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('BrowserAssetStore de-duplicates bytes beneath allocated ids', () => {
  test('N ids over identical bytes keep N registry rows and one blob row', async () => {
    const pool = makePool('dedup-pool');
    const ids = await Promise.all([
      pool.store.put(blob('dup me')),
      pool.store.put(blob('dup me')),
      pool.store.put(blob('dup me')),
    ]);
    expect(new Set(ids).size).toBe(3);
    expect(await pool.assets()).toBe(3);
    expect(await pool.blobs()).toBe(1);
  });

  test('distinct bytes keep distinct blob rows', async () => {
    const pool = makePool('distinct-pool');
    await pool.store.put(blob('a'));
    await pool.store.put(blob('b'));
    expect(await pool.blobs()).toBe(2);
  });
});

describe('BrowserAssetStore reclaims bytes at the last reference', () => {
  test('a cached URL is revoked when another instance removes its registry entry', async () => {
    const pool = makePool('cross-instance-cache');
    const id = await pool.store.put(blob('shared database'));
    const url = await pool.store.resolve(id);
    expect(url).not.toBeNull();
    expect(blobForObjectUrl(url!)).toBeDefined();

    await pool.cold().remove(id);

    await vi.waitFor(() => expect(blobForObjectUrl(url!)).toBeUndefined());
  });

  test('release revokes only this instance URL and leaves the registry untouched', async () => {
    const pool = makePool('consumer-release');
    const id = await pool.store.put(blob('displayed bytes'));
    const url = await pool.store.resolve(id);
    expect(blobForObjectUrl(url!)).toBeDefined();

    pool.store.release(id);
    pool.store.release(id);
    expect(() => pool.store.release('never allocated')).not.toThrow();
    await vi.waitFor(() => expect(blobForObjectUrl(url!)).toBeUndefined());
    expect(await pool.assets()).toBe(1);
    expect(await pool.blobs()).toBe(1);

    const nextUrl = await pool.store.resolve(id);
    expect(nextUrl).not.toBe(url);
    expect(await readObjectUrl(nextUrl!)).toEqual(bytes('displayed bytes'));
  });

  test('removing one of two ids drops the row but keeps the bytes', async () => {
    const pool = makePool('reclaim-partial');
    const a = await pool.store.put(blob('two owners'));
    const b = await pool.store.put(blob('two owners'));
    await pool.store.remove(a);
    expect(await pool.assets()).toBe(1);
    expect(await pool.blobs()).toBe(1);
    // Read through a cold instance so no cached object URL can mask a
    // reclamation that should not have happened.
    const url = await pool.cold().resolve(b);
    expect(url).not.toBeNull();
    expect(await readObjectUrl(url!)).toEqual(bytes('two owners'));
  });

  test('removing the last id reclaims the bytes', async () => {
    const pool = makePool('reclaim-last');
    const a = await pool.store.put(blob('sole owner'));
    const b = await pool.store.put(blob('sole owner'));
    await pool.store.remove(a);
    await pool.store.remove(b);
    expect(await pool.assets()).toBe(0);
    expect(await pool.blobs()).toBe(0);
  });

  test('removing one asset does not reclaim an unrelated assets bytes', async () => {
    const pool = makePool('reclaim-unrelated');
    const a = await pool.store.put(blob('doomed'));
    await pool.store.put(blob('bystander'));
    await pool.store.remove(a);
    expect(await pool.blobs()).toBe(1);
  });

  test('a repeated remove reclaims nothing twice', async () => {
    const pool = makePool('reclaim-idempotent');
    const a = await pool.store.put(blob('once'));
    const b = await pool.store.put(blob('twice'));
    await pool.store.remove(a);
    await pool.store.remove(a);
    expect(await pool.blobs()).toBe(1);
    expect(await pool.store.resolve(b)).not.toBeNull();
  });

  test('a concurrent put of the same bytes is never orphaned by the last remove', async () => {
    const pool = makePool('reclaim-race');
    const first = await pool.store.put(blob('contended bytes'));
    // The removal of the only reference races a put that adopts the same bytes.
    // Whichever transaction commits first, the surviving id must resolve.
    const [second] = await Promise.all([
      pool.store.put(blob('contended bytes')),
      pool.store.remove(first),
    ]);
    expect(await pool.assets()).toBe(1);
    expect(await pool.blobs()).toBe(1);
    const url = await pool.cold().resolve(second);
    expect(url).not.toBeNull();
    expect(await readObjectUrl(url!)).toEqual(bytes('contended bytes'));
  });

  test('an entry whose bytes are already gone resolves to null and removes cleanly', async () => {
    const pool = makePool('dangling-entry');
    const id = await pool.store.put(blob('orphan'));
    await dropBlobRows(pool.idb, pool.dbName);
    expect(await pool.cold().resolve(id)).toBeNull();
    await expect(pool.store.remove(id)).resolves.toBeUndefined();
    expect(await pool.assets()).toBe(0);
  });
});

describe('BrowserAssetStore replaces bytes behind stable ids', () => {
  test('keeps the id stable, revokes the old URL, and resolves the new bytes', async () => {
    const pool = makePool('replace-stable');
    const id = await pool.store.put(blob('before'));
    const oldUrl = await pool.store.resolve(id);

    await expect(pool.store.replace(id, blob('after'))).resolves.toBeUndefined();

    expect(blobForObjectUrl(oldUrl!)).toBeUndefined();
    const newUrl = await pool.store.resolve(id);
    expect(newUrl).not.toBe(oldUrl);
    expect(await readObjectUrl(newUrl!)).toEqual(bytes('after'));
  });

  test('broadcasts replacement so another instance revokes its cached URL', async () => {
    const pool = makePool('replace-cross-instance');
    const id = await pool.store.put(blob('before'));
    const reader = pool.cold();
    const oldUrl = await reader.resolve(id);

    await pool.store.replace(id, blob('after'));

    await vi.waitFor(() => expect(blobForObjectUrl(oldUrl!)).toBeUndefined());
    const newUrl = await reader.resolve(id);
    expect(await readObjectUrl(newUrl!)).toEqual(bytes('after'));
  });

  test('reclaims the old blob when the replaced id was its last reference', async () => {
    const pool = makePool('replace-reclaim-last');
    const id = await pool.store.put(blob('old bytes'));
    const [oldHash] = await rowKeys(pool.idb, pool.dbName, 'blobs');

    await pool.store.replace(id, blob('new bytes'));

    expect(await pool.assets()).toBe(1);
    expect(await pool.blobs()).toBe(1);
    expect(await rowKeys(pool.idb, pool.dbName, 'blobs')).not.toContain(oldHash);
  });

  test('keeps the old blob while a sibling id still references it', async () => {
    const pool = makePool('replace-reclaim-shared');
    const replaced = await pool.store.put(blob('shared old bytes'));
    const sibling = await pool.store.put(blob('shared old bytes'));
    const [oldHash] = await rowKeys(pool.idb, pool.dbName, 'blobs');

    await pool.store.replace(replaced, blob('new bytes'));

    expect(await pool.blobs()).toBe(2);
    expect(await rowKeys(pool.idb, pool.dbName, 'blobs')).toContain(oldHash);
    const siblingUrl = await pool.cold().resolve(sibling);
    expect(await readObjectUrl(siblingUrl!)).toEqual(bytes('shared old bytes'));
  });

  test('deduplicates replacement bytes already in the pool without changing its outcome', async () => {
    const pool = makePool('replace-dedup-hit');
    const replaced = await pool.store.put(blob('old bytes'));
    const existing = await pool.store.put(blob('target bytes'));

    const result = await pool.store.replace(replaced, blob('target bytes'));

    expect(result).toBeUndefined();
    expect(await pool.assets()).toBe(2);
    expect(await pool.blobs()).toBe(1);
    for (const id of [replaced, existing]) {
      const url = await pool.cold().resolve(id);
      expect(await readObjectUrl(url!)).toEqual(bytes('target bytes'));
    }
  });

  test('rejects replacing an unknown id', async () => {
    const pool = makePool('replace-unknown');
    await expect(pool.store.replace(toAssetId('not allocated'), blob('bytes'))).rejects.toThrow(
      /unknown asset id/i,
    );
    expect(await pool.assets()).toBe(0);
    expect(await pool.blobs()).toBe(0);
  });

  test('keeps metadata when omitted and replaces it when provided', async () => {
    const pool = makePool('replace-meta');
    const id = await pool.store.put(blob('one', 'image/png'), {
      contentType: 'image/png',
      prompt: 'first prompt',
      nested: { seed: 1 },
    });

    await pool.store.replace(id, blob('two', 'image/webp'));
    let row = (await entryRow(pool.idb, pool.dbName, id)) as {
      meta: unknown;
      mime: string;
    };
    expect(row.meta).toEqual({
      contentType: 'image/png',
      prompt: 'first prompt',
      nested: { seed: 1 },
    });
    expect(row.mime).toBe('image/webp');

    const updated = { contentType: 'image/jpeg', prompt: 'second prompt' };
    await pool.store.replace(id, blob('three', 'image/webp'), updated);
    row = (await entryRow(pool.idb, pool.dbName, id)) as { meta: unknown; mime: string };
    expect(row.meta).toEqual(updated);
    expect(row.mime).toBe('image/jpeg');
  });

  test('a concurrent replace and remove leaves no orphan or dangling row', async () => {
    const pool = makePool('replace-remove-race');
    const id = await pool.store.put(blob('before race'));

    const [replaceResult, removeResult] = await Promise.allSettled([
      pool.store.replace(id, blob('after race')),
      pool.store.remove(id),
    ]);

    expect(removeResult.status).toBe('fulfilled');
    if (replaceResult.status === 'rejected') {
      expect(replaceResult.reason).toMatchObject({ message: expect.stringMatching(/unknown/i) });
    }
    expect(await pool.assets()).toBe(0);
    expect(await pool.blobs()).toBe(0);
    expect(await pool.cold().resolve(id)).toBeNull();
  });
});

describe('BrowserAssetStore registry rows', () => {
  test('carry contentHash, mime and meta, and no principal', async () => {
    const pool = makePool('row-shape');
    const id = await pool.store.put(blob('shaped', 'image/png'), { contentType: 'image/png' });
    const row = await entryRow(pool.idb, pool.dbName, id);
    expect(Object.keys(row as object).sort()).toEqual(['contentHash', 'meta', 'mime']);
    // A principal is derived server-side from an authenticated session; the
    // browser has none to derive, so the browser registry models none.
    expect(row).not.toHaveProperty('principal');
  });

  test('round-trip meta verbatim, including nested provenance', async () => {
    const pool = makePool('meta-fidelity');
    const meta = {
      contentType: 'image/png',
      prompt: 'a cat on a windowsill',
      model: 'some-image-model',
      dimensions: { width: 1024, height: 768 },
      tags: ['generated', 'slide-3'],
      seed: 42,
      nested: { deep: { value: null } },
    };
    const id = await pool.store.put(blob('pixels'), meta);
    const row = (await entryRow(pool.idb, pool.dbName, id)) as { meta: unknown };
    expect(row.meta).toEqual(meta);
  });

  test('default meta to an empty object when the caller passes none', async () => {
    const pool = makePool('meta-absent');
    const id = await pool.store.put(blob('bare'));
    const row = (await entryRow(pool.idb, pool.dbName, id)) as { meta: unknown };
    expect(row.meta).toEqual({});
  });

  test('rejects non-cloneable metadata before put opens a write transaction', async () => {
    const pool = makePool('meta-clone-put');
    const seed = await pool.store.put(blob('schema seed'));
    await pool.store.remove(seed);
    const meta = { callback: () => undefined };
    await expect(pool.store.put(blob('never written'), meta)).rejects.toThrow(
      /metadata values must be structured-cloneable/i,
    );
    expect(await pool.assets()).toBe(0);
    expect(await pool.blobs()).toBe(0);
  });

  test('rejects non-cloneable replacement metadata without changing stored rows', async () => {
    const pool = makePool('meta-clone-replace');
    const id = await pool.store.put(blob('kept'));
    const meta = { callback: () => undefined };

    await expect(pool.store.replace(id, blob('rejected'), meta)).rejects.toThrow(
      /metadata values must be structured-cloneable/i,
    );

    expect(await pool.assets()).toBe(1);
    expect(await pool.blobs()).toBe(1);
    const url = await pool.cold().resolve(id);
    expect(await readObjectUrl(url!)).toEqual(bytes('kept'));
  });

  test('take mime from meta.contentType, falling back to the blob type', async () => {
    const pool = makePool('mime-source');
    const explicit = await pool.store.put(blob('x', 'text/plain'), { contentType: 'image/png' });
    const implicit = await pool.store.put(blob('y', 'audio/mpeg'));
    const untyped = await pool.store.put(new Blob(['z'], { type: '' }));
    expect(blobForObjectUrl((await pool.store.resolve(explicit))!)?.type).toBe('image/png');
    expect(blobForObjectUrl((await pool.store.resolve(implicit))!)?.type).toBe('audio/mpeg');
    expect(blobForObjectUrl((await pool.store.resolve(untyped))!)?.type).toBe('');
  });

  test('give the same bytes independent mime per id', async () => {
    const pool = makePool('mime-per-id');
    const png = await pool.store.put(blob('same bytes'), { contentType: 'image/png' });
    const jpeg = await pool.store.put(blob('same bytes'), { contentType: 'image/jpeg' });
    expect(await pool.blobs()).toBe(1);
    expect(blobForObjectUrl((await pool.store.resolve(png))!)?.type).toBe('image/png');
    expect(blobForObjectUrl((await pool.store.resolve(jpeg))!)?.type).toBe('image/jpeg');
  });
});

describe('BrowserAssetStore never surfaces a content hash', () => {
  test('the allocated id is unrelated to the stored bytes', async () => {
    const pool = makePool('hash-hiding');
    const id = await pool.store.put(blob('secret bytes'));
    const row = (await entryRow(pool.idb, pool.dbName, id)) as { contentHash: string };
    expect(row.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(id).not.toContain(row.contentHash);
    expect(id).not.toContain('sha256');
  });

  test('a content hash is not accepted as a reference', async () => {
    const pool = makePool('hash-not-a-ref');
    const id = await pool.store.put(blob('secret bytes'));
    const { contentHash } = (await entryRow(pool.idb, pool.dbName, id)) as { contentHash: string };
    // Knowing the hash buys nothing: it is a private storage key, not a handle.
    expect(await pool.store.resolve(contentHash)).toBeNull();
    await expect(pool.store.remove(contentHash)).resolves.toBeUndefined();
    expect(await pool.store.resolve(id)).not.toBeNull();
  });
});

test('BrowserAssetStore mints an object URL only after its read transaction commits', async () => {
  const pool = makePool('mint-after-commit');
  const id = await pool.store.put(blob('transaction ordering'));
  const db = await openRaw(pool.idb, pool.dbName);
  const proto = Object.getPrototypeOf(db) as IDBDatabase;
  const originalTransaction = proto.transaction;
  let activeReadonlyTransactions = 0;
  const activeCountsAtMint: number[] = [];

  proto.transaction = function patched(
    this: IDBDatabase,
    storeNames: string | string[],
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ): IDBTransaction {
    const tx = originalTransaction.call(this, storeNames, mode, options);
    if ((mode ?? 'readonly') === 'readonly') {
      activeReadonlyTransactions += 1;
      const finished = () => {
        activeReadonlyTransactions -= 1;
      };
      tx.addEventListener('complete', finished, { once: true });
      tx.addEventListener('abort', finished, { once: true });
    }
    return tx;
  } as IDBDatabase['transaction'];

  const originalCreateObjectURL = URL.createObjectURL;
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    activeCountsAtMint.push(activeReadonlyTransactions);
    return originalCreateObjectURL(value);
  });
  try {
    expect(await pool.store.resolve(id)).not.toBeNull();
    expect(activeCountsAtMint).toEqual([0]);
  } finally {
    createObjectURL.mockRestore();
    proto.transaction = originalTransaction;
  }
});

describe('allocated asset ids', () => {
  test('carry the type prefix and a fixed-width body', async () => {
    const id = newAssetId();
    expect(id.startsWith(ASSET_ID_PREFIX)).toBe(true);
    // 128 bits in a 32-symbol alphabet: 26 symbols.
    expect(id).toMatch(/^ast_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
  });

  test('do not repeat', () => {
    const minted = new Set(Array.from({ length: 2000 }, () => newAssetId()));
    expect(minted.size).toBe(2000);
  });

  test('fail clearly when crypto.getRandomValues is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const crypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { subtle: crypto.subtle },
      configurable: true,
    });
    try {
      expect(() => newAssetId()).toThrow(/crypto\.getRandomValues.*secure context/i);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });

  test('are the same width regardless of what they end up naming', async () => {
    const pool = makePool('id-width');
    const small = await pool.store.put(blob('x'));
    const large = await pool.store.put(blob('y'.repeat(100_000)));
    expect(small.length).toBe(large.length);
  });

  test('toAssetId brands without validating', async () => {
    const pool = makePool('id-brand');
    // Deliberately not an id this store issued: branding is a compile-time act,
    // so the runtime answer is a miss rather than a rejection.
    expect(await pool.store.resolve(toAssetId('not an id at all'))).toBeNull();
  });
});

describe('BrowserAssetStore failure handling', () => {
  test('an allocated-id collision aborts without overwriting or orphaning bytes', async () => {
    const pool = makePool('id-collision');
    const random = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
        return array;
      });
    try {
      const first = await pool.store.put(blob('kept bytes'));
      await expect(pool.store.put(blob('rejected bytes'))).rejects.toThrow();
      const url = await pool.store.resolve(first);
      expect(url).not.toBeNull();
      expect(await readObjectUrl(url!)).toEqual(bytes('kept bytes'));
      expect(await pool.assets()).toBe(1);
      expect(await pool.blobs()).toBe(1);
    } finally {
      random.mockRestore();
    }
  });

  test('recovers after a transient open failure instead of replaying it', async () => {
    const real = new IDBFactory();
    const seeded = new BrowserAssetStore({ indexedDB: real, dbName: 'flaky-pool' });
    const id = await seeded.put(blob('seed'));

    let failNextOpen = true;
    const flaky = {
      open: (name: string, version?: number) => {
        if (failNextOpen) {
          failNextOpen = false;
          throw new Error('transient open failure');
        }
        return real.open(name, version);
      },
      deleteDatabase: real.deleteDatabase.bind(real),
      cmp: real.cmp.bind(real),
      databases: real.databases?.bind(real),
    } as unknown as IDBFactory;

    const store = new BrowserAssetStore({ indexedDB: flaky, dbName: 'flaky-pool' });
    await expect(store.resolve(id)).rejects.toThrow();
    expect(await store.resolve(id)).not.toBeNull();
  });

  // A write whose requests all SUCCEED and whose transaction then dies before
  // commit — what an over-quota commit does — must be reported as a failure and
  // leave nothing behind. Reporting request success as durability would claim
  // something the store never gave, so `put` resolves on commit, not on the
  // last request. The abort here is triggered from the success handler of the
  // final write, so every request the store awaits has already succeeded.
  test('a write whose requests succeed but whose transaction aborts still rejects', async () => {
    const pool = makePool('abort-pool');
    await pool.store.put(blob('before the failure'));
    const db = await openRaw(pool.idb, pool.dbName);
    const proto = Object.getPrototypeOf(
      db.transaction('blobs', 'readonly').objectStore('blobs'),
    ) as IDBObjectStore;
    const originalAdd = proto.add;
    proto.add = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const req = originalAdd.call(this, value, key);
      // Only the registry write (keyed by the allocated id) arms the abort, so
      // the blob write ahead of it completes normally and the store sees a
      // fully successful sequence of requests.
      if (typeof key === 'string' && key.startsWith(ASSET_ID_PREFIX)) {
        const tx = this.transaction;
        req.addEventListener('success', () => tx.abort());
      }
      return req;
    };
    try {
      await expect(pool.store.put(blob('doomed write'))).rejects.toThrow();
    } finally {
      proto.add = originalAdd;
    }
    expect(await pool.assets()).toBe(1);
    expect(await pool.blobs()).toBe(1);
  });
});
