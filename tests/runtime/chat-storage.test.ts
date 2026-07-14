import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import type { RuntimeRecord } from '@openmaic/dsl';
import type { UIMessage } from 'ai';

import type { ChatMessageMetadata, ChatSession } from '@/lib/types/chat';
import { loadChatSessions, saveChatSessions } from '@/lib/utils/chat-storage';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

vi.mock('@/lib/utils/database', () => ({
  db: {
    chatSessions: {
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          delete: vi.fn().mockResolvedValue(0),
          sortBy: vi.fn().mockResolvedValue([]),
        })),
      })),
      bulkPut: vi.fn().mockResolvedValue(undefined),
    },
    transaction: vi.fn(async (_mode: string, _table: unknown, work: () => Promise<void>) => work()),
  },
}));

const STAGE_ID = 'stage-chat';
const LEARNER_KEY = 'anon:chat-test';

interface LegacyChatStore {
  load(stageId: string): Promise<ChatSession[]>;
  clear(stageId: string): Promise<void>;
}

class MemoryLegacyChatStore implements LegacyChatStore {
  clearCalls = 0;

  constructor(public sessions: ChatSession[] = []) {}

  async load(): Promise<ChatSession[]> {
    return structuredClone(this.sessions);
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    this.sessions = [];
  }
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt: number,
): UIMessage<ChatMessageMetadata> {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    metadata: { createdAt, originalRole: role === 'user' ? 'user' : 'agent' },
  };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    type: 'qa',
    title: 'Q&A',
    status: 'active',
    messages: [message('message-1', 'user', 'Hello', 1_000)],
    config: { agentIds: ['default-1'], defaultAgentId: 'default-1' },
    toolCalls: [],
    pendingToolCalls: [
      {
        toolCallId: 'pending-1',
        toolName: 'spotlight',
        args: {},
        agentId: 'default-1',
        status: 'pending',
        requestedAt: 1_100,
      },
    ],
    createdAt: 900,
    updatedAt: 1_200,
    sceneId: 'scene-1',
    lastActionIndex: 3,
    ...overrides,
  };
}

function makeRuntimeStore(): RuntimeStore {
  return new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
}

async function runtimeChatRecords(store: RuntimeStore): Promise<RuntimeRecord[]> {
  const sessions = (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
    (candidate) => candidate.kind === 'chat',
  );
  return (await Promise.all(sessions.map((candidate) => store.listRecords(candidate.id)))).flat();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chat RuntimeStore cutover', () => {
  it('persists chat sessions as replayable RuntimeStore records and loads them back', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const input = session();

    await saveChatSessions(STAGE_ID, [input], { store, learnerKey: LEARNER_KEY, legacyStore });

    const runtimeSessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(runtimeSessions).toHaveLength(1);
    expect(runtimeSessions[0]).toMatchObject({ kind: 'chat', status: 'active' });
    const records = await store.listRecords(runtimeSessions[0]!.id);
    expect(records.map((record) => (record.payload as { kind?: string }).kind)).toEqual([
      'chat_message',
      'chat_session_state',
    ]);
    expect(records[0]).toMatchObject({ sceneId: 'scene-1', actionIndex: 3 });
    expect(records[0]?.payload).toMatchObject({ role: 'user', content: 'Hello' });

    const loaded = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    expect(loaded).toEqual([
      {
        ...input,
        status: 'interrupted',
        pendingToolCalls: [],
      },
    ]);
  });

  it('keeps the lecture not-started sentinel out of runtime action anchors', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const lecture = session({
      type: 'lecture',
      lastActionIndex: -1,
      messages: [message('lecture-message', 'assistant', '', 1_000)],
    });

    await saveChatSessions(STAGE_ID, [lecture], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const records = await runtimeChatRecords(store);
    expect(records).not.toHaveLength(0);
    expect(records.every((record) => record.actionIndex === undefined)).toBe(true);
    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ type: 'lecture', lastActionIndex: -1 }]);
  });

  it('writes only changed records and ignores an older save that arrives later', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const latest = session({ title: 'Latest title', updatedAt: 2_000 });

    await saveChatSessions(STAGE_ID, [latest], { store, learnerKey: LEARNER_KEY, legacyStore });
    const recordCount = (await runtimeChatRecords(store)).length;
    await saveChatSessions(STAGE_ID, [latest], { store, learnerKey: LEARNER_KEY, legacyStore });
    await saveChatSessions(STAGE_ID, [session({ title: 'Stale title', updatedAt: 1_000 })], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(await runtimeChatRecords(store)).toHaveLength(recordCount);
    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ title: 'Latest title', updatedAt: 2_000 }]);
  });

  it('projects the newest logical state when a stale cross-tab record has a later seq', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const latest = session({ title: 'Latest title', updatedAt: 2_000 });
    await saveChatSessions(STAGE_ID, [latest], { store, learnerKey: LEARNER_KEY, legacyStore });
    const [runtimeSession] = (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );

    await store.appendRecord({
      id: 'stale-cross-tab-state',
      sessionId: runtimeSession!.id,
      createdAt: new Date(1_000).toISOString(),
      payload: {
        kind: 'chat_session_state',
        payloadVersion: 1,
        role: 'system',
        content: 'Stale title',
        chatSessionId: latest.id,
        type: latest.type,
        title: 'Stale title',
        status: 'interrupted',
        config: latest.config,
        toolCalls: latest.toolCalls,
        messageIds: latest.messages.map((candidate) => candidate.id),
        createdAt: latest.createdAt,
        updatedAt: 1_000,
      },
    });

    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ title: 'Latest title', updatedAt: 2_000 }]);
  });

  it('keeps only the latest 200 messages without rewriting unchanged message records', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const messages = Array.from({ length: 202 }, (_, index) =>
      message(`message-${index}`, index % 2 === 0 ? 'user' : 'assistant', `Text ${index}`, index),
    );

    await saveChatSessions(STAGE_ID, [session({ messages, updatedAt: 5_000 })], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const firstRecordCount = (await runtimeChatRecords(store)).length;
    await saveChatSessions(STAGE_ID, [session({ messages, updatedAt: 5_000 })], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const [loaded] = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    expect(loaded?.messages).toHaveLength(200);
    expect(loaded?.messages[0]?.id).toBe('message-2');
    expect(await runtimeChatRecords(store)).toHaveLength(firstRecordCount);
  });

  it('backfills legacy Dexie sessions before clearing the legacy rows', async () => {
    const store = makeRuntimeStore();
    const legacy = session({ status: 'completed', updatedAt: 3_000 });
    const legacyStore = new MemoryLegacyChatStore([legacy]);

    const loaded = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(loaded).toEqual([{ ...legacy, pendingToolCalls: [] }]);
    expect(legacyStore.sessions).toEqual([]);
    expect(legacyStore.clearCalls).toBe(1);
    expect(
      (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
        (candidate) => candidate.kind === 'chat',
      ),
    ).toHaveLength(1);
  });

  it('keeps legacy rows authoritative when the first RuntimeStore migration attempt fails', async () => {
    const legacy = session({ status: 'completed' });
    const legacyStore = new MemoryLegacyChatStore([legacy]);
    const store = {
      listSessions: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
    } as unknown as RuntimeStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(loaded).toEqual([{ ...legacy, pendingToolCalls: [] }]);
    expect(legacyStore.sessions).toEqual([legacy]);
    expect(legacyStore.clearCalls).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails loud after cutover when RuntimeStore is unavailable', async () => {
    const legacyStore = new MemoryLegacyChatStore();
    const store = {
      listSessions: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
    } as unknown as RuntimeStore;

    await expect(
      loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).rejects.toThrow('runtime unavailable');
  });

  it('deletes omitted chat sessions without touching other runtime kinds', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: 'pbl-session',
      kind: 'pbl',
      stageId: STAGE_ID,
      learnerKey: LEARNER_KEY,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const first = session({ id: 'session-1' });
    const second = session({ id: 'session-2', createdAt: 950, updatedAt: 1_300 });
    await saveChatSessions(STAGE_ID, [first, second], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    await saveChatSessions(STAGE_ID, [second], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const runtimeSessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(runtimeSessions.filter((candidate) => candidate.kind === 'chat')).toHaveLength(1);
    expect(runtimeSessions.filter((candidate) => candidate.kind === 'pbl')).toHaveLength(1);
  });
});
