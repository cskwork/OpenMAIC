import { describe, expect, test } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { RUNTIME_DSL_VERSION_KEY } from '@openmaic/dsl';
import { BrowserRuntimeStore } from '../src/index.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

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

// --- backend-specific: version-skew behaviours need to seed a raw session row
// at a foreign version, which the public API (the store always stamps the
// current version) can't express. Mirrors the document backend's reStampStage. ---

// Open the raw DB the store uses and overwrite the session row's version stamp,
// simulating a session written by another (older / newer / broken) client.
// `version: undefined` DELETES the stamp — a corrupt row no producer can write.
async function reStampSession(
  idb: IDBFactory,
  dbName: string,
  sessionId: string,
  version: string | undefined,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const get = store.get(sessionId);
    get.onsuccess = () => {
      const row = get.result as Record<string, unknown>;
      if (version === undefined) delete row[RUNTIME_DSL_VERSION_KEY];
      else row[RUNTIME_DSL_VERSION_KEY] = version;
      store.put(row);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('BrowserRuntimeStore migrate-on-read', () => {
  test('a stale-stamped session fails loud on read (no ladder path yet)', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-stale';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    await reStampSession(idb, dbName, 'sess-1', '0.0.9');

    // The runtime ladder is EMPTY today (the initial runtime version IS the
    // current one), so a past stamp has no migration path and the ladder fails
    // loud rather than guessing. When the first real runtime migration lands,
    // this test flips to asserting the lift — a stale session migrated forward
    // on read, mirroring the document backend's legacy-stamp test.
    await expect(store.getSession('sess-1')).rejects.toThrow(/no migration path/);
  });
});

describe('BrowserRuntimeStore forward-compatibility', () => {
  test('a future-stamped session reads through unchanged but rejects writes', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-future';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    await reStampSession(idb, dbName, 'sess-1', '9.9.9');

    // Read never downgrades: the newer-shaped row survives for the next
    // compatible reader.
    const loaded = await store.getSession('sess-1');
    expect(loaded!.runtimeDslVersion).toBe('9.9.9');

    // ...but an older client must not mutate newer-versioned data.
    await expect(store.appendRecord(makeRecordInit('sess-1'))).rejects.toThrow(
      /newer than this client/,
    );
    await expect(
      store.setSessionStatus('sess-1', 'completed', '2026-01-01T00:01:00.000Z'),
    ).rejects.toThrow(/newer than this client/);
  });
});

describe('BrowserRuntimeStore injected payload validators', () => {
  test('payloadValidators: {} replaces (not merges) the default skeleton gate', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators: {},
    });
    await store.createSession(makeSession()); // kind: 'chat'
    // A non-skeleton chat payload — rejected by the default map (see the
    // contract suite), accepted once the app owns the whole mapping.
    await expect(
      store.appendRecord(makeRecordInit('sess-1', { payload: { phase: 'draft' } })),
    ).resolves.toMatchObject({ seq: 0 });
  });

  test('a custom validator gates its kind with its own message', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators: {
        playback: (p) =>
          typeof p === 'object' && p !== null && 'position' in p
            ? { valid: true }
            : {
                valid: false,
                errors: [{ path: '/payload', message: 'playback payload requires a position' }],
              },
      },
    });
    await store.createSession(makeSession({ kind: 'playback' }));
    await expect(
      store.appendRecord(makeRecordInit('sess-1', { payload: { position: 1 } })),
    ).resolves.toMatchObject({ seq: 0 });
    await expect(
      store.appendRecord(makeRecordInit('sess-1', { payload: { note: 'x' } })),
    ).rejects.toThrow(/playback payload requires a position/);
  });
});

describe('BrowserRuntimeStore corrupt rows', () => {
  test('a raw row missing its runtime stamp fails loud on read', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-unstamped';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    await reStampSession(idb, dbName, 'sess-1', undefined); // strip the stamp

    // The runtime line has no unversioned epoch: sessions are born stamped, so
    // an unstamped stored row is corruption (or a misrouted document-line
    // aggregate), never legacy data — it fails loud instead of resurrecting
    // silently at some guessed version.
    await expect(store.getSession('sess-1')).rejects.toThrow(/no unversioned epoch/);
  });
});
