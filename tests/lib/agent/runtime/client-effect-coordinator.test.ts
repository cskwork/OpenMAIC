import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestVisibleTextV1,
  isClientEffectAck,
  resolveActiveEffectBudget,
  type AcceptedTargetBinding,
  type ClientEffectAck,
  type ClientEffectRequest,
} from '@/lib/agent/runtime/client-effect-contract';
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

async function request(overrides: Partial<ClientEffectRequest> = {}): Promise<ClientEffectRequest> {
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
  effect: ClientEffectRequest,
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

  it('returns a gone result after terminal cleanup', async () => {
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
    ).toEqual({ kind: 'gone' });
  });

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
});
