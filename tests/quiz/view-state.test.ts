import { describe, expect, it } from 'vitest';
import {
  isQuizRuntimeReady,
  persistQuizRetry,
  quizViewStateFromAttempt,
} from '@/lib/quiz/view-state';

describe('quiz view runtime hydration', () => {
  it('hydrates a draft or submission back into answering', () => {
    expect(
      quizViewStateFromAttempt({
        sessionId: 'attempt-1',
        status: 'active',
        phase: 'draft',
        answers: { q1: 'A' },
      }),
    ).toEqual({ phase: 'answering', answers: { q1: 'A' }, results: [] });
  });

  it('hydrates reviewed empty results into reviewing', () => {
    expect(
      quizViewStateFromAttempt({
        sessionId: 'attempt-1',
        status: 'completed',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [],
      }),
    ).toEqual({ phase: 'reviewing', answers: { q1: 'A' }, results: [] });
  });

  it('uses a clean cover when no attempt exists', () => {
    expect(quizViewStateFromAttempt(undefined)).toEqual({
      phase: 'not_started',
      answers: {},
      results: [],
    });
  });

  it('keeps the quiz blocked when runtime hydration fails', () => {
    expect(isQuizRuntimeReady({ status: 'loading' })).toBe(false);
    expect(isQuizRuntimeReady({ status: 'error' })).toBe(false);
    expect(isQuizRuntimeReady({ status: 'ready', attemptId: 'attempt-1' })).toBe(true);
  });

  it('persists a clean draft before completing retry', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: unknown[] = [];
    const retry = persistQuizRetry(
      { stageId: 'stage-1', sceneId: 'scene-1', attemptId: 'attempt-1' },
      {
        recordPhase: async (input) => {
          calls.push(input);
          await persisted;
        },
      },
    );

    let settled = false;
    void retry.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(calls).toEqual([
      {
        stageId: 'stage-1',
        sceneId: 'scene-1',
        attemptId: 'attempt-1',
        phase: 'draft',
        answers: {},
        startNewAttempt: true,
      },
    ]);
    expect(settled).toBe(false);

    release();
    await retry;
    expect(settled).toBe(true);
  });
});
