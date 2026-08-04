import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { BrowserRevisionedWhiteboardEffectRuntime } from '@/lib/agent/client/revisioned-whiteboard-effect-runtime';
import { RevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import { REVISIONED_WHITEBOARD_ACK_HEADER } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type { ClientEffectExecutionRequest } from '@/lib/agent/runtime/native-child-contract';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { buildInternalRevisionedWhiteboardDrawTextTool } from '@/lib/chat/pi/tools/native-whiteboard-v2-draw-text';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage } from '@/lib/types/stage';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

function stage(id = 'stage-1'): Stage {
  return {
    id,
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

function execution(executionId: string): ClientEffectExecutionRequest {
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
    toolName: 'wb_draw_text',
    args: {},
    argsDigest: 'sha256:test',
    issuedAt: now,
    deadlineAt: now + 10_000,
    attempt: 1,
  };
}

function createHarness(
  opts: {
    afterAccepted?: () => void;
    ledger?: NativeWhiteboardObservationLedger;
    loseFirstTerminalResponse?: boolean;
    canExecute?: () => boolean;
  } = {},
) {
  let open = false;
  let sceneId = 'scene-1';
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: stage() }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  const coordinator = new RevisionedWhiteboardCoordinator();
  const ledger = opts.ledger ?? new NativeWhiteboardObservationLedger();
  const targetRegistry = new RevisionedWhiteboardTargetRegistry();
  const ackStatuses: string[] = [];
  let terminalResponseLost = false;
  const browser = new BrowserRevisionedWhiteboardEffectRuntime({
    requestId: 'request-1',
    sessionId: 'session-1',
    readCurrentStageId: () => store.getState().stage?.id,
    readCurrentSceneId: () => sceneId,
    getAuthority: () => authority,
    targetRegistry,
    fetchAck: vi.fn(async (_input, init) => {
      const token = new Headers(init?.headers).get(REVISIONED_WHITEBOARD_ACK_HEADER)!;
      const body = JSON.parse(String(init?.body));
      ackStatuses.push(body.status);
      const result = coordinator.applyAck(token, body);
      if (body.status === 'accepted' && result.kind === 'applied') opts.afterAccepted?.();
      if (opts.loseFirstTerminalResponse && body.status !== 'accepted' && !terminalResponseLost) {
        terminalResponseLost = true;
        throw new Error('simulated response loss');
      }
      return new Response('{}', {
        status: result.kind === 'applied' || result.kind === 'duplicate' ? 200 : 409,
      });
    }),
  });
  const mutationRuntime = new RevisionedWhiteboardMutationRuntime(ledger, coordinator);
  const events: StatelessEvent[] = [];
  const onActionDone = vi.fn();
  const bundle = buildInternalRevisionedWhiteboardDrawTextTool({
    body: body(store.getState().stage!),
    observationLedger: ledger,
    mutationRuntime,
    canExecute: opts.canExecute ?? (() => true),
    onActionDone,
    send: async (event) => {
      events.push(event);
      if (event.type === 'revisioned_client_effect') await browser.execute(event.data);
    },
  });
  const readBinding = () => {
    const result = authority.querySnapshot();
    if (!result.ok || result.value.stageId === null) throw new Error('Expected authority state.');
    return { ...result.value, stageId: result.value.stageId };
  };
  const mint = (sourceId: string) => {
    const current = readBinding();
    return ledger.mintFromRead({
      childInvocationId: 'child-1',
      requestId: 'request-1',
      stageId: current.stageId,
      whiteboardId: current.activeWhiteboardId,
      revision: current.revision,
      queryId: sourceId,
      coverage: { kind: 'binding' },
      expiresAt: Date.now() + 10_000,
    });
  };
  const params = (observationToken: string, revision: number, whiteboardId: string | null) => ({
    observationToken,
    expectedWhiteboardId: whiteboardId,
    expectedRevision: revision,
    content: 'Revisioned hello',
    x: 100,
    y: 120,
    color: 'red',
  });
  return {
    authority,
    store,
    coordinator,
    ledger,
    browser,
    bundle,
    events,
    onActionDone,
    ackStatuses,
    mint,
    params,
    readBinding,
    setSceneId(value: string) {
      sceneId = value;
    },
  };
}

describe('internal Stage 3B-2 wb_draw_text vertical slice', () => {
  it('commits through Browser Authority CAS and returns a capability bundle', async () => {
    const harness = createHarness();
    const before = harness.readBinding();
    const request = execution('draw-1');
    const params = harness.params(
      harness.mint('read-1'),
      before.revision,
      before.activeWhiteboardId,
    );
    const result = await harness.bundle.handler({ request, params });

    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({
      status: 'committed',
      currentBinding: { stageId: 'stage-1', revision: 1 },
      observationTokens: {
        bindingObservationToken: expect.any(String),
        targetObservationToken: expect.any(String),
      },
    });
    expect(harness.events.map(({ type }) => type)).toEqual(['revisioned_client_effect']);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.readBinding()).toMatchObject({ revision: 1, open: true });
    const board = harness.store.getState().stage?.whiteboard?.[0];
    expect(board?.elements).toHaveLength(1);
    expect(board?.elements[0]).toMatchObject({ type: 'text', defaultColor: '#ff0000' });

    const claimsAfterCommit = harness.ledger.getSizeForTests();
    const replay = await harness.bundle.handler({ request, params });
    expect(replay).toMatchObject({
      isError: false,
      details: { replayedCapabilities: true },
    });
    expect(harness.events.map(({ type }) => type)).toEqual(['revisioned_client_effect']);
    expect(harness.ledger.getSizeForTests()).toBe(claimsAfterCommit);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
  });

  it('returns an exact settled replay after the classroom action budget is exhausted', async () => {
    let canExecute = true;
    const harness = createHarness({ canExecute: () => canExecute });
    const before = harness.readBinding();
    const request = execution('draw-budget-replay');
    const params = harness.params(
      harness.mint('read-budget-replay'),
      before.revision,
      before.activeWhiteboardId,
    );
    const first = await harness.bundle.handler({ request, params });
    canExecute = false;
    const replay = await harness.bundle.handler({ request, params });

    expect(first.isError).toBe(false);
    expect(replay).toMatchObject({
      isError: false,
      details: { replayedCapabilities: true },
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
  });

  it('returns deterministic STALE_STATE with zero action, then succeeds from a fresh read', async () => {
    const harness = createHarness();
    const initial = harness.readBinding();
    const staleToken = harness.mint('read-stale');
    const changed = harness.authority.transact({
      label: 'test.advance',
      writes: [
        {
          label: 'replace-whiteboard',
          write: () =>
            harness.store.setState({
              stage: {
                ...harness.store.getState().stage!,
                whiteboard: [
                  {
                    id: 'external-board',
                    viewportSize: 1000,
                    viewportRatio: 16 / 9,
                    elements: [],
                    background: { type: 'solid', color: '#ffffff' },
                    animations: [],
                  },
                ],
              },
            }),
        },
      ],
    });
    expect(changed).toMatchObject({ ok: true, changed: true });

    const stale = await harness.bundle.handler({
      request: execution('draw-stale'),
      params: harness.params(staleToken, initial.revision, initial.activeWhiteboardId),
    });
    expect(stale).toMatchObject({
      isError: true,
      details: { code: 'STALE_STATE', mutationMayHaveCommitted: false },
    });
    expect(harness.onActionDone).not.toHaveBeenCalled();

    const fresh = harness.readBinding();
    const copiedDiagnosticRetry = await harness.bundle.handler({
      request: execution('draw-without-fresh-read'),
      params: harness.params(staleToken, fresh.revision, fresh.activeWhiteboardId),
    });
    expect(copiedDiagnosticRetry).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_INVALID' },
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(harness.readBinding()).toMatchObject({ revision: fresh.revision });

    const success = await harness.bundle.handler({
      request: execution('draw-fresh'),
      params: harness.params(harness.mint('read-fresh'), fresh.revision, fresh.activeWhiteboardId),
    });
    expect(success.isError).toBe(false);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.readBinding().revision).toBe(fresh.revision + 1);
  });

  it('keeps accepted N+1 → CAS N+2 deterministic STALE_STATE with zero action', async () => {
    const harness = createHarness({
      afterAccepted: () => {
        const current = harness.store.getState().stage!;
        const board = current.whiteboard![0];
        expect(
          harness.authority.transact({
            label: 'test.accepted-race',
            writes: [
              {
                label: 'add-racing-element',
                write: () =>
                  harness.store.setState({
                    stage: {
                      ...current,
                      whiteboard: [
                        {
                          ...board,
                          elements: [
                            ...board.elements,
                            { id: 'race-element', type: 'text', content: 'race' } as never,
                          ],
                        },
                      ],
                    },
                  }),
              },
            ],
          }),
        ).toMatchObject({ ok: true, changed: true });
      },
    });
    const expected = harness.readBinding();
    const token = harness.mint('read-N');
    expect(
      harness.authority.transact({
        label: 'test.advance-N1',
        writes: [
          {
            label: 'replace-whiteboard',
            write: () =>
              harness.store.setState({
                stage: {
                  ...harness.store.getState().stage!,
                  whiteboard: [
                    {
                      id: 'board-N1',
                      viewportSize: 1000,
                      viewportRatio: 16 / 9,
                      elements: [],
                      background: { type: 'solid', color: '#ffffff' },
                      animations: [],
                    },
                  ],
                },
              }),
          },
        ],
      }),
    ).toMatchObject({ ok: true, changed: true });

    const result = await harness.bundle.handler({
      request: execution('draw-raced-stale'),
      params: harness.params(token, expected.revision, expected.activeWhiteboardId),
    });
    expect(result).toMatchObject({
      isError: true,
      details: { code: 'STALE_STATE', mutationMayHaveCommitted: false },
    });
    expect(harness.readBinding().revision).toBe(expected.revision + 2);
    expect(harness.onActionDone).not.toHaveBeenCalled();
  });

  it('classifies a stage switch during accepted HTTP as TARGET_CHANGED', async () => {
    const harness = createHarness({
      afterAccepted: () => {
        expect(
          harness.authority.transact({
            label: 'test.stage-switch',
            writes: [
              {
                label: 'switch-stage',
                write: () => harness.store.setState({ stage: stage('stage-2') }),
              },
            ],
          }),
        ).toMatchObject({ ok: true, changed: true });
      },
    });
    const expected = harness.readBinding();
    const result = await harness.bundle.handler({
      request: execution('draw-target-changed'),
      params: harness.params(
        harness.mint('read-before-switch'),
        expected.revision,
        expected.activeWhiteboardId,
      ),
    });
    expect(result).toMatchObject({
      isError: true,
      details: { code: 'TARGET_CHANGED', mutationMayHaveCommitted: false },
    });
    expect(harness.store.getState().stage?.id).toBe('stage-2');
    expect(harness.onActionDone).not.toHaveBeenCalled();
  });

  it('replays the same bounded no-bundle outcome after a committed capacity failure', async () => {
    const harness = createHarness({
      ledger: new NativeWhiteboardObservationLedger({ maxMintRecords: 0 }),
    });
    const before = harness.readBinding();
    const request = execution('draw-no-bundle');
    const params = harness.params(
      harness.mint('read-no-bundle'),
      before.revision,
      before.activeWhiteboardId,
    );
    const first = await harness.bundle.handler({ request, params });
    const replay = await harness.bundle.handler({ request, params });

    expect(first).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(replay).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(harness.ledger.getMintRecordCountForTests()).toBe(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
  });

  it('retries one exact terminal ACK after response loss without a second mutation', async () => {
    const harness = createHarness({ loseFirstTerminalResponse: true });
    const before = harness.readBinding();
    const result = await harness.bundle.handler({
      request: execution('draw-response-loss'),
      params: harness.params(
        harness.mint('read-response-loss'),
        before.revision,
        before.activeWhiteboardId,
      ),
    });
    expect(result.isError).toBe(false);
    expect(harness.ackStatuses).toEqual(['accepted', 'effect_committed', 'effect_committed']);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    expect(harness.readBinding().revision).toBe(before.revision + 1);
  });
});
