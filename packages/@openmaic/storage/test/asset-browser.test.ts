import { IDBFactory } from 'fake-indexeddb';
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
