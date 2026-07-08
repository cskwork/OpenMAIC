/**
 * RuntimeStore — the persistence contract for the learner-runtime layer
 * (#869): `RuntimeSession`s (identity + lifecycle, partitioned by
 * `(stageId, learnerKey)`) and their append-only `RuntimeRecord`s.
 *
 * The mirror of {@link DocumentStore} for the runtime quadrant of the storage
 * RFC, with the differences the envelope forces:
 *
 * - **Multi-tenant**: a document has ONE stored aggregate; a stage has MANY
 *   runtime sessions — one or more per `(learnerKey, kind)`. Every query is
 *   therefore partition-scoped, never global.
 * - **The store owns the version stamp.** The runtime line has no unversioned
 *   epoch, so `createSession` takes {@link RuntimeSessionInit} (no stamp) and
 *   the store stamps `RUNTIME_DSL_VERSION` itself. No code path persists an
 *   unstamped session.
 * - **Records are not independently versioned** — the version rides the parent
 *   session; records are ordered facts under it, `seq` assigned by the store.
 *
 * Payload internals are app-owned: per-kind validators are injected like
 * scene-content validators on DocumentStore, defaulting to the DSL skeleton
 * guards for the skeleton kinds (`chat`, `quizAttempt`).
 */
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
} from '@openmaic/dsl';

/**
 * The shape a caller hands to {@link RuntimeStore.createSession}: a full
 * session minus its version stamp. The store stamps `runtimeDslVersion`
 * itself — sessions are born stamped, and the stamp is the store's write
 * duty, never the caller's.
 */
export type RuntimeSessionInit = Omit<RuntimeSession, 'runtimeDslVersion'>;

/**
 * Validates one kind's record payload at the store's write boundary — the
 * runtime counterpart of `SceneValidator` (#860). Same result shape as the
 * DSL validators so implementations can return them directly.
 */
export type RuntimePayloadValidator = (
  payload: unknown,
) => { valid: true } | { valid: false; errors: { path: string; message: string }[] };

/**
 * Persistence contract for runtime sessions + records. All reads migrate on
 * read (`migrateRuntime`); all writes validate the full envelope and stamp /
 * guard the runtime version line. Implementations MUST be safe against
 * version skew from other clients sharing the same storage:
 *
 * - a FUTURE-stamped stored session (written by a newer client) rejects
 *   `appendRecord` / `setSessionStatus` rather than downgrade or corrupt;
 * - an older-stamped stored session is migrated in place before the write
 *   (a documented divergence from `putScene`: records carry no version, so
 *   there are no unmigrated siblings to strand, and this interface has no
 *   full-session save for a caller-side "load and save" remedy).
 */
export interface RuntimeStore {
  /**
   * Persist a new session. Stamps `runtimeDslVersion: RUNTIME_DSL_VERSION`,
   * validates the completed envelope (`validateRuntimeSession`), and fails
   * loud if a session with the same `id` already exists — creating twice is
   * a caller bug, not an upsert.
   */
  createSession(init: RuntimeSessionInit): Promise<RuntimeSession>;

  /** Load one session, migrated to the current runtime version. `undefined` if absent. */
  getSession(sessionId: string): Promise<RuntimeSession | undefined>;

  /**
   * All sessions of one learner on one stage (any status, any kind), migrated,
   * ordered by `createdAt` ascending. The `(stageId, learnerKey)` pair is the
   * partition key of the runtime layer — there is deliberately no global
   * listing.
   */
  listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]>;

  /**
   * Update one session's lifecycle status. `updatedAt` is caller-supplied
   * (the store is clock-free). Throws if the session is absent, if the stored
   * copy is future-stamped, or if the envelope would become invalid.
   */
  setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
  ): Promise<void>;

  /** Delete one session and all its records. Idempotent. */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Append one record to an ACTIVE session. The store assigns the
   * per-session monotonic `seq` (starting at 0) inside the same transaction
   * that inserts, validates the completed envelope
   * (`validateRuntimeRecord`), and runs the parent session's kind payload
   * validator if one is configured. Throws if the parent session is absent,
   * not `active`, or future-stamped.
   */
  appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>>;

  /**
   * A session's records ordered by `seq` (the sole replay ordering key).
   * `sceneId` narrows to records anchored to that scene (best-effort anchors;
   * records without a `sceneId` are excluded when the filter is present).
   */
  listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]>;

  /**
   * Re-key every session of `fromLearnerKey` (across ALL stages) to
   * `toLearnerKey` — the anonymous-learner-signs-in migration. Returns the
   * number of sessions moved. Idempotent (a second run moves 0) and
   * non-clobbering by construction (sessions are keyed by their own `id`).
   * Collapsing duplicate same-kind sessions after a merge (e.g. keeping one
   * playback session) is app read-policy, not store behavior.
   */
  mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number>;

  /** Delete one learner's sessions + records on one stage. Idempotent. */
  deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void>;

  /**
   * Delete ALL learners' runtime for a stage — the hook a document deletion
   * cascades through. Idempotent, deliberately version-agnostic.
   */
  deleteStageRuntime(stageId: string): Promise<void>;
}
