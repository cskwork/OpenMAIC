/**
 * Chat persistence on the learner RuntimeStore.
 *
 * The legacy Dexie table remains as a one-time migration source. Runtime
 * records are append-only, while the latest session-state record describes
 * the current message window and mutable chat metadata.
 */

import type { ChatMessageSkeleton, RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import type { KVStore, RuntimeStore } from '@openmaic/storage';
import type { UIMessage } from 'ai';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import type { ChatMessageMetadata, ChatSession, SessionStatus } from '@/lib/types/chat';
import { db, type ChatSessionRecord } from './database';

const MAX_MESSAGES_PER_SESSION = 200;
const CHAT_PAYLOAD_VERSION = 1;

interface LegacyChatStore {
  load(stageId: string): Promise<ChatSession[]>;
  clear(stageId: string): Promise<void>;
}

export interface ChatStorageOptions {
  store?: RuntimeStore;
  kv?: KVStore;
  learnerKey?: string;
  legacyStore?: LegacyChatStore;
}

interface ChatMessagePayload extends ChatMessageSkeleton {
  kind: 'chat_message';
  payloadVersion: typeof CHAT_PAYLOAD_VERSION;
  message: UIMessage<ChatMessageMetadata>;
  sessionUpdatedAt: number;
}

interface ChatSessionStatePayload extends ChatMessageSkeleton {
  kind: 'chat_session_state';
  payloadVersion: typeof CHAT_PAYLOAD_VERSION;
  chatSessionId: string;
  type: ChatSession['type'];
  title: string;
  status: SessionStatus;
  config: ChatSession['config'];
  toolCalls: ChatSession['toolCalls'];
  messageIds: string[];
  createdAt: number;
  updatedAt: number;
  sceneId?: string;
  lastActionIndex?: number;
}

interface FoldedChat {
  session?: ChatSession;
  messages: Map<string, ChatMessagePayload>;
  state?: ChatSessionStatePayload;
}

const dexieLegacyStore: LegacyChatStore = {
  async load(stageId) {
    const records = await db.chatSessions.where('stageId').equals(stageId).sortBy('createdAt');
    return records.map(fromLegacyRecord);
  },
  async clear(stageId) {
    await db.chatSessions.where('stageId').equals(stageId).delete();
  },
};

// Stage saves are debounced but can overlap. Keep each RuntimeStore partition
// sequential so an older local write cannot land after a newer one.
const storeQueues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();

function enqueue<T>(store: RuntimeStore, key: string, work: () => Promise<T>): Promise<T> {
  let queues = storeQueues.get(store);
  if (!queues) {
    queues = new Map();
    storeQueues.set(store, queues);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.finally(() => {
    if (queues?.get(key) === settled) queues.delete(key);
  });
  return current;
}

async function context(options: ChatStorageOptions): Promise<{
  store: RuntimeStore;
  learnerKey: string;
  legacyStore: LegacyChatStore;
}> {
  return {
    store: options.store ?? getRuntimeStore(),
    learnerKey: options.learnerKey ?? (await getLearnerKey(options.kv)),
    legacyStore: options.legacyStore ?? dexieLegacyStore,
  };
}

function fromLegacyRecord(record: ChatSessionRecord): ChatSession {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    status: record.status,
    messages: record.messages as UIMessage<ChatMessageMetadata>[],
    config: record.config,
    toolCalls: record.toolCalls,
    pendingToolCalls: record.pendingToolCalls,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sceneId: record.sceneId,
    lastActionIndex: record.lastActionIndex,
  };
}

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    status: session.status === 'active' ? 'interrupted' : session.status,
    messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION),
    pendingToolCalls: [],
  };
}

function runtimeSessionId(stageId: string, learnerKey: string, chatSessionId: string): string {
  return `chat:${encodeURIComponent(stageId)}:${encodeURIComponent(learnerKey)}:${encodeURIComponent(chatSessionId)}`;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function messageContent(message: UIMessage<ChatMessageMetadata>): string {
  return message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: 'text' }> =>
        part.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}

function messagePayload(
  message: UIMessage<ChatMessageMetadata>,
  sessionUpdatedAt: number,
): ChatMessagePayload {
  return {
    kind: 'chat_message',
    payloadVersion: CHAT_PAYLOAD_VERSION,
    role: message.role,
    content: messageContent(message),
    message,
    sessionUpdatedAt,
  };
}

function statePayload(session: ChatSession): ChatSessionStatePayload {
  return {
    kind: 'chat_session_state',
    payloadVersion: CHAT_PAYLOAD_VERSION,
    role: 'system',
    content: session.title,
    chatSessionId: session.id,
    type: session.type,
    title: session.title,
    status: session.status,
    config: session.config,
    toolCalls: session.toolCalls,
    messageIds: session.messages.map((message) => message.id),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.sceneId === undefined ? {} : { sceneId: session.sceneId }),
    ...(session.lastActionIndex === undefined ? {} : { lastActionIndex: session.lastActionIndex }),
  };
}

function isMessagePayload(payload: unknown): payload is ChatMessagePayload {
  const candidate = payload as Partial<ChatMessagePayload> | null;
  return (
    candidate?.kind === 'chat_message' &&
    candidate.payloadVersion === CHAT_PAYLOAD_VERSION &&
    typeof candidate.message?.id === 'string' &&
    (candidate.message.role === 'user' ||
      candidate.message.role === 'assistant' ||
      candidate.message.role === 'system') &&
    Array.isArray(candidate.message.parts) &&
    typeof candidate.sessionUpdatedAt === 'number' &&
    Number.isFinite(candidate.sessionUpdatedAt)
  );
}

function isStatePayload(payload: unknown): payload is ChatSessionStatePayload {
  const candidate = payload as Partial<ChatSessionStatePayload> | null;
  return (
    candidate?.kind === 'chat_session_state' &&
    candidate.payloadVersion === CHAT_PAYLOAD_VERSION &&
    typeof candidate.chatSessionId === 'string' &&
    (candidate.type === 'qa' || candidate.type === 'discussion' || candidate.type === 'lecture') &&
    typeof candidate.title === 'string' &&
    (candidate.status === 'idle' ||
      candidate.status === 'active' ||
      candidate.status === 'interrupted' ||
      candidate.status === 'completed' ||
      candidate.status === 'error') &&
    typeof candidate.config === 'object' &&
    candidate.config !== null &&
    Array.isArray(candidate.toolCalls) &&
    Array.isArray(candidate.messageIds) &&
    candidate.messageIds.every((id) => typeof id === 'string') &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt) &&
    (candidate.sceneId === undefined || typeof candidate.sceneId === 'string') &&
    (candidate.lastActionIndex === undefined ||
      (typeof candidate.lastActionIndex === 'number' && Number.isFinite(candidate.lastActionIndex)))
  );
}

function foldRecords(records: RuntimeRecord[]): FoldedChat {
  const messages = new Map<string, ChatMessagePayload>();
  const messageSeqs = new Map<string, number>();
  let state: ChatSessionStatePayload | undefined;
  let stateSeq = -1;
  for (const record of records) {
    if (isMessagePayload(record.payload)) {
      const id = record.payload.message.id;
      const current = messages.get(id);
      if (
        !current ||
        record.payload.sessionUpdatedAt > current.sessionUpdatedAt ||
        (record.payload.sessionUpdatedAt === current.sessionUpdatedAt &&
          record.seq > (messageSeqs.get(id) ?? -1))
      ) {
        messages.set(id, record.payload);
        messageSeqs.set(id, record.seq);
      }
    }
    if (
      isStatePayload(record.payload) &&
      (!state ||
        record.payload.updatedAt > state.updatedAt ||
        (record.payload.updatedAt === state.updatedAt && record.seq > stateSeq))
    ) {
      state = record.payload;
      stateSeq = record.seq;
    }
  }
  if (!state) return { messages };
  return {
    messages,
    state,
    session: {
      id: state.chatSessionId,
      type: state.type,
      title: state.title,
      status: state.status,
      messages: state.messageIds.flatMap((id) => {
        const payload = messages.get(id);
        return payload ? [payload.message] : [];
      }),
      config: state.config,
      toolCalls: state.toolCalls,
      pendingToolCalls: [],
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      sceneId: state.sceneId,
      lastActionIndex: state.lastActionIndex,
    },
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function appendPayload(
  store: RuntimeStore,
  runtimeId: string,
  payload: ChatMessagePayload | ChatSessionStatePayload,
  session: ChatSession,
  suffix: string,
): Promise<void> {
  const actionIndex = session.lastActionIndex;
  await store.appendRecord({
    id: `${runtimeId}:${suffix}:${session.updatedAt}`,
    sessionId: runtimeId,
    createdAt: iso(session.updatedAt),
    sceneId: session.sceneId,
    ...(Number.isInteger(actionIndex) && actionIndex !== undefined && actionIndex >= 0
      ? { actionIndex }
      : {}),
    payload,
  });
}

async function syncOne(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  session: ChatSession,
  existing?: RuntimeSession,
): Promise<void> {
  const normalized = normalizeSession(session);
  const runtimeId = runtimeSessionId(stageId, learnerKey, normalized.id);
  let runtimeSession = existing;
  if (!runtimeSession) {
    runtimeSession = await store.createSession({
      id: runtimeId,
      kind: 'chat',
      stageId,
      learnerKey,
      status: 'active',
      createdAt: iso(normalized.createdAt),
      updatedAt: iso(normalized.updatedAt),
    });
  }

  const folded = foldRecords(await store.listRecords(runtimeId));
  if (folded.state && folded.state.updatedAt > normalized.updatedAt) return;

  const nextState = statePayload(normalized);
  const changedMessages = normalized.messages.filter((message) => {
    const current = folded.messages.get(message.id);
    return !current || !sameValue(current.message, message);
  });
  const stateChanged = !folded.state || !sameValue(folded.state, nextState);
  const needsAppend = changedMessages.length > 0 || stateChanged;

  if (needsAppend && runtimeSession.status !== 'active') {
    await store.setSessionStatus(runtimeId, 'active', iso(normalized.updatedAt));
    runtimeSession = { ...runtimeSession, status: 'active' };
  }
  for (const message of changedMessages) {
    await appendPayload(
      store,
      runtimeId,
      messagePayload(message, normalized.updatedAt),
      normalized,
      `message:${encodeURIComponent(message.id)}`,
    );
  }
  if (stateChanged) {
    await appendPayload(store, runtimeId, nextState, normalized, 'state');
  }

  const desiredStatus = normalized.status === 'completed' ? 'completed' : 'active';
  if (runtimeSession.status !== desiredStatus) {
    await store.setSessionStatus(runtimeId, desiredStatus, iso(normalized.updatedAt));
  }
}

async function syncSessions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  sessions: ChatSession[],
  deleteOmitted: boolean,
): Promise<ChatSession[]> {
  const existing = (await store.listSessions(stageId, learnerKey)).filter(
    (session) => session.kind === 'chat',
  );
  const byId = new Map(existing.map((session) => [session.id, session]));
  const desiredRuntimeIds = new Set<string>();

  for (const session of sessions) {
    const id = runtimeSessionId(stageId, learnerKey, session.id);
    desiredRuntimeIds.add(id);
    await syncOne(store, stageId, learnerKey, session, byId.get(id));
  }
  if (deleteOmitted) {
    await Promise.all(
      existing
        .filter((session) => !desiredRuntimeIds.has(session.id))
        .map((session) => store.deleteSession(session.id)),
    );
  }
  return loadRuntimeSessions(store, stageId, learnerKey);
}

async function loadRuntimeSessions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<ChatSession[]> {
  const sessions = (await store.listSessions(stageId, learnerKey)).filter(
    (session) => session.kind === 'chat',
  );
  const folded = await Promise.all(
    sessions.map(async (session) => foldRecords(await store.listRecords(session.id)).session),
  );
  return folded
    .filter((session): session is ChatSession => session !== undefined)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/** Persist the complete chat-session set for a stage. */
export async function saveChatSessions(
  stageId: string,
  sessions: ChatSession[],
  options: ChatStorageOptions = {},
): Promise<void> {
  const resolved = await context(options);
  const queueKey = `${stageId}\0${resolved.learnerKey}`;
  await enqueue(resolved.store, queueKey, async () => {
    await syncSessions(resolved.store, stageId, resolved.learnerKey, sessions ?? [], true);
    await resolved.legacyStore.clear(stageId);
  });
}

/** Load chat sessions, migrating legacy Dexie rows on first access. */
export async function loadChatSessions(
  stageId: string,
  options: ChatStorageOptions = {},
): Promise<ChatSession[]> {
  const resolved = await context(options);
  const legacy = (await resolved.legacyStore.load(stageId)).map(normalizeSession);
  const queueKey = `${stageId}\0${resolved.learnerKey}`;
  try {
    return await enqueue(resolved.store, queueKey, async () => {
      if (legacy.length === 0) {
        return loadRuntimeSessions(resolved.store, stageId, resolved.learnerKey);
      }
      const migrated = await syncSessions(
        resolved.store,
        stageId,
        resolved.learnerKey,
        legacy,
        false,
      );
      await resolved.legacyStore.clear(stageId);
      return migrated;
    });
  } catch (error) {
    if (legacy.length === 0) throw error;
    console.warn(`Failed to migrate chat sessions for stage ${stageId}:`, error);
    return legacy;
  }
}

/** Clear the legacy table during stage deletion; RuntimeStore cascades separately. */
export async function deleteChatSessions(stageId: string): Promise<void> {
  await dexieLegacyStore.clear(stageId);
}
