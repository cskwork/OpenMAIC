import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/pi/client-effects/[executionId]/ack/route';
import {
  CLIENT_EFFECT_ACK_HEADER,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestVisibleTextV1,
  type ClientEffectAck,
  type ClientEffectRequest,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

const flag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD';
let originalFlag: string | undefined;

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

describe('client effect ACK route', () => {
  beforeEach(() => {
    originalFlag = process.env[flag];
    process.env[flag] = 'true';
  });

  afterEach(() => {
    piClientEffectCoordinator.clearForTests();
    if (originalFlag === undefined) delete process.env[flag];
    else process.env[flag] = originalFlag;
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

  it('distinguishes unknown and cleaned-up executions without parsing transitions', async () => {
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
    const gone = await post(
      ackRequest({
        executionId: effect.executionId,
        token: registered.delivery.acknowledgementToken,
        body: accepted(effect),
      }),
      effect.executionId,
    );
    expect(gone.status).toBe(410);
  });

  it('is unreachable while the Phase 2 flag is disabled', async () => {
    delete process.env[flag];
    const effect = await effectRequest();
    const response = await post(
      ackRequest({ executionId: effect.executionId, token: 'unused', body: accepted(effect) }),
      effect.executionId,
    );
    expect(response.status).toBe(404);
  });
});
