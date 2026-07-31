import { describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import { BrowserClientEffectRuntime } from '@/lib/agent/client/client-effect-runtime';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestWhiteboardChartV1,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardLatexV1,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  digestWhiteboardTableV1,
  digestVisibleTextV1,
  normalizeWhiteboardChartV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeWhiteboardTableV1,
  type ClientEffectAck,
  type ClientEffectDelivery,
} from '@/lib/agent/runtime/client-effect-contract';
import { renderNativeWhiteboardLatexHtmlV1 } from '@/lib/action/whiteboard-latex';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

function createStore(): StageStore {
  let state = {
    stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 1, whiteboard: [] },
    scenes: [{ id: 'scene-1' }],
    currentSceneId: 'scene-1',
    mode: 'playback' as const,
  };
  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
  } as unknown as StageStore;
}

async function delivery(): Promise<ClientEffectDelivery> {
  return {
    acknowledgementToken: 'capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-1',
      runId: 'run-1',
      agentInvocationId: 'message-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-call-1',
      executionId: 'execution-1',
      idempotencyKey: 'run-1:message-1:tool-call-1',
      toolName: 'wb_draw_text',
      args: { content: 'k 决定方向', x: 100, y: 120 },
      argsDigest: 'sha256:args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_text_exists',
        stableElementId: 'element-1',
        elementType: 'text',
        normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
        expectedContentDigest: await digestVisibleTextV1('k 决定方向'),
      },
    },
  };
}

async function shapeDelivery(): Promise<ClientEffectDelivery> {
  const shape = normalizeWhiteboardShapeV1({
    shape: 'triangle',
    x: 200,
    y: 100,
    width: 260,
    height: 180,
    fillColor: '#8844cc',
  });
  return {
    acknowledgementToken: 'shape-capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-shape-1',
      runId: 'run-shape-1',
      agentInvocationId: 'message-shape-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-call-shape-1',
      executionId: 'execution-shape-1',
      idempotencyKey: 'run-shape-1:message-shape-1:tool-call-shape-1',
      toolName: 'wb_draw_shape',
      args: {
        shape: 'triangle',
        x: 200,
        y: 100,
        width: 260,
        height: 180,
        fillColor: '#8844cc',
      },
      argsDigest: 'sha256:shape-args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-shape-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_shape_exists',
        stableElementId: 'shape-element-1',
        elementType: 'shape',
        normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
        expectedShapeDigest: await digestWhiteboardShapeV1(shape),
        ...shape,
      },
    },
  };
}

async function lineDelivery(): Promise<ClientEffectDelivery> {
  const line = normalizeWhiteboardLineV1({
    startX: 420,
    startY: 300,
    endX: 120,
    endY: 80,
    color: '#2266aa',
    width: 4,
    style: 'dashed',
    points: ['', 'arrow'],
  });
  return {
    acknowledgementToken: 'line-capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-line-1',
      runId: 'run-line-1',
      agentInvocationId: 'message-line-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-call-line-1',
      executionId: 'execution-line-1',
      idempotencyKey: 'run-line-1:message-line-1:tool-call-line-1',
      toolName: 'wb_draw_line',
      args: {
        startX: 420,
        startY: 300,
        endX: 120,
        endY: 80,
        color: '#2266aa',
        width: 4,
        style: 'dashed',
        points: ['', 'arrow'],
      },
      argsDigest: 'sha256:line-args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-line-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_line_exists',
        stableElementId: 'line-element-1',
        elementType: 'line',
        normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
        expectedLineDigest: await digestWhiteboardLineV1(line),
        ...line,
      },
    },
  };
}

async function latexDelivery(): Promise<ClientEffectDelivery> {
  const latex = normalizeWhiteboardLatexV1({
    latex: String.raw`\frac{a}{b}`,
    x: 120,
    y: 80,
    width: 400,
    height: 80,
    color: '#224466',
  });
  const html = renderNativeWhiteboardLatexHtmlV1(latex.latex);
  return {
    acknowledgementToken: 'latex-capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-latex-1',
      runId: 'run-latex-1',
      agentInvocationId: 'message-latex-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-call-latex-1',
      executionId: 'execution-latex-1',
      idempotencyKey: 'run-latex-1:message-latex-1:tool-call-latex-1',
      toolName: 'wb_draw_latex',
      args: {
        latex: latex.latex,
        x: 120,
        y: 80,
        width: 400,
        height: 80,
        color: '#224466',
      },
      argsDigest: 'sha256:latex-args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-latex-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_latex_exists',
        stableElementId: 'latex-element-1',
        elementType: 'latex',
        normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
        expectedFormulaDigest: await digestWhiteboardLatexV1(latex),
        expectedHtmlDigest: await digestWhiteboardLatexHtmlV1(html),
        ...latex,
      },
    },
  };
}

async function tableDelivery(): Promise<ClientEffectDelivery> {
  const args = {
    data: [
      ['参数', '作用'],
      ['k', '决定方向'],
      ['b', '决定高低'],
    ],
    x: 80,
    y: 60,
    width: 600,
    height: 240,
    theme: { color: '#4472c4' },
  };
  const table = normalizeWhiteboardTableV1(args);
  return {
    acknowledgementToken: 'table-capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-table-1',
      runId: 'run-table-1',
      agentInvocationId: 'message-table-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-call-table-1',
      executionId: 'execution-table-1',
      idempotencyKey: 'run-table-1:message-table-1:tool-call-table-1',
      toolName: 'wb_draw_table',
      args,
      argsDigest: 'sha256:table-args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-table-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_table_exists',
        stableElementId: 'table-element-1',
        elementType: 'table',
        normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
        expectedTableDigest: await digestWhiteboardTableV1(table),
        ...table,
      },
    },
  };
}

async function chartDelivery(): Promise<ClientEffectDelivery> {
  const args = {
    chartType: 'line' as const,
    x: 80,
    y: 60,
    width: 600,
    height: 300,
    data: {
      labels: ['一月', '二月'],
      legends: ['甲', '乙'],
      series: [
        [1, 2],
        [3, 4],
      ],
    },
    themeColors: ['#4472c4', '#ed7d31'],
  };
  const chart = normalizeWhiteboardChartV1(args);
  return {
    acknowledgementToken: 'chart-capability',
    request: {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      kind: 'client_effect',
      traceId: 'trace-chart-1',
      runId: 'run-chart-1',
      agentInvocationId: 'message-chart-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'tool-call-chart-1',
      executionId: 'execution-chart-1',
      idempotencyKey: 'run-chart-1:message-chart-1:tool-call-chart-1',
      toolName: 'wb_draw_chart',
      args,
      argsDigest: 'sha256:chart-args',
      issuedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
      target: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        messageId: 'message-chart-1',
      },
      activeEffectBudgetMs: 2_000,
      postcondition: {
        kind: 'whiteboard_chart_exists',
        stableElementId: 'chart-element-1',
        elementType: 'chart',
        normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
        expectedChartDigest: await digestWhiteboardChartV1(chart),
        ...chart,
      },
    },
  };
}

describe('BrowserClientEffectRuntime', () => {
  it('invokes the default browser fetch with the global receiver', async () => {
    const acknowledgements: ClientEffectAck[] = [];
    const browserFetch = vi.fn(function (
      this: typeof globalThis,
      _url: string | URL | Request,
      init?: RequestInit,
    ) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
      acknowledgements.push(ack);
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', browserFetch);
    try {
      const runtime = new BrowserClientEffectRuntime({
        sessionId: 'session-1',
        requestId: 'request-1',
        store: createStore(),
        waitForPresentation: async () => {},
        ensureWhiteboardVisible: async () => {},
      });

      await expect(runtime.execute(await delivery(), new AbortController().signal)).resolves.toBe(
        'effect_committed',
      );
      expect(acknowledgements.map((ack) => ack.status)).toEqual([
        'presentation_paused',
        'presentation_resumed',
        'accepted',
        'effect_committed',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('freezes presentation time, commits once, and returns the verified browser result', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const fetchAck = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
      acknowledgements.push(ack);
      return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    let releasePresentation!: () => void;
    const presentation = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck,
      waitForPresentation: () => presentation,
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await delivery();

    runtime.reserve(effect);
    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);
    await vi.waitFor(() =>
      expect(acknowledgements.map((ack) => ack.status)).toEqual(['presentation_paused']),
    );
    releasePresentation();

    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('executes a shape once and ACKs its verified geometry to the same server execution', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await shapeDelivery();

    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);

    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    if (effect.request.postcondition.kind !== 'whiteboard_shape_exists') {
      throw new Error('Expected a shape delivery.');
    }
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    const committed = acknowledgements.at(-1);
    expect(committed).toMatchObject({
      executionId: effect.request.executionId,
      idempotencyKey: effect.request.idempotencyKey,
      status: 'effect_committed',
      postcondition: {
        stableElementId: effect.request.postcondition.stableElementId,
        elementType: 'shape',
        observedShapeDigest: effect.request.postcondition.expectedShapeDigest,
        shape: 'triangle',
        bounds: { x: 200, y: 100, width: 260, height: 180 },
        fillColor: '#8844cc',
        matchingElementCount: 1,
      },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('executes a directed line once and ACKs its verified ordered state', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await lineDelivery();

    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);

    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    if (effect.request.toolName !== 'wb_draw_line') {
      throw new Error('Expected a line delivery.');
    }
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    expect(acknowledgements.at(-1)).toMatchObject({
      executionId: effect.request.executionId,
      idempotencyKey: effect.request.idempotencyKey,
      status: 'effect_committed',
      postcondition: {
        stableElementId: effect.request.postcondition.stableElementId,
        elementType: 'line',
        observedLineDigest: effect.request.postcondition.expectedLineDigest,
        start: { x: 420, y: 300 },
        end: { x: 120, y: 80 },
        strokeColor: '#2266aa',
        strokeWidth: 4,
        strokeStyle: 'dashed',
        markers: ['', 'arrow'],
        matchingElementCount: 1,
      },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('executes one formula and ACKs exact source, derived HTML digest, and geometry', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await latexDelivery();

    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);
    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    if (effect.request.postcondition.kind !== 'whiteboard_latex_exists') {
      throw new Error('Expected a LaTeX delivery.');
    }
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    expect(acknowledgements.at(-1)).toMatchObject({
      status: 'effect_committed',
      postcondition: {
        stableElementId: effect.request.postcondition.stableElementId,
        elementType: 'latex',
        observedFormulaDigest: effect.request.postcondition.expectedFormulaDigest,
        observedHtmlDigest: effect.request.postcondition.expectedHtmlDigest,
        latex: String.raw`\frac{a}{b}`,
        bounds: { x: 120, y: 80, width: 400, height: 80 },
        color: '#224466',
        matchingElementCount: 1,
      },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('executes one table and ACKs only its verified bounded digest result', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await tableDelivery();

    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);
    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    if (effect.request.postcondition.kind !== 'whiteboard_table_exists') {
      throw new Error('Expected a table delivery.');
    }
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    const committed = acknowledgements.at(-1);
    expect(committed).toMatchObject({
      status: 'effect_committed',
      postcondition: {
        stableElementId: effect.request.postcondition.stableElementId,
        elementType: 'table',
        observedTableDigest: effect.request.postcondition.expectedTableDigest,
        matchingElementCount: 1,
      },
    });
    expect(JSON.stringify(committed)).not.toContain('决定方向');
    expect(new TextEncoder().encode(JSON.stringify(committed)).byteLength).toBeLessThan(8 * 1024);
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('executes one chart and ACKs only its verified bounded digest result', async () => {
    const store = createStore();
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store,
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await chartDelivery();

    const first = runtime.execute(effect, new AbortController().signal);
    const duplicate = runtime.execute(effect, new AbortController().signal);
    await expect(first).resolves.toBe('effect_committed');
    await expect(duplicate).resolves.toBe('effect_committed');
    if (effect.request.postcondition.kind !== 'whiteboard_chart_exists') {
      throw new Error('Expected a chart delivery.');
    }
    expect(acknowledgements.map((ack) => ack.status)).toEqual([
      'presentation_paused',
      'presentation_resumed',
      'accepted',
      'effect_committed',
    ]);
    const committed = acknowledgements.at(-1);
    expect(committed).toMatchObject({
      status: 'effect_committed',
      postcondition: {
        stableElementId: effect.request.postcondition.stableElementId,
        elementType: 'chart',
        observedChartDigest: effect.request.postcondition.expectedChartDigest,
        matchingElementCount: 1,
      },
    });
    expect(JSON.stringify(committed)).not.toContain('一月');
    expect(new TextEncoder().encode(JSON.stringify(committed)).byteLength).toBeLessThan(8 * 1024);
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('rejects a duplicate line reservation whose direction or markers changed', async () => {
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: vi.fn(),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await lineDelivery();
    if (effect.request.toolName !== 'wb_draw_line') {
      throw new Error('Expected a line delivery.');
    }
    const lineRequest = effect.request;
    runtime.reserve(effect);

    expect(() =>
      runtime.reserve({
        ...effect,
        request: {
          ...lineRequest,
          postcondition: {
            ...lineRequest.postcondition,
            start: lineRequest.postcondition.end,
            end: lineRequest.postcondition.start,
            markers: ['arrow', ''],
          },
        },
      }),
    ).toThrow('CLIENT_EFFECT_DUPLICATE_CONFLICT');
  });

  it('cancels a presentation wait on request abort without leaving a pending execution', async () => {
    const acknowledgements: ClientEffectAck[] = [];
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        acknowledgements.push(ack);
        return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: (_executionId, signal) =>
        new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('Operation aborted', 'AbortError'));
          signal.addEventListener('abort', rejectAbort, { once: true });
          if (signal.aborted) rejectAbort();
        }),
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await delivery();
    const controller = new AbortController();
    const execution = runtime.execute(effect, controller.signal);
    controller.abort();

    await expect(execution).resolves.toBe('cancelled');
    expect(acknowledgements.map((ack) => ack.status)).toEqual(['presentation_paused', 'cancelled']);
  });

  it('settles a paused execution at its hard deadline without waiting for resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    try {
      const acknowledgements: ClientEffectAck[] = [];
      const store = createStore();
      const runtime = new BrowserClientEffectRuntime({
        sessionId: 'session-1',
        requestId: 'request-1',
        store,
        fetchAck: async (_url, init) => {
          const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
          acknowledgements.push(ack);
          return new Response(JSON.stringify({ success: true, state: { status: ack.status } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        waitForPresentation: async () => {},
        ensureWhiteboardVisible: async () => {},
      });
      runtime.pause();
      const effect = await delivery();
      effect.request.deadlineAt = Date.now() + 100;
      const execution = runtime.execute(effect, new AbortController().signal);

      await vi.advanceTimersByTimeAsync(101);

      await expect(execution).resolves.toBe('cancelled');
      expect(acknowledgements.map((ack) => ack.status)).toEqual(['presentation_paused']);
      expect(
        store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles locally when the ACK channel fails instead of leaving a hanging promise', async () => {
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: async () => {
        throw new Error('network unavailable');
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(await delivery(), new AbortController().signal)).resolves.toBe(
      'cancelled',
    );
  });

  it('rejects a duplicate execution when its capability token changes', async () => {
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: vi.fn(),
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });
    const effect = await delivery();
    runtime.reserve(effect);

    expect(() =>
      runtime.reserve({ ...effect, acknowledgementToken: 'different-capability' }),
    ).toThrow('CLIENT_EFFECT_DUPLICATE_CONFLICT');
  });

  it('does not report success when a late commit receives authoritative timed_out state', async () => {
    const runtime = new BrowserClientEffectRuntime({
      sessionId: 'session-1',
      requestId: 'request-1',
      store: createStore(),
      fetchAck: async (_url, init) => {
        const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
        const status = ack.status === 'effect_committed' ? 'timed_out' : ack.status;
        return new Response(JSON.stringify({ success: true, state: { status } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(await delivery(), new AbortController().signal)).resolves.toBe(
      'timed_out',
    );
  });
});
