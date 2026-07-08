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
 * Timestamps here are ISO 8601 strings — a deliberate divergence from the
 * document aggregate's epoch-millisecond numbers. The runtime contract
 * standardizes on ISO (#869), so do NOT mix the two encodings when merging a
 * runtime feed with document data: convert at the boundary, never compare a
 * runtime `createdAt` string against a document's numeric timestamp directly.
 *
 * Versioning: a session carries its OWN version field, `runtimeDslVersion`
 * (distinct from a document's `dslVersion`), and rides its OWN version line —
 * `RUNTIME_DSL_VERSION` + `migrateRuntime`, not the document's `DSL_VERSION` +
 * `migrate`. Because the two lines stamp different envelope fields, the
 * separation is mechanical, not merely a call-site convention: a document
 * migration walked over a session finds no `dslVersion` stamp and, at worst,
 * adds a foreign field it owns, never consuming or corrupting the runtime line's
 * `runtimeDslVersion` stamp — and vice versa (see `version.ts`).
 *
 * No runtime dependencies. Pure types + plain data constants only.
 */
import type { RuntimeVersioned } from './version.js';

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
export const RUNTIME_SESSION_STATUSES = [
  'active',
  'completed',
  'archived',
] as const satisfies readonly RuntimeSessionStatus[];

// Compile-time exhaustiveness: every RuntimeSessionStatus must appear above.
// `satisfies` proves each entry is a valid status; this proves the converse, so
// adding a union member without extending the tuple fails the build.
type _RuntimeSessionStatusesExhaustive = [RuntimeSessionStatus] extends [
  (typeof RUNTIME_SESSION_STATUSES)[number],
]
  ? true
  : never;
const _runtimeSessionStatusesExhaustive: _RuntimeSessionStatusesExhaustive = true;
void _runtimeSessionStatusesExhaustive;

/** Narrow an unknown value to a valid {@link RuntimeSessionStatus}. */
export function isRuntimeSessionStatus(value: unknown): value is RuntimeSessionStatus {
  return (RUNTIME_SESSION_STATUSES as readonly unknown[]).includes(value);
}

/**
 * ISO-8601 shape a runtime timestamp string is required to match:
 * `YYYY-MM-DDTHH:mm:ss`, an optional fractional-second part, and a mandatory
 * zone designator (`Z` or `±hh:mm`). Runtime timestamps are display metadata
 * whose only cross-tab guarantee is a comparable, unambiguous instant, so the
 * zone is not optional here — a zoneless string names no instant.
 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * True when `value` is a well-formed ISO-8601 timestamp per the runtime
 * contract. The runtime envelope has no generated schema artifact backing it
 * (unlike stage/scene/action), so this pure check is where the documented
 * "ISO 8601" promise on `createdAt` / `updatedAt` is actually enforced.
 *
 * Three layers, none of which alone suffices:
 * - the regex pins the *format* (`Date.parse` alone accepts many non-ISO forms
 *   — bare dates, `'2026/01/01'`, even some free text — so it cannot stand in
 *   for a format check), and pins the mandatory zone designator;
 * - `!Number.isNaN(Date.parse(value))` rejects field-range violations the regex
 *   lets through (month `13`, hour `25`, minute / second `60`), which only a
 *   real date parse catches; but
 * - `Date.parse` does NOT reliably reject day-of-month overflow: on V8 (the CI
 *   Node 22 engine) `'2026-02-30'`, `'2026-02-29'` (2026 is not a leap year),
 *   and `'2026-04-31'` all *normalize* (roll into the next month) instead of
 *   yielding `NaN`, and the verdict is engine-dependent. So the final layer
 *   re-parses the calendar date and requires it to round-trip unchanged, which
 *   rejects the overflow AND makes the verdict engine-independent.
 *
 * Pure, no runtime dependencies.
 */
export function isIsoTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) return false;
  // Day-of-month round-trip: reject a day that `Date.UTC` normalized into the
  // next month (e.g. Feb 30 -> Mar 2) rather than accepting it as valid.
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const d = new Date(Date.UTC(y, m - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === day;
}

/**
 * The core runtime kind *names* the contract recognizes — the ones Part B
 * migrates first. `RuntimeSession.kind` is an open `string`, so apps define
 * their own kinds without touching the contract; these are just the recognized
 * ones. Note this is about kind *names*, not skeletons: the DSL ships payload
 * skeletons for `chat` and `quizAttempt` only. `playback` has NO skeleton by
 * design — its payload is app-owned; only the kind name is contract-recognized.
 */
export type CoreRuntimeKind = 'chat' | 'quizAttempt' | 'playback';

/** All core runtime kinds. */
export const CORE_RUNTIME_KINDS = [
  'chat',
  'quizAttempt',
  'playback',
] as const satisfies readonly CoreRuntimeKind[];

// Compile-time exhaustiveness: every CoreRuntimeKind must appear above (see the
// RUNTIME_SESSION_STATUSES check for the pattern).
type _CoreRuntimeKindsExhaustive = [CoreRuntimeKind] extends [(typeof CORE_RUNTIME_KINDS)[number]]
  ? true
  : never;
const _coreRuntimeKindsExhaustive: _CoreRuntimeKindsExhaustive = true;
void _coreRuntimeKindsExhaustive;

/** Narrow an unknown value to a valid {@link CoreRuntimeKind}. */
export function isCoreRuntimeKind(value: unknown): value is CoreRuntimeKind {
  return (CORE_RUNTIME_KINDS as readonly unknown[]).includes(value);
}

/**
 * The unit of learner-runtime identity and lifecycle. Sessions are keyed by
 * `(stageId, learnerKey)` plus a `kind`; a learner may hold several sessions
 * of the same kind on one stage (e.g. repeated quiz attempts).
 *
 * Extends {@link RuntimeVersioned}, so a session carries an optional
 * `runtimeDslVersion` serialized-contract stamp (absent on legacy data) — a
 * DIFFERENT envelope field from a document's `dslVersion`. Stamping +
 * migrate-on-read run on the runtime line only: a session is stamped with
 * `RUNTIME_DSL_VERSION` and migrated by `migrateRuntime`, independent of the
 * document's `DSL_VERSION` / `migrate`. Because the two stamps live on distinct
 * fields, misrouting a migration is inert rather than corrupting (see
 * `version.ts`).
 */
export interface RuntimeSession extends RuntimeVersioned {
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
}

/**
 * The set of values a {@link RuntimeRecord.payload} may hold: any value EXCEPT
 * `undefined`. `null` is deliberately included — it is a legal stored payload an
 * app may deliberately persist, and {@link validateRuntimeRecord} accepts it.
 *
 * `NonNullable<unknown>` is `{}` (every non-nullish value) without the banned
 * bare-`{}` literal; unioning `null` back in yields "anything but `undefined`".
 * This aligns the static type with the runtime validator, which rejects
 * `payload: undefined` but accepts `null` — a plain `unknown` payload would let
 * `payload: undefined` type-check yet fail at append time.
 */
export type RuntimePayload = NonNullable<unknown> | null;

/**
 * One ordered fact inside a session. Identity, learner and lifecycle live on
 * the parent {@link RuntimeSession}; the record carries only ordering,
 * anchoring, and the app-owned payload.
 */
export interface RuntimeRecord<TPayload extends RuntimePayload = RuntimePayload> {
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

/**
 * The shape a producer hands to a store's `append`: a {@link RuntimeRecord}
 * minus its `seq`. Ordering is store-owned — `seq` is the per-session monotonic
 * key the store assigns on append and cannot be supplied by the caller — so the
 * creation type omits it structurally rather than trusting producers to leave
 * it out (and to leave it consistent across concurrent appenders).
 */
export type RuntimeRecordInit<TPayload extends RuntimePayload = RuntimePayload> = Omit<
  RuntimeRecord<TPayload>,
  'seq'
>;

/** Speaker roles the replay renderer can rely on for `chat` records. */
export type ChatRuntimeRole = 'user' | 'assistant' | 'system';

/** All chat roles. */
export const CHAT_RUNTIME_ROLES = [
  'user',
  'assistant',
  'system',
] as const satisfies readonly ChatRuntimeRole[];

// Compile-time exhaustiveness: every ChatRuntimeRole must appear above (see the
// RUNTIME_SESSION_STATUSES check for the pattern).
type _ChatRuntimeRolesExhaustive = [ChatRuntimeRole] extends [(typeof CHAT_RUNTIME_ROLES)[number]]
  ? true
  : never;
const _chatRuntimeRolesExhaustive: _ChatRuntimeRolesExhaustive = true;
void _chatRuntimeRolesExhaustive;

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
 * Narrow an unknown value to a {@link ChatMessageSkeleton}: an object whose
 * `role` is a recognized {@link ChatRuntimeRole} and whose `content` is a
 * string. Structural subset only — app-added fields are ignored, matching how
 * apps extend the skeleton by intersection. Pure, no runtime deps.
 */
export function isChatMessageSkeleton(value: unknown): value is ChatMessageSkeleton {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { role?: unknown; content?: unknown };
  return isChatRuntimeRole(v.role) && typeof v.content === 'string';
}

/**
 * Phases of a quiz attempt. Mirrors the lifecycle the browser app expresses
 * today by creating/deleting storage keys (draft → submitted → reviewed),
 * made explicit so downstream consumers can reason about *when* and *in
 * which attempt* an answer was given.
 */
export type QuizAttemptPhase = 'draft' | 'submitted' | 'reviewed';

/** All quiz attempt phases, in lifecycle order. */
export const QUIZ_ATTEMPT_PHASES = [
  'draft',
  'submitted',
  'reviewed',
] as const satisfies readonly QuizAttemptPhase[];

// Compile-time exhaustiveness: every QuizAttemptPhase must appear above (see the
// RUNTIME_SESSION_STATUSES check for the pattern).
type _QuizAttemptPhasesExhaustive = [QuizAttemptPhase] extends [
  (typeof QUIZ_ATTEMPT_PHASES)[number],
]
  ? true
  : never;
const _quizAttemptPhasesExhaustive: _QuizAttemptPhasesExhaustive = true;
void _quizAttemptPhasesExhaustive;

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

/**
 * Narrow an unknown value to a {@link QuizAttemptSkeleton}: an object whose
 * `phase` is a recognized {@link QuizAttemptPhase} and whose `answers` is a
 * plain object (the id→answer map — not an array or null). Structural subset
 * only; the answer values themselves stay app-owned. Pure, no runtime deps.
 */
export function isQuizAttemptSkeleton(value: unknown): value is QuizAttemptSkeleton {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { phase?: unknown; answers?: unknown };
  return (
    isQuizAttemptPhase(v.phase) &&
    typeof v.answers === 'object' &&
    v.answers !== null &&
    !Array.isArray(v.answers) &&
    // Require a plain id→answer record: a Map/Date/class instance would pass the
    // object check but hide its entries from `answers[questionId]` consumers.
    (Object.getPrototypeOf(v.answers) === Object.prototype ||
      Object.getPrototypeOf(v.answers) === null)
  );
}
