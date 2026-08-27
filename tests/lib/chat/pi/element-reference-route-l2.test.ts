import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  buildAgent: vi.fn(),
  streamLLM: vi.fn(),
  resolveModel: vi.fn(),
  legacyChildPrompts: [] as string[],
  nativeChildPrompts: [] as string[],
  directorPrompts: [] as string[],
  callAgentExecutions: 0,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...actual, isProviderKeyRequired: () => false };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeBody() {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Explain the selected fact.' }],
      },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'Lesson', whiteboard: [] },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          title: 'Grounded slide',
          order: 0,
          type: 'slide',
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'text-1',
                  type: 'text',
                  content: '<p>Evaporation removes heat.</p>',
                  defaultFontName: 'Arial',
                  defaultColor: '#111111',
                  left: 10,
                  top: 20,
                  width: 180,
                  height: 40,
                  rotate: 0,
                },
              ],
            },
          },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: {
      agentIds: ['teacher-1'],
      agentConfigs: [
        {
          id: 'teacher-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'Teach only from supplied evidence.',
          priority: 10,
          avatar: '',
          color: '#3366ff',
          allowedActions: [],
        },
      ],
    },
    elementReference: {
      kind: 'slide_element',
      sceneId: 'scene-1',
      elementId: 'text-1',
    },
    apiKey: '',
    model: 'test:model',
  };
}

function installAgentShell(legacyAnswer: string, nativeAnswer = 'Native grounded answer.') {
  mocks.buildAgent.mockImplementation((options: Record<string, unknown>) => {
    const tools = (options.tools ?? []) as Array<{
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => Promise<{
        content: unknown[];
        details?: unknown;
        isError?: boolean;
      }>;
    }>;
    const callAgent = tools.find((tool) => tool.name === 'call_agent');
    if (callAgent) {
      return {
        prompt: async (prompt: string) => {
          mocks.directorPrompts.push(prompt);
        },
        waitForIdle: async () => {
          mocks.callAgentExecutions += 1;
          const args = { agentId: 'teacher-1', instruction: 'Answer from the selected element.' };
          const result = await callAgent.execute('delegate-grounded-1', args);
          await (
            options.afterToolCall as ((context: Record<string, unknown>) => unknown) | undefined
          )?.({
            toolCall: { name: 'call_agent' },
            args,
            result,
            isError: result.isError === true,
          });
        },
        state: { messages: [] },
      };
    }

    if (tools.length > 0) {
      let subscriber: ((event: unknown, signal: AbortSignal) => unknown) | undefined;
      const state = { messages: [] as Array<Record<string, unknown>> };
      return {
        subscribe: (handler: (event: unknown, signal: AbortSignal) => unknown) => {
          subscriber = handler;
          return () => {};
        },
        prompt: async (prompt: string) => {
          mocks.nativeChildPrompts.push(prompt);
        },
        waitForIdle: async () => {
          const signal = new AbortController().signal;
          await subscriber?.(
            {
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: nativeAnswer },
            },
            signal,
          );
          state.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: nativeAnswer }],
            stopReason: 'stop',
          });
          await subscriber?.({ type: 'agent_end' }, signal);
        },
        abort: vi.fn(),
        state,
      };
    }

    let subscriber: ((event: unknown) => unknown) | undefined;
    return {
      subscribe: (handler: (event: unknown) => unknown) => {
        subscriber = handler;
        return () => {};
      },
      prompt: async (prompt: string) => {
        mocks.legacyChildPrompts.push(prompt);
      },
      waitForIdle: async () => {
        await subscriber?.({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: JSON.stringify([{ type: 'text', content: legacyAnswer }]),
          },
        });
      },
      state: {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify([{ type: 'text', content: legacyAnswer }]),
              },
            ],
          },
        ],
      },
    };
  });
}

describe('PPT element reference Route → Director → real call_agent L2', () => {
  const piFlag = 'NEXT_PUBLIC_PI_CHAT_ENABLED';
  const nativeFlag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME';
  let originalPiFlag: string | undefined;
  let originalNativeFlag: string | undefined;

  beforeEach(() => {
    originalPiFlag = process.env[piFlag];
    originalNativeFlag = process.env[nativeFlag];
    process.env[piFlag] = 'true';
    delete process.env[nativeFlag];
    vi.resetModules();
    mocks.buildAgent.mockReset();
    mocks.streamLLM.mockReset();
    mocks.resolveModel.mockReset();
    mocks.legacyChildPrompts.length = 0;
    mocks.nativeChildPrompts.length = 0;
    mocks.directorPrompts.length = 0;
    mocks.callAgentExecutions = 0;
    mocks.resolveModel.mockResolvedValue({
      model: { provider: 'test', modelId: 'shared-model' },
      apiKey: '',
      providerId: 'test',
      modelInfo: { outputWindow: 1024, contextWindow: 8192 },
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
  });

  afterEach(() => {
    if (originalPiFlag === undefined) delete process.env[piFlag];
    else process.env[piFlag] = originalPiFlag;
    if (originalNativeFlag === undefined) delete process.env[nativeFlag];
    else process.env[nativeFlag] = originalNativeFlag;
  });

  it('grounds the Legacy Child through the full server orchestration chain', async () => {
    installAgentShell('Legacy grounded answer.');
    const { POST } = await import('@/app/api/chat/pi/route');

    const response = await POST(makeRequest(makeBody()));
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    expect(mocks.callAgentExecutions).toBe(1);
    expect(mocks.directorPrompts.join('\n')).toContain('Evaporation removes heat.');
    expect(mocks.legacyChildPrompts.join('\n')).toContain('Evaporation removes heat.');
    expect(stream).toContain('Legacy grounded answer.');
    expect(stream).toContain('"type":"done"');
    expect(stream).not.toContain('"type":"error"');
  }, 15_000);

  it('grounds the Native Child through the same full server orchestration chain', async () => {
    process.env[nativeFlag] = 'true';
    installAgentShell('unused legacy answer');
    const { isPiNativeChildRuntimeEnabled } = await import('@/lib/config/feature-flags');
    expect(isPiNativeChildRuntimeEnabled()).toBe(true);
    const { POST } = await import('@/app/api/chat/pi/route');

    const response = await POST(makeRequest(makeBody()));
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    expect(mocks.callAgentExecutions).toBe(1);
    expect(mocks.nativeChildPrompts.join('\n')).toContain('Evaporation removes heat.');
    expect(stream).toContain('Native grounded answer.');
    expect(stream).toContain('"type":"done"');
    expect(stream).not.toContain('"type":"error"');
  }, 15_000);
});
