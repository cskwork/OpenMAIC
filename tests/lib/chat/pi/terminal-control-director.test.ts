import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import {
  attachDirectorToolExecutionGate,
  createDirectorToolExecutionGate,
  createInclassTerminalController,
  guardDirectorToolsWithExecutionGate,
} from '@/lib/chat/pi/terminal-control';
import { buildCueUserTool } from '@/lib/chat/pi/tools/cue-user';

const EMPTY_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'deterministic-director',
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: 1,
  };
}

function streamMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() =>
    stream.push({
      type: 'done',
      reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message,
    }),
  );
  return stream;
}

function toolResultText(context: Context, toolName: string): string | undefined {
  const result = context.messages.findLast(
    (message): message is Extract<Context['messages'][number], { role: 'toolResult' }> =>
      message.role === 'toolResult' && message.toolName === toolName,
  );
  return result?.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

describe('Pi Director Phase 0T continuation', () => {
  it('feeds TASK_INCOMPLETE to the same Director before allowing a later cue_user', async () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
    });
    const contexts: Context[] = [];
    const cueUser = vi.fn(async () => true);
    const callAgent = vi.fn(async () => {
      controller.recordChildResult({
        source: 'runtime_child_result',
        agentInvocationId: 'student-invocation-1',
        agentId: 'student-1',
        outcomeId: 'student_analysis',
        status: 'completed',
        substantive: true,
      });
      return {
        content: [{ type: 'text' as const, text: 'Student completed the requested analysis.' }],
        details: {
          agentId: 'student-1',
          agentInvocationId: 'student-invocation-1',
          outcomeId: 'student_analysis',
        },
      };
    });
    const callAgentTool: AgentTool = {
      name: 'call_agent',
      label: 'Call agent',
      description: 'Call the requested classroom agent.',
      parameters: Type.Object({
        agentId: Type.String(),
        instruction: Type.String(),
      }),
      execute: callAgent,
    };
    const cueUserTool = buildCueUserTool({
      cueUser,
      getLastAgentId: () => 'student-1',
      terminalPreflight: (request) =>
        controller.preflight(request, {
          hasTeachingSubstantiveTurn: true,
          hasVisibleAgentTurn: true,
          hasAgentContent: true,
          userCued: cueUser.mock.calls.length > 0,
          sessionClosed: false,
        }),
    });

    const streamFn = ((_model, context) => {
      contexts.push(context);
      const cueResult = toolResultText(context, 'cue_user');
      const agentResult = toolResultText(context, 'call_agent');
      if (!cueResult && !agentResult) {
        return streamMessage(
          assistantMessage(
            [
              {
                type: 'toolCall',
                id: 'cue-too-early',
                name: 'cue_user',
                arguments: {
                  reason: 'task_complete_followup',
                  prompt: 'Any follow-up?',
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (cueResult?.includes('TASK_INCOMPLETE') && !agentResult) {
        return streamMessage(
          assistantMessage(
            [
              {
                type: 'toolCall',
                id: 'student-call',
                name: 'call_agent',
                arguments: {
                  agentId: 'student-1',
                  outcomeId: 'student_analysis',
                  instruction: 'Give the requested student analysis.',
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (agentResult && cueUser.mock.calls.length === 0) {
        return streamMessage(
          assistantMessage(
            [
              {
                type: 'toolCall',
                id: 'cue-after-completion',
                name: 'cue_user',
                arguments: {
                  reason: 'task_complete_followup',
                  prompt: 'Any follow-up?',
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      return streamMessage(
        assistantMessage([{ type: 'text', text: 'The requested discussion is complete.' }], 'stop'),
      );
    }) as StreamFn;

    const director = buildAgent({
      streamFn,
      systemPrompt: 'Use the tools to complete requested outcomes before cueing the user.',
      tools: [callAgentTool, cueUserTool],
      allowedToolNames: new Set(['call_agent', 'cue_user']),
      afterToolCall: (context) => {
        const status = (
          context.result.details as { terminalControl?: { status?: string } } | undefined
        )?.terminalControl?.status;
        return status === 'rejected'
          ? { isError: true }
          : status === 'allowed'
            ? { terminate: false }
            : undefined;
      },
    });

    await director.prompt('Let the requested virtual agents finish; I am only listening.');
    await director.waitForIdle();

    expect(contexts).toHaveLength(4);
    expect(toolResultText(contexts[1], 'cue_user')).toContain('TASK_INCOMPLETE');
    expect(
      contexts[1].messages.find(
        (message) => message.role === 'toolResult' && message.toolName === 'cue_user',
      ),
    ).toMatchObject({ toolCallId: 'cue-too-early', isError: true });
    expect(toolResultText(contexts[2], 'call_agent')).toContain(
      'Student completed the requested analysis.',
    );
    expect(callAgent).toHaveBeenCalledOnce();
    expect(cueUser).toHaveBeenCalledOnce();
    expect(controller.getTrace()).toMatchObject({
      revision: 2,
      outcomes: [
        {
          id: 'student_analysis',
          status: 'completed',
          completedBy: {
            agentInvocationId: 'student-invocation-1',
            revision: 1,
          },
        },
      ],
      decisions: [
        { status: 'rejected', code: 'TASK_INCOMPLETE' },
        { status: 'allowed', code: 'ALLOWED' },
      ],
      terminal: {
        kind: 'cue_user',
        reason: 'task_complete_followup',
        revision: 2,
      },
    });
    expect(director.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'The requested discussion is complete.' }],
    });
  });

  it('blocks later side effects in the same real Pi multi-tool batch after exhaustion', async () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
      maxRejections: 2,
    });
    const executionGate = createDirectorToolExecutionGate({
      controller,
      maxToolCalls: 10,
    });
    const cueUser = vi.fn(async () => true);
    const callAgent = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'This side effect must not run.' }],
      details: {},
    }));
    const rawTools: AgentTool[] = [
      buildCueUserTool({
        cueUser,
        getLastAgentId: () => 'teacher-1',
        terminalPreflight: (request) =>
          controller.preflight(request, {
            hasTeachingSubstantiveTurn: true,
            hasVisibleAgentTurn: true,
            hasAgentContent: true,
            userCued: false,
            sessionClosed: false,
          }),
      }),
      {
        name: 'call_agent',
        label: 'Call agent',
        description: 'Call a classroom agent.',
        parameters: Type.Object({
          agentId: Type.String(),
          instruction: Type.String(),
          outcomeId: Type.Optional(Type.String()),
        }),
        execute: callAgent,
      },
    ];
    const tools = guardDirectorToolsWithExecutionGate(rawTools, executionGate);
    let turn = 0;
    const streamFn = ((_model, _context, options) => {
      if (options?.signal?.aborted) {
        return streamMessage(assistantMessage([{ type: 'text', text: '' }], 'aborted'));
      }
      turn += 1;
      if (turn === 1) {
        return streamMessage(
          assistantMessage(
            [
              {
                type: 'toolCall',
                id: 'cue-rejected',
                name: 'cue_user',
                arguments: { reason: 'task_complete_followup' },
              },
              {
                type: 'toolCall',
                id: 'cue-exhausted',
                name: 'cue_user',
                arguments: { reason: 'task_complete_followup' },
              },
              {
                type: 'toolCall',
                id: 'student-after-exhaustion',
                name: 'call_agent',
                arguments: {
                  agentId: 'student-1',
                  outcomeId: 'student_analysis',
                  instruction: 'Continue after exhaustion.',
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      return streamMessage(assistantMessage([{ type: 'text', text: 'Stopped.' }], 'stop'));
    }) as StreamFn;
    const director = buildAgent({
      streamFn,
      systemPrompt: 'Test terminal execution boundaries.',
      tools,
      allowedToolNames: new Set(['cue_user', 'call_agent']),
      afterToolCall: (context) => {
        const status = (
          context.result.details as { terminalControl?: { status?: string } } | undefined
        )?.terminalControl?.status;
        if (status === 'rejected') return { isError: true };
        if (status === 'exhausted') return { isError: true, terminate: true };
        return undefined;
      },
    });
    const unsubscribeExecutionGate = attachDirectorToolExecutionGate(director, executionGate);

    try {
      await director.prompt('Run the batch.');
      await director.waitForIdle();
    } finally {
      unsubscribeExecutionGate();
    }

    expect(callAgent).not.toHaveBeenCalled();
    expect(cueUser).not.toHaveBeenCalled();
    expect(controller.getTrace()).toMatchObject({
      exhaustedReason: 'TERMINAL_REJECTION_BUDGET_EXHAUSTED',
      terminal: {
        kind: 'runtime_exhausted',
        reason: 'TERMINAL_REJECTION_BUDGET_EXHAUSTED',
      },
    });
    expect(executionGate.getAttemptCount()).toBe(3);
  });

  it('enforces the Director tool-call cap before a later call in the same Pi batch', async () => {
    const controller = createInclassTerminalController();
    const executionGate = createDirectorToolExecutionGate({
      controller,
      maxToolCalls: 1,
    });
    const firstSideEffect = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'First tool completed.' }],
      details: {},
    }));
    const blockedSideEffect = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Must not execute.' }],
      details: {},
    }));
    const rawTools: AgentTool[] = [
      {
        name: 'first_tool',
        label: 'First tool',
        description: 'Consumes the only permitted tool call.',
        parameters: Type.Object({}),
        execute: firstSideEffect,
      },
      {
        name: 'call_agent',
        label: 'Call agent',
        description: 'Would exceed the Director tool-call cap.',
        parameters: Type.Object({
          agentId: Type.String(),
          instruction: Type.String(),
        }),
        execute: blockedSideEffect,
      },
    ];
    const tools = guardDirectorToolsWithExecutionGate(rawTools, executionGate);
    const streamFn = ((_model, _context, options) =>
      options?.signal?.aborted
        ? streamMessage(assistantMessage([{ type: 'text', text: '' }], 'aborted'))
        : streamMessage(
            assistantMessage(
              [
                {
                  type: 'toolCall',
                  id: 'first',
                  name: 'first_tool',
                  arguments: {},
                },
                {
                  type: 'toolCall',
                  id: 'over-budget',
                  name: 'call_agent',
                  arguments: {
                    agentId: 'student-1',
                    instruction: 'This must be blocked.',
                  },
                },
              ],
              'toolUse',
            ),
          )) as StreamFn;
    const director = buildAgent({
      streamFn,
      systemPrompt: 'Test the hard Director tool-call cap.',
      tools,
      allowedToolNames: new Set(['first_tool', 'call_agent']),
      afterToolCall: () => {
        if (executionGate.getAttemptCount() >= 1) {
          controller.recordRuntimeExhaustion('director_tool_call_budget');
          return { isError: true, terminate: true };
        }
        return undefined;
      },
    });
    const unsubscribeExecutionGate = attachDirectorToolExecutionGate(director, executionGate);

    try {
      await director.prompt('Run the capped batch.');
      await director.waitForIdle();
    } finally {
      unsubscribeExecutionGate();
    }

    expect(firstSideEffect).toHaveBeenCalledOnce();
    expect(blockedSideEffect).not.toHaveBeenCalled();
    expect(controller.getTrace()).toMatchObject({
      exhaustedReason: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
    });
    expect(executionGate.getAttemptCount()).toBe(2);
  });

  it.each([
    {
      label: 'schema-invalid',
      invalidCalls: [
        {
          type: 'toolCall' as const,
          id: 'invalid-1',
          name: 'call_agent',
          arguments: { agentId: 'student-1' },
        },
        {
          type: 'toolCall' as const,
          id: 'invalid-2',
          name: 'call_agent',
          arguments: { instruction: 'Missing agentId.' },
        },
        {
          type: 'toolCall' as const,
          id: 'invalid-3',
          name: 'call_agent',
          arguments: {},
        },
      ],
    },
    {
      label: 'unknown-tool',
      invalidCalls: ['unknown-1', 'unknown-2', 'unknown-3'].map((id) => ({
        type: 'toolCall' as const,
        id,
        name: 'not_registered',
        arguments: {},
      })),
    },
  ])(
    'counts $label attempts before Pi lookup/validation and blocks a later valid call',
    async ({ invalidCalls }) => {
      const controller = createInclassTerminalController();
      const executionGate = createDirectorToolExecutionGate({
        controller,
        maxToolCalls: 2,
      });
      const callAgent = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'Must not execute.' }],
        details: {},
      }));
      const tools = guardDirectorToolsWithExecutionGate(
        [
          {
            name: 'call_agent',
            label: 'Call agent',
            description: 'A valid side effect after malformed attempts.',
            parameters: Type.Object({
              agentId: Type.String(),
              instruction: Type.String(),
            }),
            execute: callAgent,
          },
        ],
        executionGate,
      );
      let turn = 0;
      const streamFn = ((_model, _context, options) => {
        if (options?.signal?.aborted) {
          return streamMessage(assistantMessage([{ type: 'text', text: '' }], 'aborted'));
        }
        turn += 1;
        if (turn === 1) {
          return streamMessage(
            assistantMessage(
              [
                ...invalidCalls,
                {
                  type: 'toolCall',
                  id: 'valid-after-cap',
                  name: 'call_agent',
                  arguments: {
                    agentId: 'student-1',
                    instruction: 'This valid call must never execute.',
                  },
                },
              ],
              'toolUse',
            ),
          );
        }
        return streamMessage(assistantMessage([{ type: 'text', text: 'Stopped.' }], 'stop'));
      }) as StreamFn;
      const director = buildAgent({
        streamFn,
        systemPrompt: 'Test the all-attempt Director hard cap.',
        tools,
        allowedToolNames: new Set(['call_agent']),
      });
      const unsubscribeExecutionGate = attachDirectorToolExecutionGate(director, executionGate);

      try {
        await director.prompt('Run malformed attempts, then a valid tool.');
        await director.waitForIdle();
      } finally {
        unsubscribeExecutionGate();
      }

      expect(callAgent).not.toHaveBeenCalled();
      expect(executionGate.getAttemptCount()).toBe(3);
      expect(controller.getTrace()).toMatchObject({
        terminal: {
          kind: 'runtime_exhausted',
          reason: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
        },
        exhaustedReason: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
      });
    },
  );
});
