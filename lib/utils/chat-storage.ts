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
import { isEqual } from 'lodash';
import { nanoid } from 'nanoid';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import type { ChatMessageMetadata, ChatSession, SessionStatus } from '@/lib/types/chat';
import { db, type ChatSessionRecord } from './database';
import {
  chatStoragePartitionLockName,
  withChatStorageExclusiveLock,
  withChatStorageSharedLock,
} from './chat-storage-lock';

const MAX_MESSAGES_PER_SESSION = 200;
const MAX_RUNTIME_RECORDS_PER_CHAT_SESSION = 256;
const CHAT_PAYLOAD_VERSION = 1;
const RUNTIME_GENERATION_SEPARATOR = ':generation:';
const RESTORE_MARKER_PREFIX = 'chat-restore-marker:';

interface LegacyChatStore {
  load(stageId: string): Promise<ChatSession[]>;
  clear(stageId: string): Promise<void>;
}

export interface ChatStorageOptions {
  store?: RuntimeStore;
  kv?: KVStore;
  learnerKey?: string;
  legacyStore?: LegacyChatStore;
  globalLockHeld?: boolean;
  snapshot?: ChatStorageSnapshot;
}

export interface ChatStorageReadOptions extends ChatStorageOptions {
  fallbackToLegacyOnError?: boolean;
  observe?: boolean;
  onSnapshot?: (snapshot: ChatStorageSnapshot) => void;
}

export interface ChatStorageSnapshot {
  sessions: ChatSession[];
  /** `undefined` means the runtime generation could not be read authoritatively. */
  restoreMarker?: string | null;
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

interface ChatRuntimeView {
  runtimeSession: RuntimeSession;
  records: RuntimeRecord[];
  folded: FoldedChat;
}

interface ChatRuntimeCandidate extends ChatRuntimeView {
  baseRuntimeId: string;
  generation: number;
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
// sequential locally. The shared legacy table requires Web Locks across realms;
// injected legacy stores retain the isolated generation fallback used by
// concurrency tests and non-browser adapters.
const storeQueues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();
const observedChatSessionIds = new WeakMap<RuntimeStore, Map<string, Set<string>>>();
const observedChatSessions = new WeakMap<RuntimeStore, Map<string, Map<string, ChatSession>>>();

export class ChatStorageLockUnavailableError extends Error {}
export class ChatStorageSnapshotInvalidatedByRestoreError extends Error {}

function observedIds(store: RuntimeStore, key: string): Set<string> {
  return observedChatSessionIds.get(store)?.get(key) ?? new Set();
}

function rememberObservedIds(store: RuntimeStore, key: string, ids: Iterable<string>): void {
  let partitions = observedChatSessionIds.get(store);
  if (!partitions) {
    partitions = new Map();
    observedChatSessionIds.set(store, partitions);
  }
  partitions.set(key, new Set(ids));
}

function observedSessions(store: RuntimeStore, key: string): Map<string, ChatSession> | undefined {
  return observedChatSessions.get(store)?.get(key);
}

function rememberObservedSessions(
  store: RuntimeStore,
  key: string,
  sessions: readonly ChatSession[],
): void {
  let partitions = observedChatSessions.get(store);
  if (!partitions) {
    partitions = new Map();
    observedChatSessions.set(store, partitions);
  }
  partitions.set(
    key,
    new Map(sessions.map((session) => [session.id, structuredClone(normalizeSession(session))])),
  );
}

function matchesObservedSessions(
  store: RuntimeStore,
  key: string,
  sessions: readonly ChatSession[],
): boolean {
  const observed = observedSessions(store, key);
  if (!observed) return sessions.length === 0;
  if (observed.size !== sessions.length) return false;
  return sessions.every((session) => isEqual(observed.get(session.id), normalizeSession(session)));
}

function sessionMap(sessions: readonly ChatSession[]): Map<string, ChatSession> {
  return new Map(
    sessions.map((session) => [session.id, structuredClone(normalizeSession(session))]),
  );
}

function matchesSnapshot(snapshot: ChatStorageSnapshot, sessions: readonly ChatSession[]): boolean {
  const baseline = sessionMap(snapshot.sessions);
  if (baseline.size !== sessions.length) return false;
  return sessions.every((session) => isEqual(baseline.get(session.id), normalizeSession(session)));
}

function reportSnapshot(
  options: ChatStorageReadOptions,
  sessions: readonly ChatSession[],
  restoreMarker: string | null | undefined,
): void {
  options.onSnapshot?.({
    sessions: structuredClone([...sessions]),
    restoreMarker,
  });
}

function withPartitionLocks<T>(
  crossRealmKey: string,
  key: string,
  requiresCrossRealmLock: boolean,
  work: (isolatedWrites: boolean) => Promise<T>,
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    const locks = navigator.locks;
    return locks.request<Promise<T>>(
      chatStoragePartitionLockName(crossRealmKey),
      () =>
        locks.request<Promise<T>>(chatStoragePartitionLockName(key), () =>
          work(false),
        ) as unknown as Promise<T>,
    ) as unknown as Promise<T>;
  }
  if (requiresCrossRealmLock) {
    throw new ChatStorageLockUnavailableError(
      'Chat storage requires the Web Locks API in this browser',
    );
  }
  return work(true);
}

function enqueue<T>(
  store: RuntimeStore,
  key: string,
  crossRealmKey: string,
  requiresCrossRealmLock: boolean,
  work: (isolatedWrites: boolean) => Promise<T>,
  globalLockHeld = false,
): Promise<T> {
  const enqueueInGlobalEpoch = (): Promise<T> => {
    let queues = storeQueues.get(store);
    if (!queues) {
      queues = new Map();
      storeQueues.set(store, queues);
    }
    const previous = queues.get(key) ?? Promise.resolve();
    const run = () => withPartitionLocks(crossRealmKey, key, requiresCrossRealmLock, work);
    const current = previous.catch(() => undefined).then(run);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    void settled.finally(() => {
      if (queues?.get(key) === settled) queues.delete(key);
    });
    return current;
  };

  // Register in the local partition queue only after this operation's global
  // shared lock is granted. Otherwise a caller already holding a shared lock
  // can wait for a later operation queued behind maintenance, creating a
  // shared -> later shared -> exclusive -> shared inversion.
  return globalLockHeld ? enqueueInGlobalEpoch() : withChatStorageSharedLock(enqueueInGlobalEpoch);
}

async function context(options: ChatStorageOptions): Promise<{
  store: RuntimeStore;
  learnerKey: string;
  legacyStore: LegacyChatStore;
  requiresCrossRealmLock: boolean;
}> {
  const legacyStore = options.legacyStore ?? dexieLegacyStore;
  return {
    store: options.store ?? getRuntimeStore(),
    learnerKey: options.learnerKey ?? (await getLearnerKey(options.kv)),
    legacyStore,
    requiresCrossRealmLock: legacyStore === dexieLegacyStore,
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

function generationRuntimeSessionId(
  baseRuntimeId: string,
  generation: number,
  writerToken?: string,
): string {
  return `${baseRuntimeId}${RUNTIME_GENERATION_SEPARATOR}${generation}${writerToken ? `:${writerToken}` : ''}`;
}

function restoreMarkerPrefix(stageId: string): string {
  return `${RESTORE_MARKER_PREFIX}${encodeURIComponent(stageId)}:`;
}

function currentRestoreMarker(
  views: readonly ChatRuntimeView[],
  stageId: string,
): string | undefined {
  // RuntimeStore already scopes `views` to one learner. Keep marker discovery
  // stage-scoped so a marker remains recognizable after mergeLearner re-keys
  // the session without rewriting its immutable id.
  const prefix = restoreMarkerPrefix(stageId);
  return views
    .map((view) => view.runtimeSession.id)
    .filter((id) => id.startsWith(prefix))
    .sort()
    .at(-1);
}

function chatRuntimeIdentity(
  runtimeId: string,
  stageId: string,
  chatSessionId: string,
): { baseRuntimeId: string; generation: number } | undefined {
  const markerIndex = runtimeId.lastIndexOf(RUNTIME_GENERATION_SEPARATOR);
  let baseRuntimeId = runtimeId;
  let generation = 0;
  if (markerIndex >= 0) {
    baseRuntimeId = runtimeId.slice(0, markerIndex);
    const rawIdentity = runtimeId.slice(markerIndex + RUNTIME_GENERATION_SEPARATOR.length);
    const [rawGeneration, writerToken, ...extra] = rawIdentity.split(':');
    if (!/^[1-9]\d*$/.test(rawGeneration)) return undefined;
    if (extra.length > 0 || (writerToken !== undefined && !/^[\w-]+$/.test(writerToken))) {
      return undefined;
    }
    generation = Number(rawGeneration);
    if (!Number.isSafeInteger(generation)) return undefined;
  }
  if (
    !baseRuntimeId.startsWith(`chat:${encodeURIComponent(stageId)}:`) ||
    !baseRuntimeId.endsWith(`:${encodeURIComponent(chatSessionId)}`)
  ) {
    return undefined;
  }
  return { baseRuntimeId, generation };
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

function matchesChatPartition(
  session: RuntimeSession,
  id: string,
  stageId: string,
  learnerKey: string,
): boolean {
  return (
    session.id === id &&
    session.kind === 'chat' &&
    session.stageId === stageId &&
    session.learnerKey === learnerKey
  );
}

async function createOrGetRuntimeSession(
  store: RuntimeStore,
  init: Parameters<RuntimeStore['createSession']>[0],
): Promise<RuntimeSession> {
  try {
    return await store.createSession(init);
  } catch (error) {
    let raced: RuntimeSession | undefined;
    try {
      raced = await store.getSession(init.id);
    } catch {
      throw error;
    }
    if (!raced || !matchesChatPartition(raced, init.id, init.stageId, init.learnerKey)) {
      throw error;
    }
    return raced;
  }
}

function changesForSession(
  normalized: ChatSession,
  folded: FoldedChat,
): {
  nextState: ChatSessionStatePayload;
  changedMessages: UIMessage<ChatMessageMetadata>[];
  stateChanged: boolean;
} {
  const nextState = statePayload(normalized);
  return {
    nextState,
    changedMessages: normalized.messages.filter((message) => {
      const current = folded.messages.get(message.id);
      return !current || !isEqual(current.message, message);
    }),
    stateChanged: !folded.state || !isEqual(folded.state, nextState),
  };
}

async function runtimeViews(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<ChatRuntimeView[]> {
  const sessions = (await store.listSessions(stageId, learnerKey)).filter(
    (session) => session.kind === 'chat',
  );
  return Promise.all(
    sessions.map(async (runtimeSession) => {
      const records = await store.listRecords(runtimeSession.id);
      return { runtimeSession, records, folded: foldRecords(records) };
    }),
  );
}

function chatRuntimeCandidates(
  views: ChatRuntimeView[],
  stageId: string,
  chatSessionId: string,
): ChatRuntimeCandidate[] {
  return views.flatMap((view) => {
    const identity = chatRuntimeIdentity(view.runtimeSession.id, stageId, chatSessionId);
    return identity ? [{ ...view, ...identity }] : [];
  });
}

function newestRuntimeCandidate(
  candidates: ChatRuntimeCandidate[],
): ChatRuntimeCandidate | undefined {
  return [...candidates].sort((left, right) => {
    const leftUpdatedAt = left.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
    const rightUpdatedAt = right.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
    if (left.generation !== right.generation) return right.generation - left.generation;
    return right.runtimeSession.id.localeCompare(left.runtimeSession.id);
  })[0];
}

function highestGeneration(
  candidates: ChatRuntimeCandidate[],
  baseRuntimeId: string,
): ChatRuntimeCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.baseRuntimeId === baseRuntimeId)
    .sort((left, right) => {
      if (left.generation !== right.generation) return right.generation - left.generation;
      const leftUpdatedAt = left.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
      const rightUpdatedAt = right.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
      if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
      return right.runtimeSession.id.localeCompare(left.runtimeSession.id);
    })[0];
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

async function completeRuntimeCandidate(
  store: RuntimeStore,
  candidate: ChatRuntimeCandidate,
  session: ChatSession,
): Promise<boolean> {
  const runtimeId = candidate.runtimeSession.id;
  const runtimeSession = await store.getSession(runtimeId);
  if (!runtimeSession) return false;
  if (runtimeSession.status !== 'completed') {
    try {
      await store.setSessionStatus(runtimeId, 'completed', iso(session.updatedAt));
    } catch (error) {
      let latest: RuntimeSession | undefined;
      try {
        latest = await store.getSession(runtimeId);
      } catch {
        throw error;
      }
      if (latest) throw error;
      return false;
    }
  }
  return true;
}

async function retireRuntimeCandidates(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  candidateIds: string[],
  successor: ChatSession,
  successorRuntimeId: string,
): Promise<void> {
  const ids = new Set(candidateIds);
  if (ids.size === 0) return;
  const successorIdentity = chatRuntimeIdentity(successorRuntimeId, stageId, successor.id);
  if (!successorIdentity) {
    throw new Error(`Invalid chat runtime successor ${JSON.stringify(successorRuntimeId)}`);
  }
  const currentViews = await runtimeViews(store, stageId, learnerKey);
  await Promise.all(
    currentViews.flatMap((view) => {
      if (!ids.has(view.runtimeSession.id) || view.runtimeSession.status !== 'completed') return [];
      const state = view.folded.state;
      const identity = chatRuntimeIdentity(view.runtimeSession.id, stageId, successor.id);
      if (
        state &&
        (state.updatedAt > successor.updatedAt ||
          (state.updatedAt === successor.updatedAt &&
            (!identity ||
              identity.generation > successorIdentity.generation ||
              (identity.generation === successorIdentity.generation &&
                view.runtimeSession.id.localeCompare(successorRuntimeId) > 0))))
      ) {
        return [];
      }
      return [store.deleteSession(view.runtimeSession.id)];
    }),
  );
}

async function syncOne(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  session: ChatSession,
  existingViews: ChatRuntimeView[],
  isolatedWrites: boolean,
  observed: ChatSession | undefined,
): Promise<string> {
  let desired = normalizeSession(session);
  let views = existingViews;
  let retryError: unknown;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidates = chatRuntimeCandidates(views, stageId, desired.id);
    const source = newestRuntimeCandidate(candidates);
    if (source?.folded.session && source.folded.session.updatedAt > desired.updatedAt) {
      const localEditAdvanced =
        observed !== undefined &&
        desired.updatedAt > observed.updatedAt &&
        !isEqual(desired, observed);
      desired = localEditAdvanced
        ? { ...desired, updatedAt: source.folded.session.updatedAt + 1 }
        : source.folded.session;
    }

    const baseRuntimeId =
      source?.baseRuntimeId ?? runtimeSessionId(stageId, learnerKey, desired.id);
    let destination = highestGeneration(candidates, baseRuntimeId);
    if (isolatedWrites) {
      // A unique generation is safe across realms without a shared mutex:
      // every writer stores at most the normalized 200 messages plus state.
      const folded = destination?.folded ?? { messages: new Map<string, ChatMessagePayload>() };
      const changes = changesForSession(desired, folded);
      const appendCount = changes.changedMessages.length + (changes.stateChanged ? 1 : 0);
      if (destination && appendCount === 0) {
        const destinationId = destination.runtimeSession.id;
        if (desired.status === 'completed' && destination.runtimeSession.status !== 'completed') {
          if (!(await completeRuntimeCandidate(store, destination, desired))) {
            views = await runtimeViews(store, stageId, learnerKey);
            continue;
          }
        }
        const retired = candidates.filter(
          (candidate) => candidate.runtimeSession.id !== destinationId,
        );
        const completed = await Promise.all(
          retired.map((candidate) => completeRuntimeCandidate(store, candidate, desired)),
        );
        if (completed.some((candidate) => !candidate)) {
          views = await runtimeViews(store, stageId, learnerKey);
          continue;
        }
        await retireRuntimeCandidates(
          store,
          stageId,
          learnerKey,
          retired.map((candidate) => candidate.runtimeSession.id),
          desired,
          destinationId,
        );
        return destinationId;
      }

      const generation = Math.max(0, ...candidates.map((candidate) => candidate.generation)) + 1;
      const runtimeId = generationRuntimeSessionId(baseRuntimeId, generation, nanoid());
      try {
        await Promise.all(
          candidates.map((candidate) => completeRuntimeCandidate(store, candidate, desired)),
        );
        let runtimeSession = await createOrGetRuntimeSession(store, {
          id: runtimeId,
          kind: 'chat',
          stageId,
          learnerKey,
          status: 'active',
          createdAt: iso(desired.createdAt),
          updatedAt: iso(desired.updatedAt),
        });
        for (const message of desired.messages) {
          await appendPayload(
            store,
            runtimeId,
            messagePayload(message, desired.updatedAt),
            desired,
            `message:${encodeURIComponent(message.id)}`,
          );
        }
        await appendPayload(store, runtimeId, statePayload(desired), desired, 'state');
        if (desired.status === 'completed') {
          await store.setSessionStatus(runtimeId, 'completed', iso(desired.updatedAt));
          runtimeSession = { ...runtimeSession, status: 'completed' };
        }
        await retireRuntimeCandidates(
          store,
          stageId,
          learnerKey,
          candidates.map((candidate) => candidate.runtimeSession.id),
          desired,
          runtimeId,
        );
        return runtimeSession.id;
      } catch (error) {
        retryError = error;
        try {
          await store.deleteSession(runtimeId);
          views = await runtimeViews(store, stageId, learnerKey);
        } catch {
          throw error;
        }
        continue;
      }
    }
    if (!destination) {
      const runtimeSession = await createOrGetRuntimeSession(store, {
        id: baseRuntimeId,
        kind: 'chat',
        stageId,
        learnerKey,
        status: 'active',
        createdAt: iso(desired.createdAt),
        updatedAt: iso(desired.updatedAt),
      });
      const records = await store.listRecords(runtimeSession.id);
      destination = {
        runtimeSession,
        records,
        folded: foldRecords(records),
        baseRuntimeId,
        generation: 0,
      };
    }

    const changes = changesForSession(desired, destination.folded);
    const appendCount = changes.changedMessages.length + (changes.stateChanged ? 1 : 0);
    // Updating a message and its session state takes multiple RuntimeStore
    // appends. Publish that snapshot through a fresh generation so a failure
    // cannot make only the new message visible through the previous state.
    if (
      destination.folded.state &&
      changes.changedMessages.length > 0 &&
      destination.runtimeSession.status !== 'completed'
    ) {
      if (!(await completeRuntimeCandidate(store, destination, desired))) {
        views = await runtimeViews(store, stageId, learnerKey);
        continue;
      }
      views = await runtimeViews(store, stageId, learnerKey);
      continue;
    }
    const needsRollover =
      destination.records.length > MAX_RUNTIME_RECORDS_PER_CHAT_SESSION ||
      (appendCount > 0 &&
        destination.records.length + appendCount > MAX_RUNTIME_RECORDS_PER_CHAT_SESSION);
    if (
      destination.runtimeSession.status === 'completed' &&
      (appendCount > 0 || destination.records.length > MAX_RUNTIME_RECORDS_PER_CHAT_SESSION)
    ) {
      await createOrGetRuntimeSession(store, {
        id: generationRuntimeSessionId(baseRuntimeId, destination.generation + 1),
        kind: 'chat',
        stageId,
        learnerKey,
        status: 'active',
        createdAt: iso(desired.createdAt),
        updatedAt: iso(desired.updatedAt),
      });
      views = await runtimeViews(store, stageId, learnerKey);
      continue;
    }
    if (needsRollover) {
      await completeRuntimeCandidate(store, destination, desired);
      views = await runtimeViews(store, stageId, learnerKey);
      continue;
    }

    let { runtimeSession } = destination;
    const runtimeId = runtimeSession.id;
    try {
      if (appendCount > 0 && runtimeSession.status !== 'active') {
        await store.setSessionStatus(runtimeId, 'active', iso(desired.updatedAt));
        runtimeSession = { ...runtimeSession, status: 'active' };
      }
      for (const message of changes.changedMessages) {
        await appendPayload(
          store,
          runtimeId,
          messagePayload(message, desired.updatedAt),
          desired,
          `message:${encodeURIComponent(message.id)}`,
        );
      }
      if (changes.stateChanged) {
        await appendPayload(store, runtimeId, changes.nextState, desired, 'state');
      }

      const desiredStatus = desired.status === 'completed' ? 'completed' : 'active';
      if (
        runtimeSession.status !== desiredStatus &&
        !(runtimeSession.status === 'completed' && appendCount === 0)
      ) {
        await store.setSessionStatus(runtimeId, desiredStatus, iso(desired.updatedAt));
      }
      return runtimeId;
    } catch (error) {
      retryError = error;
      let latest: RuntimeSession | undefined;
      try {
        latest = await store.getSession(runtimeId);
      } catch {
        throw error;
      }
      if (latest && !matchesChatPartition(latest, runtimeId, stageId, learnerKey)) {
        throw error;
      }
      if (latest?.status === 'active') {
        // A generation without a committed state is not externally visible.
        // Remove its partial records before retrying instead of exposing them
        // through a later state append or retaining an orphaned session.
        if (!destination.folded.state) {
          let latestFolded: FoldedChat;
          try {
            latestFolded = foldRecords(await store.listRecords(runtimeId));
          } catch {
            throw error;
          }
          if (latestFolded.state) throw error;
          try {
            await store.deleteSession(runtimeId);
            views = await runtimeViews(store, stageId, learnerKey);
            continue;
          } catch {
            throw error;
          }
        }
        throw error;
      }
      views = await runtimeViews(store, stageId, learnerKey);
    }
  }
  if (!isolatedWrites) {
    // A failed locked write may exhaust its retries immediately after
    // creating the next generation. Such state-less generations are never a
    // committed snapshot and no other partition writer can be active here.
    try {
      const unresolved = (await runtimeViews(store, stageId, learnerKey)).filter(
        (view) =>
          chatRuntimeIdentity(view.runtimeSession.id, stageId, desired.id) !== undefined &&
          !view.folded.state,
      );
      await Promise.all(unresolved.map((view) => store.deleteSession(view.runtimeSession.id)));
    } catch {
      // Preserve the append failure that made the save fail; cleanup remains
      // best-effort if the RuntimeStore itself is unavailable.
    }
  }
  throw (
    retryError ?? new Error(`Failed to resolve chat generation for ${JSON.stringify(desired.id)}`)
  );
}

async function syncSessions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  sessions: ChatSession[],
  deleteOmitted: boolean,
  isolatedWrites: boolean,
  knownSessionIds: ReadonlySet<string> = new Set(),
  observed: ReadonlyMap<string, ChatSession> = new Map(),
  existingViews?: ChatRuntimeView[],
): Promise<ChatSession[]> {
  const existing = existingViews ?? (await runtimeViews(store, stageId, learnerKey));
  const desiredRuntimeIds = new Map<string, string>();

  for (const session of sessions) {
    desiredRuntimeIds.set(
      session.id,
      await syncOne(
        store,
        stageId,
        learnerKey,
        session,
        existing,
        isolatedWrites,
        observed.get(session.id),
      ),
    );
  }
  if (deleteOmitted) {
    const afterSync = await runtimeViews(store, stageId, learnerKey);
    const afterSyncById = new Map(afterSync.map((view) => [view.runtimeSession.id, view]));
    await Promise.all(
      existing.flatMap((view) => {
        const chatSessionId = view.folded.session?.id;
        const desiredRuntimeId = chatSessionId ? desiredRuntimeIds.get(chatSessionId) : undefined;
        const current = afterSyncById.get(view.runtimeSession.id);
        // A full snapshot may have been captured in another tab before this
        // runtime session existed. Only treat omission as deletion for chat
        // IDs this RuntimeStore instance has actually observed; otherwise a
        // stale snapshot could erase a newer tab's session. State-less views
        // may still be in flight, so leave them to their writer's retry path.
        if (!chatSessionId) return [];
        if (!desiredRuntimeId) {
          return knownSessionIds.has(chatSessionId)
            ? [store.deleteSession(view.runtimeSession.id)]
            : [];
        }
        if (
          desiredRuntimeId === view.runtimeSession.id ||
          !current ||
          current.runtimeSession.status !== 'completed'
        ) {
          return [];
        }
        const successor = afterSyncById.get(desiredRuntimeId);
        const currentIdentity = chatRuntimeIdentity(
          current.runtimeSession.id,
          stageId,
          chatSessionId,
        );
        const successorIdentity = successor
          ? chatRuntimeIdentity(successor.runtimeSession.id, stageId, chatSessionId)
          : undefined;
        if (
          current.folded.state &&
          (!successor?.folded.state ||
            successor.folded.state.updatedAt < current.folded.state.updatedAt ||
            (successor.folded.state.updatedAt === current.folded.state.updatedAt &&
              (!currentIdentity ||
                !successorIdentity ||
                currentIdentity.generation > successorIdentity.generation ||
                (currentIdentity.generation === successorIdentity.generation &&
                  current.runtimeSession.id.localeCompare(successor.runtimeSession.id) > 0))))
        ) {
          return [];
        }
        return [store.deleteSession(view.runtimeSession.id)];
      }),
    );
  }
  return loadRuntimeSessions(store, stageId, learnerKey);
}

async function loadRuntimeSessions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<ChatSession[]> {
  const newestByChatSession = new Map<string, ChatRuntimeView>();
  for (const view of await runtimeViews(store, stageId, learnerKey)) {
    const chatSession = view.folded.session;
    if (!chatSession) continue;
    const identity = chatRuntimeIdentity(view.runtimeSession.id, stageId, chatSession.id);
    if (!identity) continue;
    const current = newestByChatSession.get(chatSession.id);
    const currentGeneration = current
      ? chatRuntimeIdentity(current.runtimeSession.id, stageId, chatSession.id)!.generation
      : -1;
    if (
      !current ||
      chatSession.updatedAt > current.folded.session!.updatedAt ||
      (chatSession.updatedAt === current.folded.session!.updatedAt &&
        (identity.generation > currentGeneration ||
          (identity.generation === currentGeneration &&
            view.runtimeSession.id.localeCompare(current.runtimeSession.id) > 0)))
    ) {
      newestByChatSession.set(chatSession.id, view);
    }
  }
  return [...newestByChatSession.values()]
    .map((view) => view.folded.session!)
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
  const nextSessions = sessions ?? [];
  try {
    await enqueue(
      resolved.store,
      queueKey,
      stageId,
      resolved.requiresCrossRealmLock,
      async (isolatedWrites) => {
        const beforeSave = await runtimeViews(resolved.store, stageId, resolved.learnerKey);
        const restoreMarker = currentRestoreMarker(beforeSave, stageId) ?? null;
        const callerSnapshot = options.snapshot;
        if (
          callerSnapshot &&
          (callerSnapshot.restoreMarker === undefined ||
            callerSnapshot.restoreMarker !== restoreMarker)
        ) {
          // Restore invalidates snapshots captured by already-mounted callers.
          // Unchanged stage autosaves are harmless no-ops; real chat mutations
          // fail loud until the caller reloads instead of overwriting backup data.
          if (matchesSnapshot(callerSnapshot, nextSessions)) return;
          throw new ChatStorageSnapshotInvalidatedByRestoreError(
            `Chat snapshot for stage ${JSON.stringify(stageId)} was invalidated by backup restore`,
          );
        }
        if (!callerSnapshot && restoreMarker !== null) {
          throw new ChatStorageSnapshotInvalidatedByRestoreError(
            `Chat snapshot for stage ${JSON.stringify(stageId)} must be reloaded after backup restore`,
          );
        }
        const knownSessionIds = callerSnapshot
          ? new Set(callerSnapshot.sessions.map((session) => session.id))
          : observedIds(resolved.store, queueKey);
        const priorObservedSessions = callerSnapshot
          ? sessionMap(callerSnapshot.sessions)
          : observedSessions(resolved.store, queueKey);
        await syncSessions(
          resolved.store,
          stageId,
          resolved.learnerKey,
          nextSessions,
          true,
          isolatedWrites,
          knownSessionIds,
          priorObservedSessions,
          beforeSave,
        );
        rememberObservedIds(
          resolved.store,
          queueKey,
          nextSessions.map((session) => session.id),
        );
        // saveChatSessions does not return a reconciled snapshot to its caller.
        // Keep conflict observations aligned with the state the caller really
        // saw, even when this save silently preserved a newer cross-tab value.
        rememberObservedSessions(resolved.store, queueKey, nextSessions);
        await resolved.legacyStore.clear(stageId);
      },
      options.globalLockHeld,
    );
  } catch (error) {
    // A stage autosave echoes the caller-visible chat snapshot even when the
    // user only changed document data. Without Web Locks, an unchanged echo is
    // a safe no-op; any chat creation, edit, or deletion must still fail loud.
    if (
      error instanceof ChatStorageLockUnavailableError &&
      (options.snapshot
        ? matchesSnapshot(options.snapshot, nextSessions)
        : matchesObservedSessions(resolved.store, queueKey, nextSessions))
    ) {
      return;
    }
    throw error;
  }
}

/** Load chat sessions, migrating legacy Dexie rows on first access. */
export async function loadChatSessions(
  stageId: string,
  options: ChatStorageReadOptions = {},
): Promise<ChatSession[]> {
  const resolved = await context(options);
  const queueKey = `${stageId}\0${resolved.learnerKey}`;
  let legacy: ChatSession[] = [];
  let runtimeReadSucceeded = false;
  let readRestoreMarker: string | null | undefined;
  try {
    return await enqueue(
      resolved.store,
      queueKey,
      stageId,
      resolved.requiresCrossRealmLock,
      async (isolatedWrites) => {
        // Read legacy rows only after entering the same partition queue/lock as
        // saves. Otherwise a delayed migration can replay a snapshot captured
        // before a concurrent save cleared it and resurrect deleted chats.
        legacy = (await resolved.legacyStore.load(stageId)).map(normalizeSession);
        const beforeLoad = await runtimeViews(resolved.store, stageId, resolved.learnerKey);
        const restoreMarker = currentRestoreMarker(beforeLoad, stageId) ?? null;
        readRestoreMarker = restoreMarker;
        if (legacy.length === 0) {
          const loaded = await loadRuntimeSessions(resolved.store, stageId, resolved.learnerKey);
          runtimeReadSucceeded = true;
          if (options.observe !== false) {
            rememberObservedIds(
              resolved.store,
              queueKey,
              loaded.map((session) => session.id),
            );
            rememberObservedSessions(resolved.store, queueKey, loaded);
          }
          reportSnapshot(options, loaded, restoreMarker);
          return loaded;
        }
        const migrated = await syncSessions(
          resolved.store,
          stageId,
          resolved.learnerKey,
          legacy,
          false,
          isolatedWrites,
          undefined,
          undefined,
          beforeLoad,
        );
        runtimeReadSucceeded = true;
        if (options.observe !== false) {
          rememberObservedIds(
            resolved.store,
            queueKey,
            migrated.map((session) => session.id),
          );
          rememberObservedSessions(resolved.store, queueKey, migrated);
        }
        await resolved.legacyStore.clear(stageId);
        reportSnapshot(options, migrated, restoreMarker);
        return migrated;
      },
    );
  } catch (error) {
    if (error instanceof ChatStorageLockUnavailableError) {
      // No-lock environments cannot safely migrate or clear the shared legacy
      // table, but a read-only legacy snapshot keeps pre-cutover history
      // visible. Strict callers such as backup export still fail loud.
      if (options.fallbackToLegacyOnError === false) throw error;
      const readOnlyLegacy = (await resolved.legacyStore.load(stageId)).map(normalizeSession);
      if (readOnlyLegacy.length === 0) throw error;
      if (options.observe !== false) {
        rememberObservedIds(
          resolved.store,
          queueKey,
          readOnlyLegacy.map((session) => session.id),
        );
        rememberObservedSessions(resolved.store, queueKey, readOnlyLegacy);
      }
      reportSnapshot(options, readOnlyLegacy, undefined);
      console.warn(`Loaded legacy chat sessions without migration for stage ${stageId}:`, error);
      return readOnlyLegacy;
    }
    // A failed runtime read is not an authoritative empty snapshot. Forget the
    // prior observation so a later stage save cannot retire unseen data. A
    // legacy-clear failure happens after migration succeeded, so retain it.
    if (options.observe !== false && !runtimeReadSucceeded) {
      rememberObservedIds(resolved.store, queueKey, []);
      rememberObservedSessions(resolved.store, queueKey, []);
    } else if (options.observe !== false) {
      // The fallback returns only the legacy rows. Runtime-only sessions that
      // were discovered during sync were not exposed to the caller, so their
      // omission from the next UI snapshot must not be treated as deletion.
      rememberObservedIds(
        resolved.store,
        queueKey,
        legacy.map((session) => session.id),
      );
      rememberObservedSessions(resolved.store, queueKey, legacy);
    }
    if (options.fallbackToLegacyOnError === false) throw error;
    if (legacy.length === 0) throw error;
    reportSnapshot(options, legacy, runtimeReadSucceeded ? readRestoreMarker : undefined);
    console.warn(`Failed to migrate chat sessions for stage ${stageId}:`, error);
    return legacy;
  }
}

/** Remove this learner's runtime chat partition before restoring a backup. */
export async function clearRuntimeChatSessions(
  stageId: string,
  options: ChatStorageOptions = {},
): Promise<void> {
  const resolved = await context(options);
  const queueKey = `${stageId}\0${resolved.learnerKey}`;
  await enqueue(resolved.store, queueKey, stageId, resolved.requiresCrossRealmLock, async () => {
    await clearRuntimeChatSessionsUnlocked(resolved.store, stageId, resolved.learnerKey, queueKey);
  });
}

async function clearRuntimeChatSessionsUnlocked(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  queueKey: string,
  recordRestore = false,
): Promise<void> {
  const views = await runtimeViews(store, stageId, learnerKey);
  await Promise.all(views.map((view) => store.deleteSession(view.runtimeSession.id)));
  if (recordRestore) {
    const now = new Date().toISOString();
    await store.createSession({
      id: `${restoreMarkerPrefix(stageId)}${encodeURIComponent(learnerKey)}:${nanoid()}`,
      kind: 'chat',
      stageId,
      learnerKey,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    });
    // Durable restore state changed, but the mounted caller's React snapshot
    // did not. Preserve its old observation so its next autosave is rejected.
    return;
  }
  rememberObservedIds(store, queueKey, []);
  rememberObservedSessions(store, queueKey, []);
}

/** Stage legacy backup rows and clear their runtime partitions under the same locks. */
export async function restoreChatSessionsFromBackup(
  stageIds: string[],
  restoreLegacyRows: () => Promise<void>,
  options: ChatStorageOptions = {},
): Promise<void> {
  const resolved = await context(options);
  const orderedStageIds = [...new Set(stageIds)].sort();
  const queueKeys = orderedStageIds.map((stageId) => `${stageId}\0${resolved.learnerKey}`);
  // Snapshot only work that predates this restore. A later save may be queued
  // behind an exclusive maintenance request; awaiting it while holding the
  // shared global lock would create a cycle (restore -> save -> maintenance -> restore).
  const existingQueues = storeQueues.get(resolved.store);
  const precedingWrites = queueKeys
    .map((queueKey) => existingQueues?.get(queueKey))
    .filter((pending): pending is Promise<void> => pending !== undefined);

  async function withStageLock(index: number): Promise<void> {
    if (index < orderedStageIds.length) {
      const stageId = orderedStageIds[index]!;
      const queueKey = queueKeys[index]!;
      await withPartitionLocks(stageId, queueKey, resolved.requiresCrossRealmLock, async () =>
        withStageLock(index + 1),
      );
      return;
    }

    await restoreLegacyRows();
    for (const stageId of orderedStageIds) {
      const queueKey = `${stageId}\0${resolved.learnerKey}`;
      await clearRuntimeChatSessionsUnlocked(
        resolved.store,
        stageId,
        resolved.learnerKey,
        queueKey,
        true,
      );
    }
  }

  const restoreAfterPrecedingWrites = async (): Promise<void> => {
    await Promise.all(precedingWrites);
    await withStageLock(0);
  };

  if (options.globalLockHeld) {
    await restoreAfterPrecedingWrites();
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // The queue snapshot and shared-lock request are synchronous with respect
    // to other JavaScript tasks. New saves either join this shared epoch and
    // coordinate on partition locks, or wait behind a later exclusive request.
    await withChatStorageSharedLock(restoreAfterPrecedingWrites);
    return;
  }
  if (resolved.requiresCrossRealmLock) {
    throw new ChatStorageLockUnavailableError(
      'Chat storage requires the Web Locks API in this browser',
    );
  }
  // Without Web Locks, serialize the whole restore against same-realm writers.
  await Promise.all(precedingWrites);
  await withChatStorageExclusiveLock(() => withStageLock(0));
}

/** Clear the legacy table during stage deletion; RuntimeStore cascades separately. */
export async function deleteChatSessions(stageId: string): Promise<void> {
  await dexieLegacyStore.clear(stageId);
}
