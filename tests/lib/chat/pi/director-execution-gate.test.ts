import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import {
  attachDirectorToolExecutionGate,
  createDirectorToolExecutionGate,
  guardDirectorToolsWithExecutionGate,
} from '@/lib/chat/pi/director-execution-gate';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'deterministic-director',
    usage,
    stopReason: 'toolUse',
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

describe('Pi Director safety execution gate', () => {
  it('does not double count a reserved tool call', () => {
    const gate = createDirectorToolExecutionGate({
      maxToolCalls: 1,
      isTerminalReached: () => false,
    });

    expect(gate.reserveAttempt('first')).toBeUndefined();
    expect(gate.beforeExecute('first')).toBeUndefined();
    expect(gate.getAttemptCount()).toBe(1);
    gate.finishAttempt('first');

    expect(gate.reserveAttempt('over-budget')).toMatchObject({
      code: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
    });
    expect(gate.getAttemptCount()).toBe(2);
  });

  it('blocks a later tool in the same Pi batch after a terminal transition', async () => {
    let terminalReached = false;
    const terminalTool = vi.fn(async () => {
      terminalReached = true;
      return {
        content: [{ type: 'text' as const, text: 'Terminal transition completed.' }],
        details: {},
      };
    });
    const laterSideEffect = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Must not execute.' }],
      details: {},
    }));
    const gate = createDirectorToolExecutionGate({
      maxToolCalls: 10,
      isTerminalReached: () => terminalReached,
    });
    const tools = guardDirectorToolsWithExecutionGate(
      [
        {
          name: 'terminal_tool',
          label: 'Terminal tool',
          description: 'Completes the request.',
          parameters: Type.Object({}),
          executionMode: 'sequential',
          execute: terminalTool,
        },
        {
          name: 'later_tool',
          label: 'Later tool',
          description: 'Must not run after a terminal transition.',
          parameters: Type.Object({}),
          executionMode: 'sequential',
          execute: laterSideEffect,
        },
      ],
      gate,
    );
    const streamFn = ((_model, _context, options) =>
      options?.signal?.aborted
        ? streamMessage({
            ...assistantMessage([]),
            stopReason: 'aborted',
          })
        : streamMessage(
            assistantMessage([
              { type: 'toolCall', id: 'terminal', name: 'terminal_tool', arguments: {} },
              { type: 'toolCall', id: 'later', name: 'later_tool', arguments: {} },
            ]),
          )) as StreamFn;
    const director = buildAgent({
      streamFn,
      systemPrompt: 'Test duplicate-terminal prevention.',
      tools,
      allowedToolNames: new Set(tools.map((tool) => tool.name)),
    });
    const unsubscribe = attachDirectorToolExecutionGate(director, gate);

    try {
      await director.prompt('Run the terminal batch.');
      await director.waitForIdle();
    } finally {
      unsubscribe();
    }

    expect(terminalTool).toHaveBeenCalledOnce();
    expect(laterSideEffect).not.toHaveBeenCalled();
    expect(gate.getAttemptCount()).toBe(2);
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
  ])('counts $label attempts and blocks a later valid side effect', async ({ invalidCalls }) => {
    const callAgent = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Must not execute.' }],
      details: {},
    }));
    const callAgentTool: AgentTool = {
      name: 'call_agent',
      label: 'Call agent',
      description: 'A valid side effect after malformed attempts.',
      parameters: Type.Object({
        agentId: Type.String(),
        instruction: Type.String(),
      }),
      executionMode: 'sequential',
      execute: callAgent,
    };
    const gate = createDirectorToolExecutionGate({
      maxToolCalls: 2,
      isTerminalReached: () => false,
    });
    const tools = guardDirectorToolsWithExecutionGate([callAgentTool], gate);
    const streamFn = ((_model, _context, options) =>
      options?.signal?.aborted
        ? streamMessage({
            ...assistantMessage([]),
            stopReason: 'aborted',
          })
        : streamMessage(
            assistantMessage([
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
            ]),
          )) as StreamFn;
    const director = buildAgent({
      streamFn,
      systemPrompt: 'Test the all-attempt Director hard cap.',
      tools,
      allowedToolNames: new Set(['call_agent']),
    });
    const unsubscribe = attachDirectorToolExecutionGate(director, gate);

    try {
      await director.prompt('Run malformed attempts, then a valid tool.');
      await director.waitForIdle();
    } finally {
      unsubscribe();
    }

    expect(callAgent).not.toHaveBeenCalled();
    expect(gate.getAttemptCount()).toBe(3);
  });
});
