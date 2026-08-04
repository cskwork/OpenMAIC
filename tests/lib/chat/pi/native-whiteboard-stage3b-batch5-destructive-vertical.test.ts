import { describe, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import { createStore } from 'zustand/vanilla';
import { BrowserRevisionedWhiteboardEffectRuntime } from '@/lib/agent/client/revisioned-whiteboard-effect-runtime';
import { RevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import { REVISIONED_WHITEBOARD_ACK_HEADER } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type { ClientEffectExecutionRequest } from '@/lib/agent/runtime/native-child-contract';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import {
  buildInternalRevisionedWhiteboardClearTool,
  buildInternalRevisionedWhiteboardDeleteTool,
} from '@/lib/chat/pi/tools/native-whiteboard-v2-destructive';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import {
  WhiteboardEnvironmentAuthority,
  type WhiteboardAuthorityHistoryStore,
} from '@/lib/store/whiteboard-environment-authority';
import type { PPTElement } from '@openmaic/dsl';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { Stage, Whiteboard } from '@/lib/types/stage';

type ToolName = 'wb_delete' | 'wb_clear';

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

function board(elements: PPTElement[] = [text('text-1'), text('text-2')]): Whiteboard {
  return {
    id: 'board-1',
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements,
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

function createHistoryStore(input?: { throwAfterCall?: boolean }) {
  const pushExactSnapshot = vi.fn((_: PPTElement[], boardContentDigest: string) => {
    if (input?.throwAfterCall) throw new Error('unprovable history settlement');
    return { snapshotIndex: 0, boardContentDigest, inserted: true };
  });
  return {
    store: { getState: () => ({ pushExactSnapshot }) } satisfies WhiteboardAuthorityHistoryStore,
    pushExactSnapshot,
  };
}

function createHarness(input: {
  withBoard?: boolean;
  elements?: PPTElement[];
  open?: boolean;
  historyStore?: WhiteboardAuthorityHistoryStore;
  canExecute?: () => boolean;
  ledger?: NativeWhiteboardObservationLedger;
  readCurrentSceneId?: () => string;
  afterAccepted?: () => void;
}) {
  let open = input.open ?? true;
  const initialStage = stage(input.withBoard === false ? [] : [board(input.elements)]);
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: initialStage }));
  const authority = new WhiteboardEnvironmentAuthority(store, () => open, {
    historyStore: input.historyStore,
  });
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  const coordinator = new RevisionedWhiteboardCoordinator();
  const ledger = input.ledger ?? new NativeWhiteboardObservationLedger();
  const browser = new BrowserRevisionedWhiteboardEffectRuntime({
    requestId: 'request-1',
    sessionId: 'session-1',
    readCurrentStageId: () => store.getState().stage?.id,
    readCurrentSceneId: input.readCurrentSceneId ?? (() => 'scene-1'),
    getAuthority: () => authority,
    targetRegistry: new RevisionedWhiteboardTargetRegistry(),
    fetchAck: vi.fn(async (_input, init) => {
      const token = new Headers(init?.headers).get(REVISIONED_WHITEBOARD_ACK_HEADER)!;
      const ack = JSON.parse(String(init?.body));
      const result = coordinator.applyAck(token, ack);
      if (ack.status === 'accepted' && result.kind === 'applied') input.afterAccepted?.();
      return new Response('{}', {
        status: result.kind === 'applied' || result.kind === 'duplicate' ? 200 : 409,
      });
    }),
  });
  const mutationRuntime = new RevisionedWhiteboardMutationRuntime(ledger, coordinator);
  const events: StatelessEvent[] = [];
  const onActionDone = vi.fn();
  const options = {
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
  const deleteTool = buildInternalRevisionedWhiteboardDeleteTool(options);
  const clearTool = buildInternalRevisionedWhiteboardClearTool(options);
  const readBinding = () => {
    const snapshot = authority.querySnapshot();
    if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
    return snapshot.value;
  };
  const mint = (
    queryId: string,
    coverage: Parameters<typeof ledger.mintFromRead>[0]['coverage'],
  ) => {
    const current = readBinding();
    return ledger.mintFromRead({
      childInvocationId: 'child-1',
      requestId: 'request-1',
      stageId: current.stageId!,
      whiteboardId: current.activeWhiteboardId,
      revision: current.revision,
      queryId,
      coverage,
      expiresAt: Date.now() + 10_000,
    });
  };
  return {
    authority,
    store,
    ledger,
    events,
    onActionDone,
    deleteTool,
    clearTool,
    readBinding,
    mint,
    readOpen: () => open,
  };
}

describe('internal Stage 3B Batch 5 destructive vertical slice', () => {
  it('uses strict exact-key Pi schemas and nullable binding only for Clear', () => {
    const harness = createHarness({});
    const common = {
      observationToken: 'observation-1',
      expectedWhiteboardId: 'board-1',
      expectedRevision: 0,
    };
    expect(
      Value.Check(harness.deleteTool.tool.parameters, { ...common, elementId: 'text-1' }),
    ).toBe(true);
    expect(
      Value.Check(harness.deleteTool.tool.parameters, { ...common, elementId: 'text-1', x: 1 }),
    ).toBe(false);
    expect(
      Value.Check(harness.deleteTool.tool.parameters, {
        ...common,
        expectedWhiteboardId: null,
        elementId: 'text-1',
      }),
    ).toBe(false);
    expect(Value.Check(harness.clearTool.tool.parameters, common)).toBe(true);
    expect(
      Value.Check(harness.clearTool.tool.parameters, { ...common, expectedWhiteboardId: null }),
    ).toBe(true);
    expect(Value.Check(harness.clearTool.tool.parameters, { ...common, reason: 'done' })).toBe(
      false,
    );
  });

  it('deletes one element through Browser Authority and returns binding-only coverage', async () => {
    const harness = createHarness({ open: false });
    const current = harness.readBinding();
    const request = execution('wb_delete', 'delete-vertical');
    const params = {
      observationToken: harness.mint('read-delete', { kind: 'element', elementId: 'text-1' }),
      expectedWhiteboardId: current.activeWhiteboardId!,
      expectedRevision: current.revision,
      elementId: 'text-1',
    };
    const first = await harness.deleteTool.handler({ request, params });
    expect(first).toMatchObject({
      isError: false,
      details: {
        stableElementId: 'text-1',
        observedElementType: 'text',
        elementCountBefore: 2,
        elementCountAfter: 1,
        currentBinding: { whiteboardId: 'board-1', revision: 1 },
        observationTokens: { bindingObservationToken: expect.any(String) },
      },
    });
    expect((first.details as { observationTokens: object }).observationTokens).not.toHaveProperty(
      'membershipObservationToken',
    );
    expect(harness.store.getState().stage?.whiteboard?.[0].elements.map(({ id }) => id)).toEqual([
      'text-2',
    ]);
    expect(harness.readOpen()).toBe(true);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    const claimCount = harness.ledger.getSizeForTests();
    const replay = await harness.deleteTool.handler({ request, params });
    expect(replay).toMatchObject({ isError: false, details: { replayedCapabilities: true } });
    expect(harness.events).toHaveLength(1);
    expect(harness.ledger.getSizeForTests()).toBe(claimCount);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it('clears a non-empty closed board, snapshots once and atomically returns empty membership', async () => {
    const history = createHistoryStore();
    let canExecute = true;
    const harness = createHarness({
      open: false,
      historyStore: history.store,
      canExecute: () => canExecute,
    });
    const current = harness.readBinding();
    const request = execution('wb_clear', 'clear-vertical');
    const params = {
      observationToken: harness.mint('read-clear', { kind: 'membership', complete: true }),
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
    };
    const first = await harness.clearTool.handler({ request, params });
    expect(first).toMatchObject({
      isError: false,
      details: {
        boardState: 'cleared_existing',
        cleared: true,
        visibilityChanged: true,
        elementCountBefore: 2,
        elementCountAfter: 0,
        historyDisposition: 'inserted',
        currentBinding: { whiteboardId: 'board-1', revision: 1 },
        observationTokens: {
          bindingObservationToken: expect.any(String),
          membershipObservationToken: expect.any(String),
        },
      },
    });
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    expect(harness.readOpen()).toBe(true);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    const firstDetails = first.details as {
      currentBinding: { stageId: string; whiteboardId: string; revision: number };
      observationTokens: {
        bindingObservationToken: string;
        membershipObservationToken: string;
      };
    };
    const claimBase = {
      childInvocationId: 'child-1',
      requestId: 'request-1',
      ...firstDetails.currentBinding,
    };
    expect(
      harness.ledger.consume({
        ...claimBase,
        token: firstDetails.observationTokens.membershipObservationToken,
        requiredCoverage: { kind: 'binding' },
      }),
    ).toEqual({ ok: false, code: 'OBSERVATION_COVERAGE_MISMATCH' });
    expect(
      harness.ledger.consume({
        ...claimBase,
        token: firstDetails.observationTokens.bindingObservationToken,
        requiredCoverage: { kind: 'binding' },
      }),
    ).toEqual({ ok: true });
    expect(
      harness.ledger.consume({
        ...claimBase,
        token: firstDetails.observationTokens.membershipObservationToken,
        requiredCoverage: { kind: 'membership', complete: true },
      }),
    ).toEqual({ ok: true });
    canExecute = false;
    const replay = await harness.clearTool.handler({ request, params });
    expect(replay).toMatchObject({ isError: false, details: { replayedCapabilities: true } });
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it.each([
    { withBoard: false, elements: undefined, open: true, boardState: 'no_board' },
    { withBoard: true, elements: [] as PPTElement[], open: false, boardState: 'preserved_empty' },
  ])('returns both capabilities for Clear no-op $boardState without action', async (input) => {
    const harness = createHarness(input);
    const current = harness.readBinding();
    const result = await harness.clearTool.handler({
      request: execution('wb_clear', `clear-${input.boardState}-vertical`),
      params: {
        observationToken: harness.mint(`read-${input.boardState}`, {
          kind: 'membership',
          complete: true,
        }),
        expectedWhiteboardId: current.activeWhiteboardId,
        expectedRevision: current.revision,
      },
    });
    expect(result).toMatchObject({
      isError: false,
      details: {
        boardState: input.boardState,
        cleared: false,
        currentBinding: { revision: 0 },
        observationTokens: {
          bindingObservationToken: expect.any(String),
          membershipObservationToken: expect.any(String),
        },
      },
    });
    expect(harness.readOpen()).toBe(input.open);
    expect(harness.onActionDone).not.toHaveBeenCalled();
  });

  it('rejects coverage substitution before Browser delivery or action', async () => {
    const deleteHarness = createHarness({});
    const deleteBinding = deleteHarness.readBinding();
    const deleted = await deleteHarness.deleteTool.handler({
      request: execution('wb_delete', 'delete-wrong-coverage'),
      params: {
        observationToken: deleteHarness.mint('read-binding-only', { kind: 'binding' }),
        expectedWhiteboardId: deleteBinding.activeWhiteboardId!,
        expectedRevision: deleteBinding.revision,
        elementId: 'text-1',
      },
    });
    expect(deleted).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_COVERAGE_MISMATCH' },
    });
    expect(deleteHarness.events).toHaveLength(0);
    expect(deleteHarness.onActionDone).not.toHaveBeenCalled();

    const clearHarness = createHarness({ historyStore: createHistoryStore().store });
    const clearBinding = clearHarness.readBinding();
    const cleared = await clearHarness.clearTool.handler({
      request: execution('wb_clear', 'clear-incomplete-coverage'),
      params: {
        observationToken: clearHarness.mint('read-element-only', {
          kind: 'element',
          elementId: 'text-1',
        }),
        expectedWhiteboardId: clearBinding.activeWhiteboardId,
        expectedRevision: clearBinding.revision,
      },
    });
    expect(cleared).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_COVERAGE_MISMATCH' },
    });
    expect(clearHarness.events).toHaveLength(0);
    expect(clearHarness.onActionDone).not.toHaveBeenCalled();
  });

  it('deterministically rejects non-empty Clear when history is unconfigured', async () => {
    const harness = createHarness({ open: false });
    const current = harness.readBinding();
    const result = await harness.clearTool.handler({
      request: execution('wb_clear', 'clear-no-history'),
      params: {
        observationToken: harness.mint('read-no-history', { kind: 'membership', complete: true }),
        expectedWhiteboardId: current.activeWhiteboardId,
        expectedRevision: current.revision,
      },
    });
    expect(result).toMatchObject({
      isError: true,
      details: {
        code: 'TARGET_PRECONDITION_FAILED',
        status: 'rejected',
        mutationMayHaveCommitted: false,
      },
    });
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    expect(harness.readOpen()).toBe(false);
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(harness.ledger.getMintRecordCountForTests()).toBe(0);
  });

  it('charges called-but-unprovable history once and exact-replays without capabilities', async () => {
    const history = createHistoryStore({ throwAfterCall: true });
    const harness = createHarness({ open: false, historyStore: history.store });
    const current = harness.readBinding();
    const request = execution('wb_clear', 'clear-history-uncertain');
    const params = {
      observationToken: harness.mint('read-history-uncertain', {
        kind: 'membership',
        complete: true,
      }),
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
    };
    const first = await harness.clearTool.handler({ request, params });
    expect(first).toMatchObject({
      isError: true,
      details: {
        code: 'REVISIONED_WHITEBOARD_UNCERTAIN',
        status: 'uncertain',
        mutationMayHaveCommitted: true,
      },
    });
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    expect(harness.readOpen()).toBe(false);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.ledger.getMintRecordCountForTests()).toBe(0);
    const replay = await harness.clearTool.handler({ request, params });
    expect(replay).toMatchObject({ isError: true, details: { status: 'uncertain' } });
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it.each([
    { toolName: 'wb_delete' as const, race: 'stage' as const, code: 'TARGET_CHANGED' },
    {
      toolName: 'wb_delete' as const,
      race: 'scene' as const,
      code: 'AUTHENTICATED_TARGET_CHANGED',
    },
    { toolName: 'wb_clear' as const, race: 'stage' as const, code: 'TARGET_CHANGED' },
    {
      toolName: 'wb_clear' as const,
      race: 'scene' as const,
      code: 'AUTHENTICATED_TARGET_CHANGED',
    },
  ])(
    'rejects $toolName after an accepted-to-CAS $race change before destructive side effects',
    async ({ toolName, race, code }) => {
      const history = createHistoryStore();
      let sceneId = 'scene-1';
      const harness = createHarness({
        open: false,
        historyStore: history.store,
        readCurrentSceneId: () => sceneId,
        afterAccepted: () => {
          if (race === 'scene') {
            sceneId = 'scene-2';
            return;
          }
          expect(
            harness.authority.transact({
              label: `test.${toolName}.stage-switch`,
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
      const current = harness.readBinding();
      const request = execution(toolName, `${toolName}-${race}-changed`);
      const result =
        toolName === 'wb_delete'
          ? await harness.deleteTool.handler({
              request,
              params: {
                observationToken: harness.mint(`read-delete-${race}`, {
                  kind: 'element',
                  elementId: 'text-1',
                }),
                expectedWhiteboardId: current.activeWhiteboardId!,
                expectedRevision: current.revision,
                elementId: 'text-1',
              },
            })
          : await harness.clearTool.handler({
              request,
              params: {
                observationToken: harness.mint(`read-clear-${race}`, {
                  kind: 'membership',
                  complete: true,
                }),
                expectedWhiteboardId: current.activeWhiteboardId,
                expectedRevision: current.revision,
              },
            });

      expect(result).toMatchObject({
        isError: true,
        details: { code, status: 'rejected', mutationMayHaveCommitted: false },
      });
      expect(harness.store.getState().stage?.whiteboard?.[0].elements.map(({ id }) => id)).toEqual([
        'text-1',
        'text-2',
      ]);
      expect(harness.store.getState().stage?.id).toBe(race === 'stage' ? 'stage-2' : 'stage-1');
      expect(harness.readOpen()).toBe(false);
      expect(history.pushExactSnapshot).not.toHaveBeenCalled();
      expect(harness.onActionDone).not.toHaveBeenCalled();
      expect(harness.ledger.getSizeForTests()).toBe(0);
      expect(harness.ledger.getMintRecordCountForTests()).toBe(0);
      expect(harness.readBinding().revision).toBe(race === 'stage' ? 1 : 0);
    },
  );

  it('fails the two-token Clear output atomically when capability capacity is insufficient', async () => {
    const history = createHistoryStore();
    const harness = createHarness({
      historyStore: history.store,
      ledger: new NativeWhiteboardObservationLedger({ maxClaims: 1 }),
    });
    const current = harness.readBinding();
    const request = execution('wb_clear', 'clear-capability-capacity');
    const params = {
      observationToken: harness.mint('read-capability-capacity', {
        kind: 'membership',
        complete: true,
      }),
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
    };
    const first = await harness.clearTool.handler({ request, params });
    expect(first).toMatchObject({
      isError: true,
      details: {
        code: 'OBSERVATION_CAPABILITY_LIMIT',
        status: 'committed',
        currentBinding: { revision: current.revision + 1 },
      },
    });
    expect(harness.ledger.getSizeForTests()).toBe(0);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    const replay = await harness.clearTool.handler({ request, params });
    expect(replay).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(harness.ledger.getSizeForTests()).toBe(0);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });
});
