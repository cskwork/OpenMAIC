import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRuntimeStore } from '@openmaic/storage';

import type { ChatSession } from '@/lib/types/chat';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

const learnerKey = 'anon:database-cutover';

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
