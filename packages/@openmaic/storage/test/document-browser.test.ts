import { describe, expect, test } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { DSL_VERSION, DSL_VERSION_KEY, validateScene } from '@openmaic/dsl';
import { BrowserDocumentStore, type MaicDocument } from '../src/index.js';
import { runDocumentStoreContract, makeDocument, slideScene } from './document-contract.js';

// Each store gets its own in-memory IndexedDB factory so contract cases stay
// isolated without leaning on an ambient global.
function makeStore(): BrowserDocumentStore {
  return new BrowserDocumentStore({ indexedDB: new IDBFactory() });
}

runDocumentStoreContract('BrowserDocumentStore', makeStore);

// --- backend-specific: migrate-on-read needs to seed a raw row at an old
// version, which the public API (which always stamps the current version) can't
// express. ---
describe('BrowserDocumentStore migrate-on-read', () => {
  // Open the raw DB the store uses and overwrite the stage row's version stamp,
  // simulating a document written by an older client.
  async function reStampStage(
    idb: IDBFactory,
    dbName: string,
    stageId: string,
    version: string | undefined,
  ): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('stages', 'readwrite');
      const store = tx.objectStore('stages');
      const get = store.get(stageId);
      get.onsuccess = () => {
        const row = get.result as Record<string, unknown>;
        if (version === undefined) delete row[DSL_VERSION_KEY];
        else row[DSL_VERSION_KEY] = version;
        store.put(row);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  test('stamps a legacy (unversioned) document forward on load', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-legacy';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument());
    await reStampStage(idb, dbName, 'stage-1', undefined);

    const loaded = await store.loadDocument('stage-1');
    expect(loaded!.dslVersion).toBe(DSL_VERSION);
  });

  test('returns a future-versioned document untouched (no downgrade)', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-future';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument());
    await reStampStage(idb, dbName, 'stage-1', '99.0.0');

    const loaded = await store.loadDocument('stage-1');
    expect(loaded!.dslVersion).toBe('99.0.0');
  });

  test('getScene reads a future-versioned document without downgrade', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-future-scene';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument());
    await reStampStage(idb, dbName, 'stage-1', '99.0.0');

    // A document at/above the current version needs no migration, so getScene
    // returns the row directly (never downgraded).
    const scene = await store.getScene('stage-1', 'scene-a');
    expect(scene!.id).toBe('scene-a');
  });

  test('getScene migrates a stale (legacy) document on read', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-stale-scene';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument());
    await reStampStage(idb, dbName, 'stage-1', undefined); // legacy

    // A stale document routes getScene through the whole-document migrate path.
    const scene = await store.getScene('stage-1', 'scene-a');
    expect(scene!.id).toBe('scene-a');
  });

  test('putScene rejects when the stored document is not current', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-putscene-noncurrent';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument());

    // Legacy stored document: the other scenes have not been migrated, so
    // stamping the whole document current off one incremental write would
    // corrupt them — reject and require a full load + save first.
    await reStampStage(idb, dbName, 'stage-1', undefined);
    await expect(store.putScene('stage-1', slideScene('stage-1', 'new', 2))).rejects.toThrow();
    // rejected write left nothing behind (a legacy doc still migrates on read)
    expect(await store.getScene('stage-1', 'new')).toBeNull();

    // Future stored document: an old client must not downgrade it.
    await reStampStage(idb, dbName, 'stage-1', '99.0.0');
    await expect(store.putScene('stage-1', slideScene('stage-1', 'new2', 3))).rejects.toThrow();
    expect(await store.getScene('stage-1', 'new2')).toBeNull();
  });

  test('refuses to overwrite a stored document written by a newer client', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-overwrite-future';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument()); // current
    await reStampStage(idb, dbName, 'stage-1', '99.0.0'); // stored as future

    // A fresh/current document for the same id (its own dslVersion is not future,
    // so the incoming-version guard passes) must still not clobber the newer
    // stored document — the store checks the stored row inside the write tx.
    const fresh = makeDocument();
    fresh.stage.name = 'Old Client Overwrite';
    await expect(store.saveDocument(fresh)).rejects.toThrow();

    const loaded = await store.loadDocument('stage-1');
    expect(loaded!.dslVersion).toBe('99.0.0');
    expect(loaded!.stage.name).toBe('Intro Course');
  });

  test('deleteScene rejects when the stored document is not current', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-deletescene-noncurrent';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument());

    // Future stored document: an old client must not mutate newer-versioned data
    // (mirrors the putScene guard — deleting a scene is an incremental mutation).
    await reStampStage(idb, dbName, 'stage-1', '99.0.0');
    await expect(store.deleteScene('stage-1', 'scene-a')).rejects.toThrow();
    expect((await store.loadDocument('stage-1'))!.scenes.map((s) => s.id)).toEqual([
      'scene-a',
      'scene-b',
    ]);

    // Stale stored document must be normalized (load + save) before incremental ops.
    await reStampStage(idb, dbName, 'stage-1', undefined);
    await expect(store.deleteScene('stage-1', 'scene-a')).rejects.toThrow();
  });

  test('fails loud on a malformed stored version stamp', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-documents-malformed';
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName });
    await store.saveDocument(makeDocument());
    // A present-but-corrupt stamp makes a false version claim; reads must throw
    // rather than silently comparing it as some arbitrary version.
    await reStampStage(idb, dbName, 'stage-1', 'not-a-version');
    await expect(store.loadDocument('stage-1')).rejects.toThrow();
    await expect(store.getScene('stage-1', 'scene-a')).rejects.toThrow();
    // saveDocument reads the stored stamp inside its future-overwrite guard, so a
    // corrupt stored stamp also fails loud (recoverable via deleteDocument).
    await expect(store.saveDocument(makeDocument())).rejects.toThrow();
  });
});

// The store is generic over the scene type: an app can persist its own widened
// scene union (kinds the DSL does not own, e.g. `interactive`) by injecting a
// matching validator. The store treats scene content opaquely.
describe('BrowserDocumentStore with an app-widened scene union', () => {
  interface InteractiveScene {
    id: string;
    stageId: string;
    title: string;
    order: number;
    type: 'interactive';
    content: { type: 'interactive'; html: string };
  }

  // Accept the app's own kind, else fall back to the DSL validator (slide/quiz).
  const validateAppScene = (scene: unknown) => {
    const s = scene as { type?: unknown; id?: unknown };
    if (s.type === 'interactive') {
      return typeof s.id === 'string'
        ? { valid: true as const }
        : { valid: false as const, errors: [{ path: '/id', message: 'expected string id' }] };
    }
    return validateScene(scene);
  };

  const interactiveDoc: MaicDocument<InteractiveScene> = {
    stage: { id: 'stage-1', name: 'Interactive Course', createdAt: 1, updatedAt: 2 },
    scenes: [
      {
        id: 'i1',
        stageId: 'stage-1',
        title: 'Widget',
        order: 0,
        type: 'interactive',
        content: { type: 'interactive', html: '<div/>' },
      },
    ],
  };

  test('persists an app-only interactive scene via an injected validator', async () => {
    const store = new BrowserDocumentStore<InteractiveScene>({
      indexedDB: new IDBFactory(),
      validateScene: validateAppScene,
    });
    await store.saveDocument(interactiveDoc);

    const loaded = await store.loadDocument('stage-1');
    expect(loaded!.scenes[0]).toMatchObject({
      type: 'interactive',
      content: { type: 'interactive', html: '<div/>' },
    });
  });

  test('the default store (DSL validator) rejects an app-only scene kind', async () => {
    const store = new BrowserDocumentStore({ indexedDB: new IDBFactory() });
    await expect(store.saveDocument(interactiveDoc as unknown as MaicDocument)).rejects.toThrow();
  });

  test('supports incremental scene ops for an app scene union', async () => {
    const store = new BrowserDocumentStore<InteractiveScene>({
      indexedDB: new IDBFactory(),
      validateScene: validateAppScene,
    });
    await store.saveDocument(interactiveDoc);

    const added: InteractiveScene = {
      id: 'i2',
      stageId: 'stage-1',
      title: 'Widget 2',
      order: 1,
      type: 'interactive',
      content: { type: 'interactive', html: '<span/>' },
    };
    await store.putScene('stage-1', added);
    expect((await store.getScene('stage-1', 'i2'))!.content.html).toBe('<span/>');

    await store.deleteScene('stage-1', 'i1');
    expect((await store.loadDocument('stage-1'))!.scenes.map((s) => s.id)).toEqual(['i2']);
  });

  test('enforces the phantom-partition guard even under a permissive validator', async () => {
    // A validator that accepts everything must NOT be able to weaken the store's
    // own key invariant: a scene whose stageId disagrees with its document is
    // still rejected (assertStorableScene runs independently of the validator).
    const store = new BrowserDocumentStore<InteractiveScene>({
      indexedDB: new IDBFactory(),
      validateScene: () => ({ valid: true }),
    });
    const mismatched: MaicDocument<InteractiveScene> = {
      stage: { id: 'stage-1', name: 'C', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'x',
          stageId: 'other-stage',
          title: 'W',
          order: 0,
          type: 'interactive',
          content: { type: 'interactive', html: '' },
        },
      ],
    };
    await expect(store.saveDocument(mismatched)).rejects.toThrow();
    expect(await store.loadDocument('stage-1')).toBeNull();
  });
});
