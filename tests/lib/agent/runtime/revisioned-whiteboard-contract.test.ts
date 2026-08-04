import { describe, expect, it, vi } from 'vitest';
import { isClientEffectAck } from '@/lib/agent/runtime/client-effect-contract';
import {
  MAX_REVISIONED_WHITEBOARD_JSON_DEPTH,
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedDrawTextDigests,
  isRevisionedWhiteboardEffectDelivery,
  isRevisionedWhiteboardAuthorityReceipt,
  isRevisionedWhiteboardMutationAck,
  normalizeRevisionedDrawTextIntent,
  type RevisionedWhiteboardAuthorityReceipt,
  type RevisionedWhiteboardMutationAck,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';

const requestDigest = `sha256:${'a'.repeat(64)}`;
const binding = { stageId: 'stage-1', whiteboardId: null, revision: 3 } as const;
const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
} as const;

function registration(deadlineAt = Date.now() + 10_000) {
  return {
    executionId: 'execution-1',
    requestDigest,
    toolName: 'wb_clear' as const,
    expectedBinding: binding,
    authenticatedTarget,
    deadlineAt,
  };
}

function registerPending(coordinator: RevisionedWhiteboardCoordinator, input = registration()) {
  const registered = coordinator.register(input);
  expect(registered.kind).toBe('pending');
  if (registered.kind !== 'pending') throw new Error('Expected a pending registration.');
  return registered;
}

function committed(changed = true): RevisionedWhiteboardAuthorityReceipt {
  return {
    protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
    outcome: 'committed',
    executionId: 'execution-1',
    requestDigest,
    toolName: 'wb_clear',
    previousBinding: binding,
    currentBinding: {
      stageId: 'stage-1',
      whiteboardId: changed ? 'whiteboard-1' : null,
      revision: changed ? 4 : 3,
    },
    changed,
    mutationMayHaveCommitted: false,
    delta: changed ? { createdElementId: 'element-1' } : {},
    postcondition: { kind: 'text_exists', matchingElementCount: changed ? 1 : 0 },
  };
}

function accepted(): RevisionedWhiteboardMutationAck {
  return {
    protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
    status: 'accepted',
    executionId: 'execution-1',
    requestDigest,
    targetBinding: {
      stageId: binding.stageId,
      whiteboardId: binding.whiteboardId,
      observedRevision: binding.revision,
    },
  };
}

describe('revisioned whiteboard wire contract', () => {
  it('canonicalizes strict draw intent and binds every Runtime field into requestDigest', () => {
    const base = {
      executionId: 'execution-1',
      expectedBinding: binding,
      authenticatedTarget,
      deadlineAt: 2_000,
      intent: { content: 'hello', x: 100, y: 120, color: 'red' },
    };
    const digests = createRevisionedDrawTextDigests(base)!;
    expect(digests.normalizedIntent).toMatchObject({ color: '#ff0000' });
    expect(normalizeRevisionedDrawTextIntent({ ...base.intent, color: 'currentColor' })).toBeNull();
    expect(normalizeRevisionedDrawTextIntent({ ...base.intent, x: Number.NaN })).toBeNull();
    expect(
      normalizeRevisionedDrawTextIntent({ ...base.intent, content: 'bad\u0000text' }),
    ).toBeNull();

    const variants = [
      { ...base, executionId: 'execution-2' },
      { ...base, expectedBinding: { ...binding, revision: 4 } },
      { ...base, authenticatedTarget: { ...authenticatedTarget, sceneId: 'scene-2' } },
      { ...base, deadlineAt: 2_001 },
      { ...base, intent: { ...base.intent, content: 'different' } },
    ];
    for (const variant of variants) {
      expect(createRevisionedDrawTextDigests(variant)?.requestDigest).not.toBe(
        digests.requestDigest,
      );
    }
    const delivery = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      executionId: base.executionId,
      requestDigest: digests.requestDigest,
      toolName: 'wb_draw_text',
      expectedBinding: base.expectedBinding,
      authenticatedTarget: base.authenticatedTarget,
      deadlineAt: base.deadlineAt,
      intent: digests.normalizedIntent,
      acknowledgementToken: 'ack-token',
    };
    expect(isRevisionedWhiteboardEffectDelivery(delivery)).toBe(true);
    expect(
      isRevisionedWhiteboardEffectDelivery({ ...delivery, observationToken: 'forbidden' }),
    ).toBe(false);
  });

  it('accepts an exact nullable accepted binding without changing the v1 ACK contract', () => {
    const ack = accepted();
    expect(isRevisionedWhiteboardMutationAck(ack)).toBe(true);
    expect(isClientEffectAck(ack)).toBe(false);
    expect(isRevisionedWhiteboardMutationAck({ ...ack, observationToken: 'forbidden' })).toBe(
      false,
    );
    expect(
      isRevisionedWhiteboardMutationAck({
        ...ack,
        targetBinding: { stageId: 'stage-1', whiteboardId: null, revision: 3 },
      }),
    ).toBe(false);
  });

  it('snapshots mutable coordinator registration fields', () => {
    const coordinator = new RevisionedWhiteboardCoordinator({ createToken: () => 'ack-token' });
    const expectedBinding = { stageId: 'stage-1', whiteboardId: null, revision: 3 };
    const target = {
      childInvocationId: 'child-1',
      requestId: 'request-1',
      sessionId: 'session-1',
      sceneId: 'scene-1',
    };
    const input = {
      executionId: 'execution-1',
      requestDigest,
      toolName: 'wb_clear' as const,
      expectedBinding,
      authenticatedTarget: target,
      deadlineAt: Date.now() + 10_000,
    };
    coordinator.register(input);

    expectedBinding.revision = 99;
    target.sceneId = 'scene-mutated';

    expect(coordinator.applyAck('ack-token', accepted())).toEqual({
      kind: 'applied',
      status: 'accepted',
    });
    expect(() => coordinator.register(input)).toThrow(
      'REVISIONED_WHITEBOARD_REGISTRATION_CONFLICT',
    );
  });

  it('keeps Authority wire receipts exact, bounded and free of Runtime tokens', () => {
    const receipt = committed();
    expect(isRevisionedWhiteboardAuthorityReceipt(receipt)).toBe(true);
    expect(
      isRevisionedWhiteboardAuthorityReceipt({ ...receipt, observationToken: 'forbidden' }),
    ).toBe(false);
    expect(
      isRevisionedWhiteboardAuthorityReceipt({
        ...receipt,
        delta: { oversized: 'x'.repeat(70_000) },
      }),
    ).toBe(false);

    let deep: unknown = 'leaf';
    for (let index = 0; index <= MAX_REVISIONED_WHITEBOARD_JSON_DEPTH; index += 1) {
      deep = { child: deep };
    }
    expect(isRevisionedWhiteboardAuthorityReceipt({ ...receipt, delta: deep })).toBe(false);
  });

  it('requires terminal ACK status to agree with the receipt outcome', () => {
    const receipt = committed();
    expect(
      isRevisionedWhiteboardMutationAck({
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_committed',
        executionId: 'execution-1',
        requestDigest,
        receipt,
      }),
    ).toBe(true);
    expect(
      isRevisionedWhiteboardMutationAck({
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_uncertain',
        executionId: 'execution-1',
        requestDigest,
        receipt,
      }),
    ).toBe(false);
  });
});

describe('RevisionedWhiteboardCoordinator', () => {
  it('shares pending replay, then returns a token-free settled replay', async () => {
    const coordinator = new RevisionedWhiteboardCoordinator({ createToken: () => 'ack-token' });
    const input = {
      ...registration(),
      observationAuthorizationDigest: `sha256:${'b'.repeat(64)}`,
    };
    const first = registerPending(coordinator, input);
    const duplicate = coordinator.register(input);
    expect(duplicate).toMatchObject({ kind: 'pending', acknowledgementToken: 'ack-token' });
    if (duplicate.kind !== 'pending') throw new Error('Expected pending replay.');
    expect(duplicate.terminal).toBe(first.terminal);

    coordinator.applyAck('ack-token', {
      ...accepted(),
      targetBinding: { stageId: 'stage-1', whiteboardId: null, observedRevision: 4 },
    });
    coordinator.applyAck('ack-token', {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      status: 'effect_rejected',
      executionId: 'execution-1',
      requestDigest,
      receipt: {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        outcome: 'rejected',
        executionId: 'execution-1',
        requestDigest,
        toolName: 'wb_clear',
        previousBinding: { stageId: 'stage-1', whiteboardId: null, revision: 5 },
        currentBinding: { stageId: 'stage-1', whiteboardId: null, revision: 5 },
        changed: false,
        mutationMayHaveCommitted: false,
        error: { code: 'STALE_STATE' },
      },
    });
    await expect(first.terminal).resolves.toMatchObject({ status: 'rejected' });
    coordinator.cleanup('execution-1');
    const settled = coordinator.register(input);
    expect(settled.kind).toBe('settled_replay');
    expect('acknowledgementToken' in settled).toBe(false);
    await expect(settled.terminal).resolves.toMatchObject({ status: 'rejected' });
    expect(() =>
      coordinator.register({
        ...input,
        observationAuthorizationDigest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toThrow('REVISIONED_WHITEBOARD_REGISTRATION_CONFLICT');
  });

  it('settles committed and transfers one action charge exactly once across replay', () => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    const registered = registration();
    const { acknowledgementToken } = registerPending(coordinator, registered);
    const terminalAck = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      status: 'effect_committed',
      executionId: 'execution-1',
      requestDigest,
      receipt: committed(),
    } as const;

    expect(coordinator.applyAck('wrong-token', accepted())).toMatchObject({ kind: 'invalid' });
    expect(coordinator.applyAck(acknowledgementToken, accepted())).toMatchObject({
      kind: 'applied',
      status: 'accepted',
    });
    expect(coordinator.applyAck(acknowledgementToken, terminalAck)).toMatchObject({
      kind: 'applied',
      status: 'committed',
    });
    expect(coordinator.applyAck(acknowledgementToken, terminalAck)).toMatchObject({
      kind: 'duplicate',
    });
    expect(coordinator.takeActionCharge('execution-1')).toBe(true);
    expect(coordinator.takeActionCharge('execution-1')).toBe(false);
    coordinator.cleanup('execution-1');
    expect(coordinator.applyAck(acknowledgementToken, terminalAck)).toMatchObject({
      kind: 'duplicate',
    });
    expect(coordinator.takeActionCharge('execution-1')).toBe(false);
    expect(coordinator.getTerminal('execution-1')).toMatchObject({
      status: 'committed',
      actionDisposition: 'consume_once',
      authenticatedReceipt: {
        authenticatedTarget,
        deadlineAt: registered.deadlineAt,
      },
    });
  });

  it('does not expose an action charge for a verified no-op', () => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    const { acknowledgementToken } = registerPending(coordinator);
    coordinator.applyAck(acknowledgementToken, accepted());
    coordinator.applyAck(acknowledgementToken, {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      status: 'effect_committed',
      executionId: 'execution-1',
      requestDigest,
      receipt: committed(false),
    });
    expect(coordinator.takeActionCharge('execution-1')).toBe(false);
  });

  it('enforces outcome-specific rejected and uncertain binding correlation', () => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    const { acknowledgementToken } = registerPending(coordinator);
    coordinator.applyAck(acknowledgementToken, accepted());

    expect(
      coordinator.applyAck(acknowledgementToken, {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_rejected',
        executionId: 'execution-1',
        requestDigest,
        receipt: {
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          outcome: 'rejected',
          executionId: 'execution-1',
          requestDigest,
          toolName: 'wb_clear',
          previousBinding: { stageId: 'stage-z', whiteboardId: 'wb-z', revision: 99 },
          currentBinding: { stageId: 'stage-z', whiteboardId: 'wb-z', revision: 99 },
          changed: false,
          mutationMayHaveCommitted: false,
          error: { code: 'TARGET_PRECONDITION_FAILED' },
        },
      }),
    ).toEqual({
      kind: 'invalid',
      reason: 'REVISIONED_WHITEBOARD_RECEIPT_TARGET_MISMATCH',
    });

    expect(
      coordinator.applyAck(acknowledgementToken, {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_uncertain',
        executionId: 'execution-1',
        requestDigest,
        receipt: {
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          outcome: 'uncertain',
          executionId: 'execution-1',
          requestDigest,
          toolName: 'wb_clear',
          previousBinding: binding,
          currentBinding: { ...binding, revision: 9 },
          changed: true,
          mutationMayHaveCommitted: true,
          error: { code: 'POSTCONDITION_UNCERTAIN' },
        },
      }),
    ).toEqual({
      kind: 'invalid',
      reason: 'REVISIONED_WHITEBOARD_RECEIPT_REVISION_INVALID',
    });
  });

  it.each([
    {
      code: 'STALE_STATE' as const,
      diagnostic: { stageId: 'stage-1', whiteboardId: null, revision: 4 },
    },
    {
      code: 'TARGET_CHANGED' as const,
      diagnostic: { stageId: 'stage-2', whiteboardId: null, revision: 0 },
    },
    {
      code: 'AUTHENTICATED_TARGET_CHANGED' as const,
      diagnostic: { stageId: 'stage-2', whiteboardId: 'wb-2', revision: 0 },
    },
  ])('accepts a correlated $code rejection', ({ code, diagnostic }) => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    const { acknowledgementToken } = registerPending(coordinator);
    coordinator.applyAck(acknowledgementToken, accepted());

    expect(
      coordinator.applyAck(acknowledgementToken, {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_rejected',
        executionId: 'execution-1',
        requestDigest,
        receipt: {
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          outcome: 'rejected',
          executionId: 'execution-1',
          requestDigest,
          toolName: 'wb_clear',
          previousBinding: diagnostic,
          currentBinding: diagnostic,
          changed: false,
          mutationMayHaveCommitted: false,
          error: { code },
        },
      }),
    ).toEqual({ kind: 'applied', status: 'rejected' });
    expect(coordinator.takeActionCharge('execution-1')).toBe(false);
  });

  it('keeps accepted A then target/stage B as deterministic rejected with no action charge', () => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    const { acknowledgementToken } = registerPending(coordinator);
    expect(coordinator.applyAck(acknowledgementToken, accepted())).toEqual({
      kind: 'applied',
      status: 'accepted',
    });

    expect(
      coordinator.applyAck(acknowledgementToken, {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_rejected',
        executionId: 'execution-1',
        requestDigest,
        receipt: {
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          outcome: 'rejected',
          executionId: 'execution-1',
          requestDigest,
          toolName: 'wb_clear',
          previousBinding: { stageId: 'stage-2', whiteboardId: 'wb-2', revision: 0 },
          currentBinding: { stageId: 'stage-2', whiteboardId: 'wb-2', revision: 0 },
          changed: false,
          mutationMayHaveCommitted: false,
          error: { code: 'AUTHENTICATED_TARGET_CHANGED' },
        },
      }),
    ).toEqual({ kind: 'applied', status: 'rejected' });
    expect(coordinator.getTerminal('execution-1')).toMatchObject({
      status: 'rejected',
      mutationMayHaveCommitted: false,
      actionDisposition: 'none',
    });
    expect(coordinator.takeActionCharge('execution-1')).toBe(false);
  });

  it('accounts accepted delivery loss conservatively without fallible callbacks', () => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    const { acknowledgementToken } = registerPending(coordinator);
    coordinator.applyAck(acknowledgementToken, accepted());
    expect(coordinator.settleDeliveryFailure('execution-1')).toMatchObject({
      status: 'uncertain',
      actionDisposition: 'consume_once',
    });
    expect(coordinator.takeActionCharge('execution-1')).toBe(true);
    expect(coordinator.takeActionCharge('execution-1')).toBe(false);
  });

  it('settles pre-accepted delivery failure without action and rejects a late accepted ACK', () => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    const { acknowledgementToken } = registerPending(coordinator);
    expect(coordinator.settleDeliveryFailure('execution-1')).toMatchObject({
      status: 'rejected',
      mutationMayHaveCommitted: false,
      actionDisposition: 'none',
    });
    expect(coordinator.takeActionCharge('execution-1')).toBe(false);
    expect(coordinator.applyAck(acknowledgementToken, accepted())).toEqual({
      kind: 'invalid',
      reason: 'REVISIONED_WHITEBOARD_ACK_AFTER_TERMINAL',
    });
  });

  it('uses the absolute deadline even when the timer callback is delayed', () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const coordinator = new RevisionedWhiteboardCoordinator({ now: () => now });
      const { acknowledgementToken } = registerPending(coordinator, registration(1_100));
      coordinator.applyAck(acknowledgementToken, accepted());
      now = 1_100;
      expect(
        coordinator.applyAck(acknowledgementToken, {
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          status: 'effect_committed',
          executionId: 'execution-1',
          requestDigest,
          receipt: committed(),
        }),
      ).toMatchObject({ kind: 'invalid' });
      expect(coordinator.getTerminal('execution-1')).toMatchObject({ status: 'uncertain' });
      expect(coordinator.takeActionCharge('execution-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
