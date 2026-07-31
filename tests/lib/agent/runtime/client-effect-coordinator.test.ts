import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
  digestWhiteboardChartV1,
  digestWhiteboardCodeV1,
  digestWhiteboardEditableCodeStateV1,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardLatexV1,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  digestWhiteboardTableV1,
  digestVisibleTextV1,
  isClientEffectAck,
  normalizeWhiteboardChartV1,
  normalizeWhiteboardCodeV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeWhiteboardTableV1,
  resolveActiveEffectBudget,
  type AcceptedTargetBinding,
  type ClientEffectAck,
  type ClientEffectRequest,
  type WhiteboardLatexClientEffectRequest,
  type WhiteboardLatexPostcondition,
  type WhiteboardLineClientEffectRequest,
  type WhiteboardLinePostcondition,
  type WhiteboardShapeClientEffectRequest,
  type WhiteboardShapePostcondition,
  type WhiteboardTextClientEffectRequest,
  type WhiteboardOpenClientEffectRequest,
  type WhiteboardOpenCommittedObservation,
  type WhiteboardChartClientEffectRequest,
  type WhiteboardCodeClientEffectRequest,
  type WhiteboardCodeEditClientEffectRequest,
  type WhiteboardEditableCodeState,
  type WhiteboardTableClientEffectRequest,
} from '@/lib/agent/runtime/client-effect-contract';
import { renderNativeWhiteboardLatexHtmlV1 } from '@/lib/action/whiteboard-latex';
import { ClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

const targetBinding: AcceptedTargetBinding = {
  requestId: 'request-1',
  sessionId: 'session-1',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  whiteboardId: 'whiteboard-1',
  bindingVersion: 1,
};

async function request(
  overrides: Partial<WhiteboardTextClientEffectRequest> = {},
): Promise<WhiteboardTextClientEffectRequest> {
  const expectedContentDigest = await digestVisibleTextV1('hello');
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    kind: 'client_effect',
    traceId: 'trace-1',
    runId: 'run-1',
    agentInvocationId: 'invocation-1',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: 'tool-call-1',
    executionId: 'execution-1',
    idempotencyKey: 'run-1:invocation-1:tool-call-1',
    toolName: 'wb_draw_text',
    args: { content: 'hello' },
    argsDigest: 'sha256:args',
    issuedAt: Date.now(),
    deadlineAt: Date.now() + 10_000,
    attempt: 1,
    target: {
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      messageId: 'invocation-1',
    },
    activeEffectBudgetMs: 2_000,
    postcondition: {
      kind: 'whiteboard_text_exists',
      stableElementId: 'element-1',
      elementType: 'text',
      normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
      expectedContentDigest,
    },
    ...overrides,
  };
}

async function openRequest(
  overrides: Partial<WhiteboardOpenClientEffectRequest> = {},
): Promise<WhiteboardOpenClientEffectRequest> {
  const base = await request();
  return {
    ...base,
    toolName: 'wb_open',
    args: {},
    postcondition: {
      kind: 'whiteboard_open',
      normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
      desiredOpen: true,
    },
    ...overrides,
  };
}

function openCommitted(
  effect: WhiteboardOpenClientEffectRequest,
  overrides: Partial<WhiteboardOpenCommittedObservation> = {},
): Omit<Extract<ClientEffectAck, { status: 'effect_committed' }>, 'postcondition'> & {
  postcondition: WhiteboardOpenCommittedObservation;
} {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'event-open-committed',
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      kind: 'whiteboard_open',
      normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
      whiteboardId: targetBinding.whiteboardId,
      desiredOpen: true,
      observedOpen: true,
      created: false,
      visibilityChanged: true,
      ...overrides,
    },
  };
}

function accepted(
  effect: ClientEffectRequest,
  clientEventId = 'event-accepted',
): Extract<ClientEffectAck, { status: 'accepted' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId,
    status: 'accepted',
    observedAt: Date.now(),
    targetBinding,
  };
}

function committed(
  effect: WhiteboardTextClientEffectRequest,
  clientEventId = 'event-committed',
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId,
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'text',
      normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
      observedContentDigest: effect.postcondition.expectedContentDigest,
      matchingElementCount: 1,
    },
  };
}

async function shapeRequest(): Promise<WhiteboardShapeClientEffectRequest> {
  const shape = normalizeWhiteboardShapeV1({
    shape: 'rectangle',
    x: 80,
    y: 60,
    width: 240,
    height: 160,
    fillColor: '#4477aa',
  });
  return {
    ...(await request()),
    toolName: 'wb_draw_shape',
    args: { shape: 'rectangle', x: 80, y: 60, width: 240, height: 160 },
    postcondition: {
      kind: 'whiteboard_shape_exists',
      stableElementId: 'shape-1',
      elementType: 'shape',
      normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
      expectedShapeDigest: await digestWhiteboardShapeV1(shape),
      ...shape,
    },
  };
}

function shapeCommitted(
  effect: WhiteboardShapeClientEffectRequest,
  overrides: Partial<Omit<WhiteboardShapePostcondition, 'kind' | 'expectedShapeDigest'>> = {},
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'event-shape-committed',
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'shape',
      normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
      observedShapeDigest: effect.postcondition.expectedShapeDigest,
      matchingElementCount: 1,
      shape: effect.postcondition.shape,
      bounds: effect.postcondition.bounds,
      fillColor: effect.postcondition.fillColor,
      ...overrides,
    },
  };
}

async function lineRequest(): Promise<WhiteboardLineClientEffectRequest> {
  const line = normalizeWhiteboardLineV1({
    startX: 360,
    startY: 280,
    endX: 120,
    endY: 80,
    color: '#2255aa',
    width: 3,
    style: 'dashed',
    points: ['', 'arrow'],
  });
  return {
    ...(await request()),
    toolName: 'wb_draw_line',
    args: {
      startX: 360,
      startY: 280,
      endX: 120,
      endY: 80,
      color: '#2255aa',
      width: 3,
      style: 'dashed',
      points: ['', 'arrow'],
    },
    postcondition: {
      kind: 'whiteboard_line_exists',
      stableElementId: 'line-1',
      elementType: 'line',
      normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
      expectedLineDigest: await digestWhiteboardLineV1(line),
      ...line,
    },
  };
}

function lineCommitted(
  effect: WhiteboardLineClientEffectRequest,
  overrides: Partial<Omit<WhiteboardLinePostcondition, 'kind' | 'expectedLineDigest'>> = {},
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'event-line-committed',
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'line',
      normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
      observedLineDigest: effect.postcondition.expectedLineDigest,
      matchingElementCount: 1,
      start: effect.postcondition.start,
      end: effect.postcondition.end,
      strokeColor: effect.postcondition.strokeColor,
      strokeWidth: effect.postcondition.strokeWidth,
      strokeStyle: effect.postcondition.strokeStyle,
      markers: effect.postcondition.markers,
      ...overrides,
    },
  };
}

async function latexRequest(): Promise<WhiteboardLatexClientEffectRequest> {
  const latex = normalizeWhiteboardLatexV1({
    latex: String.raw`\frac{a}{b}`,
    x: 100,
    y: 80,
    width: 400,
    height: 80,
    color: '#113355',
  });
  const html = renderNativeWhiteboardLatexHtmlV1(latex.latex);
  return {
    ...(await request()),
    toolName: 'wb_draw_latex',
    args: {
      latex: latex.latex,
      x: 100,
      y: 80,
      width: 400,
      height: 80,
      color: '#113355',
    },
    postcondition: {
      kind: 'whiteboard_latex_exists',
      stableElementId: 'latex-1',
      elementType: 'latex',
      normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
      expectedFormulaDigest: await digestWhiteboardLatexV1(latex),
      expectedHtmlDigest: await digestWhiteboardLatexHtmlV1(html),
      ...latex,
    },
  };
}

function latexCommitted(
  effect: WhiteboardLatexClientEffectRequest,
  overrides: Partial<
    Omit<WhiteboardLatexPostcondition, 'kind' | 'expectedFormulaDigest' | 'expectedHtmlDigest'>
  > = {},
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'event-latex-committed',
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'latex',
      normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
      observedFormulaDigest: effect.postcondition.expectedFormulaDigest,
      observedHtmlDigest: effect.postcondition.expectedHtmlDigest,
      matchingElementCount: 1,
      latex: effect.postcondition.latex,
      bounds: effect.postcondition.bounds,
      color: effect.postcondition.color,
      renderVersion: effect.postcondition.renderVersion,
      ...overrides,
    },
  };
}

async function tableRequest(): Promise<WhiteboardTableClientEffectRequest> {
  const args = {
    data: [
      ['参数', '作用'],
      ['k', '决定方向'],
    ],
    x: 80,
    y: 60,
    width: 500,
    height: 180,
  };
  const table = normalizeWhiteboardTableV1(args);
  return {
    ...(await request()),
    toolName: 'wb_draw_table',
    args,
    postcondition: {
      kind: 'whiteboard_table_exists',
      stableElementId: 'table-1',
      elementType: 'table',
      normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
      expectedTableDigest: await digestWhiteboardTableV1(table),
      ...table,
    },
  };
}

function tableCommitted(
  effect: WhiteboardTableClientEffectRequest,
  observedTableDigest = effect.postcondition.expectedTableDigest,
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'event-table-committed',
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'table',
      normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
      observedTableDigest,
      matchingElementCount: 1,
    },
  };
}

async function chartRequest(): Promise<WhiteboardChartClientEffectRequest> {
  const args = {
    chartType: 'line' as const,
    x: 80,
    y: 60,
    width: 500,
    height: 260,
    data: {
      labels: ['一月', '二月'],
      legends: ['甲', '乙'],
      series: [
        [1, 2],
        [3, 4],
      ],
    },
  };
  const chart = normalizeWhiteboardChartV1(args);
  return {
    ...(await request()),
    toolName: 'wb_draw_chart',
    args,
    postcondition: {
      kind: 'whiteboard_chart_exists',
      stableElementId: 'chart-1',
      elementType: 'chart',
      normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
      expectedChartDigest: await digestWhiteboardChartV1(chart),
      ...chart,
    },
  };
}

function chartCommitted(
  effect: WhiteboardChartClientEffectRequest,
  observedChartDigest = effect.postcondition.expectedChartDigest,
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'event-chart-committed',
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'chart',
      normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
      observedChartDigest,
      matchingElementCount: 1,
    },
  };
}

async function codeRequest(): Promise<WhiteboardCodeClientEffectRequest> {
  const args = {
    language: 'ts',
    code: 'const slope = 2;\n\nreturn slope;',
    x: 80,
    y: 60,
    width: 560,
    height: 280,
    fileName: 'slope.ts',
  };
  const code = normalizeWhiteboardCodeV1(args);
  return {
    ...(await request()),
    toolName: 'wb_draw_code',
    args,
    postcondition: {
      kind: 'whiteboard_code_exists',
      stableElementId: 'code-1',
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
      expectedCodeDigest: await digestWhiteboardCodeV1(code),
      ...code,
    },
  };
}

function codeCommitted(
  effect: WhiteboardCodeClientEffectRequest,
  observedCodeDigest = effect.postcondition.expectedCodeDigest,
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'event-code-committed',
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding,
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
      observedCodeDigest,
      matchingElementCount: 1,
    },
  };
}

async function codeEditRequest(
  overrides: Partial<WhiteboardCodeEditClientEffectRequest> = {},
): Promise<WhiteboardCodeEditClientEffectRequest> {
  const before: WhiteboardEditableCodeState = {
    language: 'python',
    lines: [{ id: 'L1', content: 'x = 1' }],
    bounds: { x: 80, y: 60, width: 500, height: 300 },
    showLineNumbers: true,
    fontSize: 14,
    rotate: 0,
  };
  const after: WhiteboardEditableCodeState = {
    ...before,
    lines: [{ id: 'L1', content: 'x = 2' }],
  };
  return {
    ...(await request()),
    executionId: 'execution-edit-1',
    idempotencyKey: 'run-1:invocation-1:tool-edit-1',
    toolCallId: 'tool-edit-1',
    toolName: 'wb_edit_code',
    args: {
      elementId: 'code-1',
      operation: 'replace_lines',
      lineIds: ['L1'],
      content: 'x = 2',
    },
    postcondition: {
      kind: 'whiteboard_code_edited',
      stableElementId: 'code-1',
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
      expectedWhiteboardId: 'whiteboard-1',
      expectedBeforeCodeDigest: await digestWhiteboardEditableCodeStateV1(before),
      expectedAfterCodeDigest: await digestWhiteboardEditableCodeStateV1(after),
      expectedAfterCodeState: after,
      noOp: false,
    },
    ...overrides,
  };
}

function codeEditCommitted(
  effect: WhiteboardCodeEditClientEffectRequest,
  overrides: Partial<
    Extract<
      Extract<ClientEffectAck, { status: 'effect_committed' }>['postcondition'],
      { normalizationVersion: typeof CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION }
    >
  > = {},
): Extract<ClientEffectAck, { status: 'effect_committed' }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: `event-${effect.executionId}-committed`,
    status: 'effect_committed',
    observedAt: Date.now(),
    targetBinding: {
      ...targetBinding,
      requestId: effect.target.requestId,
      sessionId: effect.target.sessionId,
      stageId: effect.target.stageId,
      sceneId: effect.target.sceneId,
      whiteboardId: effect.postcondition.expectedWhiteboardId,
    },
    postcondition: {
      stableElementId: effect.postcondition.stableElementId,
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
      expectedWhiteboardId: effect.postcondition.expectedWhiteboardId,
      observedBeforeCodeDigest: effect.postcondition.expectedBeforeCodeDigest,
      observedAfterCodeDigest: effect.postcondition.expectedAfterCodeDigest,
      matchingElementCount: 1,
      noOp: effect.postcondition.noOp,
      ...overrides,
    },
  };
}

describe('ClientEffectCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits past accepted and settles only after a verified commit', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const registered = coordinator.register(effect);
    let settled = false;
    void registered.result.then(() => {
      settled = true;
    });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        accepted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'accepted' } });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        committed(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('settles a shape only after its exact geometry and fill postcondition is verified', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await shapeRequest();
    const registered = coordinator.register(effect);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      accepted(effect),
    );

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        shapeCommitted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('rejects a committed shape whose verified bounds differ from the request', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await shapeRequest();
    const registered = coordinator.register(effect);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      accepted(effect),
    );

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        shapeCommitted(effect, {
          bounds: { ...effect.postcondition.bounds, width: 241 },
        }),
      ),
    ).toMatchObject({
      kind: 'invalid',
      reason: 'Committed postcondition does not match the requested effect.',
      snapshot: { status: 'accepted' },
    });
  });

  it('settles a line only after its exact ordered endpoints, stroke, and markers are verified', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await lineRequest();
    const registered = coordinator.register(effect);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      accepted(effect),
    );

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        lineCommitted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('settles code only after its exact canonical digest is verified', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await codeRequest();
    const registered = coordinator.register(effect);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      accepted(effect),
    );

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        codeCommitted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('rejects a code commit whose canonical source digest differs from the request', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await codeRequest();
    const registered = coordinator.register(effect);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      accepted(effect),
    );

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        codeCommitted(effect, 'sha256:different-code'),
      ),
    ).toMatchObject({
      kind: 'invalid',
      reason: 'Committed postcondition does not match the requested effect.',
      snapshot: { status: 'accepted' },
    });
  });

  it('settles a code edit only after exact whiteboard and before/after digests are verified', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await codeEditRequest();
    const registered = coordinator.register(effect);
    const editBinding = {
      ...targetBinding,
      whiteboardId: effect.postcondition.expectedWhiteboardId,
    };
    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
        ...accepted(effect),
        targetBinding: editBinding,
      }),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'accepted' } });
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        codeEditCommitted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('rejects an edit accepted on another whiteboard or committed with a different before digest', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await codeEditRequest();
    const registered = coordinator.register(effect);
    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
        ...accepted(effect),
        targetBinding: { ...targetBinding, whiteboardId: 'whiteboard-other' },
      }),
    ).toMatchObject({
      kind: 'invalid',
      reason: 'Accepted whiteboard does not match the requested edit target.',
    });

    const validBinding = {
      ...targetBinding,
      whiteboardId: effect.postcondition.expectedWhiteboardId,
    };
    coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
      ...accepted(effect, 'event-edit-accepted'),
      targetBinding: validBinding,
    });
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        codeEditCommitted(effect, {
          observedBeforeCodeDigest: 'sha256:different-before',
        }),
      ),
    ).toMatchObject({
      kind: 'invalid',
      reason: 'Committed postcondition does not match the requested effect.',
      snapshot: { status: 'accepted' },
    });
  });

  it('scopes edit ownership by session and whiteboard while locking the same target across requests', async () => {
    const coordinator = new ClientEffectCoordinator();
    const first = await codeEditRequest();
    coordinator.register(first);

    const otherSession = await codeEditRequest({
      executionId: 'execution-edit-other-session',
      idempotencyKey: 'other-session-key',
      target: { ...first.target, requestId: 'request-2', sessionId: 'session-2' },
    });
    expect(() => coordinator.register(otherSession)).not.toThrow();

    const otherWhiteboard = await codeEditRequest({
      executionId: 'execution-edit-other-whiteboard',
      idempotencyKey: 'other-whiteboard-key',
      postcondition: {
        ...first.postcondition,
        expectedWhiteboardId: 'whiteboard-2',
      },
    });
    expect(() => coordinator.register(otherWhiteboard)).not.toThrow();

    const sameTargetOtherRequest = await codeEditRequest({
      executionId: 'execution-edit-conflict',
      idempotencyKey: 'conflict-key',
      target: { ...first.target, requestId: 'request-concurrent' },
    });
    expect(() => coordinator.register(sameTargetOtherRequest)).toThrow(
      'belongs to another execution in this whiteboard scope',
    );
  });

  it('accepts an edit preparation failure before accepted state', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await codeEditRequest();
    const registered = coordinator.register(effect);
    const failure: ClientEffectAck = {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      executionId: effect.executionId,
      idempotencyKey: effect.idempotencyKey,
      clientEventId: 'event-edit-prepare-failed',
      observedAt: Date.now(),
      status: 'effect_failed',
      error: {
        code: 'CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_MISMATCH',
        message: 'CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_MISMATCH',
        retryable: false,
      },
    };
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        failure,
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_failed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_failed',
      isError: true,
    });
  });

  it('accepts only the exact code-edit commit ACK shape', async () => {
    const effect = await codeEditRequest();
    const valid = codeEditCommitted(effect);
    expect(isClientEffectAck(valid)).toBe(true);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          observedBeforeCodeDigest: '',
        },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          expectedAfterCodeState: effect.postcondition.expectedAfterCodeState,
        },
      }),
    ).toBe(false);
  });

  it('rejects a committed line with reversed endpoint semantics or different markers', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await lineRequest();
    const registered = coordinator.register(effect);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      accepted(effect),
    );

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        lineCommitted(effect, {
          start: effect.postcondition.end,
          end: effect.postcondition.start,
          markers: ['arrow', ''],
        }),
      ),
    ).toMatchObject({
      kind: 'invalid',
      reason: 'Committed postcondition does not match the requested effect.',
      snapshot: { status: 'accepted' },
    });
  });

  it('rejects commit before accepted without settling the execution', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const registered = coordinator.register(effect);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        committed(effect),
      ),
    ).toMatchObject({ kind: 'invalid', snapshot: { status: 'pending' } });
    expect(coordinator.getSnapshot(effect.executionId)).toMatchObject({ status: 'pending' });
  });

  it('freezes the active budget during pause but retains the hard ceiling', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const registered = coordinator.register(effect);
    vi.advanceTimersByTime(1_000);

    coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      executionId: effect.executionId,
      idempotencyKey: effect.idempotencyKey,
      clientEventId: 'pause',
      status: 'presentation_paused',
      observedAt: Date.now(),
    });
    vi.advanceTimersByTime(5_000);
    expect(coordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'pending',
      paused: true,
      activeRemainingMs: 1_000,
    });

    coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      executionId: effect.executionId,
      idempotencyKey: effect.idempotencyKey,
      clientEventId: 'resume',
      status: 'presentation_resumed',
      observedAt: Date.now(),
    });
    vi.advanceTimersByTime(1_000);
    await expect(registered.result).resolves.toMatchObject({ status: 'timed_out' });
  });

  it('cancels at the hard ceiling even while presentation is paused', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request({ deadlineAt: Date.now() + 3_000 });
    const registered = coordinator.register(effect);
    coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      executionId: effect.executionId,
      idempotencyKey: effect.idempotencyKey,
      clientEventId: 'pause',
      status: 'presentation_paused',
      observedAt: Date.now(),
    });

    vi.advanceTimersByTime(3_000);
    await expect(registered.result).resolves.toMatchObject({
      status: 'cancelled',
      error: { code: 'HARD_DEADLINE_EXCEEDED' },
    });
  });

  it('deduplicates exact ACKs and rejects conflicting clientEventId reuse', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const registered = coordinator.register(effect);
    const first = accepted(effect);

    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, first),
    ).toMatchObject({ kind: 'applied' });
    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, first),
    ).toMatchObject({ kind: 'duplicate' });
    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
        ...first,
        status: 'cancelled',
        error: { code: 'CANCELLED', message: 'cancelled', retryable: false },
      }),
    ).toMatchObject({ kind: 'invalid' });
  });

  it('returns the authoritative terminal snapshot for duplicate and late ACKs', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const registered = coordinator.register(effect);
    const first = accepted(effect);

    coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, first);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      committed(effect),
    );

    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, first),
    ).toMatchObject({
      kind: 'duplicate',
      snapshot: { status: 'effect_committed' },
    });
    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
        ...first,
        clientEventId: 'late-pause',
        status: 'presentation_paused',
      }),
    ).toMatchObject({
      kind: 'late',
      snapshot: { status: 'effect_committed' },
    });
  });

  it('returns terminal state before applying the acknowledgement-count limit', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const registered = coordinator.register(effect);
    for (let index = 0; index < 64; index += 1) {
      expect(
        coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
          protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
          executionId: effect.executionId,
          idempotencyKey: effect.idempotencyKey,
          clientEventId: `pause-${index}`,
          status: 'presentation_paused',
          observedAt: Date.now(),
        }),
      ).toMatchObject({ kind: 'applied' });
    }
    coordinator.cancel(effect.executionId, 'SESSION_ENDED', 'Session ended.');

    expect(
      coordinator.acknowledge(effect.executionId, registered.delivery.acknowledgementToken, {
        protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
        executionId: effect.executionId,
        idempotencyKey: effect.idempotencyKey,
        clientEventId: 'late-after-limit',
        status: 'presentation_resumed',
        observedAt: Date.now(),
      }),
    ).toMatchObject({
      kind: 'late',
      snapshot: { status: 'cancelled' },
    });
  });

  it('reuses an exact duplicate registration and rejects a conflicting one', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const first = coordinator.register(effect);
    const duplicate = coordinator.register(effect);

    expect(duplicate.delivery.acknowledgementToken).toBe(first.delivery.acknowledgementToken);
    expect(duplicate.result).toBe(first.result);
    expect(() =>
      coordinator.register({
        ...effect,
        argsDigest: 'sha256:conflict',
      }),
    ).toThrow('conflicts');
  });

  it('uses stable contract identity for a redelivered registration', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const first = coordinator.register(effect);
    const redelivery = coordinator.register({
      ...effect,
      issuedAt: effect.issuedAt + 100,
      deadlineAt: effect.deadlineAt + 100,
      activeEffectBudgetMs: effect.activeEffectBudgetMs - 100,
      attempt: effect.attempt + 1,
    });

    expect(redelivery.delivery.acknowledgementToken).toBe(first.delivery.acknowledgementToken);
    expect(redelivery.delivery.request).toBe(effect);
    expect(() =>
      coordinator.register({
        ...effect,
        target: { ...effect.target, sceneId: 'different-scene' },
      }),
    ).toThrow('conflicts');
  });

  it('rejects a stable element ID owned by another execution', async () => {
    const coordinator = new ClientEffectCoordinator();
    coordinator.register(await request());
    await expect(
      request({
        executionId: 'execution-2',
        toolCallId: 'tool-call-2',
        idempotencyKey: 'run-1:invocation-1:tool-call-2',
      }).then((effect) => coordinator.register(effect)),
    ).rejects.toThrow('belongs to another execution');
  });

  it('authenticates a terminal tombstone and returns its authoritative state', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request();
    const registered = coordinator.register(effect);
    coordinator.cancel(effect.executionId, 'SESSION_ENDED', 'Session ended.');
    coordinator.cleanup(effect.executionId);

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        accepted(effect),
      ),
    ).toMatchObject({
      kind: 'late',
      snapshot: {
        executionId: effect.executionId,
        idempotencyKey: effect.idempotencyKey,
        status: 'cancelled',
        terminalResult: { status: 'cancelled', error: { code: 'SESSION_ENDED' } },
      },
    });
    expect(coordinator.authorize(effect.executionId, 'wrong-token')).toBe('unauthorized');
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        accepted({ ...effect, idempotencyKey: 'conflicting-idempotency-key' }),
      ),
    ).toMatchObject({
      kind: 'invalid',
      reason: 'ACK identity does not match the cleaned-up execution.',
      snapshot: { status: 'cancelled' },
    });
  });

  it.each(['accepted', 'effect_committed'] as const)(
    'rejects a live %s ACK once the authoritative clock reaches the hard deadline',
    async (status) => {
      let clock = Date.now();
      const coordinator = new ClientEffectCoordinator(() => clock);
      const effect = await request({ deadlineAt: clock + 100 });
      const registered = coordinator.register(effect);
      clock = effect.deadlineAt;

      const outcome = coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        status === 'accepted' ? accepted(effect) : committed(effect),
      );

      expect(outcome).toMatchObject({
        kind: 'late',
        snapshot: {
          status: 'cancelled',
          terminalResult: {
            status: 'cancelled',
            error: { code: 'HARD_DEADLINE_EXCEEDED' },
          },
        },
      });
      await expect(registered.result).resolves.toMatchObject({
        status: 'cancelled',
        isError: true,
        completedAt: effect.deadlineAt,
      });
    },
  );

  it('emits auditable trace events without the capability token', async () => {
    const trace: unknown[] = [];
    const coordinator = new ClientEffectCoordinator(Date.now, 256, (event) => trace.push(event));
    const effect = await request();
    const registered = coordinator.register(effect);
    coordinator.acknowledge(
      effect.executionId,
      registered.delivery.acknowledgementToken,
      accepted(effect),
    );
    coordinator.cancel(effect.executionId, 'SESSION_ENDED', 'Session ended.');

    expect(trace).toMatchObject([
      { type: 'registered', status: 'pending' },
      { type: 'ack_applied', ackStatus: 'accepted', status: 'accepted' },
      { type: 'settled', code: 'SESSION_ENDED', status: 'cancelled' },
    ]);
    expect(JSON.stringify(trace)).not.toContain(registered.delivery.acknowledgementToken);
  });

  it('reports zero active budget after an active timeout', async () => {
    const coordinator = new ClientEffectCoordinator();
    const effect = await request({ activeEffectBudgetMs: 2_000 });
    const registered = coordinator.register(effect);

    vi.advanceTimersByTime(2_000);
    await expect(registered.result).resolves.toMatchObject({ status: 'timed_out' });
    expect(coordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'timed_out',
      activeRemainingMs: 0,
    });
  });
});

describe('resolveActiveEffectBudget', () => {
  it('caps the active budget by the remaining hard ceiling and margin', () => {
    expect(
      resolveActiveEffectBudget({
        configuredActiveEffectBudgetMs: 5_000,
        now: 1_000,
        deadlineAt: 4_000,
        settlementSafetyMarginMs: 500,
      }),
    ).toBe(2_500);
  });

  it('returns null when no safe active budget remains', () => {
    expect(
      resolveActiveEffectBudget({
        configuredActiveEffectBudgetMs: 5_000,
        now: 3_800,
        deadlineAt: 4_000,
        settlementSafetyMarginMs: 500,
      }),
    ).toBeNull();
  });
});

describe('visible text canonicalization', () => {
  it('normalizes line endings, NBSP, Unicode composition, and outer whitespace', async () => {
    await expect(digestVisibleTextV1('  e\u0301\r\nx\u00a0y  ')).resolves.toBe(
      await digestVisibleTextV1('é\nx y'),
    );
  });
});

describe('isClientEffectAck', () => {
  it('accepts only exact status variants with finite and non-blank identity', async () => {
    const effect = await request();
    const valid = accepted(effect);
    expect(isClientEffectAck(valid)).toBe(true);

    const invalid: unknown[] = [
      { ...valid, executionId: '   ' },
      { ...valid, clientEventId: '' },
      { ...valid, observedAt: Number.NaN },
      { ...valid, observedAt: Number.POSITIVE_INFINITY },
      { ...valid, unexpected: true },
      { ...valid, targetBinding: { ...valid.targetBinding, bindingVersion: 0 } },
      {
        ...committed(effect),
        postcondition: {
          ...committed(effect).postcondition,
          normalizationVersion: 'unknown',
        },
      },
      {
        ...committed(effect),
        postcondition: {
          ...committed(effect).postcondition,
          matchingElementCount: 2,
        },
      },
      {
        protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
        executionId: effect.executionId,
        idempotencyKey: effect.idempotencyKey,
        clientEventId: 'failed',
        observedAt: Date.now(),
        status: 'effect_failed',
        error: { code: 'FAILED', message: 'failed' },
      },
      {
        protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
        executionId: effect.executionId,
        idempotencyKey: effect.idempotencyKey,
        clientEventId: 'pause',
        observedAt: Date.now(),
        status: 'presentation_paused',
        targetBinding,
      },
    ];

    for (const candidate of invalid) expect(isClientEffectAck(candidate)).toBe(false);
  });

  it('accepts the exact shape commit variant and rejects malformed shape state', async () => {
    const effect = await shapeRequest();
    const valid = shapeCommitted(effect);
    expect(isClientEffectAck(valid)).toBe(true);

    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          bounds: { ...effect.postcondition.bounds, width: Number.NaN },
        },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          unexpected: true,
        },
      }),
    ).toBe(false);
  });

  it('accepts the exact line commit variant and rejects malformed line state', async () => {
    const effect = await lineRequest();
    const valid = lineCommitted(effect);
    expect(isClientEffectAck(valid)).toBe(true);

    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          start: { x: Number.NaN, y: effect.postcondition.start.y },
        },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          markers: ['', 'dot'],
        },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          unexpected: true,
        },
      }),
    ).toBe(false);
  });

  it('settles LaTeX only for the exact formula, HTML digest, bounds, and render version', async () => {
    const effect = await latexRequest();
    const coordinator = new ClientEffectCoordinator();
    const registered = coordinator.register(effect);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        accepted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'accepted' } });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        latexCommitted(effect, { latex: 'x+1' }),
      ),
    ).toMatchObject({ kind: 'invalid' });
    expect(coordinator.getSnapshot(effect.executionId)).toMatchObject({ status: 'accepted' });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        latexCommitted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('accepts the exact LaTeX ACK variant and rejects extra or malformed derived state', async () => {
    const effect = await latexRequest();
    const valid = latexCommitted(effect);
    expect(isClientEffectAck(valid)).toBe(true);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, observedHtmlDigest: '' },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: {
          ...valid.postcondition,
          bounds: { ...effect.postcondition.bounds, height: Number.NaN },
        },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, unexpected: true },
      }),
    ).toBe(false);
  });

  it('settles a table only for the exact bounded digest ACK', async () => {
    const effect = await tableRequest();
    const coordinator = new ClientEffectCoordinator();
    const registered = coordinator.register(effect);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        accepted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'accepted' } });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        tableCommitted(effect, 'sha256:wrong'),
      ),
    ).toMatchObject({ kind: 'invalid' });
    expect(coordinator.getSnapshot(effect.executionId)).toMatchObject({ status: 'accepted' });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        tableCommitted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('accepts only the minimal exact table ACK variant', async () => {
    const effect = await tableRequest();
    const valid = tableCommitted(effect);
    expect(isClientEffectAck(valid)).toBe(true);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, observedTableDigest: '' },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, data: effect.postcondition.data },
      }),
    ).toBe(false);
  });

  it('settles a chart only for the exact bounded digest ACK', async () => {
    const effect = await chartRequest();
    const coordinator = new ClientEffectCoordinator();
    const registered = coordinator.register(effect);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        accepted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'accepted' } });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        chartCommitted(effect, 'sha256:wrong'),
      ),
    ).toMatchObject({ kind: 'invalid' });
    expect(coordinator.getSnapshot(effect.executionId)).toMatchObject({ status: 'accepted' });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        chartCommitted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      isError: false,
    });
  });

  it('accepts only the minimal exact chart ACK variant', async () => {
    const effect = await chartRequest();
    const valid = chartCommitted(effect);
    expect(isClientEffectAck(valid)).toBe(true);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, observedChartDigest: '' },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, data: effect.postcondition.data },
      }),
    ).toBe(false);
  });

  it('settles wb_open only with its exact lifecycle postcondition and preserves it in terminal state', async () => {
    const effect = await openRequest();
    const coordinator = new ClientEffectCoordinator();
    const registered = coordinator.register(effect);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        accepted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'accepted' } });

    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        openCommitted(effect, { observedOpen: false as true }),
      ),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        openCommitted(effect, { whiteboardId: 'wrong-whiteboard' }),
      ),
    ).toMatchObject({ kind: 'invalid' });

    const committedAck = openCommitted(effect, { created: true, visibilityChanged: true });
    expect(isClientEffectAck(committedAck)).toBe(true);
    expect(
      isClientEffectAck({
        ...committedAck,
        postcondition: {
          ...committedAck.postcondition,
          normalizationVersion: 'maic.whiteboard-visibility.v0',
        },
      }),
    ).toBe(false);
    const { observedOpen: _observedOpen, ...missingObservedOpen } = committedAck.postcondition;
    expect(isClientEffectAck({ ...committedAck, postcondition: missingObservedOpen })).toBe(false);
    expect(
      isClientEffectAck({
        ...committedAck,
        postcondition: { ...committedAck.postcondition, observation: 'duplicate-wire-field' },
      }),
    ).toBe(false);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registered.delivery.acknowledgementToken,
        committedAck,
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      committedObservation: committedAck.postcondition,
    });
  });

  it('uses one stage-scoped lifecycle owner across scenes and rejects concurrent wb_open', async () => {
    const first = await openRequest();
    const second = await openRequest({
      executionId: 'execution-open-2',
      toolCallId: 'tool-call-open-2',
      idempotencyKey: 'run-1:invocation-1:tool-call-open-2',
      target: { ...first.target, sceneId: 'scene-2' },
    });
    const coordinator = new ClientEffectCoordinator();
    coordinator.register(first);
    expect(() => coordinator.register(second)).toThrow('CLIENT_EFFECT_RESOURCE_BUSY');
  });
});
