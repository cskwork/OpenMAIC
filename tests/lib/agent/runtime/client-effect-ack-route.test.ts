import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/pi/client-effects/[executionId]/ack/route';
import type { StageStore } from '@/lib/api/stage-api';
import { BrowserClientEffectRuntime } from '@/lib/agent/client/client-effect-runtime';
import {
  CLIENT_EFFECT_ACK_HEADER,
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardCodeV1,
  digestWhiteboardLatexV1,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  digestVisibleTextV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardCodeV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  type ClientEffectAck,
  type ClientEffectRequest,
} from '@/lib/agent/runtime/client-effect-contract';
import { renderNativeWhiteboardLatexHtmlV1 } from '@/lib/action/whiteboard-latex';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

const flag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD';
const runtimeFlag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME';
let originalFlag: string | undefined;
let originalRuntimeFlag: string | undefined;

async function effectRequest(): Promise<ClientEffectRequest> {
  return {
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
    args: { content: 'hello' },
    argsDigest: 'sha256:args',
    issuedAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    attempt: 1,
    target: {
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      messageId: 'message-1',
    },
    activeEffectBudgetMs: 30_000,
    postcondition: {
      kind: 'whiteboard_text_exists',
      stableElementId: 'element-1',
      elementType: 'text',
      normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
      expectedContentDigest: await digestVisibleTextV1('hello'),
    },
  };
}

async function shapeEffectRequest(): Promise<ClientEffectRequest> {
  const shape = normalizeWhiteboardShapeV1({
    shape: 'circle',
    x: 180,
    y: 90,
    width: 220,
    height: 220,
    fillColor: '#3366cc',
  });
  return {
    ...(await effectRequest()),
    traceId: 'trace-shape-1',
    runId: 'run-shape-1',
    agentInvocationId: 'message-shape-1',
    toolCallId: 'tool-call-shape-1',
    executionId: 'execution-shape-1',
    idempotencyKey: 'run-shape-1:message-shape-1:tool-call-shape-1',
    toolName: 'wb_draw_shape',
    args: {
      shape: 'circle',
      x: 180,
      y: 90,
      width: 220,
      height: 220,
      fillColor: '#3366cc',
    },
    argsDigest: 'sha256:shape-args',
    postcondition: {
      kind: 'whiteboard_shape_exists',
      stableElementId: 'shape-element-1',
      elementType: 'shape',
      normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
      expectedShapeDigest: await digestWhiteboardShapeV1(shape),
      ...shape,
    },
  };
}

async function lineEffectRequest(): Promise<ClientEffectRequest> {
  const line = normalizeWhiteboardLineV1({
    startX: 400,
    startY: 300,
    endX: 100,
    endY: 90,
    color: '#3366cc',
    width: 4,
    style: 'dashed',
    points: ['', 'arrow'],
  });
  return {
    ...(await effectRequest()),
    traceId: 'trace-line-1',
    runId: 'run-line-1',
    agentInvocationId: 'message-line-1',
    toolCallId: 'tool-call-line-1',
    executionId: 'execution-line-1',
    idempotencyKey: 'run-line-1:message-line-1:tool-call-line-1',
    toolName: 'wb_draw_line',
    args: {
      startX: 400,
      startY: 300,
      endX: 100,
      endY: 90,
      color: '#3366cc',
      width: 4,
      style: 'dashed',
      points: ['', 'arrow'],
    },
    argsDigest: 'sha256:line-args',
    postcondition: {
      kind: 'whiteboard_line_exists',
      stableElementId: 'line-element-1',
      elementType: 'line',
      normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
      expectedLineDigest: await digestWhiteboardLineV1(line),
      ...line,
    },
  };
}

async function latexEffectRequest(): Promise<ClientEffectRequest> {
  const latex = normalizeWhiteboardLatexV1({
    latex: String.raw`\sum_{i=1}^{n} i`,
    x: 120,
    y: 90,
    width: 400,
    height: 80,
    color: '#2255aa',
  });
  const html = renderNativeWhiteboardLatexHtmlV1(latex.latex);
  return {
    ...(await effectRequest()),
    traceId: 'trace-latex-1',
    runId: 'run-latex-1',
    agentInvocationId: 'message-latex-1',
    toolCallId: 'tool-call-latex-1',
    executionId: 'execution-latex-1',
    idempotencyKey: 'run-latex-1:message-latex-1:tool-call-latex-1',
    toolName: 'wb_draw_latex',
    args: {
      latex: latex.latex,
      x: 120,
      y: 90,
      width: 400,
      height: 80,
      color: '#2255aa',
    },
    argsDigest: 'sha256:latex-args',
    postcondition: {
      kind: 'whiteboard_latex_exists',
      stableElementId: 'latex-element-1',
      elementType: 'latex',
      normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
      expectedFormulaDigest: await digestWhiteboardLatexV1(latex),
      expectedHtmlDigest: await digestWhiteboardLatexHtmlV1(html),
      ...latex,
    },
  };
}

async function codeEffectRequest(): Promise<ClientEffectRequest> {
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
    ...(await effectRequest()),
    traceId: 'trace-code-1',
    runId: 'run-code-1',
    agentInvocationId: 'message-code-1',
    toolCallId: 'tool-call-code-1',
    executionId: 'execution-code-1',
    idempotencyKey: 'run-code-1:message-code-1:tool-call-code-1',
    toolName: 'wb_draw_code',
    args,
    argsDigest: 'sha256:code-args',
    postcondition: {
      kind: 'whiteboard_code_exists',
      stableElementId: 'code-element-1',
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
      expectedCodeDigest: await digestWhiteboardCodeV1(code),
      ...code,
    },
  };
}

function accepted(effect: ClientEffectRequest): ClientEffectAck {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'accepted-1',
    status: 'accepted',
    observedAt: Date.now(),
    targetBinding: {
      requestId: effect.target.requestId,
      sessionId: effect.target.sessionId,
      stageId: effect.target.stageId,
      sceneId: effect.target.sceneId,
      whiteboardId: 'whiteboard-1',
      bindingVersion: 1,
    },
  };
}

function ackRequest(opts: {
  executionId: string;
  token?: string;
  body: unknown;
  origin?: string;
  contentType?: string;
}) {
  return new NextRequest(`http://localhost/api/chat/pi/client-effects/${opts.executionId}/ack`, {
    method: 'POST',
    headers: {
      origin: opts.origin ?? 'http://localhost',
      'content-type': opts.contentType ?? 'application/json',
      ...(opts.token ? { [CLIENT_EFFECT_ACK_HEADER]: opts.token } : {}),
    },
    body: JSON.stringify(opts.body),
  });
}

function streamedAckRequest(opts: { executionId: string; token: string; chunks: string[] }) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of opts.chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const init = {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      [CLIENT_EFFECT_ACK_HEADER]: opts.token,
    },
    body,
    duplex: 'half',
  } as unknown as ConstructorParameters<typeof NextRequest>[1];
  return new NextRequest(
    `http://localhost/api/chat/pi/client-effects/${opts.executionId}/ack`,
    init,
  );
}

async function post(request: NextRequest, executionId: string) {
  return POST(request, { params: Promise.resolve({ executionId }) });
}

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

describe('client effect ACK route', () => {
  beforeEach(() => {
    originalFlag = process.env[flag];
    originalRuntimeFlag = process.env[runtimeFlag];
    process.env[flag] = 'true';
    process.env[runtimeFlag] = 'true';
  });

  afterEach(() => {
    piClientEffectCoordinator.clearForTests();
    if (originalFlag === undefined) delete process.env[flag];
    else process.env[flag] = originalFlag;
    if (originalRuntimeFlag === undefined) delete process.env[runtimeFlag];
    else process.env[runtimeFlag] = originalRuntimeFlag;
  });

  it('accepts an authenticated same-origin transition', async () => {
    const effect = await effectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const response = await post(
      ackRequest({
        executionId: effect.executionId,
        token: registered.delivery.acknowledgementToken,
        body: accepted(effect),
      }),
      effect.executionId,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      disposition: 'applied',
      state: { status: 'accepted' },
    });
  });

  it('rejects a wrong capability without changing state', async () => {
    const effect = await effectRequest();
    piClientEffectCoordinator.register(effect);
    const response = await post(
      ackRequest({
        executionId: effect.executionId,
        token: 'wrong-token',
        body: accepted(effect),
      }),
      effect.executionId,
    );

    expect(response.status).toBe(401);
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'pending',
    });
  });

  it('validates capability before parsing transition JSON', async () => {
    const effect = await effectRequest();
    piClientEffectCoordinator.register(effect);
    const request = new NextRequest(
      `http://localhost/api/chat/pi/client-effects/${effect.executionId}/ack`,
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          [CLIENT_EFFECT_ACK_HEADER]: 'wrong-token',
        },
        body: '{invalid',
      },
    );
    const response = await post(request, effect.executionId);
    expect(response.status).toBe(401);
  });

  it('rejects malformed JSON with a valid capability without changing state', async () => {
    const effect = await effectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const request = new NextRequest(
      `http://localhost/api/chat/pi/client-effects/${effect.executionId}/ack`,
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          [CLIENT_EFFECT_ACK_HEADER]: registered.delivery.acknowledgementToken,
        },
        body: '{invalid',
      },
    );
    const response = await post(request, effect.executionId);

    expect(response.status).toBe(400);
    const invalidShape = await post(
      ackRequest({
        executionId: effect.executionId,
        token: registered.delivery.acknowledgementToken,
        body: { ...accepted(effect), unexpected: true },
      }),
      effect.executionId,
    );
    expect(invalidShape.status).toBe(400);
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'pending',
    });
  });

  it('rejects cross-origin and non-JSON requests', async () => {
    const effect = await effectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const crossOrigin = await post(
      ackRequest({
        executionId: effect.executionId,
        token: registered.delivery.acknowledgementToken,
        body: accepted(effect),
        origin: 'https://example.com',
      }),
      effect.executionId,
    );
    expect(crossOrigin.status).toBe(403);

    const wrongType = await post(
      ackRequest({
        executionId: effect.executionId,
        token: registered.delivery.acknowledgementToken,
        body: accepted(effect),
        contentType: 'application/json; charset=utf-8',
      }),
      effect.executionId,
    );
    expect(wrongType.status).toBe(415);
  });

  it('rejects an oversized body before transition parsing', async () => {
    const effect = await effectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const response = await post(
      ackRequest({
        executionId: effect.executionId,
        token: registered.delivery.acknowledgementToken,
        body: { padding: 'x'.repeat(9_000) },
      }),
      effect.executionId,
    );
    expect(response.status).toBe(413);
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'pending',
    });
  });

  it('enforces the byte limit while reading a chunked UTF-8 body', async () => {
    const effect = await effectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const token = registered.delivery.acknowledgementToken;

    const belowLimit = await post(
      streamedAckRequest({
        executionId: effect.executionId,
        token,
        chunks: ['{"padding":"', '界'.repeat(2_000), '"}'],
      }),
      effect.executionId,
    );
    expect(belowLimit.status).toBe(400);

    const overLimit = await post(
      streamedAckRequest({
        executionId: effect.executionId,
        token,
        chunks: ['{"padding":"', '界'.repeat(3_000), '"}'],
      }),
      effect.executionId,
    );
    expect(overLimit.status).toBe(413);
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'pending',
    });
  });

  it('distinguishes unknown executions and recovers authenticated terminal tombstones', async () => {
    const unknown = await post(
      ackRequest({
        executionId: 'unknown',
        token: 'unusable',
        body: { invalid: true },
      }),
      'unknown',
    );
    expect(unknown.status).toBe(404);

    const effect = await effectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    piClientEffectCoordinator.cancel(effect.executionId, 'SESSION_ENDED', 'Session ended.');
    piClientEffectCoordinator.cleanup(effect.executionId);
    const late = await post(
      ackRequest({
        executionId: effect.executionId,
        token: registered.delivery.acknowledgementToken,
        body: accepted(effect),
      }),
      effect.executionId,
    );
    expect(late.status).toBe(200);
    await expect(late.json()).resolves.toMatchObject({
      success: true,
      disposition: 'late',
      state: {
        status: 'cancelled',
        terminalResult: { status: 'cancelled', error: { code: 'SESSION_ENDED' } },
      },
    });

    const unauthorized = await post(
      ackRequest({
        executionId: effect.executionId,
        token: 'wrong-token',
        body: accepted(effect),
      }),
      effect.executionId,
    );
    expect(unauthorized.status).toBe(401);
  });

  it('recovers an applied commit through the real route with an exact browser replay', async () => {
    const effect = await effectRequest();
    effect.args = { content: 'hello', x: 100, y: 120 };
    const registered = piClientEffectCoordinator.register(effect);
    const commitEventIds: string[] = [];
    let loseFirstCommitResponse = true;
    let browserNow = Date.now();
    const fetchAck: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const ack = JSON.parse(String(init?.body)) as ClientEffectAck;
      if (ack.status === 'effect_committed') commitEventIds.push(ack.clientEventId);
      const headers = new Headers(init?.headers);
      headers.set('origin', url.origin);
      const response = await post(
        new NextRequest(url, {
          method: init?.method,
          headers,
          body: init?.body,
        }),
        effect.executionId,
      );
      if (ack.status === 'effect_committed' && loseFirstCommitResponse) {
        loseFirstCommitResponse = false;
        piClientEffectCoordinator.cleanup(effect.executionId);
        browserNow = effect.deadlineAt + 1;
        throw new TypeError('simulated response loss after server commit');
      }
      return response;
    };
    const store = createStore();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: effect.target.sessionId,
      requestId: effect.target.requestId,
      store,
      fetchAck,
      now: () => browserNow,
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(registered.delivery, new AbortController().signal)).resolves.toBe(
      'effect_committed',
    );
    expect(commitEventIds).toHaveLength(2);
    expect(new Set(commitEventIds).size).toBe(1);
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toHaveLength(1);
  });

  it('commits an exact shape postcondition through the real browser ACK route', async () => {
    const effect = await shapeEffectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const fetchAck: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = new Headers(init?.headers);
      headers.set('origin', url.origin);
      return post(
        new NextRequest(url, {
          method: init?.method,
          headers,
          body: init?.body,
        }),
        effect.executionId,
      );
    };
    const store = createStore();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: effect.target.sessionId,
      requestId: effect.target.requestId,
      store,
      fetchAck,
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(registered.delivery, new AbortController().signal)).resolves.toBe(
      'effect_committed',
    );
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'effect_committed',
      terminalResult: { status: 'effect_committed', isError: false },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toEqual([
      expect.objectContaining({
        id: effect.postcondition.stableElementId,
        type: 'shape',
        left: 180,
        top: 90,
        width: 220,
        height: 220,
        fill: '#3366cc',
      }),
    ]);
  });

  it('commits an exact line postcondition through the real browser ACK route', async () => {
    const effect = await lineEffectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const fetchAck: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = new Headers(init?.headers);
      headers.set('origin', url.origin);
      return post(
        new NextRequest(url, {
          method: init?.method,
          headers,
          body: init?.body,
        }),
        effect.executionId,
      );
    };
    const store = createStore();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: effect.target.sessionId,
      requestId: effect.target.requestId,
      store,
      fetchAck,
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(registered.delivery, new AbortController().signal)).resolves.toBe(
      'effect_committed',
    );
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'effect_committed',
      terminalResult: { status: 'effect_committed', isError: false },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toEqual([
      expect.objectContaining({
        id: effect.postcondition.stableElementId,
        type: 'line',
        left: 100,
        top: 90,
        width: 4,
        start: [300, 210],
        end: [0, 0],
        style: 'dashed',
        color: '#3366cc',
        points: ['', 'arrow'],
      }),
    ]);
  });

  it('commits exact formula and derived HTML state through the real browser ACK route', async () => {
    const effect = await latexEffectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const fetchAck: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = new Headers(init?.headers);
      headers.set('origin', url.origin);
      return post(
        new NextRequest(url, {
          method: init?.method,
          headers,
          body: init?.body,
        }),
        effect.executionId,
      );
    };
    const store = createStore();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: effect.target.sessionId,
      requestId: effect.target.requestId,
      store,
      fetchAck,
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(registered.delivery, new AbortController().signal)).resolves.toBe(
      'effect_committed',
    );
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'effect_committed',
      terminalResult: { status: 'effect_committed', isError: false },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toEqual([
      expect.objectContaining({
        id: effect.postcondition.stableElementId,
        type: 'latex',
        left: 120,
        top: 90,
        width: 400,
        height: 80,
        latex: String.raw`\sum_{i=1}^{n} i`,
        color: '#2255aa',
        fixedRatio: true,
      }),
    ]);
  });

  it('commits exact code source and stable line identities through the real browser ACK route', async () => {
    const effect = await codeEffectRequest();
    const registered = piClientEffectCoordinator.register(effect);
    const fetchAck: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = new Headers(init?.headers);
      headers.set('origin', url.origin);
      return post(
        new NextRequest(url, {
          method: init?.method,
          headers,
          body: init?.body,
        }),
        effect.executionId,
      );
    };
    const store = createStore();
    const runtime = new BrowserClientEffectRuntime({
      sessionId: effect.target.sessionId,
      requestId: effect.target.requestId,
      store,
      fetchAck,
      waitForPresentation: async () => {},
      ensureWhiteboardVisible: async () => {},
    });

    await expect(runtime.execute(registered.delivery, new AbortController().signal)).resolves.toBe(
      'effect_committed',
    );
    expect(piClientEffectCoordinator.getSnapshot(effect.executionId)).toMatchObject({
      status: 'effect_committed',
      terminalResult: { status: 'effect_committed', isError: false },
    });
    expect(
      store.getState().stage?.whiteboard?.flatMap((whiteboard) => whiteboard.elements),
    ).toEqual([
      expect.objectContaining({
        id: effect.postcondition.stableElementId,
        type: 'code',
        language: 'typescript',
        fileName: 'slope.ts',
        left: 80,
        top: 60,
        width: 560,
        height: 280,
        lines: [
          { id: 'L1', content: 'const slope = 2;' },
          { id: 'L2', content: '' },
          { id: 'L3', content: 'return slope;' },
        ],
      }),
    ]);
  });

  it('is unreachable while the Native whiteboard capability is disabled', async () => {
    delete process.env[flag];
    const effect = await effectRequest();
    const response = await post(
      ackRequest({ executionId: effect.executionId, token: 'unused', body: accepted(effect) }),
      effect.executionId,
    );
    expect(response.status).toBe(404);
  });

  it('is unreachable while the Native Child runtime is disabled', async () => {
    delete process.env[runtimeFlag];
    const effect = await effectRequest();
    const response = await post(
      ackRequest({ executionId: effect.executionId, token: 'unused', body: accepted(effect) }),
      effect.executionId,
    );
    expect(response.status).toBe(404);
  });
});
