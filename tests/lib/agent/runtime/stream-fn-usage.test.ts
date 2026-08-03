import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';

describe('createCallLlmStreamFn usage', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('writes AI SDK token usage into the completed Pi assistant message', async () => {
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'answer' };
      })(),
      usage: Promise.resolve({
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 },
      }),
    });
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    const message = await stream.result();

    expect(message.usage).toMatchObject({
      input: 105,
      output: 30,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 150,
    });
  });

  it.each([
    { finishReason: 'stop', expected: 'stop' },
    { finishReason: 'length', expected: 'length' },
    { finishReason: 'content-filter', expected: 'error' },
    { finishReason: 'error', expected: 'error' },
    { finishReason: 'other', expected: 'error' },
  ] as const)(
    'maps AI SDK $finishReason to Pi $expected instead of inferring normal completion',
    async ({ finishReason, expected }) => {
      mocks.streamLLM.mockReturnValue({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'partial answer' };
          yield { type: 'finish', finishReason };
        })(),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      });
      const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

      const stream = await streamFn(
        {} as never,
        { systemPrompt: 'test', messages: [], tools: [] },
        {},
      );
      const message = await stream.result();

      expect(message.stopReason).toBe(expected);
    },
  );

  it('maps an AI SDK abort part to Pi aborted', async () => {
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'partial answer' };
        yield { type: 'abort', reason: 'request cancelled' };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    });
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    const message = await stream.result();

    expect(message.stopReason).toBe('aborted');
    expect(message.errorMessage).toBe('request cancelled');
  });

  it('maps AI SDK tool-calls to Pi toolUse', async () => {
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'lookup',
          input: { query: 'x' },
        };
        yield { type: 'finish', finishReason: 'tool-calls' };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    });
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    const message = await stream.result();

    expect(message.stopReason).toBe('toolUse');
    expect(message.content).toEqual([
      { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { query: 'x' } },
    ]);
  });

  it('preserves a failed tool result as error-text in the same Child continuation', async () => {
    const modelMessages: unknown[] = [];
    let transportTurn = 0;
    mocks.streamLLM.mockImplementation((params?: { messages: unknown }) => {
      modelMessages.push(params?.messages);
      transportTurn += 1;
      return {
        fullStream: (async function* () {
          if (transportTurn === 1) {
            yield {
              type: 'tool-call',
              toolCallId: 'call-failing-tool',
              toolName: 'failing_tool',
              input: {},
            };
            yield { type: 'finish', finishReason: 'tool-calls' };
            return;
          }
          yield { type: 'text-delta', text: 'I observed the tool failure.' };
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      };
    });
    const tool: AgentTool = {
      name: 'failing_tool',
      label: 'Failing tool',
      description: 'Fail deterministically.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: vi.fn(async () => {
        throw new Error('deterministic failure');
      }),
    };
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    const result = await runNativeChild({
      traceId: 'trace-error-result',
      runId: 'run-error-result',
      agentInvocationId: 'child-error-result',
      agentId: 'teacher-1',
      depth: 1,
      streamFn,
      systemPrompt: 'Test failed tool-result transport.',
      prompt: 'Call the failing tool, then continue.',
      tools: [tool],
      timeoutMs: 1_000,
      toolBudgets: {
        maxMutationExecutions: 0,
        maxReadExecutions: 0,
        maxOtherToolExecutions: 2,
        maxToolCallAttempts: 4,
      },
      toolCategories: new Map([[tool.name, 'other']]),
      createExecutionId: () => 'execution-error-result',
    });

    expect(transportTurn).toBe(2);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(mocks.streamLLM.mock.calls[0]?.[0]).toMatchObject({ messages: expect.any(Array) });
    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('I observed the tool failure.');
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({ status: 'execution_failed', isError: true }),
    ]);
    expect(modelMessages[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: [
            expect.objectContaining({
              type: 'tool-result',
              toolCallId: 'call-failing-tool',
              toolName: 'failing_tool',
              output: { type: 'error-text', value: 'deterministic failure' },
            }),
          ],
        }),
      ]),
    );
  });
});
