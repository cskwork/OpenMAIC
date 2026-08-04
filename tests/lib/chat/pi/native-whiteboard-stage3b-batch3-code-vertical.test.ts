import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { BrowserRevisionedWhiteboardEffectRuntime } from '@/lib/agent/client/revisioned-whiteboard-effect-runtime';
import { RevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import { REVISIONED_WHITEBOARD_ACK_HEADER } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import { deriveRevisionedCodeEditLineId } from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import type { ClientEffectExecutionRequest } from '@/lib/agent/runtime/native-child-contract';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import {
  buildInternalRevisionedWhiteboardDrawCodeTool,
  buildInternalRevisionedWhiteboardEditCodeTool,
} from '@/lib/chat/pi/tools/native-whiteboard-v2-code';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { PPTCodeElement } from '@openmaic/dsl';

type CodeToolName = 'wb_draw_code' | 'wb_edit_code';

function board(id: string, elements: Whiteboard['elements'] = []): Whiteboard {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements,
    background: { type: 'solid', color: '#ffffff' },
    animations: [],
  };
}

function codeElement(): PPTCodeElement {
  return {
    id: 'legacy-code',
    type: 'code',
    language: 'typescript',
    lines: [
      { id: 'legacy-A', content: 'const a = 1;' },
      { id: 'legacy-B', content: 'console.log(a);' },
    ],
    fileName: 'legacy.ts',
    showLineNumbers: true,
    fontSize: 14,
    left: 80,
    top: 60,
    width: 600,
    height: 300,
    rotate: 0,
  };
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

function execution(toolName: CodeToolName, executionId: string): ClientEffectExecutionRequest {
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
    toolCallId: 'tool-' + executionId,
    executionId,
    idempotencyKey: 'idem-' + executionId,
    toolName,
    args: {},
    argsDigest: 'sha256:test',
    issuedAt: now,
    deadlineAt: now + 10_000,
    attempt: 1,
  };
}

function createHarness(
  opts: {
    initialStage?: Stage;
    open?: boolean;
    ledger?: NativeWhiteboardObservationLedger;
    canExecute?: () => boolean;
  } = {},
) {
  let open = opts.open ?? false;
  const initialStage = opts.initialStage ?? stage();
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: initialStage }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  const coordinator = new RevisionedWhiteboardCoordinator();
  const ledger = opts.ledger ?? new NativeWhiteboardObservationLedger();
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
      const result = coordinator.applyAck(token, ack);
      return new Response('{}', {
        status: result.kind === 'applied' || result.kind === 'duplicate' ? 200 : 409,
      });
    }),
  });
  const mutationRuntime = new RevisionedWhiteboardMutationRuntime(ledger, coordinator);
  const events: StatelessEvent[] = [];
  const onActionDone = vi.fn();
  const toolOptions = {
    body: body(initialStage),
    observationLedger: ledger,
    mutationRuntime,
    canExecute: opts.canExecute ?? (() => true),
    onActionDone,
    send: async (event: StatelessEvent) => {
      events.push(event);
      if (event.type === 'revisioned_client_effect') await browser.execute(event.data);
    },
  };
  const draw = buildInternalRevisionedWhiteboardDrawCodeTool(toolOptions);
  const edit = buildInternalRevisionedWhiteboardEditCodeTool(toolOptions);
  const readBinding = () => {
    const snapshot = authority.querySnapshot();
    if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
    return snapshot.value;
  };
  const mint = (
    queryId: string,
    coverage:
      | { kind: 'binding' }
      | { kind: 'element'; elementId: string }
      | { kind: 'code'; elementId: string; complete: true },
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
    draw,
    edit,
    events,
    onActionDone,
    readBinding,
    mint,
    readOpen: () => open,
  };
}

function drawParams(
  observationToken: string,
  binding: ReturnType<ReturnType<typeof createHarness>['readBinding']>,
) {
  return {
    observationToken,
    expectedWhiteboardId: binding.activeWhiteboardId,
    expectedRevision: binding.revision,
    language: 'ts',
    code: 'const a = 1;\r\nconsole.log(a);',
    x: 80,
    y: 60,
    width: 600,
    height: 300,
    fileName: 'example.ts',
  };
}

describe('internal Stage 3B Batch 3 Code vertical slice', () => {
  it('chains Draw capability into Edit in the same Child and exact-replays both bundles', async () => {
    const harness = createHarness();
    const before = harness.readBinding();
    const drawRequest = execution('wb_draw_code', 'code-draw-chain');
    const drawInput = drawParams(harness.mint('read-draw', { kind: 'binding' }), before);
    const drawResult = await harness.draw.handler({ request: drawRequest, params: drawInput });
    expect(drawResult).toMatchObject({
      isError: false,
      details: {
        status: 'committed',
        orderedLineIds: ['L1', 'L2'],
        observationTokens: {
          bindingObservationToken: expect.any(String),
          targetObservationToken: expect.any(String),
          codeObservationToken: expect.any(String),
        },
      },
    });
    const drawDetails = drawResult.details as {
      stableElementId: string;
      currentBinding: { whiteboardId: string; revision: number };
      observationTokens: { codeObservationToken: string };
    };

    const editRequest = execution('wb_edit_code', 'code-edit-chain');
    const editInput = {
      observationToken: drawDetails.observationTokens.codeObservationToken,
      expectedWhiteboardId: drawDetails.currentBinding.whiteboardId,
      expectedRevision: drawDetails.currentBinding.revision,
      elementId: drawDetails.stableElementId,
      operation: 'insert_after',
      lineId: 'L1',
      content: 'const b = 2;',
    };
    const editResult = await harness.edit.handler({ request: editRequest, params: editInput });
    expect(editResult).toMatchObject({
      isError: false,
      details: {
        status: 'committed',
        stableElementId: drawDetails.stableElementId,
        codeChanged: true,
        visibilityChanged: false,
        changed: true,
        newLineIds: [expect.stringMatching(/^CE2_[0-9a-f]{64}_1$/u)],
        observationTokens: {
          bindingObservationToken: expect.any(String),
          codeObservationToken: expect.any(String),
        },
      },
    });
    const claimsAfter = harness.ledger.getSizeForTests();
    const replay = await harness.edit.handler({ request: editRequest, params: editInput });
    expect(replay).toMatchObject({ isError: false, details: { replayedCapabilities: true } });
    expect(harness.ledger.getSizeForTests()).toBe(claimsAfter);
    expect(harness.events).toHaveLength(2);
    expect(harness.onActionDone).toHaveBeenCalledTimes(2);
    const element = harness.store.getState().stage?.whiteboard?.[0].elements[0] as PPTCodeElement;
    expect(element.lines.map(({ content }) => content)).toEqual([
      'const a = 1;',
      'const b = 2;',
      'console.log(a);',
    ]);
  });

  it('accepts a complete-code read for a pre-existing Legacy element and rejects weaker coverage', async () => {
    const initial = stage([board('board-1', [codeElement()])]);
    const harness = createHarness({ initialStage: initial, open: true });
    const current = harness.readBinding();
    const common = {
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
      elementId: 'legacy-code',
      operation: 'delete_lines',
      lineIds: ['legacy-B'],
    };
    for (const [index, coverage] of [
      { kind: 'binding' as const },
      { kind: 'element' as const, elementId: 'legacy-code' },
      { kind: 'code' as const, elementId: 'other-code', complete: true as const },
    ].entries()) {
      const rejected = await harness.edit.handler({
        request: execution('wb_edit_code', 'weak-coverage-' + index),
        params: { ...common, observationToken: harness.mint('weak-' + index, coverage) },
      });
      expect(rejected).toMatchObject({
        isError: true,
        details: { code: 'OBSERVATION_COVERAGE_MISMATCH' },
      });
    }
    expect(harness.events).toHaveLength(0);
    expect(harness.onActionDone).not.toHaveBeenCalled();

    const success = await harness.edit.handler({
      request: execution('wb_edit_code', 'legacy-edit-success'),
      params: {
        ...common,
        observationToken: harness.mint('complete-code', {
          kind: 'code',
          elementId: 'legacy-code',
          complete: true,
        }),
      },
    });
    expect(success.isError).toBe(false);
    const element = harness.store.getState().stage?.whiteboard?.[0].elements[0] as PPTCodeElement;
    expect(element.lines).toEqual([{ id: 'legacy-A', content: 'const a = 1;' }]);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it('returns STALE_STATE with zero action and requires a fresh complete-code observation', async () => {
    const initial = stage([board('board-1', [codeElement()])]);
    const harness = createHarness({ initialStage: initial, open: true });
    const stale = harness.readBinding();
    const staleToken = harness.mint('stale-code', {
      kind: 'code',
      elementId: 'legacy-code',
      complete: true,
    });
    const currentStage = harness.store.getState().stage!;
    const currentBoard = currentStage.whiteboard![0];
    expect(
      harness.authority.transact({
        label: 'test.advance-code-revision',
        writes: [
          {
            label: 'add-unrelated-text',
            write: () =>
              harness.store.setState({
                stage: {
                  ...currentStage,
                  whiteboard: [
                    {
                      ...currentBoard,
                      elements: [
                        ...currentBoard.elements,
                        { id: 'unrelated', type: 'text', content: 'x' } as never,
                      ],
                    },
                  ],
                },
              }),
          },
        ],
      }),
    ).toMatchObject({ ok: true, changed: true });
    const edit = {
      expectedWhiteboardId: stale.activeWhiteboardId,
      expectedRevision: stale.revision,
      elementId: 'legacy-code',
      operation: 'replace_lines',
      lineIds: ['legacy-A'],
      content: 'const a = 2;',
    };
    const staleResult = await harness.edit.handler({
      request: execution('wb_edit_code', 'stale-edit'),
      params: { ...edit, observationToken: staleToken },
    });
    expect(staleResult).toMatchObject({
      isError: true,
      details: { code: 'STALE_STATE', mutationMayHaveCommitted: false },
    });
    expect(harness.onActionDone).not.toHaveBeenCalled();

    const fresh = harness.readBinding();
    const copiedRevision = await harness.edit.handler({
      request: execution('wb_edit_code', 'copied-stale-edit'),
      params: {
        ...edit,
        observationToken: staleToken,
        expectedRevision: fresh.revision,
        expectedWhiteboardId: fresh.activeWhiteboardId,
      },
    });
    expect(copiedRevision).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_INVALID' },
    });
    const success = await harness.edit.handler({
      request: execution('wb_edit_code', 'fresh-edit'),
      params: {
        ...edit,
        observationToken: harness.mint('fresh-code', {
          kind: 'code',
          elementId: 'legacy-code',
          complete: true,
        }),
        expectedRevision: fresh.revision,
        expectedWhiteboardId: fresh.activeWhiteboardId,
      },
    });
    expect(success.isError).toBe(false);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it('does not charge a true no-op, but charges a visibility-only verified commit', async () => {
    const initial = stage([board('board-1', [codeElement()])]);
    const run = async (open: boolean, executionId: string) => {
      const harness = createHarness({ initialStage: structuredClone(initial), open });
      const current = harness.readBinding();
      const result = await harness.edit.handler({
        request: execution('wb_edit_code', executionId),
        params: {
          observationToken: harness.mint('read-' + executionId, {
            kind: 'code',
            elementId: 'legacy-code',
            complete: true,
          }),
          expectedWhiteboardId: current.activeWhiteboardId,
          expectedRevision: current.revision,
          elementId: 'legacy-code',
          operation: 'replace_lines',
          lineIds: ['legacy-A'],
          content: 'const a = 1;',
        },
      });
      return { harness, result };
    };
    const noOp = await run(true, 'true-noop');
    expect(noOp.result).toMatchObject({
      isError: false,
      details: { codeChanged: false, visibilityChanged: false, changed: false },
    });
    expect(noOp.harness.onActionDone).not.toHaveBeenCalled();
    expect(noOp.harness.readBinding().revision).toBe(0);

    const visible = await run(false, 'visibility-only');
    expect(visible.result).toMatchObject({
      isError: false,
      details: { codeChanged: false, visibilityChanged: true, changed: true },
    });
    expect(visible.harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(visible.harness.readBinding().revision).toBe(1);
    expect(visible.harness.readOpen()).toBe(true);
  });

  it('mints the three-token Draw bundle atomically or returns a stable bounded failure', async () => {
    const ledger = new NativeWhiteboardObservationLedger({ maxClaims: 2 });
    const harness = createHarness({ ledger });
    const current = harness.readBinding();
    const request = execution('wb_draw_code', 'draw-bundle-capacity');
    const params = drawParams(harness.mint('read-capacity', { kind: 'binding' }), current);
    const first = await harness.draw.handler({ request, params });
    const replay = await harness.draw.handler({ request, params });
    expect(first).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(replay).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(ledger.getSizeForTests()).toBe(0);
    expect(ledger.getMintRecordCountForTests()).toBe(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
  });

  it('settles two edits authorized at one revision as one commit and one deterministic stale', async () => {
    const initial = stage([board('board-1', [codeElement()])]);
    const harness = createHarness({ initialStage: initial, open: true });
    const current = harness.readBinding();
    const tokenA = harness.mint('concurrent-A', {
      kind: 'code',
      elementId: 'legacy-code',
      complete: true,
    });
    const tokenB = harness.mint('concurrent-B', {
      kind: 'code',
      elementId: 'legacy-code',
      complete: true,
    });
    const common = {
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
      elementId: 'legacy-code',
      operation: 'replace_lines',
      lineIds: ['legacy-A'],
    };
    const first = await harness.edit.handler({
      request: execution('wb_edit_code', 'concurrent-edit-A'),
      params: { ...common, observationToken: tokenA, content: 'const a = 2;' },
    });
    const second = await harness.edit.handler({
      request: execution('wb_edit_code', 'concurrent-edit-B'),
      params: { ...common, observationToken: tokenB, content: 'const a = 3;' },
    });
    expect(first.isError).toBe(false);
    expect(second).toMatchObject({
      isError: true,
      details: { code: 'STALE_STATE', mutationMayHaveCommitted: false },
    });
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.readBinding().revision).toBe(current.revision + 1);
    const element = harness.store.getState().stage?.whiteboard?.[0].elements[0] as PPTCodeElement;
    expect(element.lines[0]).toEqual({ id: 'legacy-A', content: 'const a = 2;' });
  });

  it('mints the two-token Edit bundle atomically and preserves the committed outcome on replay', async () => {
    const ledger = new NativeWhiteboardObservationLedger({ maxClaims: 1 });
    const initial = stage([board('board-1', [codeElement()])]);
    const harness = createHarness({ initialStage: initial, open: true, ledger });
    const current = harness.readBinding();
    const request = execution('wb_edit_code', 'edit-bundle-capacity');
    const params = {
      observationToken: harness.mint('read-edit-capacity', {
        kind: 'code',
        elementId: 'legacy-code',
        complete: true,
      }),
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
      elementId: 'legacy-code',
      operation: 'replace_lines',
      lineIds: ['legacy-A'],
      content: 'const a = 2;',
    };
    const first = await harness.edit.handler({ request, params });
    const replay = await harness.edit.handler({ request, params });
    expect(first).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(replay).toMatchObject({
      isError: true,
      details: { code: 'OBSERVATION_CAPABILITY_LIMIT', status: 'committed' },
    });
    expect(ledger.getSizeForTests()).toBe(0);
    expect(ledger.getMintRecordCountForTests()).toBe(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
  });

  it('reports an Authority-listener failure as replayable uncertain and charges once', async () => {
    const initial = stage([board('board-1', [codeElement()])]);
    const harness = createHarness({ initialStage: initial, open: true });
    harness.authority.subscribe(() => {
      throw new Error('listener failed after commit');
    });
    const current = harness.readBinding();
    const request = execution('wb_edit_code', 'edit-uncertain');
    const params = {
      observationToken: harness.mint('read-edit-uncertain', {
        kind: 'code',
        elementId: 'legacy-code',
        complete: true,
      }),
      expectedWhiteboardId: current.activeWhiteboardId,
      expectedRevision: current.revision,
      elementId: 'legacy-code',
      operation: 'replace_lines',
      lineIds: ['legacy-A'],
      content: 'const a = 2;',
    };
    const first = await harness.edit.handler({ request, params });
    const replay = await harness.edit.handler({ request, params });
    expect(first).toMatchObject({
      isError: true,
      details: {
        code: 'REVISIONED_WHITEBOARD_UNCERTAIN',
        status: 'uncertain',
        mutationMayHaveCommitted: true,
      },
    });
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
    expect(harness.readBinding().revision).toBe(current.revision + 1);
    const element = harness.store.getState().stage?.whiteboard?.[0].elements[0] as PPTCodeElement;
    expect(element.lines[0]).toEqual({ id: 'legacy-A', content: 'const a = 2;' });
  });

  it('rejects a preserved same-execution CE2 namespace before mutation and action accounting', async () => {
    const executionId = 'reserved-prefix-handler';
    const reservedId = deriveRevisionedCodeEditLineId(executionId, 99);
    const initial = stage([
      board('board-1', [
        {
          ...codeElement(),
          lines: [
            { id: reservedId, content: 'reserved' },
            { id: 'legacy-A', content: 'legacy' },
          ],
        },
      ]),
    ]);
    const harness = createHarness({ initialStage: initial, open: false });
    const current = harness.readBinding();
    const result = await harness.edit.handler({
      request: execution('wb_edit_code', executionId),
      params: {
        observationToken: harness.mint('read-reserved-prefix', {
          kind: 'code',
          elementId: 'legacy-code',
          complete: true,
        }),
        expectedWhiteboardId: current.activeWhiteboardId,
        expectedRevision: current.revision,
        elementId: 'legacy-code',
        operation: 'delete_lines',
        lineIds: ['legacy-A'],
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
    expect(harness.events).toHaveLength(1);
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(harness.readBinding()).toMatchObject({ revision: current.revision, open: false });
    expect(
      (harness.store.getState().stage?.whiteboard?.[0].elements[0] as PPTCodeElement).lines,
    ).toEqual([
      { id: reservedId, content: 'reserved' },
      { id: 'legacy-A', content: 'legacy' },
    ]);
  });
});
