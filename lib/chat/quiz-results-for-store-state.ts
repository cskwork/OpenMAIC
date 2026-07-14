import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import { loadQuizAttemptState, type QuizAttemptState } from '@/lib/quiz/runtime';
import { createLogger } from '@/lib/logger';

const log = createLogger('ChatQuizContext');

export interface QuizResultsForStoreState {
  sceneId: string;
  answers: QuizAnswers;
  results: QuestionResult[];
}

/**
 * Hydrate graded quiz context for chat. An empty result list still marks the
 * QuizView as reviewed, but carries no feedback that the agent can use.
 */
export async function buildQuizResultsForStoreState(
  scenes: { id: string; type?: string; stageId?: string }[],
  currentSceneId: string | null,
): Promise<QuizResultsForStoreState | undefined> {
  if (!currentSceneId) return undefined;
  const scene = scenes.find((candidate) => candidate.id === currentSceneId);
  if (!scene || scene.type !== 'quiz' || !scene.stageId) return undefined;
  let state: QuizAttemptState | undefined;
  try {
    ({ state } = await loadQuizAttemptState({
      stageId: scene.stageId,
      sceneId: currentSceneId,
    }));
  } catch (error) {
    log.warn('Failed to load quiz context:', error);
    return undefined;
  }
  if (state?.phase !== 'reviewed' || !state.results || state.results.length === 0) {
    return undefined;
  }
  return {
    sceneId: currentSceneId,
    answers: state.answers,
    results: state.results,
  };
}
