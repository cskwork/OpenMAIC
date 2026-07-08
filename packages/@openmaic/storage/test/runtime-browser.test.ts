import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore } from '../src/index.js';
import { runRuntimeStoreContract } from './runtime-contract.js';

// The runtime backend builds its ranged record reads with the ambient
// `IDBKeyRange` — in a real browser it is always provided alongside
// `indexedDB`. Tests inject a fake factory, so supply the matching fake range
// class as the ambient global (what `fake-indexeddb/auto` would do, minus the
// ambient factory the store deliberately takes by injection instead).
globalThis.IDBKeyRange = IDBKeyRange;

// Each store gets its own in-memory IndexedDB factory so contract cases stay
// isolated without leaning on an ambient global.
runRuntimeStoreContract(
  'BrowserRuntimeStore',
  () => new BrowserRuntimeStore({ indexedDB: new IDBFactory() }),
);
