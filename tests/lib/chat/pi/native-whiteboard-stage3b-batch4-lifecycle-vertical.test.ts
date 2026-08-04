import { describe, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import { createStore } from 'zustand/vanilla';
import { BrowserRevisionedWhiteboardEffectRuntime } from '@/lib/agent/client/revisioned-whiteboard-effect-runtime';
import { RevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import { REVISIONED_WHITEBOARD_ACK_HEADER } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import { deriveRevisionedWhiteboardId } from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import type { ClientEffectExecutionRequest } from '@/lib/agent/runtime/native-child-contract';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { buildInternalRevisionedWhiteboardDrawTextTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-draw-text';
import {
  buildInternalRevisionedWhiteboardCloseTool,
  buildInternalRevisionedWhiteboardOpenTool,
} from '@/lib/chat/pi/tools/native-whiteboard-v2-lifecycle';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

type ToolName = 'wb_open' | 'wb_close' | 'wb_draw_text';

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

function stage(whiteboards: Whiteboard[], id = 'stage-1'): Stage {
  return {
    id,
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
      whiteboardOpen: true,
    },
    apiKey: 'test-only',
  } as StatelessChatRequest;
}

function execution(toolName: ToolName, executionId: string): ClientEffectExecutionRequest {
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

function createHarness(input: {
  withBoard: boolean;
  open: boolean;
  ledger?: NativeWhiteboardObservationLedger;
  afterAccepted?: () => void;
  canExecute?: () => boolean;
}) {
  let open = input.open;
  const initialStage = stage(input.withBoard ? [board()] : []);
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: initialStage }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  const coordinator = new RevisionedWhiteboardCoordinator();
  const ledger = input.ledger ?? new NativeWhiteboardObservationLedger();
  const registry = new RevisionedWhiteboardTargetRegistry();
  const browser = new BrowserRevisionedWhiteboardEffectRuntime({
    requestId: 'request-1',
    sessionId: 'session-1',
    readCurrentStageId: () => store.getState().stage?.id,
    readCurrentSceneId: () => 'scene-1',
    getAuthority: () => authority,
    targetRegistry: registry,
    fetchAck: vi.fn(async (_input, init) => {
      const token = new Headers(init?.headers).get(REVISIONED_WHITEBOARD_ACK_HEADER)!;
      const ack = JSON.parse(String(init?.body));
      const applied = coordinator.applyAck(token, ack);
      if (ack.status === 'accepted' && applied.kind === 'applied') input.afterAccepted?.();
      return new Response('{}', {
        status: applied.kind === 'applied' || applied.kind === 'duplicate' ? 200 : 409,
      });
    }),
  });
  const mutationRuntime = new RevisionedWhiteboardMutationRuntime(ledger, coordinator);
  const events: StatelessEvent[] = [];
  const onActionDone = vi.fn();
  const common = {
    body: body(initialStage),
    observationLedger: ledger,
    mutationRuntime,
    canExecute: input.canExecute ?? (() => true),
    onActionDone,
    send: async (event: StatelessEvent) => {
      events.push(event);
      if (event.type === 'revisioned_client_effect') await browser.execute(event.data);
    },
  };
  const lifecycleOptions = {
    ...common,
    onActionDone: vi.fn((details) => onActionDone(details)),
  };
  const drawOptions = {
    ...common,
    onActionDone: vi.fn((details) => onActionDone(details)),
  };
  const openTool = buildInternalRevisionedWhiteboardOpenTool(lifecycleOptions);
  const closeTool = buildInternalRevisionedWhiteboardCloseTool(lifecycleOptions);
  const drawTool = buildInternalRevisionedWhiteboardDrawTextTool(drawOptions);
  const readBinding = () => {
    const snapshot = authority.querySnapshot();
    if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
    return snapshot.value;
  };
  const mintBinding = (queryId: string) => {
    const current = readBinding();
    return ledger.mintFromRead({
      childInvocationId: 'child-1',
      requestId: 'request-1',
      stageId: current.stageId!,
      whiteboardId: current.activeWhiteboardId,
      revision: current.revision,
      queryId,
      coverage: { kind: 'binding' },
      expiresAt: Date.now() + 10_000,
    });
  };
  return {
    authority,
    store,
    ledger,
    events,
    onActionDone,
    openTool,
    closeTool,
    drawTool,
    readBinding,
    mintBinding,
    readOpen: () => open,
  };
}

describe('internal Stage 3B Batch 4 lifecycle vertical slice', () => {
  it('uses strict lifecycle Pi schemas without model-supplied reason', () => {
    const harness = createHarness({ withBoard: true, open: true });
    const valid = {
      observationToken: 'observation-1',
      expectedWhiteboardId: 'board-1',
      expectedRevision: 0,
    };
    expect(Value.Check(harness.openTool.tool.parameters, valid)).toBe(true);
    expect(Value.Check(harness.closeTool.tool.parameters, valid)).toBe(true);
    expect(Value.Check(harness.closeTool.tool.parameters, { ...valid, reason: 'done' })).toBe(
      false,
    );
  });

  it('closes then reopens and draws on the same existing board', async () => {
    const harness = createHarness({ withBoard: true, open: true });
    const before = harness.readBinding();
    const closeRequest = execution('wb_close', 'close-existing-chain');
    const closeInput = {
      observationToken: harness.mintBinding('read-close-existing'),
      expectedWhiteboardId: before.activeWhiteboardId,
      expectedRevision: before.revision,
    };
    const closed = await harness.closeTool.handler({ request: closeRequest, params: closeInput });
    expect(closed).toMatchObject({
      isError: false,
      details: {
        currentBinding: { whiteboardId: 'board-1', revision: 1 },
        observationTokens: { bindingObservationToken: expect.any(String) },
      },
    });
    expect(harness.readOpen()).toBe(false);
    const closedDetails = closed.details as {
      currentBinding: { whiteboardId: string; revision: number };
      observationTokens: { bindingObservationToken: string };
    };
    const drawn = await harness.drawTool.handler({
      request: execution('wb_draw_text', 'draw-after-close-existing'),
      params: {
        observationToken: closedDetails.observationTokens.bindingObservationToken,
        expectedWhiteboardId: closedDetails.currentBinding.whiteboardId,
        expectedRevision: closedDetails.currentBinding.revision,
        content: 'same Child continuation',
        x: 80,
        y: 80,
      },
    });
    expect(drawn).toMatchObject({
      isError: false,
      details: { currentBinding: { whiteboardId: 'board-1', revision: 2 } },
    });
    expect(harness.readOpen()).toBe(true);
    expect(harness.store.getState().stage?.whiteboard).toHaveLength(1);
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    expect(harness.events).toHaveLength(2);
    expect(harness.onActionDone).toHaveBeenCalledTimes(2);
  });

  it('opens a null binding by creating one deterministic empty board and replays its token', async () => {
    const harness = createHarness({ withBoard: false, open: false });
    const current = harness.readBinding();
    const request = execution('wb_open', 'open-create-empty');
    const params = {
      observationToken: harness.mintBinding('read-open-create'),
      expectedWhiteboardId: null,
      expectedRevision: current.revision,
    };
    const first = await harness.openTool.handler({ request, params });
    const expectedWhiteboardId = deriveRevisionedWhiteboardId(request.executionId);
    expect(first).toMatchObject({
      isError: false,
      details: {
        currentBinding: { whiteboardId: expectedWhiteboardId, revision: 1 },
        receipt: {
          changed: true,
          delta: { created: true, visibilityChanged: true },
          postcondition: { boardState: 'created_empty', elementCountAfter: 0 },
        },
      },
    });
    const firstToken = (first.details as { observationTokens: { bindingObservationToken: string } })
      .observationTokens.bindingObservationToken;
    const claims = harness.ledger.getSizeForTests();
    const replay = await harness.openTool.handler({ request, params });
    expect(replay).toMatchObject({
      isError: false,
      details: {
        replayedCapabilities: true,
        observationTokens: { bindingObservationToken: firstToken },
      },
    });
    expect(harness.ledger.getSizeForTests()).toBe(claims);
    expect(harness.store.getState().stage?.whiteboard).toMatchObject([
      { id: expectedWhiteboardId, elements: [] },
    ]);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it('closes a null-binding overlay and lets Draw deterministically create its board', async () => {
    const harness = createHarness({ withBoard: false, open: true });
    const before = harness.readBinding();
    const closed = await harness.closeTool.handler({
      request: execution('wb_close', 'close-null-chain'),
      params: {
        observationToken: harness.mintBinding('read-close-null'),
        expectedWhiteboardId: null,
        expectedRevision: before.revision,
      },
    });
    expect(closed).toMatchObject({
      isError: false,
      details: {
        currentBinding: { whiteboardId: null, revision: 1 },
        receipt: { changed: true, postcondition: { boardState: 'no_board' } },
      },
    });
    expect(harness.store.getState().stage?.whiteboard).toEqual([]);
    const closedDetails = closed.details as {
      currentBinding: { whiteboardId: null; revision: number };
      observationTokens: { bindingObservationToken: string };
    };
    const drawExecutionId = 'draw-after-close-null';
    const drawn = await harness.drawTool.handler({
      request: execution('wb_draw_text', drawExecutionId),
      params: {
        observationToken: closedDetails.observationTokens.bindingObservationToken,
        expectedWhiteboardId: null,
        expectedRevision: closedDetails.currentBinding.revision,
        content: 'create after null close',
        x: 80,
        y: 80,
      },
    });
    expect(drawn).toMatchObject({
      isError: false,
      details: {
        currentBinding: {
          whiteboardId: deriveRevisionedWhiteboardId(drawExecutionId),
          revision: 2,
        },
      },
    });
    expect(harness.readOpen()).toBe(true);
    expect(harness.store.getState().stage?.whiteboard).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(2);
  });

  it('charges a lifecycle uncertain result once, mints no capability and exact-replays it', async () => {
    const harness = createHarness({ withBoard: true, open: true });
    const unsubscribe = harness.authority.subscribe(() => {
      throw new Error('listener failed after the visibility write');
    });
    const before = harness.readBinding();
    const request = execution('wb_close', 'close-handler-uncertain');
    const params = {
      observationToken: harness.mintBinding('read-close-uncertain'),
      expectedWhiteboardId: before.activeWhiteboardId,
      expectedRevision: before.revision,
    };

    const first = await harness.closeTool.handler({ request, params });
    expect(first).toMatchObject({
      isError: true,
      details: {
        code: 'REVISIONED_WHITEBOARD_UNCERTAIN',
        status: 'uncertain',
        mutationMayHaveCommitted: true,
      },
    });
    expect(harness.readOpen()).toBe(false);
    expect(harness.readBinding().revision).toBe(before.revision + 1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.ledger.getSizeForTests()).toBe(0);
    expect(harness.ledger.getMintRecordCountForTests()).toBe(0);

    const replay = await harness.closeTool.handler({ request, params });
    expect(replay).toMatchObject({
      isError: true,
      details: {
        code: 'REVISIONED_WHITEBOARD_UNCERTAIN',
        status: 'uncertain',
        mutationMayHaveCommitted: true,
      },
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.ledger.getSizeForTests()).toBe(0);
    expect(harness.ledger.getMintRecordCountForTests()).toBe(0);
    unsubscribe();
  });

  it('classifies a lifecycle stage switch during accepted HTTP as TARGET_CHANGED', async () => {
    const harness = createHarness({
      withBoard: true,
      open: true,
      afterAccepted: () => {
        expect(
          harness.authority.transact({
            label: 'test.lifecycle-stage-switch',
            writes: [
              {
                label: 'switch-stage',
                write: () => harness.store.setState({ stage: stage([board()], 'stage-2') }),
              },
            ],
          }),
        ).toMatchObject({ ok: true, changed: true });
      },
    });
    const before = harness.readBinding();
    const result = await harness.closeTool.handler({
      request: execution('wb_close', 'close-target-changed'),
      params: {
        observationToken: harness.mintBinding('read-before-stage-switch'),
        expectedWhiteboardId: before.activeWhiteboardId,
        expectedRevision: before.revision,
      },
    });
    expect(result).toMatchObject({
      isError: true,
      details: { code: 'TARGET_CHANGED', mutationMayHaveCommitted: false },
    });
    expect(harness.store.getState().stage?.id).toBe('stage-2');
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(harness.ledger.getSizeForTests()).toBe(0);
    expect(harness.ledger.getMintRecordCountForTests()).toBe(0);
  });

  it('returns the settled lifecycle replay before a newly exhausted action budget', async () => {
    let canExecute = true;
    const harness = createHarness({
      withBoard: true,
      open: true,
      canExecute: () => canExecute,
    });
    const before = harness.readBinding();
    const request = execution('wb_close', 'close-budget-replay');
    const params = {
      observationToken: harness.mintBinding('read-budget-replay'),
      expectedWhiteboardId: before.activeWhiteboardId,
      expectedRevision: before.revision,
    };
    const first = await harness.closeTool.handler({ request, params });
    const firstToken = (
      first.details as {
        observationTokens: { bindingObservationToken: string };
      }
    ).observationTokens.bindingObservationToken;
    canExecute = false;
    const replay = await harness.closeTool.handler({ request, params });
    expect(replay).toMatchObject({
      isError: false,
      details: {
        replayedCapabilities: true,
        observationTokens: { bindingObservationToken: firstToken },
      },
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it('charges no action for no-op Close and exact-replays one binding token', async () => {
    const harness = createHarness({ withBoard: false, open: false });
    const current = harness.readBinding();
    const request = execution('wb_close', 'close-null-noop');
    const params = {
      observationToken: harness.mintBinding('read-close-noop'),
      expectedWhiteboardId: null,
      expectedRevision: current.revision,
    };
    const first = await harness.closeTool.handler({ request, params });
    expect(first).toMatchObject({
      isError: false,
      details: { receipt: { changed: false }, replayedCapabilities: false },
    });
    const firstToken = (first.details as { observationTokens: { bindingObservationToken: string } })
      .observationTokens.bindingObservationToken;
    const claimCount = harness.ledger.getSizeForTests();
    const replay = await harness.closeTool.handler({ request, params });
    expect(replay).toMatchObject({
      isError: false,
      details: {
        replayedCapabilities: true,
        observationTokens: { bindingObservationToken: firstToken },
      },
    });
    expect(harness.ledger.getSizeForTests()).toBe(claimCount);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).not.toHaveBeenCalled();
  });

  it('records and replays post-commit binding capability capacity failure', async () => {
    const harness = createHarness({
      withBoard: true,
      open: true,
      ledger: new NativeWhiteboardObservationLedger({ maxMintRecords: 0 }),
    });
    const current = harness.readBinding();
    const request = execution('wb_close', 'close-capability-limit');
    const params = {
      observationToken: harness.mintBinding('read-capability-limit'),
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
    };
    const first = await harness.closeTool.handler({ request, params });
    expect(first).toMatchObject({
      isError: true,
      details: {
        code: 'OBSERVATION_CAPABILITY_LIMIT',
        status: 'committed',
        mutationMayHaveCommitted: false,
      },
    });
    const replay = await harness.closeTool.handler({ request, params });
    expect(replay).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.ledger.getSizeForTests()).toBe(0);
  });

  it('returns stale with zero action and requires a fresh binding observation', async () => {
    const harness = createHarness({ withBoard: true, open: true });
    const stale = harness.readBinding();
    const staleToken = harness.mintBinding('read-stale');
    const opened = await harness.openTool.handler({
      request: execution('wb_open', 'open-noop-before-stale'),
      params: {
        observationToken: harness.mintBinding('read-open-noop'),
        expectedWhiteboardId: stale.activeWhiteboardId,
        expectedRevision: stale.revision,
      },
    });
    expect(opened.isError).toBe(false);
    // The Open above is a no-op, so advance the revision with a real Close.
    const closed = await harness.closeTool.handler({
      request: execution('wb_close', 'close-advance-revision'),
      params: {
        observationToken: (
          opened.details as {
            observationTokens: { bindingObservationToken: string };
          }
        ).observationTokens.bindingObservationToken,
        expectedWhiteboardId: stale.activeWhiteboardId,
        expectedRevision: stale.revision,
      },
    });
    expect(closed.isError).toBe(false);
    const staleResult = await harness.closeTool.handler({
      request: execution('wb_close', 'close-stale-attempt'),
      params: {
        observationToken: staleToken,
        expectedWhiteboardId: stale.activeWhiteboardId,
        expectedRevision: stale.revision,
      },
    });
    expect(staleResult).toMatchObject({
      isError: true,
      details: { code: 'STALE_STATE', retryable: true },
    });
    expect(harness.events).toHaveLength(3);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });
});
