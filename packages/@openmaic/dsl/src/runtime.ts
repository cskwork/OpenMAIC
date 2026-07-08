/**
 * Runtime layer contract (#869): what a learner produces while taking a
 * course — conversations, quiz attempts, playback facts. Runtime data does
 * not travel with the document; it is persisted per learner by a
 * `RuntimeStore` (`@openmaic/storage`, Part B of #869) and is exportable as
 * a replay. This module owns only the *envelope* and the skeletons of the
 * core kinds; payload internals are app-owned and injected via generics,
 * exactly like widened scene content on `DocumentStore<TScene>` (#860).
 *
 * Two-level model, deliberately:
 *
 * - A {@link RuntimeSession} is the unit of identity and lifecycle. It owns
 *   the `(stageId, learnerKey, kind)` dimensions and the status ladder. A
 *   document has many sessions — one or more per learner.
 * - A {@link RuntimeRecord} is an ordered fact inside one session. Ordering
 *   is the store-assigned monotonic {@link RuntimeRecord.seq}, never client
 *   timestamps (multiple tabs and clock skew make wall clocks unreliable
 *   for replay). Timestamps are display metadata.
 *
 * Anchors are best-effort: documents are editable, so a `sceneId` /
 * `actionIndex` written yesterday may dangle after today's edit. Consumers
 * (replay, summaries) MUST tolerate missing or stale anchors.
 *
 * No runtime dependencies. Pure types + plain data constants only.
 */

/**
 * Lifecycle of a session. Records carry no lifecycle of their own — a chat
 * message or an answered question is a fact, not a state machine.
 *
 * - `active`: the learner may still append records.
 * - `completed`: closed normally; eligible for replay export.
 * - `archived`: kept for history but hidden from default listings.
 */
export type RuntimeSessionStatus = 'active' | 'completed' | 'archived';

/** All session statuses, in lifecycle order. */
export const RUNTIME_SESSION_STATUSES = ['active', 'completed', 'archived'] as const;

/** Narrow an unknown value to a valid {@link RuntimeSessionStatus}. */
export function isRuntimeSessionStatus(value: unknown): value is RuntimeSessionStatus {
  return (RUNTIME_SESSION_STATUSES as readonly unknown[]).includes(value);
}

/**
 * Runtime kinds whose payload skeletons the DSL owns. `RuntimeSession.kind`
 * is an open `string` — apps define their own kinds without touching the
 * contract; these are only the ones with a DSL-owned skeleton.
 */
export type CoreRuntimeKind = 'chat' | 'quizAttempt' | 'playback';

/** All core runtime kinds. */
export const CORE_RUNTIME_KINDS = ['chat', 'quizAttempt', 'playback'] as const;

/** Narrow an unknown value to a valid {@link CoreRuntimeKind}. */
export function isCoreRuntimeKind(value: unknown): value is CoreRuntimeKind {
  return (CORE_RUNTIME_KINDS as readonly unknown[]).includes(value);
}

/**
 * The unit of learner-runtime identity and lifecycle. Sessions are keyed by
 * `(stageId, learnerKey)` plus a `kind`; a learner may hold several sessions
 * of the same kind on one stage (e.g. repeated quiz attempts).
 */
export interface RuntimeSession {
  id: string;
  /** {@link CoreRuntimeKind} or an app-defined kind. */
  kind: string;
  stageId: string;
  /**
   * Opaque principal string — the DSL does not own auth. Deployments choose
   * the shape (an anonymous device key, an account id, …); stores treat it
   * as an exact-match partition key.
   */
  learnerKey: string;
  status: RuntimeSessionStatus;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /**
   * Serialized-contract version stamp (see `DSL_VERSION_KEY`), same
   * stamping + migrate-on-read ladder as the document aggregate. Absent on
   * legacy data.
   */
  dslVersion?: string;
}

/**
 * One ordered fact inside a session. Identity, learner and lifecycle live on
 * the parent {@link RuntimeSession}; the record carries only ordering,
 * anchoring, and the app-owned payload.
 */
export interface RuntimeRecord<TPayload = unknown> {
  id: string;
  /** Parent {@link RuntimeSession.id}. */
  sessionId: string;
  /**
   * Per-session monotonic sequence, assigned by the store on append. The
   * sole replay ordering key — never order by timestamp.
   */
  seq: number;
  /** Best-effort anchor into the document timeline; may dangle after edits. */
  sceneId?: string;
  /** Best-effort anchor; index into the anchored scene's actions. */
  actionIndex?: number;
  /**
   * App-defined sub-anchor below the scene/action granularity (e.g. a quiz
   * question id or a PBL microtask id). Opaque to the DSL.
   */
  subAnchor?: string;
  /** ISO 8601. Display metadata only — see {@link RuntimeRecord.seq}. */
  createdAt: string;
  /** App-owned payload; validation is injected per kind, like scene content. */
  payload: TPayload;
}

/** Speaker roles the replay renderer can rely on for `chat` records. */
export type ChatRuntimeRole = 'user' | 'assistant' | 'system';

/** All chat roles. */
export const CHAT_RUNTIME_ROLES = ['user', 'assistant', 'system'] as const;

/** Narrow an unknown value to a valid {@link ChatRuntimeRole}. */
export function isChatRuntimeRole(value: unknown): value is ChatRuntimeRole {
  return (CHAT_RUNTIME_ROLES as readonly unknown[]).includes(value);
}

/**
 * Minimal payload skeleton for `chat` records — just enough structure for a
 * replay renderer (who spoke, what text). Apps extend with their own fields
 * (attachments, tool traces, …) by intersection.
 */
export interface ChatMessageSkeleton {
  role: ChatRuntimeRole;
  content: string;
}

/**
 * Phases of a quiz attempt. Mirrors the lifecycle the browser app expresses
 * today by creating/deleting storage keys (draft → submitted → reviewed),
 * made explicit so downstream consumers can reason about *when* and *in
 * which attempt* an answer was given.
 */
export type QuizAttemptPhase = 'draft' | 'submitted' | 'reviewed';

/** All quiz attempt phases, in lifecycle order. */
export const QUIZ_ATTEMPT_PHASES = ['draft', 'submitted', 'reviewed'] as const;

/** Narrow an unknown value to a valid {@link QuizAttemptPhase}. */
export function isQuizAttemptPhase(value: unknown): value is QuizAttemptPhase {
  return (QUIZ_ATTEMPT_PHASES as readonly unknown[]).includes(value);
}

/**
 * Minimal payload skeleton for `quizAttempt` records. Answers are keyed by
 * question id; grading detail and scoring algorithms are app-owned.
 */
export interface QuizAttemptSkeleton {
  phase: QuizAttemptPhase;
  answers: Record<string, unknown>;
}
