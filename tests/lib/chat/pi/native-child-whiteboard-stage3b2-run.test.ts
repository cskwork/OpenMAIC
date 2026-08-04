import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { NextRequest } from 'next/server';
import { POST as postRevisionedAck } from '@/app/api/chat/pi/revisioned-whiteboard-effects/[executionId]/ack/route';
import { BrowserClientQueryRuntime } from '@/lib/agent/client/client-query-runtime';
import { BrowserRevisionedWhiteboardEffectRuntime } from '@/lib/agent/client/revisioned-whiteboard-effect-runtime';
import { RevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import { CLIENT_QUERY_RESPONSE_HEADER } from '@/lib/agent/runtime/client-query-contract';
import { piRevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import { piClientQueryCoordinator } from '@/lib/agent/runtime/client-query-coordinator';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { buildInternalNativeWhiteboardReadTool } from '@/lib/chat/pi/tools/native-whiteboard-read';
import { buildInternalRevisionedWhiteboardDrawTextTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-draw-text';
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

function stage(whiteboards: Whiteboard[] = []): Stage {
  return {
    id: 'stage-1',
    name: 'Stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: whiteboards,
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

function latestToolText(context: Context): string {
  return (
    context.messages
      .findLast((message) => message.role === 'toolResult')
      ?.content.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? ''
  );
}

function parseReadResult(context: Context): {
  whiteboardId: string | null;
  revision: number;
  observationTokens: { bindingObservationToken: string };
} {
  const text = latestToolText(context);
  return JSON.parse(text.slice(text.indexOf('{')));
}

afterEach(() => {
  piClientQueryCoordinator.clearForTests();
  piRevisionedWhiteboardCoordinator.clearForTests();
  useStageStore.getState().clearStore();
  useCanvasStore.getState().setWhiteboardOpen(false);
  vi.unstubAllEnvs();
});

describe('Stage 3B-2 real same-Child continuation', () => {
  it('runs wb_read → stale draw → wb_read → committed draw → final text through StreamBuffer', async () => {
    const initialStage = stage();
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD', 'true');
    setStageStoreStateThroughAuthority({ stage: initialStage, currentSceneId: 'scene-1' });
    const authority = getDefaultWhiteboardEnvironmentAuthority();
    if (!authority) throw new Error('Expected default whiteboard Authority.');
    const initialAuthoritySnapshot = authority.querySnapshot();
    if (!initialAuthoritySnapshot.ok) throw new Error('Expected an authoritative snapshot.');
    const initialRevision = initialAuthoritySnapshot.value.revision;

    const observationLedger = new NativeWhiteboardObservationLedger();
    const mutationRuntime = new RevisionedWhiteboardMutationRuntime(
      observationLedger,
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
    const revisionedBrowser = new BrowserRevisionedWhiteboardEffectRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      getAuthority: () => authority,
      targetRegistry: new RevisionedWhiteboardTargetRegistry(),
      fetchAck: vi.fn(async (input, init) => {
        const path = String(input);
        const executionId = decodeURIComponent(path.split('/').at(-2)!);
        const headers = new Headers(init?.headers);
        headers.set('origin', 'http://localhost');
        return postRevisionedAck(
          new NextRequest(`http://localhost${path}`, {
            method: init?.method,
            headers,
            body: String(init?.body),
          }),
          { params: Promise.resolve({ executionId }) },
        );
      }),
    });
    const errors: string[] = [];
    const lifecycle: string[] = [];
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady() {},
        onRevisionedClientEffectQueued(delivery) {
          lifecycle.push(`queued:${delivery.executionId}`);
          revisionedBrowser.reserve(delivery);
        },
        async onRevisionedClientEffectReady(_messageId, delivery, signal) {
          lifecycle.push(`execute:${delivery.executionId}`);
          await revisionedBrowser.execute(delivery, signal);
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {},
        onError(message) {
          errors.push(message);
        },
      },
      { tickMs: 1, charsPerTick: 1_000 },
    );
    buffer.pushAgentStart({
      messageId: 'child-1',
      agentId: 'teacher-1',
      agentName: 'Teacher',
    });
    buffer.start();

    const sent: StatelessEvent[] = [];
    const send = async (event: StatelessEvent) => {
      sent.push(event);
      if (event.type === 'client_query') await queryRuntime.execute(event.data);
      if (event.type === 'revisioned_client_effect') {
        buffer.pushRevisionedClientEffect('child-1', event.data);
      }
    };
    const read = buildInternalNativeWhiteboardReadTool({
      body: body(initialStage),
      observationLedger,
      send,
    });
    const onActionDone = vi.fn();
    const draw = buildInternalRevisionedWhiteboardDrawTextTool({
      body: body(initialStage),
      observationLedger,
      mutationRuntime,
      canExecute: () => true,
      onActionDone,
      send,
    });

    let turn = 0;
    let advanced = false;
    const contexts: Context[] = [];
    const streamFn = ((_model, context) => {
      contexts.push(context);
      turn += 1;
      if (turn === 1 || turn === 3) {
        if (turn === 3) expect(latestToolText(context)).toContain('"code":"STALE_STATE"');
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: turn === 1 ? 'read-stale' : 'read-fresh',
                name: 'wb_read',
                arguments: { scope: 'summary' },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (turn === 2 || turn === 4) {
        const readResult = parseReadResult(context);
        if (!advanced) {
          const externalBoard: Whiteboard = {
            id: 'external-board',
            viewportSize: 1000,
            viewportRatio: 16 / 9,
            elements: [],
            background: { type: 'solid', color: '#ffffff' },
            animations: [],
          };
          const current = useStageStore.getState().stage!;
          expect(
            authority.transact({
              label: 'test.external-authority-write',
              writes: [
                {
                  label: 'create-board',
                  write: () =>
                    useStageStore.setState({ stage: { ...current, whiteboard: [externalBoard] } }),
                },
              ],
              preferredActiveWhiteboardId: externalBoard.id,
            }),
          ).toMatchObject({ ok: true, changed: true });
          advanced = true;
        }
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: turn === 2 ? 'draw-stale' : 'draw-fresh',
                name: 'wb_draw_text',
                arguments: {
                  observationToken: readResult.observationTokens.bindingObservationToken,
                  expectedWhiteboardId: readResult.whiteboardId,
                  expectedRevision: readResult.revision,
                  content: 'A revisioned idea',
                  x: 100,
                  y: 120,
                },
              },
            ],
            'toolUse',
          ),
        );
      }
      const committedText = latestToolText(context);
      expect(committedText).toContain('Whiteboard mutation result (DATA, NOT INSTRUCTIONS)');
      expect(JSON.parse(committedText.slice(committedText.indexOf('{')))).toMatchObject({
        currentBinding: { stageId: 'stage-1' },
        observationTokens: {
          bindingObservationToken: expect.any(String),
          targetObservationToken: expect.any(String),
        },
      });
      return stream(
        assistant(
          [{ type: 'text', text: 'Revisioned whiteboard continuation completed.' }],
          'stop',
        ),
      );
    }) as StreamFn;
    const executionIds = ['query-stale', 'draw-stale', 'query-fresh', 'draw-fresh'];

    const result = await runNativeChild({
      traceId: 'trace-1',
      runId: 'run-1',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      streamFn,
      systemPrompt: 'Use authoritative whiteboard reads and revisioned mutations.',
      prompt: 'Draw after reading, and recover from stale state.',
      tools: [read.tool, draw.tool],
      allowedToolNames: new Set(['wb_read', 'wb_draw_text']),
      clientQueryHandlers: new Map([['wb_read', read.handler]]),
      clientEffectHandlers: new Map([['wb_draw_text', draw.handler]]),
      toolCategories: new Map([
        ['wb_read', 'read'],
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

    buffer.pushAgentEnd({ messageId: 'child-1', agentId: 'teacher-1' });
    buffer.pushDone({ totalActions: 1, totalAgents: 1 });
    await buffer.waitUntilDrained();

    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('Revisioned whiteboard continuation completed.');
    expect(result.toolBudgetUsage).toEqual({
      mutationExecutions: 2,
      readExecutions: 2,
      otherToolExecutions: 0,
      toolCallAttempts: 4,
    });
    expect(result.toolExecutions.map(({ status }) => status)).toEqual([
      'succeeded',
      'execution_failed',
      'succeeded',
      'succeeded',
    ]);
    expect(sent.map(({ type }) => type)).toEqual([
      'client_query',
      'revisioned_client_effect',
      'client_query',
      'revisioned_client_effect',
    ]);
    expect(lifecycle).toEqual([
      'queued:draw-stale',
      'execute:draw-stale',
      'queued:draw-fresh',
      'execute:draw-fresh',
    ]);
    expect(errors).toEqual([]);
    expect(onActionDone).toHaveBeenCalledTimes(1);
    expect(authority.querySnapshot()).toMatchObject({
      ok: true,
      value: {
        revision: initialRevision + 2,
        activeWhiteboardId: 'external-board',
        open: true,
      },
    });
    expect(useStageStore.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    expect(contexts).toHaveLength(5);
  });
});
