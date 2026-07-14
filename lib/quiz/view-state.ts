import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import type { QuizAttemptState } from '@/lib/quiz/runtime';

export interface QuizViewHydratedState {
  phase: 'not_started' | 'answering' | 'reviewing';
  answers: QuizAnswers;
  results: QuestionResult[];
}

export function quizViewStateFromAttempt(
  state: QuizAttemptState | undefined,
): QuizViewHydratedState {
  if (!state) return { phase: 'not_started', answers: {}, results: [] };
  if (state.phase === 'reviewed') {
    return {
      phase: 'reviewing',
      answers: state.answers,
      results: state.results ?? [],
    };
  }
  return { phase: 'answering', answers: state.answers, results: [] };
}
