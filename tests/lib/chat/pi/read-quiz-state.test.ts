import { describe, expect, it } from 'vitest';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { buildQuizStateContext, buildReadQuizStateTool } from '@/lib/chat/pi/tools/read-quiz-state';
import { appendQuizStateContext } from '@/lib/chat/pi/tools/call-agent';

function request(reviewing = false): StatelessChatRequest {
  return {
    messages: [],
    storeState: {
      stage: { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 },
      scenes: [
        {
          id: 'quiz-1',
          stageId: 'stage-1',
          type: 'quiz',
          title: 'Quiz',
          order: 0,
          content: {
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                type: 'single',
                question: 'What does cope with mean?',
                options: [
                  { value: 'A', label: 'Ignore' },
                  { value: 'B', label: 'Deal with' },
                ],
                answer: ['B'],
                analysis: 'It means handling a difficult situation.',
                points: 1,
              },
            ],
          },
          actions: [],
        },
      ],
      currentSceneId: 'quiz-1',
      mode: 'playback',
      whiteboardOpen: false,
      quizPhase: reviewing ? 'reviewing' : 'answering',
      ...(reviewing
        ? {
            quizResults: {
              sceneId: 'quiz-1',
              answers: { q1: 'A' },
              results: [
                {
                  questionId: 'q1',
                  correct: false,
                  status: 'incorrect' as const,
                  earned: 0,
                },
              ],
            },
          }
        : {}),
    },
    config: { agentIds: ['default-1'] },
    apiKey: '',
  } as StatelessChatRequest;
}

describe('read_quiz_state', () => {
  it('withholds answers and analysis before submission', () => {
    const context = buildQuizStateContext(request());

    expect(context).toContain('Mode: PRE_SUBMIT');
    expect(context).toContain('What does cope with mean?');
    expect(context).toContain('A. Ignore | B. Deal with');
    expect(context).not.toContain('Correct answer');
    expect(context).not.toContain('handling a difficult situation');
  });

  it('returns attempt-specific results after submission', () => {
    const context = buildQuizStateContext(request(true));

    expect(context).toContain('Mode: REVIEWING');
    expect(context).toContain('Learner answer: A');
    expect(context).toContain('Correct answer: B');
    expect(context).toContain('Result: incorrect (0/1)');
    expect(context).toContain('Analysis: It means handling a difficult situation.');
  });

  it('records the authoritative context when the tool runs', async () => {
    let saved = '';
    const tool = buildReadQuizStateTool({
      request: request(),
      onRead: (context) => {
        saved = context;
      },
    });

    const result = await tool.execute('read-1', {});

    expect(saved).toContain('Mode: PRE_SUBMIT');
    expect(result.details).toEqual({ mode: 'pre_submit', phase: 'answering' });
  });

  it('appends the authoritative tool result to the child-agent instruction', () => {
    const context = buildQuizStateContext(request());
    const instruction = appendQuizStateContext('Help the learner with question 1.', context);

    expect(instruction).toContain('Help the learner with question 1.');
    expect(instruction).toContain('# Authoritative Quiz State');
    expect(instruction).toContain('Mode: PRE_SUBMIT');
  });
});
