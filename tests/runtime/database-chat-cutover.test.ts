import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRuntimeStore } from '@openmaic/storage';

import type { ChatSession } from '@/lib/types/chat';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

const learnerKey = 'anon:database-cutover';

function serialLockManager(): Pick<LockManager, 'request'> {
  const tails = new Map<string, Promise<void>>();
  const manager = {
    async request<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(name, current);
      await previous;
      try {
        return await callback();
      } finally {
        release();
        if (tails.get(name) === current) tails.delete(name);
      }
    },
  };
  return manager as unknown as Pick<LockManager, 'request'>;
}

function chatSession(): ChatSession {
  return {
    id: 'chat-backup',
    type: 'qa',
    title: 'Persisted chat',
    status: 'completed',
    messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    config: { agentIds: ['default-1'] },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

describe('database runtime chat integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports RuntimeStore chats and clears them with the main database', async () => {
    const runtimeStore = new BrowserRuntimeStore({ indexedDB: globalThis.indexedDB });
    const { db, clearDatabase, exportDatabase, importDatabase } =
      await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.put({
      id: 'stage-backup',
      name: 'Backup stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await saveChatSessions('stage-backup', [chatSession()], {
      store: runtimeStore,
      learnerKey,
    });
    await saveChatSessions('orphaned-runtime-stage', [{ ...chatSession(), id: 'orphaned-chat' }], {
      store: runtimeStore,
      learnerKey,
    });

    const exported = await exportDatabase({
      store: runtimeStore,
      learnerKey,
    });
    expect(exported.chatSessions).toMatchObject([
      { id: 'chat-backup', stageId: 'stage-backup', title: 'Persisted chat' },
    ]);

    await saveChatSessions(
      'stage-backup',
      [
        { ...chatSession(), title: 'Newer local chat', updatedAt: 3_000 },
        { ...chatSession(), id: 'chat-not-in-backup', title: 'Not in backup', updatedAt: 3_100 },
      ],
      { store: runtimeStore, learnerKey },
    );
    await importDatabase(exported, { store: runtimeStore, learnerKey });
    await expect(
      loadChatSessions('stage-backup', { store: runtimeStore, learnerKey }),
    ).resolves.toMatchObject([{ id: 'chat-backup', title: 'Persisted chat' }]);

    await clearDatabase(runtimeStore);
    await expect(runtimeStore.listSessions('stage-backup', learnerKey)).resolves.toEqual([]);
    await expect(runtimeStore.listSessions('orphaned-runtime-stage', learnerKey)).resolves.toEqual(
      [],
    );
  });

  it('keeps backup staging and runtime clearing in the same cross-tab lock', async () => {
    const indexedDB = globalThis.indexedDB;
    const importingStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-lock' });
    const loadingStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-lock' });
    const { db, exportDatabase, importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    vi.stubGlobal('navigator', { locks: serialLockManager() });
    await db.stages.bulkPut([
      {
        id: 'stage-backup',
        name: 'Backup stage',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      {
        id: 'stage-z-backup',
        name: 'Later backup stage',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ]);
    await saveChatSessions('stage-backup', [chatSession()], {
      store: importingStore,
      learnerKey,
    });
    await saveChatSessions(
      'stage-z-backup',
      [{ ...chatSession(), id: 'chat-z-backup', title: 'Later persisted chat' }],
      { store: importingStore, learnerKey },
    );
    const exported = await exportDatabase({ store: importingStore, learnerKey });
    await saveChatSessions(
      'stage-backup',
      [{ ...chatSession(), title: 'Newer local chat', updatedAt: 3_000 }],
      { store: importingStore, learnerKey },
    );
    await saveChatSessions(
      'stage-z-backup',
      [
        {
          ...chatSession(),
          id: 'chat-z-backup',
          title: 'Later newer local chat',
          updatedAt: 3_000,
        },
      ],
      { store: importingStore, learnerKey },
    );

    const originalTransaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    let transactionCommitted!: () => void;
    const didCommit = new Promise<void>((resolve) => {
      transactionCommitted = resolve;
    });
    let releaseImport!: () => void;
    const importMayContinue = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) =>
      originalTransaction(...args).then(async (result) => {
        transactionCommitted();
        await importMayContinue;
        return result;
      })) as typeof db.transaction);

    const importing = importDatabase(exported, { store: importingStore, learnerKey });
    await didCommit;
    const loading = loadChatSessions('stage-z-backup', { store: loadingStore, learnerKey });
    const earlyOutcome = await Promise.race([
      loading.then(() => 'read' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);
    expect(earlyOutcome).toBe('blocked');

    releaseImport();
    await importing;
    await expect(loading).resolves.toMatchObject([{ title: 'Later persisted chat' }]);
    await expect(
      loadChatSessions('stage-backup', { store: loadingStore, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Persisted chat' }]);
  });

  it('fails loud without deleting documents when the runtime-wide clear fails', async () => {
    const { clearDatabase, db } = await import('@/lib/utils/database');
    await db.stages.put({
      id: 'stage-retained',
      name: 'Retained stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    const runtimeStore = {
      deleteAllRuntime: vi.fn().mockRejectedValue(new Error('runtime clear failed')),
    } as unknown as BrowserRuntimeStore;

    await expect(clearDatabase(runtimeStore)).rejects.toThrow('runtime clear failed');
    await expect(db.stages.get('stage-retained')).resolves.toMatchObject({ id: 'stage-retained' });
  });
});
