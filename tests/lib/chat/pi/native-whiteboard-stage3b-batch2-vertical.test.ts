import { describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { BrowserRevisionedWhiteboardEffectRuntime } from '@/lib/agent/client/revisioned-whiteboard-effect-runtime';
import { RevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import { REVISIONED_WHITEBOARD_ACK_HEADER } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type { ClientEffectExecutionRequest } from '@/lib/agent/runtime/native-child-contract';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import {
  buildInternalRevisionedWhiteboardDrawChartTool,
  buildInternalRevisionedWhiteboardDrawLatexTool,
  buildInternalRevisionedWhiteboardDrawTableTool,
} from '@/lib/chat/pi/tools/native-whiteboard-v2-draw';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

type Batch2ToolName = 'wb_draw_latex' | 'wb_draw_table' | 'wb_draw_chart';

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

function execution(toolName: Batch2ToolName, executionId: string): ClientEffectExecutionRequest {
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

function params(
  toolName: Batch2ToolName,
  observationToken: string,
  whiteboardId: string | null,
  revision: number,
) {
  const common = {
    observationToken,
    expectedWhiteboardId: whiteboardId,
    expectedRevision: revision,
  };
  switch (toolName) {
    case 'wb_draw_latex':
      return { ...common, latex: '\\frac{x}{2}', x: 20, y: 30, width: 300, height: 80 };
    case 'wb_draw_table':
      return {
        ...common,
        data: [
          ['<b>&', 'Value'],
          ['A', '1'],
        ],
        x: 20,
        y: 30,
        width: 400,
        height: 120,
      };
    case 'wb_draw_chart':
      return {
        ...common,
        chartType: 'bar' as const,
        x: 20,
        y: 30,
        width: 500,
        height: 300,
        data: { labels: ['A'], legends: ['S'], series: [[1]] },
        themeColors: ['#ed7d31', 'rgba(68, 114, 196, 0.1234)'],
      };
  }
}

function createHarness(
  toolName: Batch2ToolName,
  opts: {
    afterAccepted?: (
      authority: WhiteboardEnvironmentAuthority,
      store: StoreApi<{ stage: Stage | null }>,
    ) => void;
  } = {},
) {
  let open = false;
  const initialStage = stage();
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: initialStage }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  const coordinator = new RevisionedWhiteboardCoordinator();
  const ledger = new NativeWhiteboardObservationLedger();
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
      const outcome = coordinator.applyAck(token, ack);
      if (ack.status === 'accepted' && outcome.kind === 'applied') {
        opts.afterAccepted?.(authority, store);
      }
      return new Response('{}', {
        status: outcome.kind === 'applied' || outcome.kind === 'duplicate' ? 200 : 409,
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
    canExecute: () => true,
    onActionDone,
    send: async (event: StatelessEvent) => {
      events.push(event);
      if (event.type === 'revisioned_client_effect') await browser.execute(event.data);
    },
  };
  const bundle =
    toolName === 'wb_draw_latex'
      ? buildInternalRevisionedWhiteboardDrawLatexTool(toolOptions)
      : toolName === 'wb_draw_table'
        ? buildInternalRevisionedWhiteboardDrawTableTool(toolOptions)
        : buildInternalRevisionedWhiteboardDrawChartTool(toolOptions);
  const readBinding = () => {
    const snapshot = authority.querySnapshot();
    if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
    return snapshot.value;
  };
  const mint = (queryId: string) => {
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
  return { authority, store, ledger, bundle, events, onActionDone, readBinding, mint };
}

describe('internal Stage 3B Batch 2 renderer-backed vertical slices', () => {
  it.each(['wb_draw_latex', 'wb_draw_table', 'wb_draw_chart'] as const)(
    'commits and exact-replays %s through Browser Authority CAS',
    async (toolName) => {
      const harness = createHarness(toolName);
      const before = harness.readBinding();
      const request = execution(toolName, toolName + '-success');
      const input = params(
        toolName,
        harness.mint(toolName + '-read'),
        before.activeWhiteboardId,
        before.revision,
      );
      const first = await harness.bundle.handler({ request, params: input });
      expect(first).toMatchObject({
        isError: false,
        details: {
          status: 'committed',
          observationTokens: {
            bindingObservationToken: expect.any(String),
            targetObservationToken: expect.any(String),
          },
        },
      });
      const firstDetails = first.details as {
        stableElementId: string;
        observationTokens: {
          bindingObservationToken: string;
          targetObservationToken: string;
        };
      };
      expect(
        harness.ledger.getClaimForTests(firstDetails.observationTokens.bindingObservationToken),
      ).toMatchObject({ coverage: { kind: 'binding' } });
      expect(
        harness.ledger.getClaimForTests(firstDetails.observationTokens.targetObservationToken),
      ).toMatchObject({
        coverage: { kind: 'element', elementId: firstDetails.stableElementId },
      });
      expect(harness.events).toHaveLength(1);
      expect(harness.onActionDone).toHaveBeenCalledTimes(1);
      expect(harness.readBinding()).toMatchObject({ revision: before.revision + 1, open: true });
      expect(harness.store.getState().stage?.whiteboard?.[0].elements[0]?.type).toBe(
        toolName === 'wb_draw_latex' ? 'latex' : toolName === 'wb_draw_table' ? 'table' : 'chart',
      );

      const claimCount = harness.ledger.getSizeForTests();
      const replay = await harness.bundle.handler({ request, params: input });
      expect(replay).toMatchObject({ isError: false, details: { replayedCapabilities: true } });
      expect(harness.events).toHaveLength(1);
      expect(harness.onActionDone).toHaveBeenCalledTimes(1);
      expect(harness.ledger.getSizeForTests()).toBe(claimCount);
      expect(harness.store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    },
  );

  it.each(['wb_draw_latex', 'wb_draw_table', 'wb_draw_chart'] as const)(
    'returns STALE_STATE for %s and requires a fresh wb_read capability',
    async (toolName) => {
      const harness = createHarness(toolName);
      const staleBinding = harness.readBinding();
      const staleToken = harness.mint(toolName + '-stale');
      const externalBoard: Whiteboard = {
        id: 'external-board',
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        elements: [],
        background: { type: 'solid', color: '#ffffff' },
        animations: [],
      };
      expect(
        harness.authority.transact({
          label: 'test.external-change',
          writes: [
            {
              label: 'replace-board',
              write: () =>
                harness.store.setState({
                  stage: { ...harness.store.getState().stage!, whiteboard: [externalBoard] },
                }),
            },
          ],
          preferredActiveWhiteboardId: externalBoard.id,
        }),
      ).toMatchObject({ ok: true, changed: true });

      const stale = await harness.bundle.handler({
        request: execution(toolName, toolName + '-stale-execution'),
        params: params(
          toolName,
          staleToken,
          staleBinding.activeWhiteboardId,
          staleBinding.revision,
        ),
      });
      expect(stale).toMatchObject({
        isError: true,
        details: { code: 'STALE_STATE', mutationMayHaveCommitted: false },
      });
      expect(harness.onActionDone).not.toHaveBeenCalled();

      const fresh = harness.readBinding();
      const copied = await harness.bundle.handler({
        request: execution(toolName, toolName + '-copied-revision'),
        params: params(toolName, staleToken, fresh.activeWhiteboardId, fresh.revision),
      });
      expect(copied).toMatchObject({
        isError: true,
        details: { code: 'OBSERVATION_CAPABILITY_INVALID' },
      });

      const success = await harness.bundle.handler({
        request: execution(toolName, toolName + '-fresh-execution'),
        params: params(
          toolName,
          harness.mint(toolName + '-fresh'),
          fresh.activeWhiteboardId,
          fresh.revision,
        ),
      });
      expect(success.isError).toBe(false);
      expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['wb_draw_latex', 'wb_draw_table', 'wb_draw_chart'] as const)(
    'keeps the accepted-to-CAS race for %s deterministic and action-free',
    async (toolName) => {
      const harness = createHarness(toolName, {
        afterAccepted: (authority, store) => {
          const current = store.getState().stage!;
          const racingBoard: Whiteboard = {
            id: 'racing-board',
            viewportSize: 1000,
            viewportRatio: 16 / 9,
            elements: [],
            background: { type: 'solid', color: '#ffffff' },
            animations: [],
          };
          expect(
            authority.transact({
              label: 'test.accepted-race',
              writes: [
                {
                  label: 'replace-board',
                  write: () => store.setState({ stage: { ...current, whiteboard: [racingBoard] } }),
                },
              ],
              preferredActiveWhiteboardId: racingBoard.id,
            }),
          ).toMatchObject({ ok: true, changed: true });
        },
      });
      const before = harness.readBinding();
      const result = await harness.bundle.handler({
        request: execution(toolName, toolName + '-accepted-race'),
        params: params(
          toolName,
          harness.mint(toolName + '-accepted-race-read'),
          before.activeWhiteboardId,
          before.revision,
        ),
      });
      expect(result).toMatchObject({
        isError: true,
        details: { code: 'STALE_STATE', mutationMayHaveCommitted: false },
      });
      expect(harness.onActionDone).not.toHaveBeenCalled();
      expect(harness.store.getState().stage?.whiteboard?.[0]).toMatchObject({
        id: 'racing-board',
        elements: [],
      });
    },
  );

  it.each([
    ['wb_draw_latex', { latex: '\\frac{', x: 10, y: 10 }],
    ['wb_draw_table', { data: [['A'], ['B', 'C']], x: 10, y: 10, width: 300, height: 100 }],
    [
      'wb_draw_chart',
      {
        chartType: 'bar',
        x: 10,
        y: 10,
        width: 300,
        height: 200,
        data: { labels: ['A'], legends: ['S'], series: [[1]] },
        themeColors: ['ff0000'],
      },
    ],
  ] as const)(
    'rejects invalid %s intent before delivery and preserves the read capability',
    async (toolName, invalidIntent) => {
      const harness = createHarness(toolName);
      const before = harness.readBinding();
      const token = harness.mint(toolName + '-invalid');
      const result = await harness.bundle.handler({
        request: execution(toolName, toolName + '-invalid-execution'),
        params: {
          observationToken: token,
          expectedWhiteboardId: before.activeWhiteboardId,
          expectedRevision: before.revision,
          ...invalidIntent,
        },
      });
      expect(result).toMatchObject({
        isError: true,
        details: { code: 'REVISIONED_WHITEBOARD_INTENT_INVALID' },
      });
      expect(harness.events).toHaveLength(0);
      expect(harness.onActionDone).not.toHaveBeenCalled();
      expect(harness.ledger.getClaimForTests(token)).toBeDefined();
    },
  );
});
