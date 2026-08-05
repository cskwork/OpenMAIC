import { describe, expect, it, vi } from 'vitest';
import { createRevisionedWhiteboardAcceptedAck } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type {
  ClientEffectExecutionRequest,
  NativeClientEffectHandler,
} from '@/lib/agent/runtime/native-child-contract';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { buildInternalRevisionedWhiteboardDrawCodeTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-code';
import { buildInternalRevisionedWhiteboardClearTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-destructive';
import { buildInternalRevisionedWhiteboardDrawTextTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-draw-text';
import { buildInternalRevisionedWhiteboardOpenTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-lifecycle';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import type { SendEvent } from '@/lib/chat/pi/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { Stage } from '@/lib/types/stage';

const toolCases = [
  {
    family: 'draw',
    toolName: 'wb_draw_text',
    coverage: { kind: 'binding' } as const,
    params: {
      content: 'Abort-safe text',
      x: 100,
      y: 120,
    },
  },
  {
    family: 'lifecycle',
    toolName: 'wb_open',
    coverage: { kind: 'binding' } as const,
    params: {},
  },
  {
    family: 'code',
    toolName: 'wb_draw_code',
    coverage: { kind: 'binding' } as const,
    params: {
      language: 'typescript',
      code: 'const value = 1;',
      x: 80,
      y: 60,
    },
  },
  {
    family: 'destructive',
    toolName: 'wb_clear',
    coverage: { kind: 'membership', complete: true } as const,
    params: {},
  },
] as const;

function stage(): Stage {
  return {
    id: 'stage-1',
    name: 'Stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: [],
  };
}

function body(): StatelessChatRequest {
  return {
    messages: [],
    config: {
      agentIds: ['teacher-1'],
      piSessionId: 'session-1',
      piRequestId: 'request-1',
    },
    storeState: {
      stage: stage(),
      scenes: [],
      outlines: [],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    apiKey: 'test-only',
  } as StatelessChatRequest;
}

function execution(toolName: string, executionId: string): ClientEffectExecutionRequest {
  const now = Date.now();
  return {
    protocolVersion: 'maic.tool-execution.v1',
    kind: 'client_effect',
    traceId: 'trace-1',
    runId: 'run-1',
    agentInvocationId: 'child-1',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: `tool-${executionId}`,
    executionId,
    idempotencyKey: `idem-${executionId}`,
    toolName,
    args: {},
    argsDigest: 'sha256:test',
    issuedAt: now,
    deadlineAt: now + 10_000,
    attempt: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(input: {
  toolName: string;
  coverage: (typeof toolCases)[number]['coverage'];
}) {
  const ledger = new NativeWhiteboardObservationLedger();
  const coordinator = new RevisionedWhiteboardCoordinator();
  const mutationRuntime = new RevisionedWhiteboardMutationRuntime(ledger, coordinator);
  const deliveryWait = deferred();
  const events: StatelessEvent[] = [];
  const send = vi.fn<SendEvent>(async (event) => {
    events.push(event);
    await deliveryWait.promise;
  });
  const onActionDone = vi.fn();
  const options = {
    body: body(),
    observationLedger: ledger,
    mutationRuntime,
    canExecute: () => true,
    onActionDone,
    send,
  };
  let handler: NativeClientEffectHandler;
  switch (input.toolName) {
    case 'wb_draw_text':
      handler = buildInternalRevisionedWhiteboardDrawTextTool(options).handler;
      break;
    case 'wb_open':
      handler = buildInternalRevisionedWhiteboardOpenTool(options).handler;
      break;
    case 'wb_draw_code':
      handler = buildInternalRevisionedWhiteboardDrawCodeTool(options).handler;
      break;
    case 'wb_clear':
      handler = buildInternalRevisionedWhiteboardClearTool(options).handler;
      break;
    default:
      throw new Error('Unexpected tool case.');
  }
  const observationToken = ledger.mintFromRead({
    childInvocationId: 'child-1',
    requestId: 'request-1',
    stageId: 'stage-1',
    whiteboardId: null,
    revision: 0,
    queryId: `query-${input.toolName}`,
    coverage: input.coverage,
    expiresAt: Date.now() + 10_000,
  });
  return {
    coordinator,
    deliveryWait,
    events,
    handler,
    observationToken,
    onActionDone,
    send,
  };
}

describe('revisioned whiteboard mutation delivery abort closure', () => {
  it.each(toolCases)(
    'settles $family delivery when abort wins while send is pending',
    async ({ toolName, coverage, params }) => {
      const harness = createHarness({ toolName, coverage });
      const controller = new AbortController();
      const executionId = `abort-${toolName}`;
      const resultPromise = harness.handler({
        request: execution(toolName, executionId),
        params: {
          observationToken: harness.observationToken,
          expectedWhiteboardId: null,
          expectedRevision: 0,
          ...params,
        },
        signal: controller.signal,
      });

      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
      controller.abort();
      const result = await resultPromise;

      expect(result).toMatchObject({
        isError: true,
        details: {
          code: 'REVISIONED_WHITEBOARD_DELIVERY_FAILED',
          status: 'rejected',
          mutationMayHaveCommitted: false,
        },
      });
      expect(harness.onActionDone).not.toHaveBeenCalled();
      harness.deliveryWait.resolve();
      await Promise.resolve();
      expect(harness.onActionDone).not.toHaveBeenCalled();
    },
  );

  it('settles an accepted pending delivery as uncertain and charges exactly once', async () => {
    const harness = createHarness({ toolName: 'wb_draw_text', coverage: { kind: 'binding' } });
    const controller = new AbortController();
    const executionId = 'abort-after-accepted';
    const resultPromise = harness.handler({
      request: execution('wb_draw_text', executionId),
      params: {
        observationToken: harness.observationToken,
        expectedWhiteboardId: null,
        expectedRevision: 0,
        content: 'Accepted abort',
        x: 100,
        y: 120,
      },
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(harness.events).toHaveLength(1));
    const event = harness.events[0];
    if (event.type !== 'revisioned_client_effect') throw new Error('Expected delivery.');
    expect(
      harness.coordinator.applyAck(
        event.data.acknowledgementToken,
        createRevisionedWhiteboardAcceptedAck({
          executionId,
          requestDigest: event.data.requestDigest,
          targetBinding: {
            stageId: 'stage-1',
            whiteboardId: null,
            observedRevision: 0,
          },
        }),
      ),
    ).toEqual({ kind: 'applied', status: 'accepted' });

    controller.abort();
    const result = await resultPromise;
    expect(result).toMatchObject({
      isError: true,
      details: {
        code: 'REVISIONED_WHITEBOARD_UNCERTAIN',
        status: 'uncertain',
        mutationMayHaveCommitted: true,
      },
    });
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getTerminal(executionId)).toMatchObject({
      status: 'uncertain',
      actionDisposition: 'consume_once',
    });
    expect(
      harness.coordinator.applyAck(
        event.data.acknowledgementToken,
        createRevisionedWhiteboardAcceptedAck({
          executionId,
          requestDigest: event.data.requestDigest,
          targetBinding: {
            stageId: 'stage-1',
            whiteboardId: null,
            observedRevision: 0,
          },
        }),
      ),
    ).toMatchObject({ kind: 'invalid' });
    harness.deliveryWait.resolve();
    await Promise.resolve();
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it('observes an already-aborted signal before attempting browser delivery', async () => {
    const harness = createHarness({ toolName: 'wb_open', coverage: { kind: 'binding' } });
    const controller = new AbortController();
    controller.abort();

    const result = await harness.handler({
      request: execution('wb_open', 'already-aborted'),
      params: {
        observationToken: harness.observationToken,
        expectedWhiteboardId: null,
        expectedRevision: 0,
      },
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      isError: true,
      details: { code: 'REVISIONED_WHITEBOARD_DELIVERY_FAILED', status: 'rejected' },
    });
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.onActionDone).not.toHaveBeenCalled();
    harness.deliveryWait.resolve();
  });

  it('settles a rejected send without waiting for the coordinator deadline', async () => {
    const harness = createHarness({ toolName: 'wb_draw_text', coverage: { kind: 'binding' } });
    harness.send.mockRejectedValueOnce(new Error('simulated send failure'));

    const result = await harness.handler({
      request: execution('wb_draw_text', 'send-rejected'),
      params: {
        observationToken: harness.observationToken,
        expectedWhiteboardId: null,
        expectedRevision: 0,
        content: 'Rejected send',
        x: 100,
        y: 120,
      },
    });

    expect(result).toMatchObject({
      isError: true,
      details: { code: 'REVISIONED_WHITEBOARD_DELIVERY_FAILED', status: 'rejected' },
    });
    expect(harness.onActionDone).not.toHaveBeenCalled();
    harness.deliveryWait.resolve();
  });
});
