import type { QuestionResult } from '@/lib/quiz/grading';

/**
 * One-time compatibility reader for quiz state written before RuntimeStore.
 *
 * Four legacy keys may coexist:
 *
 *   quizDraft:<sceneId>
 *   quizAnswers:<sceneId>
 *   quizResults:<sceneId>
 *   quizAttemptId:<sceneId>
 *
 * RuntimeStore is the only live read source. The draft key also acts as a
 * synchronous crash-recovery journal while an async RuntimeStore write is in
 * flight; `loadQuizAttemptState` consumes it, commits the strongest valid state
 * to the current learner partition, then deletes all four keys.
 */

export const DRAFT_KEY_PREFIX = 'quizDraft:';
export const ANSWERS_KEY_PREFIX = 'quizAnswers:';
export const RESULTS_KEY_PREFIX = 'quizResults:';
export const ATTEMPT_ID_KEY_PREFIX = 'quizAttemptId:';

export type QuizAnswers = Record<string, string | string[]>;

export type SubmittedState =
  | { kind: 'reviewing'; answers: QuizAnswers; results: QuestionResult[] }
  | { kind: 'answering'; answers: QuizAnswers }
  | null;

export function hasLegacyQuizState(sceneId: string): boolean {
  return [DRAFT_KEY_PREFIX, ANSWERS_KEY_PREFIX, RESULTS_KEY_PREFIX, ATTEMPT_ID_KEY_PREFIX].some(
    (prefix) => safeGet(prefix + sceneId) !== null,
  );
}

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort recovery journal; RuntimeStore remains the authority.
  }
}

function safeRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Parse legacy post-submit state: answers + optional graded results. */
export function readSubmittedState(sceneId: string): SubmittedState {
  const rawA = safeGet(ANSWERS_KEY_PREFIX + sceneId);
  if (!rawA) return null;
  try {
    const answers = JSON.parse(rawA) as QuizAnswers;
    const rawR = safeGet(RESULTS_KEY_PREFIX + sceneId);
    if (rawR) {
      const results = JSON.parse(rawR) as QuestionResult[];
      if (Array.isArray(results)) {
        return { kind: 'reviewing', answers, results };
      }
    }
    return { kind: 'answering', answers };
  } catch {
    return null;
  }
}

export function readDraftState(sceneId: string): QuizAnswers | null {
  const raw = safeGet(DRAFT_KEY_PREFIX + sceneId);
  if (!raw) return null;
  try {
    const answers = JSON.parse(raw) as unknown;
    if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
    return answers as QuizAnswers;
  } catch {
    return null;
  }
}

/** Read the legacy attempt pointer only to order one-time migration snapshots. */
export function readLegacyAttemptId(sceneId: string): string | null {
  const attemptId = safeGet(ATTEMPT_ID_KEY_PREFIX + sceneId);
  return attemptId && attemptId.trim().length > 0 ? attemptId : null;
}

/** Synchronously journal the latest draft before its async RuntimeStore write. */
export function writeDraftRecovery(sceneId: string, attemptId: string, answers: QuizAnswers): void {
  safeSet(DRAFT_KEY_PREFIX + sceneId, JSON.stringify(answers));
  safeSet(ATTEMPT_ID_KEY_PREFIX + sceneId, attemptId);
}

/** Retire only the recovery snapshot proven durable by this exact write. */
export function clearDraftRecovery(sceneId: string, attemptId: string, answers: QuizAnswers): void {
  if (safeGet(ATTEMPT_ID_KEY_PREFIX + sceneId) !== attemptId) return;
  if (safeGet(DRAFT_KEY_PREFIX + sceneId) !== JSON.stringify(answers)) return;
  safeRemove(DRAFT_KEY_PREFIX + sceneId);
  safeRemove(ATTEMPT_ID_KEY_PREFIX + sceneId);
}

/** Retire every legacy key after migration or during stage deletion. */
export function clearAllForScene(sceneId: string): void {
  safeRemove(DRAFT_KEY_PREFIX + sceneId);
  safeRemove(ANSWERS_KEY_PREFIX + sceneId);
  safeRemove(RESULTS_KEY_PREFIX + sceneId);
  safeRemove(ATTEMPT_ID_KEY_PREFIX + sceneId);
}
