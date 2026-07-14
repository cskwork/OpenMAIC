import type {
  QuizAttemptPhase,
  QuizAttemptSkeleton,
  RuntimeRecord,
  RuntimeSession,
} from '@openmaic/dsl';
import type { RuntimeStore } from '@openmaic/storage';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

export interface QuizAttemptPayload extends QuizAttemptSkeleton {
  payloadVersion: 1;
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
}

export interface QuizAttemptRecordInput {
  stageId: string;
  sceneId: string;
  attemptId: string;
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
}

export interface LegacyQuizAttemptInput {
  stageId: string;
  sceneId: string;
  attemptId: string;
  draftAnswers?: QuizAnswers;
  submittedAnswers?: QuizAnswers;
  results?: QuestionResult[];
}

export interface QuizAttemptRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
}

const PHASE_ORDER: Record<QuizAttemptPhase, number> = {
  draft: 0,
  submitted: 1,
  reviewed: 2,
};

const queues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();

function enqueue<T>(store: RuntimeStore, attemptId: string, work: () => Promise<T>): Promise<T> {
  let storeQueues = queues.get(store);
  if (!storeQueues) {
    storeQueues = new Map();
    queues.set(store, storeQueues);
  }
  const prior = storeQueues.get(attemptId) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  storeQueues.set(attemptId, settled);
  void settled.finally(() => {
    if (storeQueues.get(attemptId) === settled) storeQueues.delete(attemptId);
  });
  return current;
}

async function withAttemptLock<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`maic:quiz-attempt:${attemptId}`, work);
  }
  return work();
}

function mintId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `quiz-record:${suffix}`;
}

function asQuizPayload(record: RuntimeRecord | undefined): QuizAttemptPayload | undefined {
  if (!record || typeof record.payload !== 'object' || record.payload === null) return undefined;
  const payload = record.payload as Partial<QuizAttemptPayload>;
  if (
    payload.payloadVersion !== 1 ||
    (payload.phase !== 'draft' && payload.phase !== 'submitted' && payload.phase !== 'reviewed') ||
    typeof payload.answers !== 'object' ||
    payload.answers === null ||
    Array.isArray(payload.answers)
  ) {
    return undefined;
  }
  return payload as QuizAttemptPayload;
}

function samePayload(left: QuizAttemptPayload, right: QuizAttemptPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPartition(session: RuntimeSession, stageId: string, learnerKey: string): void {
  if (
    session.kind !== 'quizAttempt' ||
    session.stageId !== stageId ||
    session.learnerKey !== learnerKey
  ) {
    throw new Error(
      `Quiz attempt ${JSON.stringify(session.id)} does not belong to stage ` +
        `${JSON.stringify(stageId)} and learner ${JSON.stringify(learnerKey)}`,
    );
  }
}

/**
 * Append one immutable quiz lifecycle fact. Calls for one attempt are serialized
 * so rapid draft writes cannot overtake submit or review writes.
 */
export async function recordQuizAttempt(
  input: QuizAttemptRecordInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<void> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const now = deps.now ?? (() => new Date().toISOString());
  const mintRecordId = deps.mintRecordId ?? mintId;

  return enqueue(store, input.attemptId, () =>
    withAttemptLock(input.attemptId, async () => {
      const timestamp = now();
      let session = await store.getSession(input.attemptId);
      if (!session) {
        session = await store.createSession({
          id: input.attemptId,
          kind: 'quizAttempt',
          stageId: input.stageId,
          learnerKey,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      } else {
        assertPartition(session, input.stageId, learnerKey);
      }

      const records = await store.listRecords(input.attemptId);
      const foreignAnchor = records.find(
        (record) => record.sceneId !== undefined && record.sceneId !== input.sceneId,
      );
      if (foreignAnchor) {
        throw new Error(
          `Quiz attempt ${JSON.stringify(input.attemptId)} is already anchored to scene ` +
            `${JSON.stringify(foreignAnchor.sceneId)}`,
        );
      }
      const last = asQuizPayload(records.at(-1));
      const payload: QuizAttemptPayload = {
        payloadVersion: 1,
        phase: input.phase,
        answers: input.answers,
        ...(input.results === undefined ? {} : { results: input.results }),
      };

      if (last && PHASE_ORDER[payload.phase] < PHASE_ORDER[last.phase]) return;

      if (last && samePayload(last, payload)) {
        if (payload.phase === 'reviewed' && session.status !== 'completed') {
          await store.setSessionStatus(input.attemptId, 'completed', timestamp);
        }
        return;
      }

      if (session.status !== 'active') {
        throw new Error(
          `Quiz attempt ${JSON.stringify(input.attemptId)} is already ${session.status}`,
        );
      }

      await store.appendRecord({
        id: mintRecordId(),
        sessionId: input.attemptId,
        sceneId: input.sceneId,
        createdAt: timestamp,
        payload,
      });
      await store.setSessionStatus(
        input.attemptId,
        payload.phase === 'reviewed' ? 'completed' : 'active',
        timestamp,
      );
    }),
  );
}

/** Backfill the strongest legacy localStorage state without deleting legacy keys. */
export async function backfillQuizAttempt(
  input: LegacyQuizAttemptInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<void> {
  const base = {
    stageId: input.stageId,
    sceneId: input.sceneId,
    attemptId: input.attemptId,
  };
  if (input.submittedAnswers) {
    await recordQuizAttempt({ ...base, phase: 'submitted', answers: input.submittedAnswers }, deps);
    if (input.results !== undefined) {
      await recordQuizAttempt(
        {
          ...base,
          phase: 'reviewed',
          answers: input.submittedAnswers,
          results: input.results,
        },
        deps,
      );
    }
    return;
  }
  if (input.draftAnswers) {
    await recordQuizAttempt({ ...base, phase: 'draft', answers: input.draftAnswers }, deps);
  }
}
