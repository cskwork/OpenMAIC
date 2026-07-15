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
    const legacyStore = {
      load: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const { db, clearDatabase, exportDatabase } = await import('@/lib/utils/database');
    const { saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.put({
      id: 'stage-backup',
      name: 'Backup stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await saveChatSessions('stage-backup', [chatSession()], {
      store: runtimeStore,
      learnerKey,
      legacyStore,
    });

    const exported = await exportDatabase({
      store: runtimeStore,
      learnerKey,
      legacyStore,
    });
    expect(exported.chatSessions).toMatchObject([
      { id: 'chat-backup', stageId: 'stage-backup', title: 'Persisted chat' },
    ]);

    await clearDatabase(runtimeStore);
    await expect(runtimeStore.listSessions('stage-backup', learnerKey)).resolves.toEqual([]);
  });
});
