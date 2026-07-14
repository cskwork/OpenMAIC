import { describe, expect, it } from 'vitest';
import { quizViewStateFromAttempt } from '@/lib/quiz/view-state';

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
});
