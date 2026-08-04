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
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { buildInternalNativeWhiteboardReadTool } from '@/lib/chat/pi/tools/native-whiteboard-read';
import {
  buildInternalRevisionedWhiteboardClearTool,
  buildInternalRevisionedWhiteboardDeleteTool,
} from '@/lib/chat/pi/tools/native-whiteboard-v2-destructive';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { getDefaultWhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import type { PPTElement } from '@openmaic/dsl';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { Stage, Whiteboard } from '@/lib/types/stage';
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

function text(id: string): PPTElement {
  return {
    id,
    type: 'text',
    content: `<p>${id}</p>`,
    left: 40,
    top: 40,
    width: 240,
    height: 80,
    rotate: 0,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
  };
}

function board(): Whiteboard {
  return {
    id: 'board-1',
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements: [text('text-1'), text('text-2')],
    background: { type: 'solid', color: '#ffffff' },
    animations: [],
  };
}

function stage(): Stage {
  return {
    id: 'stage-1',
    name: 'Stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: [board()],
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

function latestToolData(context: Context): Record<string, unknown> {
  const toolResult = context.messages.findLast((message) => message.role === 'toolResult');
  const text =
    toolResult?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? '';
  return JSON.parse(text.slice(text.indexOf('{')));
}

const readCurrentStageId = () => useStageStore.getState().stage?.id;
const readCurrentSceneId = () => useStageStore.getState().currentSceneId;

afterEach(() => {
  piClientQueryCoordinator.clearForTests();
  piRevisionedWhiteboardCoordinator.clearForTests();
  browserRevisionedWhiteboardTargetRegistry.clear();
  useWhiteboardHistoryStore.getState().clearHistory();
  useStageStore.getState().clearStore();
  useCanvasStore.getState().setWhiteboardOpen(false);
  vi.unstubAllEnvs();
});

describe('Stage 3B Batch 5 real same-Child destructive continuation', () => {
  it.each(['wb_delete', 'wb_clear'] as const)(
    'runs stale %s → fresh wb_read elements → retry → verified result → final text',
    async (toolName) => {
      const initialStage = stage();
      vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
      vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD', 'true');
      setStageStoreStateThroughAuthority({ stage: initialStage, currentSceneId: 'scene-1' });
      useCanvasStore.getState().setWhiteboardOpen(false);
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
        readCurrentStageId,
        readCurrentSceneId,
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
      const mutation =
        toolName === 'wb_delete'
          ? buildInternalRevisionedWhiteboardDeleteTool(common)
          : buildInternalRevisionedWhiteboardClearTool(common);

      let turn = 0;
      let advanced = false;
      const streamFn = ((_model, context) => {
        turn += 1;
        if (turn === 1 || turn === 3) {
          if (turn === 3) {
            expect(
              context.messages.findLast((message) => message.role === 'toolResult'),
            ).toMatchObject({ isError: true });
            expect(JSON.stringify(latestToolData(context))).toContain('STALE_STATE');
          }
          return stream(
            assistant(
              [
                {
                  type: 'toolCall',
                  id: turn === 1 ? 'read-elements-stale' : 'read-elements-fresh',
                  name: 'wb_read',
                  arguments: { scope: 'elements' },
                },
              ],
              'toolUse',
            ),
          );
        }
        if (turn === 2 || turn === 4) {
          const result = latestToolData(context) as {
            whiteboardId: string;
            revision: number;
            observationTokens: { membershipObservationToken: string };
            data: { items: Array<{ id: string; targetObservationToken: string }> };
          };
          if (!advanced) {
            expect(
              authority.transact({
                label: 'test.batch5-external-visibility-write',
                writes: [
                  {
                    label: 'open-whiteboard',
                    write: () => useCanvasStore.setState({ whiteboardOpen: true }),
                  },
                ],
              }),
            ).toMatchObject({ ok: true, changed: true });
            advanced = true;
          }
          return stream(
            assistant(
              [
                {
                  type: 'toolCall',
                  id: turn === 2 ? `call-${toolName}-stale` : `call-${toolName}-fresh`,
                  name: toolName,
                  arguments:
                    toolName === 'wb_delete'
                      ? {
                          observationToken: result.data.items[0].targetObservationToken,
                          expectedWhiteboardId: result.whiteboardId,
                          expectedRevision: result.revision,
                          elementId: result.data.items[0].id,
                        }
                      : {
                          observationToken: result.observationTokens.membershipObservationToken,
                          expectedWhiteboardId: result.whiteboardId,
                          expectedRevision: result.revision,
                        },
                },
              ],
              'toolUse',
            ),
          );
        }
        const result = latestToolData(context) as {
          currentBinding: { whiteboardId: string; revision: number };
          observationTokens: Record<string, string>;
        };
        expect(result.currentBinding).toEqual({
          stageId: 'stage-1',
          whiteboardId: 'board-1',
          revision: before.value.revision + 2,
        });
        expect(result.observationTokens.bindingObservationToken).toEqual(expect.any(String));
        if (toolName === 'wb_delete') {
          expect(result).toMatchObject({
            stableElementId: 'text-1',
            elementCountBefore: 2,
            elementCountAfter: 1,
          });
          expect(result.observationTokens).not.toHaveProperty('membershipObservationToken');
        } else {
          expect(result).toMatchObject({
            boardState: 'cleared_existing',
            cleared: true,
            elementCountBefore: 2,
            elementCountAfter: 0,
          });
          expect(result.observationTokens.membershipObservationToken).toEqual(expect.any(String));
        }
        return stream(
          assistant(
            [{ type: 'text', text: `${toolName} completed and the same Child continued.` }],
            'stop',
          ),
        );
      }) as StreamFn;

      const executionIds = [
        `read-${toolName}-stale`,
        `mutation-${toolName}-stale`,
        `read-${toolName}-fresh`,
        `mutation-${toolName}-fresh`,
      ];
      const result = await runNativeChild({
        traceId: `trace-${toolName}`,
        runId: `run-${toolName}`,
        agentInvocationId: 'child-1',
        agentId: 'teacher-1',
        depth: 1,
        streamFn,
        systemPrompt: 'Use authoritative reads before destructive whiteboard mutations.',
        prompt: `Perform ${toolName} and explain the verified result.`,
        tools: [read.tool, mutation.tool],
        allowedToolNames: new Set(['wb_read', toolName]),
        clientQueryHandlers: new Map([['wb_read', read.handler]]),
        clientEffectHandlers: new Map([[toolName, mutation.handler]]),
        toolCategories: new Map([
          ['wb_read', 'read'],
          [toolName, 'mutation'],
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
      expect(result).toMatchObject({
        status: 'completed',
        finalOutput: `${toolName} completed and the same Child continued.`,
        toolBudgetUsage: {
          mutationExecutions: 2,
          readExecutions: 2,
          otherToolExecutions: 0,
          toolCallAttempts: 4,
        },
      });
      expect(result.toolExecutions.map(({ status }) => status)).toEqual([
        'succeeded',
        'execution_failed',
        'succeeded',
        'succeeded',
      ]);
      expect(events.map(({ type }) => type)).toEqual([
        'client_query',
        'revisioned_client_effect',
        'client_query',
        'revisioned_client_effect',
      ]);
      expect(onActionDone).toHaveBeenCalledTimes(1);
      expect(authority.querySnapshot()).toMatchObject({
        ok: true,
        value: { revision: before.value.revision + 2, open: true },
      });
      expect(useStageStore.getState().stage?.whiteboard?.[0].elements).toHaveLength(
        toolName === 'wb_delete' ? 1 : 0,
      );
      expect(useWhiteboardHistoryStore.getState().snapshots).toHaveLength(
        toolName === 'wb_clear' ? 1 : 0,
      );
    },
  );
});
