// The INTERNAL blob layer. Imported from its module rather than the package
// entry point on purpose: `BrowserAssetProvider` is not exported, because a
// content-addressed ref is a de-duplication signal no outward API may emit.
// Its semantics are still pinned here — the registry above it relies on them.
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import type { StorageProvider } from '@openmaic/dsl';
import { BrowserAssetProvider } from '../src/asset/browser.js';
import { contentHashOf, type BlobStore } from '../src/asset/blob.js';
import { blobForObjectUrl, objectUrlCount } from './setup.js';
import { runBlobStoreContract } from './asset-blob-contract.js';

runBlobStoreContract(
  'BrowserAssetProvider',
  () => new BrowserAssetProvider({ indexedDB: new IDBFactory(), dbName: 'test-assets' }),
  async (url) => {
    const b = blobForObjectUrl(url);
    if (!b) throw new Error(`no blob registered for object URL ${url}`);
    return new Uint8Array(await b.arrayBuffer());
  },
);

test('content hashing fails clearly when crypto.subtle is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const crypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: crypto.getRandomValues.bind(crypto), subtle: undefined },
    configurable: true,
  });
  try {
    await expect(contentHashOf(new Blob(['bytes']))).rejects.toThrow(
      /crypto\.subtle.*secure context/i,
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

test('the internal blob layer is not assignable to the allocated-id DSL contract', () => {
  const provider = new BrowserAssetProvider({
    indexedDB: new IDBFactory(),
    dbName: 'type-separation',
  });
  const blobStore: BlobStore = provider;
  const assignProvider = (): StorageProvider =>
    // @ts-expect-error content hashes are not allocated asset refs.
    provider;
  const assignBlobStore = (): StorageProvider =>
    // @ts-expect-error the branded, contravariant hash parameter keeps the contracts distinct.
    blobStore;

  expect(typeof assignProvider).toBe('function');
  expect(typeof assignBlobStore).toBe('function');
});

// Re-putting the same bytes with a corrected contentType must not leave a
// stale cached object URL: resolve() has to reflect the latest write, not
// whatever was cached first (otherwise MIME depends on cache warmth).
test('BrowserAssetProvider re-put updates the resolved contentType', async () => {
  const provider = new BrowserAssetProvider({ indexedDB: new IDBFactory(), dbName: 'mime-db' });
  const key = await provider.put(new Blob(['pixels'], { type: '' }));
  const first = await provider.resolve(key);
  expect(blobForObjectUrl(first!)?.type).toBe('');

  await provider.put(new Blob(['pixels'], { type: 'image/png' }));
  const second = await provider.resolve(key);
  expect(blobForObjectUrl(second!)?.type).toBe('image/png');
});

test('BrowserAssetProvider release reclaims a removed key snapshot', async () => {
  const provider = new BrowserAssetProvider({
    indexedDB: new IDBFactory(),
    dbName: 'remove-release-db',
  });
  const key = await provider.put(new Blob(['temporary'], { type: 'text/plain' }));
  const url = await provider.resolve(key);
  expect(blobForObjectUrl(url!)).toBeDefined();

  await provider.remove(key);
  expect(blobForObjectUrl(url!)).toBeDefined();
  await provider.release(key);

  expect(blobForObjectUrl(url!)).toBeUndefined();
  expect(objectUrlCount()).toBe(0);
  await provider.close();
});

test('BrowserAssetProvider close reclaims re-put snapshot churn', async () => {
  const provider = new BrowserAssetProvider({
    indexedDB: new IDBFactory(),
    dbName: 'churn-close-db',
  });

  for (let version = 0; version < 20; version += 1) {
    const key = await provider.put(
      new Blob(['same bytes'], { type: `application/x-version-${version}` }),
    );
    await provider.resolve(key);
  }
  expect(objectUrlCount()).toBe(20);

  await provider.close();

  expect(objectUrlCount()).toBe(0);
});

// A transient failure in resolve() must not be cached: the next resolve(key)
// has to retry, not replay the rejection.
test('BrowserAssetProvider recovers after a transient resolve failure', async () => {
  const real = new IDBFactory();
  const key = await new BrowserAssetProvider({ indexedDB: real, dbName: 'flaky-db' }).put(
    new Blob(['seed'], { type: 'text/plain' }),
  );

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

  const provider = new BrowserAssetProvider({ indexedDB: flaky, dbName: 'flaky-db' });
  await expect(provider.resolve(key)).rejects.toThrow(); // first open throws
  const url = await provider.resolve(key); // retry must succeed, not replay the rejection
  expect(url).not.toBeNull();
});

// Backend-specific: the content-addressing contract asserts identical bytes
// yield the same key; this asserts they actually collapse to ONE stored row,
// so a backend that appended duplicates couldn't pass silently.
test('BrowserAssetProvider stores identical bytes exactly once', async () => {
  const idb = new IDBFactory();
  const provider = new BrowserAssetProvider({ indexedDB: idb, dbName: 'dedup-db' });
  await provider.put(new Blob(['dup me'], { type: 'text/plain' }));
  await provider.put(new Blob(['dup me'], { type: 'text/plain' }));

  const count = await new Promise<number>((resolve, reject) => {
    const open = idb.open('dedup-db', 1);
    open.onsuccess = () => {
      const req = open.result.transaction('assets', 'readonly').objectStore('assets').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
  expect(count).toBe(1);
});
