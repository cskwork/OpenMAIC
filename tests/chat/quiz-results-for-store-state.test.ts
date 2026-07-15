import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/quiz/runtime', () => ({
  loadQuizAttemptState: vi.fn(),
}));

import { buildQuizResultsForStoreState } from '@/lib/chat/quiz-results-for-store-state';
import { loadQuizAttemptState } from '@/lib/quiz/runtime';

describe('quiz results for chat store state', () => {
  beforeEach(() => {
    vi.mocked(loadQuizAttemptState).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits an explicitly reviewed quiz when the grader returned no results', async () => {
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'completed',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [],
      },
    });

    await expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }], 'quiz-1'),
    ).resolves.toBeUndefined();
    expect(loadQuizAttemptState).toHaveBeenCalledWith({
      stageId: 'stage-1',
      sceneId: 'quiz-1',
    });
  });

  it('includes non-empty reviewed results for the active quiz', async () => {
    const results = [{ questionId: 'q1', correct: true, status: 'correct' as const, earned: 1 }];
    vi.mocked(loadQuizAttemptState).mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        sessionId: 'attempt-1',
        status: 'completed',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
    });

    await expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }], 'quiz-1'),
    ).resolves.toEqual({ sceneId: 'quiz-1', answers: { q1: 'A' }, results });
  });

  it('omits quiz context when RuntimeStore is unavailable', async () => {
    vi.mocked(loadQuizAttemptState).mockRejectedValue(new Error('indexedDB unavailable'));

    await expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }], 'quiz-1'),
    ).resolves.toBeUndefined();
  });

  it('times out a stalled RuntimeStore read instead of blocking chat', async () => {
    vi.useFakeTimers();
    vi.mocked(loadQuizAttemptState).mockReturnValue(new Promise(() => {}));

    const reading = buildQuizResultsForStoreState(
      [{ id: 'quiz-1', type: 'quiz', stageId: 'stage-1' }],
      'quiz-1',
    );
    await vi.runAllTimersAsync();

    await expect(reading).resolves.toBeUndefined();
  });
});
