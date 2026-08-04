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
import { deriveRevisionedWhiteboardId } from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { buildInternalNativeWhiteboardReadTool } from '@/lib/chat/pi/tools/native-whiteboard-read';
import { buildInternalRevisionedWhiteboardDrawTextTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-draw-text';
import { buildInternalRevisionedWhiteboardCloseTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-lifecycle';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { getDefaultWhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';
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

function board(): Whiteboard {
  return {
    id: 'board-1',
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements: [],
    background: { type: 'solid', color: '#ffffff' },
    animations: [],
  };
}

function stage(withBoard = true): Stage {
  return {
    id: 'stage-1',
    name: 'Stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: withBoard ? [board()] : [],
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
      whiteboardOpen: true,
    },
    apiKey: 'test-only',
  } as StatelessChatRequest;
}

const readCurrentStageId = () => useStageStore.getState().stage?.id;
const readCurrentSceneId = () => useStageStore.getState().currentSceneId;

function latestToolData(context: Context): Record<string, unknown> {
  const text =
    context.messages
      .findLast((message) => message.role === 'toolResult')
      ?.content.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? '';
  return JSON.parse(text.slice(text.indexOf('{')));
}

afterEach(() => {
  piClientQueryCoordinator.clearForTests();
  piRevisionedWhiteboardCoordinator.clearForTests();
  browserRevisionedWhiteboardTargetRegistry.clear();
  useStageStore.getState().clearStore();
  useCanvasStore.getState().setWhiteboardOpen(false);
  vi.unstubAllEnvs();
});

describe('Stage 3B Batch 4 real same-Child lifecycle continuation', () => {
  it.each([
    {
      name: 'existing binding',
      withBoard: true,
      executionSuffix: 'existing',
      expectedBoardId: 'board-1',
      expectedBoardCountAfterClose: 1,
    },
    {
      name: 'null binding',
      withBoard: false,
      executionSuffix: 'null',
      expectedBoardId: deriveRevisionedWhiteboardId('draw-lifecycle-null'),
      expectedBoardCountAfterClose: 0,
    },
  ])(
    'runs real wb_read → Close → binding token → Draw reopen → final text for $name',
    async ({ withBoard, executionSuffix, expectedBoardId, expectedBoardCountAfterClose }) => {
      const initialStage = stage(withBoard);
      vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
      vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD', 'true');
      setStageStoreStateThroughAuthority({ stage: initialStage, currentSceneId: 'scene-1' });
      useCanvasStore.getState().setWhiteboardOpen(true);
      const authority = getDefaultWhiteboardEnvironmentAuthority();
      if (!authority) throw new Error('Expected default Authority.');
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
        readCurrentStageId,
        readCurrentSceneId,
        getAuthority: () => authority,
        targetRegistry: browserRevisionedWhiteboardTargetRegistry,
        fetchAck: vi.fn(async (_input, init) => {
          const token = new Headers(init?.headers).get(REVISIONED_WHITEBOARD_ACK_HEADER)!;
          const applied = piRevisionedWhiteboardCoordinator.applyAck(
            token,
            JSON.parse(String(init?.body)),
          );
          return new Response('{}', {
            status: applied.kind === 'applied' || applied.kind === 'duplicate' ? 200 : 409,
          });
        }),
      });
      const events: StatelessEvent[] = [];
      let boardCountAfterClose: number | null = null;
      let deliveryError: unknown;
      const send = async (event: StatelessEvent) => {
        events.push(event);
        if (event.type === 'client_query') await queryRuntime.execute(event.data);
        if (event.type === 'revisioned_client_effect') {
          try {
            await effectRuntime.execute(event.data);
          } catch (error) {
            deliveryError = error;
            throw error;
          }
          if (event.data.toolName === 'wb_close') {
            boardCountAfterClose = useStageStore.getState().stage?.whiteboard?.length ?? 0;
          }
        }
      };
      const read = buildInternalNativeWhiteboardReadTool({
        body: body(initialStage),
        observationLedger: ledger,
        send,
      });
      const onActionDone = vi.fn();
      const common = {
        body: body(initialStage),
        observationLedger: ledger,
        mutationRuntime,
        canExecute: () => true,
        onActionDone,
        send,
      };
      const close = buildInternalRevisionedWhiteboardCloseTool(common);
      const draw = buildInternalRevisionedWhiteboardDrawTextTool(common);

      let turn = 0;
      const streamFn = ((_model, context) => {
        turn += 1;
        if (turn === 1) {
          return stream(
            assistant(
              [
                {
                  type: 'toolCall',
                  id: 'read-binding',
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
                  id: 'close-board',
                  name: 'wb_close',
                  arguments: {
                    observationToken: result.observationTokens.bindingObservationToken,
                    expectedWhiteboardId: result.whiteboardId,
                    expectedRevision: result.revision,
                  },
                },
              ],
              'toolUse',
            ),
          );
        }
        if (turn === 3) {
          const result = latestToolData(context) as {
            currentBinding: { whiteboardId: string | null; revision: number };
            observationTokens: { bindingObservationToken: string };
          };
          return stream(
            assistant(
              [
                {
                  type: 'toolCall',
                  id: 'draw-after-close',
                  name: 'wb_draw_text',
                  arguments: {
                    observationToken: result.observationTokens.bindingObservationToken,
                    expectedWhiteboardId: result.currentBinding.whiteboardId,
                    expectedRevision: result.currentBinding.revision,
                    content: 'Reopened safely',
                    x: 80,
                    y: 80,
                  },
                },
              ],
              'toolUse',
            ),
          );
        }
        expect(latestToolData(context)).toMatchObject({
          currentBinding: { whiteboardId: expectedBoardId },
          observationTokens: { bindingObservationToken: expect.any(String) },
        });
        return stream(
          assistant(
            [{ type: 'text', text: 'Closed, reopened, and continued in one Child.' }],
            'stop',
          ),
        );
      }) as StreamFn;

      const executionIds = [
        `read-lifecycle-${executionSuffix}`,
        `close-lifecycle-${executionSuffix}`,
        `draw-lifecycle-${executionSuffix}`,
      ];
      const result = await runNativeChild({
        traceId: 'trace-lifecycle',
        runId: 'run-lifecycle',
        agentInvocationId: 'child-1',
        agentId: 'teacher-1',
        depth: 1,
        streamFn,
        systemPrompt: 'Use authoritative reads and lifecycle tools conservatively.',
        prompt: 'Close only as requested, then draw and explain.',
        tools: [read.tool, close.tool, draw.tool],
        allowedToolNames: new Set(['wb_read', 'wb_close', 'wb_draw_text']),
        clientQueryHandlers: new Map([['wb_read', read.handler]]),
        clientEffectHandlers: new Map([
          ['wb_close', close.handler],
          ['wb_draw_text', draw.handler],
        ]),
        toolCategories: new Map([
          ['wb_read', 'read'],
          ['wb_close', 'mutation'],
          ['wb_draw_text', 'mutation'],
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

      expect(
        result.status,
        JSON.stringify({ result, deliveryError: String(deliveryError) }, null, 2),
      ).toBe('completed');
      expect(result.finalOutput).toBe('Closed, reopened, and continued in one Child.');
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
      expect(boardCountAfterClose).toBe(expectedBoardCountAfterClose);
      expect(authority.querySnapshot()).toMatchObject({
        ok: true,
        value: {
          revision: before.value.revision + 2,
          open: true,
          activeWhiteboardId: expectedBoardId,
        },
      });
      expect(useStageStore.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    },
  );

  it('rejects extra Close parameters through real Pi validation without delivery or action', async () => {
    const currentStage = stage();
    const ledger = new NativeWhiteboardObservationLedger();
    const mutationRuntime = new RevisionedWhiteboardMutationRuntime(
      ledger,
      piRevisionedWhiteboardCoordinator,
    );
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const close = buildInternalRevisionedWhiteboardCloseTool({
      body: body(currentStage),
      observationLedger: ledger,
      mutationRuntime,
      canExecute: () => true,
      onActionDone,
      send: async (event) => {
        events.push(event);
      },
    });
    let turn = 0;
    const streamFn = ((_model, context) => {
      turn += 1;
      if (turn === 1) {
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: 'invalid-close',
                name: 'wb_close',
                arguments: {
                  observationToken: 'not-consumed',
                  expectedWhiteboardId: 'board-1',
                  expectedRevision: 0,
                  reason: 'turn done',
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      expect(context.messages.findLast((message) => message.role === 'toolResult')).toMatchObject({
        isError: true,
      });
      return stream(assistant([{ type: 'text', text: 'Invalid Close rejected.' }], 'stop'));
    }) as StreamFn;
    const result = await runNativeChild({
      traceId: 'trace-invalid-close',
      runId: 'run-invalid-close',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      streamFn,
      systemPrompt: 'Use the exact tool schema.',
      prompt: 'Attempt the fixed invalid call.',
      tools: [close.tool],
      allowedToolNames: new Set(['wb_close']),
      clientEffectHandlers: new Map([['wb_close', close.handler]]),
      toolCategories: new Map([['wb_close', 'mutation']]),
      toolBudgets: {
        maxMutationExecutions: 2,
        maxReadExecutions: 8,
        maxOtherToolExecutions: 2,
        maxToolCallAttempts: 12,
      },
      timeoutMs: 5_000,
      createExecutionId: () => 'invalid-close-execution',
    });
    expect(result.status).toBe('completed');
    expect(result.toolExecutions).toMatchObject([{ status: 'rejected' }]);
    expect(events).toEqual([]);
    expect(onActionDone).not.toHaveBeenCalled();
  });

  it('does not emit Close when the Child finishes without calling it', async () => {
    const currentStage = stage();
    const ledger = new NativeWhiteboardObservationLedger();
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const close = buildInternalRevisionedWhiteboardCloseTool({
      body: body(currentStage),
      observationLedger: ledger,
      canExecute: () => true,
      onActionDone,
      send: async (event) => {
        events.push(event);
      },
    });
    const result = await runNativeChild({
      traceId: 'trace-no-close',
      runId: 'run-no-close',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      streamFn: (() =>
        stream(
          assistant([{ type: 'text', text: 'Keep the whiteboard open.' }], 'stop'),
        )) as StreamFn,
      systemPrompt: 'Do not close unless requested.',
      prompt: 'Explain the current board.',
      tools: [close.tool],
      allowedToolNames: new Set(['wb_close']),
      clientEffectHandlers: new Map([['wb_close', close.handler]]),
      toolCategories: new Map([['wb_close', 'mutation']]),
      toolBudgets: {
        maxMutationExecutions: 2,
        maxReadExecutions: 8,
        maxOtherToolExecutions: 2,
        maxToolCallAttempts: 12,
      },
      timeoutMs: 5_000,
      createExecutionId: () => 'unused-close-execution',
    });
    expect(result).toMatchObject({ status: 'completed', finalOutput: 'Keep the whiteboard open.' });
    expect(result.toolExecutions).toEqual([]);
    expect(events).toEqual([]);
    expect(onActionDone).not.toHaveBeenCalled();
  });
});
