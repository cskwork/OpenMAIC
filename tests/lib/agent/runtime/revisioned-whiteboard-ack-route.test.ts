import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/pi/revisioned-whiteboard-effects/[executionId]/ack/route';
import {
  REVISIONED_WHITEBOARD_ACK_HEADER,
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedDrawTextDigests,
  createRevisionedWhiteboardAcceptedAck,
  createRevisionedWhiteboardTerminalAck,
  type RevisionedWhiteboardAuthorityReceipt,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { piRevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import {
  deriveRevisionedElementId,
  digestVisibleTextV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';

const runtimeFlag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME';
const whiteboardFlag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_WHITEBOARD';
let originalRuntimeFlag: string | undefined;
let originalWhiteboardFlag: string | undefined;

function register(deadlineAt = Date.now() + 10_000) {
  const expectedBinding = { stageId: 'stage-1', whiteboardId: 'board-1', revision: 4 };
  const authenticatedTarget = {
    childInvocationId: 'child-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    sceneId: 'scene-1',
  };
  const digests = createRevisionedDrawTextDigests({
    executionId: 'execution-1',
    expectedBinding,
    authenticatedTarget,
    deadlineAt,
    intent: { content: 'hello', x: 100, y: 100 },
  })!;
  const registered = piRevisionedWhiteboardCoordinator.register({
    executionId: 'execution-1',
    requestDigest: digests.requestDigest,
    toolName: 'wb_draw_text',
    expectedBinding,
    authenticatedTarget,
    deadlineAt,
    intentDigest: digests.intentDigest,
    observationAuthorizationDigest: `sha256:${'b'.repeat(64)}`,
    expectedMutation: {
      kind: 'wb_draw_text_v2',
      intentDigest: digests.intentDigest,
      stableElementId: deriveRevisionedElementId('execution-1'),
      expectedContentDigest: digestVisibleTextV1Sync(digests.normalizedIntent.content),
    },
  });
  if (registered.kind !== 'pending') throw new Error('Expected a pending registration.');
  return { registered, digests, expectedBinding };
}

function request(token: string, body: unknown) {
  return new NextRequest(
    'http://localhost/api/chat/pi/revisioned-whiteboard-effects/execution-1/ack',
    {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
        [REVISIONED_WHITEBOARD_ACK_HEADER]: token,
      },
      body: JSON.stringify(body),
    },
  );
}

describe('revisioned whiteboard ACK route', () => {
  beforeEach(() => {
    originalRuntimeFlag = process.env[runtimeFlag];
    originalWhiteboardFlag = process.env[whiteboardFlag];
    process.env[runtimeFlag] = 'true';
    process.env[whiteboardFlag] = 'true';
  });

  afterEach(() => {
    piRevisionedWhiteboardCoordinator.clearForTests();
    if (originalRuntimeFlag === undefined) delete process.env[runtimeFlag];
    else process.env[runtimeFlag] = originalRuntimeFlag;
    if (originalWhiteboardFlag === undefined) delete process.env[whiteboardFlag];
    else process.env[whiteboardFlag] = originalWhiteboardFlag;
  });

  it('authenticates accepted independently of expected, then applies N+2 STALE_STATE', async () => {
    const { registered, digests, expectedBinding } = register();
    const accepted = createRevisionedWhiteboardAcceptedAck({
      executionId: 'execution-1',
      requestDigest: digests.requestDigest,
      targetBinding: { stageId: 'stage-1', whiteboardId: 'board-1', observedRevision: 5 },
    });
    const acceptedResponse = await POST(request(registered.acknowledgementToken, accepted), {
      params: Promise.resolve({ executionId: 'execution-1' }),
    });
    expect(acceptedResponse.status).toBe(200);

    const staleBinding = { ...expectedBinding, revision: 6 };
    const receipt: RevisionedWhiteboardAuthorityReceipt = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'rejected',
      executionId: 'execution-1',
      requestDigest: digests.requestDigest,
      toolName: 'wb_draw_text',
      previousBinding: staleBinding,
      currentBinding: staleBinding,
      changed: false,
      mutationMayHaveCommitted: false,
      error: { code: 'STALE_STATE' },
    };
    const terminalResponse = await POST(
      request(registered.acknowledgementToken, createRevisionedWhiteboardTerminalAck(receipt)),
      { params: Promise.resolve({ executionId: 'execution-1' }) },
    );
    expect(terminalResponse.status).toBe(200);
    await expect(registered.terminal).resolves.toMatchObject({
      status: 'rejected',
      actionDisposition: 'none',
      receipt: { error: { code: 'STALE_STATE' } },
    });
  });

  it('rejects wrong tokens, cross-origin requests and over-limit envelopes before parsing', async () => {
    const { registered, digests } = register();
    const accepted = createRevisionedWhiteboardAcceptedAck({
      executionId: 'execution-1',
      requestDigest: digests.requestDigest,
      targetBinding: { stageId: 'stage-1', whiteboardId: 'board-1', observedRevision: 4 },
    });
    expect(
      (
        await POST(request('wrong-token', accepted), {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(401);
    const crossOrigin = request(registered.acknowledgementToken, accepted);
    crossOrigin.headers.set('origin', 'https://other.example');
    expect(
      (
        await POST(crossOrigin, {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(403);
    const oversized = request(registered.acknowledgementToken, accepted);
    oversized.headers.set('content-length', String(70 * 1024));
    expect(
      (
        await POST(oversized, {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(413);
  });

  it('rejects invalid content types, malformed UTF-8, execution mismatch and extra keys', async () => {
    const { registered, digests } = register();
    const accepted = createRevisionedWhiteboardAcceptedAck({
      executionId: 'execution-1',
      requestDigest: digests.requestDigest,
      targetBinding: { stageId: 'stage-1', whiteboardId: 'board-1', observedRevision: 4 },
    });
    const wrongContentType = request(registered.acknowledgementToken, accepted);
    wrongContentType.headers.set('content-type', 'text/plain');
    expect(
      (
        await POST(wrongContentType, {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(415);
    const missingContentType = request(registered.acknowledgementToken, accepted);
    missingContentType.headers.delete('content-type');
    expect(
      (
        await POST(missingContentType, {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(415);

    const invalidUtf8 = new NextRequest(
      'http://localhost/api/chat/pi/revisioned-whiteboard-effects/execution-1/ack',
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          [REVISIONED_WHITEBOARD_ACK_HEADER]: registered.acknowledgementToken,
        },
        body: new Uint8Array([0xc3, 0x28]),
      },
    );
    expect(
      (
        await POST(invalidUtf8, {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(registered.acknowledgementToken, {
            ...accepted,
            executionId: 'execution-other',
          }),
          { params: Promise.resolve({ executionId: 'execution-1' }) },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(request(registered.acknowledgementToken, { ...accepted, extra: true }), {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(400);
  });

  it('returns duplicate for an exact terminal replay, including from a tombstone', async () => {
    const { registered, digests, expectedBinding } = register();
    const accepted = createRevisionedWhiteboardAcceptedAck({
      executionId: 'execution-1',
      requestDigest: digests.requestDigest,
      targetBinding: { stageId: 'stage-1', whiteboardId: 'board-1', observedRevision: 4 },
    });
    expect(
      (
        await POST(request(registered.acknowledgementToken, accepted), {
          params: Promise.resolve({ executionId: 'execution-1' }),
        })
      ).status,
    ).toBe(200);
    const staleBinding = { ...expectedBinding, revision: 5 };
    const terminal = createRevisionedWhiteboardTerminalAck({
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'rejected',
      executionId: 'execution-1',
      requestDigest: digests.requestDigest,
      toolName: 'wb_draw_text',
      previousBinding: staleBinding,
      currentBinding: staleBinding,
      changed: false,
      mutationMayHaveCommitted: false,
      error: { code: 'STALE_STATE' },
    });
    const first = await POST(request(registered.acknowledgementToken, terminal), {
      params: Promise.resolve({ executionId: 'execution-1' }),
    });
    const duplicate = await POST(request(registered.acknowledgementToken, terminal), {
      params: Promise.resolve({ executionId: 'execution-1' }),
    });
    expect(first.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ disposition: 'duplicate' });

    piRevisionedWhiteboardCoordinator.cleanup('execution-1');
    const tombstoneReplay = await POST(request(registered.acknowledgementToken, terminal), {
      params: Promise.resolve({ executionId: 'execution-1' }),
    });
    expect(await tombstoneReplay.json()).toMatchObject({ disposition: 'duplicate' });
  });

  it('rejects an accepted ACK received after the absolute deadline', async () => {
    const { registered, digests } = register(Date.now() + 10);
    const accepted = createRevisionedWhiteboardAcceptedAck({
      executionId: 'execution-1',
      requestDigest: digests.requestDigest,
      targetBinding: { stageId: 'stage-1', whiteboardId: 'board-1', observedRevision: 4 },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const late = await POST(request(registered.acknowledgementToken, accepted), {
      params: Promise.resolve({ executionId: 'execution-1' }),
    });
    expect(late.status).toBe(409);
    await expect(registered.terminal).resolves.toMatchObject({
      status: 'rejected',
      actionDisposition: 'none',
    });
  });
});
