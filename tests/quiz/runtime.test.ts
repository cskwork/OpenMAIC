import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import {
  backfillQuizAttempt,
  recordQuizAttempt,
  type QuizAttemptRuntimeDeps,
} from '@/lib/quiz/runtime';
import type { QuestionResult } from '@/lib/quiz/grading';

const results: QuestionResult[] = [
  { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
];

function makeHarness(): { store: RuntimeStore; deps: QuizAttemptRuntimeDeps } {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `quiz-runtime-${Math.random()}`,
  });
  let tick = 0;
  return {
    store,
    deps: {
      store,
      learnerKey: 'learner-1',
      now: () => new Date(Date.UTC(2026, 6, 14, 12, 0, tick++)).toISOString(),
      mintRecordId: () => `record-${tick}`,
    },
  };
}

describe('quiz attempt runtime persistence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: IDBKeyRange,
    });
  });

  it('records the quiz lifecycle in one learner-scoped session', async () => {
    const { store, deps } = makeHarness();
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-1',
    };

    await recordQuizAttempt({ ...base, phase: 'draft', answers: { q1: 'A' } }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted', answers: { q1: 'A' } }, deps);
    await recordQuizAttempt({ ...base, phase: 'reviewed', answers: { q1: 'A' }, results }, deps);

    const sessions = await store.listSessions('stage-1', 'learner-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'attempt-1',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'completed',
    });
    const records = await store.listRecords('attempt-1');
    expect(records.map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'draft', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'reviewed', answers: { q1: 'A' }, results },
    ]);
    expect(records.every((record) => record.sceneId === 'scene-quiz')).toBe(true);
  });

  it('deduplicates equal writes and ignores stale phase regressions', async () => {
    const { store, deps } = makeHarness();
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-1',
      answers: { q1: 'A' },
    };

    await recordQuizAttempt({ ...base, phase: 'draft' }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted' }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted' }, deps);
    await recordQuizAttempt({ ...base, phase: 'draft', answers: { q1: 'B' } }, deps);

    const records = await store.listRecords('attempt-1');
    expect(records.map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'draft', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
    ]);
  });

  it('backfills a reviewed legacy snapshot without clearing or mutating its inputs', async () => {
    const { store, deps } = makeHarness();
    const answers = { q1: 'A' };
    const legacyResults = structuredClone(results);

    await backfillQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-legacy',
        submittedAnswers: answers,
        results: legacyResults,
      },
      deps,
    );
    await backfillQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-legacy',
        submittedAnswers: answers,
        results: legacyResults,
      },
      deps,
    );

    expect(answers).toEqual({ q1: 'A' });
    expect(legacyResults).toEqual(results);
    expect((await store.getSession('attempt-legacy'))?.status).toBe('completed');
    expect((await store.listRecords('attempt-legacy')).map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
      {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
    ]);
  });

  it('preserves an explicitly reviewed legacy snapshot with empty results', async () => {
    const { store, deps } = makeHarness();

    await backfillQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-empty-results',
        submittedAnswers: { q1: 'A' },
        results: [],
      },
      deps,
    );

    expect((await store.getSession('attempt-empty-results'))?.status).toBe('completed');
    expect(
      (await store.listRecords('attempt-empty-results')).map((record) => record.payload),
    ).toEqual([
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'reviewed', answers: { q1: 'A' }, results: [] },
    ]);
  });

  it('keeps repeated attempts in separate sessions', async () => {
    const { store, deps } = makeHarness();

    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-1',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps,
    );
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-2',
        phase: 'draft',
        answers: { q1: 'B' },
      },
      deps,
    );

    const sessions = await store.listSessions('stage-1', 'learner-1');
    expect(sessions.map((session) => [session.id, session.status])).toEqual([
      ['attempt-1', 'completed'],
      ['attempt-2', 'active'],
    ]);
  });

  it('fails before appending when an attempt id belongs to another runtime partition', async () => {
    const { store, deps } = makeHarness();
    await store.createSession({
      id: 'attempt-1',
      kind: 'quizAttempt',
      stageId: 'other-stage',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });

    await expect(
      recordQuizAttempt(
        {
          stageId: 'stage-1',
          sceneId: 'scene-quiz',
          attemptId: 'attempt-1',
          phase: 'draft',
          answers: {},
        },
        deps,
      ),
    ).rejects.toThrow('does not belong to stage "stage-1" and learner "learner-1"');
    expect(await store.listRecords('attempt-1')).toEqual([]);
  });
});
