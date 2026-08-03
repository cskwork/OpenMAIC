import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { NextRequest } from 'next/server';
import { DELETE as reportClientQueryDeliveryFailure } from '@/app/api/chat/pi/client-queries/[queryId]/response/route';
import { handlePiClientQueryDelivery } from '@/components/chat/use-chat-sessions';
import { BrowserClientQueryRuntime } from '@/lib/agent/client/client-query-runtime';
import {
  CLIENT_QUERY_RESPONSE_HEADER,
  type ClientQueryBrowserOutcome,
} from '@/lib/agent/runtime/client-query-contract';
import { piClientQueryCoordinator } from '@/lib/agent/runtime/client-query-coordinator';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';
import type { ClientQueryExecutionRequest } from '@/lib/agent/runtime/native-child-contract';
import { buildInternalNativeWhiteboardReadTool } from '@/lib/chat/pi/tools/native-whiteboard-read';
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

function stage(): Stage {
  const whiteboard: Whiteboard = {
    id: 'board-1',
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements: [
      {
        id: 'text-1',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: 'first',
        defaultFontName: 'Arial',
        defaultColor: '#000',
      },
      {
        id: 'text-2',
        type: 'text',
        left: 0,
        top: 50,
        width: 100,
        height: 40,
        rotate: 0,
        content: 'second',
        defaultFontName: 'Arial',
        defaultColor: '#000',
      },
    ],
  };
  return {
    id: 'stage-1',
    name: 'Stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: [whiteboard],
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

function latestToolText(context: Context): string | undefined {
  return context.messages
    .findLast((message) => message.role === 'toolResult')
    ?.content.filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function execution(executionId: string): ClientQueryExecutionRequest {
  const now = Date.now();
  return {
    protocolVersion: 'maic.tool-execution.v1',
    kind: 'client_query',
    traceId: 'trace-1',
    runId: 'run-1',
    agentInvocationId: 'child-1',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: `tool-${executionId}`,
    executionId,
    idempotencyKey: `idem-${executionId}`,
    toolName: 'wb_read',
    args: {},
    argsDigest: 'sha256:test',
    issuedAt: now,
    deadlineAt: now + 10_000,
    attempt: 1,
  };
}

function runtimeForCurrentStage() {
  return new BrowserClientQueryRuntime({
    requestId: 'request-1',
    sessionId: 'session-1',
    readCurrentStageId: () => useStageStore.getState().stage?.id,
    readCurrentSceneId: () => useStageStore.getState().currentSceneId,
    fetchResponse: vi.fn(async (input, init) => {
      const queryId = decodeURIComponent(String(input).split('/').at(-2)!);
      const token = new Headers(init?.headers).get(CLIENT_QUERY_RESPONSE_HEADER)!;
      const rawBody = String(init?.body);
      const outcome = JSON.parse(rawBody) as ClientQueryBrowserOutcome;
      const result = piClientQueryCoordinator.respond(queryId, token, rawBody, outcome);
      return new Response('{}', { status: result.kind === 'invalid' ? 409 : 200 });
    }),
    now: () => 100,
  });
}

afterEach(() => {
  piClientQueryCoordinator.clearForTests();
  useStageStore.getState().clearStore();
  vi.unstubAllEnvs();
});

describe('internal Native Child wb_read', () => {
  it('uses client_query, paginates linearly and continues in the same Child', async () => {
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    const sent: StatelessEvent[] = [];
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      createCapability: (() => {
        let value = 0;
        return () => `capability-${++value}`;
      })(),
      send: async (event) => {
        sent.push(event);
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });
    const contexts: Context[] = [];
    let turn = 0;
    const streamFn = ((_model, context) => {
      contexts.push(context);
      turn += 1;
      if (turn === 1) {
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: 'read-page-1',
                name: 'wb_read',
                arguments: { scope: 'elements', limit: 1 },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (turn === 2) {
        const text = latestToolText(context)!;
        const first = JSON.parse(text.slice(text.indexOf('{'))) as { nextCursor: string };
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: 'read-page-2',
                name: 'wb_read',
                arguments: { scope: 'elements', cursor: first.nextCursor },
              },
            ],
            'toolUse',
          ),
        );
      }
      return stream(assistant([{ type: 'text', text: 'Fresh whiteboard state read.' }], 'stop'));
    }) as StreamFn;
    let execution = 0;

    const result = await runNativeChild({
      traceId: 'trace-1',
      runId: 'run-1',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      streamFn,
      systemPrompt: 'Test authoritative whiteboard reads.',
      prompt: 'Read every current element.',
      tools: [bundle.tool],
      allowedToolNames: new Set(['wb_read']),
      clientQueryHandlers: new Map([['wb_read', bundle.handler]]),
      toolCategories: new Map([['wb_read', 'read']]),
      toolBudgets: {
        maxMutationExecutions: 2,
        maxReadExecutions: 8,
        maxOtherToolExecutions: 2,
        maxToolCallAttempts: 12,
      },
      timeoutMs: 5_000,
      createExecutionId: () => `query-${++execution}`,
      onSettled: bundle.dispose,
    });

    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('Fresh whiteboard state read.');
    expect(result.toolBudgetUsage).toEqual({
      mutationExecutions: 0,
      readExecutions: 2,
      otherToolExecutions: 0,
      toolCallAttempts: 2,
    });
    expect(result.toolExecutions).toHaveLength(2);
    expect(result.toolExecutions.every((entry) => entry.request.kind === 'client_query')).toBe(
      true,
    );
    expect(sent.map((event) => event.type)).toEqual(['client_query', 'client_query']);
    expect(latestToolText(contexts[2])!).toContain('"complete":true');
    expect(bundle.getClaimCountsForTests()).toEqual({ cursors: 0, observations: 0 });
  });

  it('canonicalizes an omitted elements limit to 64 before browser delivery', async () => {
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    const sent: StatelessEvent[] = [];
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        sent.push(event);
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });

    const result = await bundle.handler({
      request: execution('query-default-limit'),
      params: { scope: 'elements' },
    });

    expect(result.isError).toBe(false);
    expect(sent[0]).toMatchObject({
      type: 'client_query',
      data: { request: { query: { scope: 'elements', startIndex: 0, limit: 64 } } },
    });
    bundle.dispose('child-1');
  });

  it('returns an authenticated browser failure to the same Child without minting claims', async () => {
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-other' });
    const runtime = runtimeForCurrentStage();
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });

    const result = await bundle.handler({
      request: execution('query-target-failure'),
      params: { scope: 'summary' },
    });

    expect(result).toMatchObject({
      isError: true,
      details: { code: 'WHITEBOARD_QUERY_TARGET_CHANGED' },
    });
    expect(bundle.getClaimCountsForTests()).toEqual({ cursors: 0, observations: 0 });
    bundle.dispose('child-1');
  });

  it('fails a changed revision and keeps its delivered continuation cursor single-use', async () => {
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });
    const first = await bundle.handler({
      request: execution('query-stale-1'),
      params: { scope: 'elements', limit: 1 },
    });
    const cursor = (first.details as { nextCursor: string }).nextCursor;
    const changed = stage();
    changed.whiteboard![0].elements.push({
      id: 'text-3',
      type: 'text',
      left: 0,
      top: 100,
      width: 100,
      height: 40,
      rotate: 0,
      content: 'third',
      defaultFontName: 'Arial',
      defaultColor: '#000',
    });
    setStageStoreStateThroughAuthority({ stage: changed, currentSceneId: 'scene-1' });

    const stale = await bundle.handler({
      request: execution('query-stale-2'),
      params: { scope: 'elements', cursor },
    });
    const reused = await bundle.handler({
      request: execution('query-stale-3'),
      params: { scope: 'elements', cursor },
    });

    expect(stale).toMatchObject({ isError: true, details: { code: 'STALE_CURSOR' } });
    expect(reused).toMatchObject({
      isError: true,
      details: { code: 'CURSOR_ALREADY_CONSUMED' },
    });
    bundle.dispose('child-1');
  });

  it('does not roll back a continuation cursor after an uncertain SSE delivery failure', async () => {
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    let deliveryCount = 0;
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        deliveryCount += 1;
        if (deliveryCount === 2) throw new Error('uncertain delivery');
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });
    const first = await bundle.handler({
      request: execution('query-delivery-1'),
      params: { scope: 'elements', limit: 1 },
    });
    const cursor = (first.details as { nextCursor: string }).nextCursor;

    const failed = await bundle.handler({
      request: execution('query-delivery-2'),
      params: { scope: 'elements', cursor },
    });
    const reused = await bundle.handler({
      request: execution('query-delivery-3'),
      params: { scope: 'elements', cursor },
    });

    expect(failed).toMatchObject({
      isError: true,
      details: { code: 'CLIENT_QUERY_DELIVERY_FAILED' },
    });
    expect(reused).toMatchObject({
      isError: true,
      details: { code: 'CURSOR_ALREADY_CONSUMED' },
    });
    bundle.dispose('child-1');
  });

  it('validates and atomically consumes observation claims across identity, revision and coverage', async () => {
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });
    const read = await bundle.handler({
      request: execution('query-capability'),
      params: { scope: 'summary' },
    });
    const details = read.details as {
      whiteboardId: string | null;
      revision: number;
      observationTokens: { bindingObservationToken: string };
    };
    const base = {
      token: details.observationTokens.bindingObservationToken,
      childInvocationId: 'child-1',
      requestId: 'request-1',
      stageId: 'stage-1',
      whiteboardId: details.whiteboardId,
      revision: details.revision,
      requiredCoverage: { kind: 'binding' as const },
    };

    expect(bundle.consumeObservationClaim({ ...base, childInvocationId: 'child-other' })).toEqual({
      ok: false,
      code: 'OBSERVATION_CAPABILITY_INVALID',
    });
    expect(bundle.consumeObservationClaim({ ...base, requestId: 'request-other' })).toEqual({
      ok: false,
      code: 'OBSERVATION_CAPABILITY_INVALID',
    });
    expect(bundle.consumeObservationClaim({ ...base, stageId: 'stage-other' })).toEqual({
      ok: false,
      code: 'OBSERVATION_CAPABILITY_INVALID',
    });
    expect(bundle.consumeObservationClaim({ ...base, whiteboardId: 'board-other' })).toEqual({
      ok: false,
      code: 'OBSERVATION_CAPABILITY_STALE',
    });
    expect(bundle.consumeObservationClaim({ ...base, revision: details.revision + 1 })).toEqual({
      ok: false,
      code: 'OBSERVATION_CAPABILITY_STALE',
    });
    expect(
      bundle.consumeObservationClaim({
        ...base,
        requiredCoverage: { kind: 'element', elementId: 'text-1' },
      }),
    ).toEqual({ ok: false, code: 'OBSERVATION_COVERAGE_MISMATCH' });
    expect(bundle.consumeObservationClaim(base)).toEqual({ ok: true });
    expect(bundle.consumeObservationClaim(base)).toEqual({
      ok: false,
      code: 'OBSERVATION_CAPABILITY_INVALID',
    });
    bundle.dispose('child-1');
  });

  it('escapes Unicode line separators only in model-visible JSON projection', async () => {
    const currentStage = stage();
    const text = currentStage.whiteboard![0].elements[0];
    if (text.type !== 'text') throw new Error('Expected text fixture.');
    text.content = 'before\u2028middle\u2029after';
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });

    const read = await bundle.handler({
      request: execution('query-separators'),
      params: { scope: 'elements', limit: 64 },
    });
    const visible = read.content[0]?.type === 'text' ? read.content[0].text : '';
    const projected = visible.slice(visible.indexOf('{'));

    expect(visible).not.toContain('\u2028');
    expect(visible).not.toContain('\u2029');
    expect(visible).toContain('\\u2028');
    expect(visible).toContain('\\u2029');
    expect(JSON.parse(projected)).toEqual(read.details);
    expect(JSON.stringify(read.details)).toContain('before\u2028middle\u2029after');
    bundle.dispose('child-1');
  });

  it('returns a reportable browser delivery failure to the same Child and continues', async () => {
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD', 'true');
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    let postAttempts = 0;
    const fetchResponse = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method !== 'DELETE') {
        postAttempts += 1;
        if (postAttempts === 1) throw new Error('response lost');
        return new Response('{}', { status: 503 });
      }
      const headers = new Headers(init.headers);
      headers.set('origin', 'http://localhost');
      return reportClientQueryDeliveryFailure(
        new NextRequest(`http://localhost${String(input)}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ queryId: 'delivery-failure-query' }) },
      );
    });
    const runtime = new BrowserClientQueryRuntime({
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => useStageStore.getState().stage?.id,
      readCurrentSceneId: () => useStageStore.getState().currentSceneId,
      fetchResponse,
    });
    const controller = new AbortController();
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        if (event.type === 'client_query') {
          await handlePiClientQueryDelivery(runtime, event.data, controller);
        }
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
                id: 'read-delivery-failure',
                name: 'wb_read',
                arguments: { scope: 'summary' },
              },
            ],
            'toolUse',
          ),
        );
      }
      expect(latestToolText(context)).toContain('Whiteboard read failed.');
      return stream(
        assistant(
          [{ type: 'text', text: 'I received the delivery failure and continued.' }],
          'stop',
        ),
      );
    }) as StreamFn;

    const result = await runNativeChild({
      traceId: 'trace-delivery-failure',
      runId: 'run-delivery-failure',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      streamFn,
      systemPrompt: 'Use the internal read tool.',
      prompt: 'Read and continue after a structured failure.',
      tools: [bundle.tool],
      allowedToolNames: new Set(['wb_read']),
      clientQueryHandlers: new Map([['wb_read', bundle.handler]]),
      toolCategories: new Map([['wb_read', 'read']]),
      toolBudgets: {
        maxMutationExecutions: 0,
        maxReadExecutions: 1,
        maxOtherToolExecutions: 0,
        maxToolCallAttempts: 2,
      },
      timeoutMs: 5_000,
      createExecutionId: () => 'delivery-failure-query',
      onSettled: bundle.dispose,
    });

    expect(result).toMatchObject({
      status: 'completed',
      finalOutput: 'I received the delivery failure and continued.',
      toolExecutions: [{ status: 'execution_failed' }],
    });
    expect(controller.signal.aborted).toBe(false);
    expect(fetchResponse.mock.calls.map(([, init]) => init?.method)).toEqual([
      'POST',
      'POST',
      'DELETE',
    ]);
  });

  it('supports the bounded web-search, read, stale-mutation, refetch and retry Gate', async () => {
    const currentStage = stage();
    setStageStoreStateThroughAuthority({ stage: currentStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(currentStage),
      send: async (event) => {
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });
    const webSearch: AgentTool = {
      name: 'web_search',
      label: 'Web search',
      description: 'Return fixed external evidence.',
      parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      execute: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'official evidence' }],
        details: { sources: [{ url: 'https://example.edu/evidence' }] },
      })),
    };
    const MutationParams = Type.Object(
      { bindingObservationToken: Type.String() },
      { additionalProperties: false },
    );
    const mutationCalls: string[] = [];
    const capabilityResults: Array<{ ok: boolean; code?: string }> = [];
    const mutation: AgentTool<typeof MutationParams> = {
      name: 'test_revisioned_mutation',
      label: 'Test revisioned mutation',
      description: 'Exercise Stage 2 stale recovery without public mutation cutover.',
      parameters: MutationParams,
      execute: vi.fn(async (_toolCallId, params) => {
        mutationCalls.push(params.bindingObservationToken);
        const current = getDefaultWhiteboardEnvironmentAuthority()?.queryActiveWhiteboard();
        if (!current?.ok || !current.snapshot.stageId) {
          throw new Error('Expected current whiteboard Authority state.');
        }
        const capability = bundle.consumeObservationClaim({
          token: params.bindingObservationToken,
          childInvocationId: 'child-1',
          requestId: 'request-1',
          stageId: current.snapshot.stageId,
          whiteboardId: current.snapshot.activeWhiteboardId,
          revision: current.snapshot.revision,
          requiredCoverage: { kind: 'binding' },
        });
        capabilityResults.push(capability);
        if (!capability.ok) {
          return {
            content: [{ type: 'text' as const, text: 'STALE_STATE; read again.' }],
            details: { code: 'STALE_STATE', capabilityCode: capability.code },
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: 'mutation committed' }],
          details: { status: 'effect_committed' },
          isError: false,
        };
      }),
    };
    let turn = 0;
    let firstObservationToken = '';
    const streamFn = ((_model, context) => {
      turn += 1;
      if (turn === 1) {
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: 'search-1',
                name: 'web_search',
                arguments: { query: 'current evidence' },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (turn === 2 || turn === 4) {
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: `read-${turn}`,
                name: 'wb_read',
                arguments: { scope: 'summary' },
              },
            ],
            'toolUse',
          ),
        );
      }
      if (turn === 3 || turn === 5) {
        const text = latestToolText(context)!;
        const readResult = JSON.parse(text.slice(text.indexOf('{'))) as {
          observationTokens: { bindingObservationToken: string };
        };
        const token = readResult.observationTokens.bindingObservationToken;
        if (turn === 3) {
          firstObservationToken = token;
          const before = getDefaultWhiteboardEnvironmentAuthority()?.queryActiveWhiteboard();
          useCanvasStore.getState().setWhiteboardOpen(true);
          const after = getDefaultWhiteboardEnvironmentAuthority()?.queryActiveWhiteboard();
          if (!before?.ok || !after?.ok || after.snapshot.revision <= before.snapshot.revision) {
            throw new Error('Expected Authority revision change.');
          }
        }
        return stream(
          assistant(
            [
              {
                type: 'toolCall',
                id: `mutation-${turn}`,
                name: 'test_revisioned_mutation',
                arguments: { bindingObservationToken: token },
              },
            ],
            'toolUse',
          ),
        );
      }
      return stream(
        assistant([{ type: 'text', text: 'Recovered with fresh whiteboard evidence.' }], 'stop'),
      );
    }) as StreamFn;
    let executionSequence = 0;

    const result = await runNativeChild({
      traceId: 'trace-mixed-gate',
      runId: 'run-mixed-gate',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      streamFn,
      systemPrompt: 'Use only the registered test tools.',
      prompt: 'Complete the fixed mixed-tool recovery chain.',
      tools: [webSearch, bundle.tool, mutation],
      allowedToolNames: new Set(['web_search', 'wb_read', 'test_revisioned_mutation']),
      clientQueryHandlers: new Map([['wb_read', bundle.handler]]),
      toolCategories: new Map([
        ['web_search', 'other'],
        ['wb_read', 'read'],
        ['test_revisioned_mutation', 'mutation'],
      ]),
      toolBudgets: {
        maxMutationExecutions: 2,
        maxReadExecutions: 8,
        maxOtherToolExecutions: 2,
        maxToolCallAttempts: 12,
      },
      timeoutMs: 5_000,
      createExecutionId: () => `mixed-execution-${++executionSequence}`,
      onSettled: bundle.dispose,
    });

    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('Recovered with fresh whiteboard evidence.');
    expect(result.toolBudgetUsage).toEqual({
      mutationExecutions: 2,
      readExecutions: 2,
      otherToolExecutions: 1,
      toolCallAttempts: 5,
    });
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls[0]).toBe(firstObservationToken);
    expect(mutationCalls[1]).not.toBe(firstObservationToken);
    expect(capabilityResults).toEqual([
      { ok: false, code: 'OBSERVATION_CAPABILITY_STALE' },
      { ok: true },
    ]);
    expect(result.toolExecutions.map((entry) => entry.status)).toEqual([
      'succeeded',
      'succeeded',
      'execution_failed',
      'succeeded',
      'succeeded',
    ]);
    expect(bundle.getClaimCountsForTests()).toEqual({ cursors: 0, observations: 0 });
  });

  it('round-trips a 16,384-unit code line across a linear eight-read chain', async () => {
    const content = 'x'.repeat(16_384);
    const codeStage = stage();
    codeStage.whiteboard![0].elements = [
      {
        id: 'code-1',
        type: 'code',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        language: 'typescript',
        fileName: 'example.ts',
        lines: [{ id: 'line-1', content }],
      },
    ];
    setStageStoreStateThroughAuthority({ stage: codeStage, currentSceneId: 'scene-1' });
    const runtime = runtimeForCurrentStage();
    const bundle = buildInternalNativeWhiteboardReadTool({
      body: body(codeStage),
      send: async (event) => {
        if (event.type === 'client_query') await runtime.execute(event.data);
      },
    });
    let cursor: string | undefined;
    let reconstructed = '';
    let finalResult: Record<string, unknown> | undefined;

    for (let page = 1; page <= 8; page += 1) {
      const result = await bundle.handler({
        request: execution(`query-code-${page}`),
        params: cursor ? { scope: 'code', cursor } : { scope: 'code', elementId: 'code-1' },
      });
      expect(result.isError).toBe(false);
      const details = result.details as {
        complete: boolean;
        nextCursor?: string;
        observationTokens: { codeObservationToken?: string };
        data: { fragments: Array<{ content: string }> };
      };
      reconstructed += details.data.fragments.map((fragment) => fragment.content).join('');
      if (page < 8) {
        expect(details.complete).toBe(false);
        expect(details.observationTokens.codeObservationToken).toBeUndefined();
        cursor = details.nextCursor;
      } else {
        expect(details.complete).toBe(true);
        expect(details.nextCursor).toBeUndefined();
        expect(details.observationTokens.codeObservationToken).toBeTruthy();
        finalResult = details as unknown as Record<string, unknown>;
      }
    }

    expect(reconstructed).toBe(content);
    expect(finalResult).toBeDefined();
    bundle.dispose('child-1');
  });
});
