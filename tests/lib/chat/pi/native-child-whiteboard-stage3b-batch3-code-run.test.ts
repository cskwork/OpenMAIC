import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { BrowserClientQueryRuntime } from '@/lib/agent/client/client-query-runtime';
import { BrowserRevisionedWhiteboardEffectRuntime } from '@/lib/agent/client/revisioned-whiteboard-effect-runtime';
import { browserRevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import { CLIENT_QUERY_RESPONSE_HEADER } from '@/lib/agent/runtime/client-query-contract';
import { piClientQueryCoordinator } from '@/lib/agent/runtime/client-query-coordinator';
import { REVISIONED_WHITEBOARD_ACK_HEADER } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { piRevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';
import type { ClientQueryExecutionRequest } from '@/lib/agent/runtime/native-child-contract';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { buildInternalNativeWhiteboardReadTool } from '@/lib/chat/pi/tools/native-whiteboard-read';
import {
  buildInternalRevisionedWhiteboardDrawCodeTool,
  buildInternalRevisionedWhiteboardEditCodeTool,
} from '@/lib/chat/pi/tools/native-whiteboard-v2-code';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { getDefaultWhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage } from '@/lib/types/stage';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import { setStageStoreStateThroughAuthority } from '@/tests/helpers/whiteboard-authority';

const EMPTY_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
) {
  return {
    role: 'assistant' as const,
    content,
    api: 'test',
    provider: 'test',
    model: 'deterministic',
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: 1,
  } satisfies AssistantMessage;
}

function stream(message: AssistantMessage) {
  const value = createAssistantMessageEventStream();
  queueMicrotask(() =>
    value.push({
      type: 'done',
      reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message,
    }),
  );
  return value;
}

function stage(): Stage {
  return {
    id: 'stage-1',
    name: 'Stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: [],
  };
}

function body(value: Stage): StatelessChatRequest {
  return {
    messages: [],
    config: {
      agentIds: ['teacher-1'],
      piSessionId: 'session-1',
      piRequestId: 'request-1',
    },
    storeState: {
      stage: value,
      scenes: [],
      outlines: [],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    apiKey: 'test-only',
  } as StatelessChatRequest;
}

function latestToolData(context: Context): Record<string, unknown> {
  const text =
    context.messages
      .findLast((message) => message.role === 'toolResult')
      ?.content.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? '';
  return JSON.parse(text.slice(text.indexOf('{')));
}

function queryExecution(executionId: string): ClientQueryExecutionRequest {
  const now = Date.now();
  return {
    protocolVersion: 'maic.tool-execution.v1',
    kind: 'client_query',
    traceId: 'trace-code',
    runId: 'run-code',
    agentInvocationId: 'child-1',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: 'tool-' + executionId,
    executionId,
    idempotencyKey: 'idem-' + executionId,
    toolName: 'wb_read',
    args: {},
    argsDigest: 'sha256:test',
    issuedAt: now,
    deadlineAt: now + 10_000,
    attempt: 1,
  };
}

afterEach(() => {
  piClientQueryCoordinator.clearForTests();
  piRevisionedWhiteboardCoordinator.clearForTests();
  browserRevisionedWhiteboardTargetRegistry.clear();
  useStageStore.getState().clearStore();
  useCanvasStore.getState().setWhiteboardOpen(false);
  vi.unstubAllEnvs();
});

describe('Stage 3B Batch 3 real same-Child Code continuation', () => {
  it('runs real wb_read → Code Draw → returned complete-code capability → Edit → final text', async () => {
    const initialStage = stage();
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD', 'true');
    setStageStoreStateThroughAuthority({ stage: initialStage, currentSceneId: 'scene-1' });
    const authority = getDefaultWhiteboardEnvironmentAuthority();
    if (!authority) throw new Error('Expected default whiteboard Authority.');
    const before = authority.querySnapshot();
    if (!before.ok) throw new Error('Expected Authority snapshot.');

    const ledger = new NativeWhiteboardObservationLedger();
    const mutationRuntime = new RevisionedWhiteboardMutationRuntime(
      ledger,
      piRevisionedWhiteboardCoordinator,
    );
    const queryRuntime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (input, init) => {
        const queryId = decodeURIComponent(String(input).split('/').at(-2)!);
        const token = new Headers(init?.headers).get(CLIENT_QUERY_RESPONSE_HEADER)!;
        const raw = String(init?.body);
        const outcome = piClientQueryCoordinator.respond(queryId, token, raw, JSON.parse(raw));
        return new Response('{}', { status: outcome.kind === 'invalid' ? 409 : 200 });
      }),
    });
    const effectRuntime = new BrowserRevisionedWhiteboardEffectRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      getAuthority: () => authority,
      targetRegistry: browserRevisionedWhiteboardTargetRegistry,
      fetchAck: vi.fn(async (_input, init) => {
        const token = new Headers(init?.headers).get(REVISIONED_WHITEBOARD_ACK_HEADER)!;
        const result = piRevisionedWhiteboardCoordinator.applyAck(
          token,
          JSON.parse(String(init?.body)),
        );
        return new Response('{}', {
          status: result.kind === 'applied' || result.kind === 'duplicate' ? 200 : 409,
        });
      }),
    });
    const events: StatelessEvent[] = [];
    const send = async (event: StatelessEvent) => {
      events.push(event);
      if (event.type === 'client_query') await queryRuntime.execute(event.data);
      if (event.type === 'revisioned_client_effect') await effectRuntime.execute(event.data);
    };
    const read = buildInternalNativeWhiteboardReadTool({
      body: body(initialStage),
      observationLedger: ledger,
      send,
    });
    const onActionDone = vi.fn();
    const codeOptions = {
      body: body(initialStage),
      observationLedger: ledger,
      mutationRuntime,
      canExecute: () => true,
      onActionDone,
      send,
    };
    const draw = buildInternalRevisionedWhiteboardDrawCodeTool(codeOptions);
    const edit = buildInternalRevisionedWhiteboardEditCodeTool(codeOptions);

    let turn = 0;
    const streamFn = ((_model, context) => {
      turn += 1;
      if (turn === 1) {
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: 'read-code',
                name: 'wb_read',
                arguments: { scope: 'summary' },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (turn === 2) {
        const result = latestToolData(context) as {
          whiteboardId: string | null;
          revision: number;
          observationTokens: { bindingObservationToken: string };
        };
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: 'draw-code',
                name: 'wb_draw_code',
                arguments: {
                  observationToken: result.observationTokens.bindingObservationToken,
                  expectedWhiteboardId: result.whiteboardId,
                  expectedRevision: result.revision,
                  language: 'ts',
                  code: 'const a = 1;\nconsole.log(a);',
                  x: 80,
                  y: 60,
                  width: 600,
                  height: 300,
                  fileName: 'example.ts',
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (turn === 3) {
        const result = latestToolData(context) as {
          stableElementId: string;
          currentBinding: { whiteboardId: string; revision: number };
          observationTokens: { codeObservationToken: string };
        };
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: 'edit-code',
                name: 'wb_edit_code',
                arguments: {
                  observationToken: result.observationTokens.codeObservationToken,
                  expectedWhiteboardId: result.currentBinding.whiteboardId,
                  expectedRevision: result.currentBinding.revision,
                  elementId: result.stableElementId,
                  operation: 'insert_after',
                  lineId: 'L1',
                  content: 'const b = 2;',
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      expect(latestToolData(context)).toMatchObject({
        codeChanged: true,
        orderedLineIds: ['L1', expect.stringMatching(/^CE2_[0-9a-f]{64}_1$/u), 'L2'],
        observationTokens: {
          bindingObservationToken: expect.any(String),
          codeObservationToken: expect.any(String),
        },
      });
      return stream(
        assistant([{ type: 'text', text: 'Code was drawn and edited in the same Child.' }], 'stop'),
      );
    }) as StreamFn;
    const executionIds = ['query-code', 'draw-code-execution', 'edit-code-execution'];
    const result = await runNativeChild({
      traceId: 'trace-code',
      runId: 'run-code',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      streamFn,
      systemPrompt: 'Use authoritative whiteboard reads and revisioned Code mutations.',
      prompt: 'Draw and edit one code block.',
      tools: [read.tool, draw.tool, edit.tool],
      allowedToolNames: new Set(['wb_read', 'wb_draw_code', 'wb_edit_code']),
      clientQueryHandlers: new Map([['wb_read', read.handler]]),
      clientEffectHandlers: new Map([
        ['wb_draw_code', draw.handler],
        ['wb_edit_code', edit.handler],
      ]),
      toolCategories: new Map([
        ['wb_read', 'read'],
        ['wb_draw_code', 'mutation'],
        ['wb_edit_code', 'mutation'],
      ]),
      toolBudgets: {
        maxMutationExecutions: 2,
        maxReadExecutions: 8,
        maxOtherToolExecutions: 2,
        maxToolCallAttempts: 12,
      },
      timeoutMs: 10_000,
      createExecutionId: () => executionIds.shift()!,
      onSettled: (childInvocationId) => read.dispose(childInvocationId),
    });

    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('Code was drawn and edited in the same Child.');
    expect(result.toolBudgetUsage).toEqual({
      mutationExecutions: 2,
      readExecutions: 1,
      otherToolExecutions: 0,
      toolCallAttempts: 3,
    });
    expect(result.toolExecutions.map(({ status }) => status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(events.map(({ type }) => type)).toEqual([
      'client_query',
      'revisioned_client_effect',
      'revisioned_client_effect',
    ]);
    expect(onActionDone).toHaveBeenCalledTimes(2);
    expect(authority.querySnapshot()).toMatchObject({
      ok: true,
      value: { revision: before.value.revision + 2, open: true },
    });
    expect(useStageStore.getState().stage?.whiteboard?.[0].elements[0]).toMatchObject({
      type: 'code',
      lines: [
        { id: 'L1', content: 'const a = 1;' },
        { id: expect.stringMatching(/^CE2_[0-9a-f]{64}_1$/u), content: 'const b = 2;' },
        { id: 'L2', content: 'console.log(a);' },
      ],
    });
  });

  it('reads zero-line Code as complete and mints a complete-code capability', async () => {
    const currentStage = stage();
    currentStage.whiteboard = [
      {
        id: 'board-zero',
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        elements: [
          {
            id: 'code-zero',
            type: 'code',
            language: 'text',
            lines: [],
            left: 10,
            top: 10,
            width: 400,
            height: 200,
            rotate: 0,
          },
        ],
        background: { type: 'solid', color: '#ffffff' },
        animations: [],
      },
    ];
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const queryRuntime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse: vi.fn(async (input, init) => {
        const queryId = decodeURIComponent(String(input).split('/').at(-2)!);
        const token = new Headers(init?.headers).get(CLIENT_QUERY_RESPONSE_HEADER)!;
        const raw = String(init?.body);
        const outcome = piClientQueryCoordinator.respond(queryId, token, raw, JSON.parse(raw));
        return new Response('{}', { status: outcome.kind === 'invalid' ? 409 : 200 });
      }),
    });
    const ledger = new NativeWhiteboardObservationLedger();
    const read = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      observationLedger: ledger,
      send: async (event) => {
        if (event.type === 'client_query') await queryRuntime.execute(event.data);
      },
    });
    const result = await read.handler({
      request: queryExecution('read-zero-code'),
      params: { scope: 'code', elementId: 'code-zero' },
    });
    expect(result).toMatchObject({
      isError: false,
      details: {
        scope: 'code',
        elementId: 'code-zero',
        complete: true,
        data: { lineCount: 0, fragments: [] },
        observationTokens: { codeObservationToken: expect.any(String) },
      },
    });
    read.dispose('child-1');
  });

  it.each([
    {
      toolName: 'wb_draw_code' as const,
      arguments: {
        observationToken: 'not-consumed',
        expectedWhiteboardId: null,
        expectedRevision: 0,
        language: 'ts',
        code: 'const a = 1;',
        x: 10,
        y: 20,
        forged: true,
      },
    },
    {
      toolName: 'wb_edit_code' as const,
      arguments: {
        observationToken: 'not-consumed',
        expectedWhiteboardId: 'board-1',
        expectedRevision: 0,
        elementId: 'code-1',
        operation: 'delete_lines',
        lineIds: ['L1'],
        forged: true,
      },
    },
  ])(
    'rejects extra $toolName arguments through real Pi validation before delivery',
    async (fixture) => {
      const currentStage = stage();
      const ledger = new NativeWhiteboardObservationLedger();
      const mutationRuntime = new RevisionedWhiteboardMutationRuntime(
        ledger,
        piRevisionedWhiteboardCoordinator,
      );
      const events: StatelessEvent[] = [];
      const onActionDone = vi.fn();
      const options = {
        body: body(currentStage),
        observationLedger: ledger,
        mutationRuntime,
        canExecute: () => true,
        onActionDone,
        send: async (event: StatelessEvent) => {
          events.push(event);
        },
      };
      const mutation =
        fixture.toolName === 'wb_draw_code'
          ? buildInternalRevisionedWhiteboardDrawCodeTool(options)
          : buildInternalRevisionedWhiteboardEditCodeTool(options);
      let turn = 0;
      const streamFn = ((_model, context) => {
        turn += 1;
        if (turn === 1) {
          return stream(
            assistant(
              [
                {
                  type: 'toolCall',
                  id: 'invalid-code-call',
                  name: fixture.toolName,
                  arguments: fixture.arguments,
                },
              ],
              'toolUse',
            ),
          );
        }
        const toolResult = context.messages.findLast((message) => message.role === 'toolResult');
        expect(toolResult).toMatchObject({ isError: true });
        return stream(
          assistant([{ type: 'text', text: 'Invalid Code call was rejected.' }], 'stop'),
        );
      }) as StreamFn;
      const result = await runNativeChild({
        traceId: 'trace-invalid',
        runId: 'run-invalid',
        agentInvocationId: 'child-1',
        agentId: 'teacher-1',
        depth: 1,
        streamFn,
        systemPrompt: 'Use the provided tool schema exactly.',
        prompt: 'Attempt the fixed invalid call.',
        tools: [mutation.tool],
        allowedToolNames: new Set([fixture.toolName]),
        clientEffectHandlers: new Map([[fixture.toolName, mutation.handler]]),
        toolCategories: new Map([[fixture.toolName, 'mutation']]),
        toolBudgets: {
          maxMutationExecutions: 2,
          maxReadExecutions: 8,
          maxOtherToolExecutions: 2,
          maxToolCallAttempts: 12,
        },
        timeoutMs: 5_000,
        createExecutionId: () => 'invalid-code-execution',
      });
      expect(result.status).toBe('completed');
      expect(result.toolExecutions).toHaveLength(1);
      expect(result.toolExecutions[0]).toMatchObject({ status: 'rejected' });
      expect(result.toolBudgetUsage).toMatchObject({ mutationExecutions: 1, toolCallAttempts: 1 });
      expect(events).toEqual([]);
      expect(onActionDone).not.toHaveBeenCalled();
    },
  );
});
