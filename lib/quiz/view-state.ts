import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import type { QuizAttemptState, QuizAttemptWriter } from '@/lib/quiz/runtime';

export type QuizRuntimeGate =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; attemptId: string };

export function isQuizRuntimeReady(
  gate: QuizRuntimeGate,
): gate is Extract<QuizRuntimeGate, { status: 'ready' }> {
  return gate.status === 'ready';
}

export async function persistQuizRetry(
  input: { stageId: string; sceneId: string; attemptId: string },
  writer: Pick<QuizAttemptWriter, 'recordPhase'>,
): Promise<void> {
  await writer.recordPhase({
    ...input,
    phase: 'draft',
    answers: {},
    startNewAttempt: true,
  });
}

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
