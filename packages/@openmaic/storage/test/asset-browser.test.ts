import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { BrowserAssetProvider } from '../src/index.js';
import { blobForObjectUrl } from './setup.js';
import { runStorageProviderContract } from './asset-contract.js';

runStorageProviderContract(
  'BrowserAssetProvider',
  () => new BrowserAssetProvider({ indexedDB: new IDBFactory(), dbName: 'test-assets' }),
  async (url) => {
    const b = blobForObjectUrl(url);
    if (!b) throw new Error(`no blob registered for object URL ${url}`);
    return new Uint8Array(await b.arrayBuffer());
  },
);

// Backend-specific: the content-addressing contract asserts identical bytes
// yield the same ref; this asserts they actually collapse to ONE stored row,
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
