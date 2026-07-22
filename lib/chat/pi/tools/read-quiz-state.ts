import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { QuizQuestion } from '@/lib/types/stage';
import type { StatelessChatRequest } from '@/lib/types/chat';

const ReadQuizStateParams = Type.Object({});

function formatOptions(question: QuizQuestion): string {
  return (question.options ?? []).map((option) => `${option.value}. ${option.label}`).join(' | ');
}

function formatPreSubmitContext(request: StatelessChatRequest, questions: QuizQuestion[]): string {
  const phase = request.storeState.quizPhase ?? 'unknown';
  const questionText = questions
    .map((question, index) => {
      const options = formatOptions(question);
      return `${index + 1}. ${question.question}${options ? `\n   Options: ${options}` : ''}`;
    })
    .join('\n');

  return [
    '# Authoritative Quiz State',
    `Mode: PRE_SUBMIT (${phase})`,
    'The learner has no graded result for this attempt. The questions below are available; never claim they are missing.',
    'Tutor policy: give only a question-specific Socratic reasoning step. Never name an option, reveal or paraphrase the correct answer, eliminate choices, or give a clue that uniquely identifies one choice.',
    'If the learner says they know nothing, begin with one neutral observation task about the stem or source passage, then ask one short question.',
    '',
    'Questions (answer key intentionally withheld):',
    questionText,
  ].join('\n');
}

function formatReviewContext(request: StatelessChatRequest, questions: QuizQuestion[]): string {
  const quizResults = request.storeState.quizResults;
  if (!quizResults) return '';

  const resultsById = new Map(quizResults.results.map((result) => [result.questionId, result]));
  const questionText = questions
    .map((question, index) => {
      const result = resultsById.get(question.id);
      const answer = quizResults.answers[question.id];
      const learnerAnswer = Array.isArray(answer) ? answer.join(', ') : (answer ?? '(empty)');
      const correctAnswer = question.answer?.join(', ') || '(open-ended)';
      return [
        `${index + 1}. ${question.question}`,
        `   Learner answer: ${learnerAnswer}`,
        `   Correct answer: ${correctAnswer}`,
        `   Result: ${result?.status ?? 'ungraded'} (${result?.earned ?? 0}/${question.points ?? 1})`,
        question.analysis ? `   Analysis: ${question.analysis}` : '',
        result?.aiComment ? `   Grader comment: ${result.aiComment}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return [
    '# Authoritative Quiz State',
    'Mode: REVIEWING',
    'The learner has submitted and grading is complete. Give feedback tied to this attempt: focus on mistakes, explain why, and acknowledge correct answers briefly.',
    '',
    questionText,
  ].join('\n');
}

function hasGradedResultsForCurrentQuiz(request: StatelessChatRequest): boolean {
  const currentScene = request.storeState.scenes.find(
    (scene) => scene.id === request.storeState.currentSceneId,
  );
  return (
    currentScene?.content.type === 'quiz' &&
    request.storeState.quizResults?.sceneId === currentScene.id &&
    request.storeState.quizResults.results.length > 0
  );
}

export function buildQuizStateContext(request: StatelessChatRequest): string | null {
  const currentScene = request.storeState.scenes.find(
    (scene) => scene.id === request.storeState.currentSceneId,
  );
  if (currentScene?.content.type !== 'quiz') return null;

  const hasResults = hasGradedResultsForCurrentQuiz(request);
  return hasResults
    ? formatReviewContext(request, currentScene.content.questions)
    : formatPreSubmitContext(request, currentScene.content.questions);
}

export function buildReadQuizStateTool(opts: {
  request: StatelessChatRequest;
  onRead: (context: string) => void;
}): AgentTool<typeof ReadQuizStateParams> {
  return {
    name: 'read_quiz_state',
    label: 'Read quiz state',
    description:
      'Read the authoritative current Quiz phase and the phase-appropriate teaching context. Required before call_agent on a Quiz scene.',
    parameters: ReadQuizStateParams,
    executionMode: 'sequential',
    execute: async () => {
      const context = buildQuizStateContext(opts.request);
      if (!context) {
        return {
          content: [{ type: 'text', text: 'The current scene is not a Quiz.' }],
          details: { mode: 'not_quiz' },
        };
      }

      opts.onRead(context);
      const hasResults = hasGradedResultsForCurrentQuiz(opts.request);
      return {
        content: [{ type: 'text', text: context }],
        details: {
          mode: hasResults ? 'reviewing' : 'pre_submit',
          phase: opts.request.storeState.quizPhase ?? 'unknown',
        },
      };
    },
  };
}
