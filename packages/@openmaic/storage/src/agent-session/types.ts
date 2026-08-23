/**
 * Durable contracts for background agent sessions.
 *
 * The four interfaces deliberately separate lifecycle coordination, the
 * per-session event stream, the append-only entry tree, and the sparse
 * per-owner projection. Hosts commonly use one backend for all four, but the
 * split prevents a control-plane reader from accidentally gaining lease-bound
 * write authority and lets projection damage be repaired independently.
 */

export const AGENT_SESSION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export const AGENT_SESSION_LIFECYCLE = {
  sessionStart: 'session_start',
  sessionResumed: 'session_resumed',
  checkpoint: 'checkpoint',
  sessionEnd: 'session_end',
  sessionInterrupted: 'session_interrupted',
  userMessage: 'user_message',
  trace: 'trace',
  thinkingEnd: 'thinking_end',
  materialExtraction: 'material_extraction',
  userQuestion: 'user_question',
  activeStageChanged: 'active_stage_changed',
  libraryChanged: 'library_changed',
} as const;

export type AgentSessionLifecycleEventType =
  (typeof AGENT_SESSION_LIFECYCLE)[keyof typeof AGENT_SESSION_LIFECYCLE];

export interface AgentSessionLease {
  workerId: string;
  workerPid: number;
  heartbeatAt: number;
}

export interface AgentSessionMeta {
  id: string;
  ownerId: string;
  prompt: string;
  /** The immutable stage with which the conversation was created. */
  stageId: string;
  /** The current tool target; absence means that {@link stageId} is active. */
  activeStageId?: string;
  skillId?: string;
  origin?: string;
  existingCourse: boolean;
  status: AgentSessionStatus;
  /** The consecutive-failure generation, incremented by every successful claim. */
  attempt: number;
  createdAt: number;
  updatedAt: number;
  lease?: AgentSessionLease;
  error?: string;
}

export interface CreateAgentSessionInput {
  /** An optional caller-minted stable id. */
  id?: string;
  ownerId: string;
  prompt: string;
  /** Defaults to a stable value derived from the final session id. */
  stageId?: string;
  skillId?: string;
  origin?: string;
  existingCourse?: boolean;
  /** Existing-course sessions may begin terminal and requeue on the first message. */
  status?: 'queued' | 'succeeded';
}

export type AgentSessionClaimReason = 'queued' | 'orphaned';

export interface ClaimedAgentSession extends AgentSessionMeta {
  claimReason: AgentSessionClaimReason;
  /** Event-log high-water mark observed while the claim held the session row lock. */
  claimSeq: number;
}

export interface ClaimAgentSessionOptions {
  leaseTtlMs: number;
  maxAttempts: number;
  /** Restricts a claim to one session instead of scanning the oldest candidates. */
  sessionId?: string;
}

export interface FinishAgentSessionPatch {
  status: AgentSessionStatus;
  error?: string;
  /** Defaults to true. False is useful for an interruption marker written first. */
  releaseLease?: boolean;
  /** Clean endings reset the consecutive-failure chain when requested. */
  resetAttempt?: boolean;
}

export interface PostAgentUserMessageResult {
  seq: number;
  delivery: 'steer' | 'queued';
  requeued: boolean;
}

export interface PostAgentUserMessageOptions {
  /** Revalidates an owner snapshot after the transaction has acquired its locks. */
  expectedOwnerId?: string;
}

/** A control-plane write was attempted through a retired or different owner. */
export class AgentSessionAccessError extends Error {
  override readonly name = 'AgentSessionAccessError';

  constructor(readonly sessionId: string) {
    super(
      `@openmaic/storage: session ${JSON.stringify(sessionId)} is not accessible by this owner`,
    );
  }
}

/** An opened tree attempted to append after its lease generation was superseded. */
export class AgentSessionLeaseLostError extends Error {
  override readonly name = 'AgentSessionLeaseLostError';

  constructor(
    readonly sessionId: string,
    readonly workerId: string,
    readonly attempt: number,
  ) {
    super(
      `@openmaic/storage: session ${JSON.stringify(sessionId)} lease or attempt fence was lost ` +
        `by ${JSON.stringify(workerId)} at attempt ${attempt}`,
    );
  }
}

/** A tree contains a dangling parent, duplicate id, or invalid leaf target. */
export class AgentSessionEntryTreeError extends Error {
  override readonly name = 'AgentSessionEntryTreeError';

  constructor(
    readonly sessionId: string,
    reason: string,
  ) {
    super(
      `@openmaic/storage: invalid entry tree for session ${JSON.stringify(sessionId)}: ${reason}`,
    );
  }
}

/** Minimal framework-independent shape stored by the append-only tree. */
export interface AgentSessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export interface AgentSessionMessageEntry extends AgentSessionEntryBase {
  type: 'message';
  message: unknown;
}

export interface AgentSessionLabelEntry extends AgentSessionEntryBase {
  type: 'label';
  targetId: string;
  label?: string;
}

export interface AgentSessionLeafEntry extends AgentSessionEntryBase {
  type: 'leaf';
  targetId: string | null;
}

export interface AgentSessionCompactionEntry extends AgentSessionEntryBase {
  type: 'compaction';
  firstKeptEntryId: string;
  summary?: unknown;
}

export interface AgentSessionBranchSummaryEntry extends AgentSessionEntryBase {
  type: 'branch_summary';
  summary?: unknown;
}

export interface AgentSessionCustomMessageEntry extends AgentSessionEntryBase {
  type: 'custom_message';
  message: unknown;
}

export type AgentSessionEntry =
  | AgentSessionMessageEntry
  | AgentSessionLabelEntry
  | AgentSessionLeafEntry
  | AgentSessionCompactionEntry
  | AgentSessionBranchSummaryEntry
  | AgentSessionCustomMessageEntry
  | AgentSessionEntryBase;

export interface AgentSessionEntryTreeHandle {
  getEntries(): Promise<AgentSessionEntry[]>;
  getEntry(id: string): Promise<AgentSessionEntry | undefined>;
  findEntries<TType extends AgentSessionEntry['type']>(
    type: TType,
  ): Promise<Array<Extract<AgentSessionEntry, { type: TType }> | AgentSessionEntry>>;
  getLabel(id: string): Promise<string | undefined>;
  getPathToRoot(leafId: string | null): Promise<AgentSessionEntry[]>;
  getLeafId(): Promise<string | null>;
  /**
   * Append a leaf marker instead of mutating prior rows. This keeps cursor
   * movement auditable and ensures a crash can only lose the newest marker.
   */
  setLeafId(leafId: string | null): Promise<void>;
  appendEntry(entry: AgentSessionEntry): Promise<void>;
  createEntryId(): Promise<string>;
}

/** Lifecycle and lease coordination for independently running processes. */
export interface AgentSessionStore {
  createSession(input: CreateAgentSessionInput): Promise<AgentSessionMeta>;
  getSession(sessionId: string): Promise<AgentSessionMeta | null>;
  listSessionsByOwner(ownerId: string): Promise<AgentSessionMeta[]>;
  /** Tombstone a visible session while deliberately preserving every child row. */
  softDeleteSession(sessionId: string, ownerId: string): Promise<boolean>;
  resolveActiveStage(sessionId: string): Promise<string>;
  setActiveStage(sessionId: string, stageId: string): Promise<boolean>;
  /**
   * Scan optimistically, then lock and recheck one candidate. The second
   * check is the authority: candidate snapshots are stale as soon as read.
   */
  claimNextSession(
    workerId: string,
    workerPid: number,
    options: ClaimAgentSessionOptions,
  ): Promise<ClaimedAgentSession | null>;
  heartbeat(sessionId: string, workerId: string): Promise<boolean>;
  finishSession(
    sessionId: string,
    workerId: string,
    patch: FinishAgentSessionPatch,
  ): Promise<boolean>;
  releaseLease(sessionId: string, workerId: string): Promise<void>;
  requestCancel(sessionId: string): Promise<void>;
  isCancelRequested(sessionId: string): Promise<boolean>;
  clearCancel(sessionId: string): Promise<void>;
  /** An attended retry clears the consecutive-failure generation. */
  requeueSession(sessionId: string): Promise<boolean>;
  /** An unattended retry preserves the consecutive-failure generation. */
  requeueForRetry(sessionId: string): Promise<boolean>;
  /**
   * Lock, persist, classify delivery, and revive a terminal session in one
   * transaction so a message cannot fall into the runner's settle window.
   */
  postUserMessage(
    sessionId: string,
    input: { text: string },
    options?: PostAgentUserMessageOptions,
  ): Promise<PostAgentUserMessageResult>;
  /**
   * Re-key package-owned session data and owner projection history. Hosts
   * remain responsible for merging product tables outside this package.
   */
  mergeOwner(fromOwnerId: string, toOwnerId: string): Promise<number>;
}

export interface NewAgentSessionEvent {
  ts: number;
  attempt: number;
  type: string;
  data: unknown;
}

export interface PersistedAgentSessionEvent extends NewAgentSessionEvent {
  /** Monotonic, one-based, per-session replay cursor. */
  id: number;
}

export interface AgentSessionUserMessage {
  seq: number;
  ts: number;
  text: string;
  delivery: string;
  materials: unknown[];
}

/** The durable stream has separate lease-bound and control-plane writers. */
export interface AgentSessionEventLog {
  appendRunEvent(
    sessionId: string,
    workerId: string,
    event: NewAgentSessionEvent,
  ): Promise<number | null>;
  appendControlEvent(sessionId: string, event: NewAgentSessionEvent): Promise<number | null>;
  appendUserMessage(
    sessionId: string,
    input: { text: string; delivery: 'steer' | 'queued'; clientRequestId?: string },
  ): Promise<number>;
  listUserMessages(sessionId: string): Promise<AgentSessionUserMessage[]>;
  readEventsAfter(
    sessionId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<PersistedAgentSessionEvent[]>;
  /** Returns raw rows scanned separately from the compacted replay frames. */
  readEventsAfterForReplay(
    sessionId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<{ events: PersistedAgentSessionEvent[]; scanned: number }>;
  lastEventSeq(sessionId: string): Promise<number>;
  hasSessionRunHistory(sessionId: string): Promise<boolean>;
}

/** Opens an append-only tree fenced to one worker and claim generation. */
export interface AgentSessionEntryTree {
  openEntryTree(
    sessionId: string,
    workerId: string,
    attempt: number,
  ): Promise<AgentSessionEntryTreeHandle>;
}

export const OWNER_SESSION_EVENT_TYPES = [
  'session_created',
  'session_status',
  'session_deleted',
  'session_active_stage',
  'session_cancel_requested',
] as const;

export type OwnerSessionEventType = (typeof OWNER_SESSION_EVENT_TYPES)[number];

interface OwnerSessionEventBase {
  sessionId: string;
  ts: number;
}

export type NewOwnerSessionEvent =
  | (OwnerSessionEventBase & {
      type: 'session_created' | 'session_status';
      status: AgentSessionStatus;
      attempt: number;
    })
  | (OwnerSessionEventBase & { type: 'session_deleted' | 'session_cancel_requested' })
  | (OwnerSessionEventBase & { type: 'session_active_stage'; activeStageId: string });

export type PersistedOwnerSessionEvent = NewOwnerSessionEvent & {
  /** Decimal bigint text avoids rounding a replay cursor in JavaScript. */
  id: string;
  ownerId: string;
};

export interface OwnerSessionEventProjection {
  /**
   * Append inside the caller's business transaction through a SAVEPOINT.
   * Any projection error is logged and returns null: derived navigation data
   * must never veto the authoritative lifecycle write. A client repairs a
   * missing summary through periodic full-list reconciliation, so hosts must
   * retain that reconciliation path whenever they enable this projection.
   */
  append(event: NewOwnerSessionEvent, transaction: AgentSessionTransaction): Promise<bigint | null>;
  readAfter(
    ownerId: string,
    afterId: bigint,
    limit?: number,
  ): Promise<PersistedOwnerSessionEvent[]>;
  /** Reads the durable counter, not max(id), because event rows may be pruned. */
  readMaxId(ownerId: string): Promise<bigint>;
  /** Returns a replacement identity when the host's resolver retires this owner. */
  readRetirement(ownerId: string): Promise<string | null>;
}

/** The minimal transaction surface exposed to hooks without a driver dependency. */
export interface AgentSessionTransaction {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}

/**
 * Host integration hooks execute in the authoritative business transaction.
 * `resolveFinalOwner` must perform the transaction's first statement and use
 * the same advisory-lock order as the host operation that retires an owner;
 * otherwise a create can commit under an identity immediately after merge.
 */
export interface AgentSessionHooks {
  resolveFinalOwner?: (transaction: AgentSessionTransaction, ownerId: string) => Promise<string>;
  /** Runs after insertion, before the creation transaction can commit. */
  onSessionCreated?: (
    transaction: AgentSessionTransaction,
    meta: AgentSessionMeta,
  ) => Promise<void>;
  /** Runs after the message event is durable but before classification commits. */
  onUserMessagePosted?: (
    transaction: AgentSessionTransaction,
    input: {
      session: AgentSessionMeta;
      text: string;
      seq: number;
      delivery: 'steer' | 'queued';
      clientRequestId: string;
    },
  ) => Promise<void>;
}
