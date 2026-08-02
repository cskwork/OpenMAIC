import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
  isClientEffectAck,
  type ClientEffectAck,
  type WhiteboardCloseClientEffectRequest,
  type WhiteboardOpenClientEffectRequest,
  type WhiteboardVisibilityTarget,
} from '@/lib/agent/runtime/client-effect-contract';
import { ClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

function closeRequest(
  overrides: Partial<WhiteboardCloseClientEffectRequest> = {},
): WhiteboardCloseClientEffectRequest {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    kind: 'client_effect',
    traceId: 'trace-close',
    runId: 'run-close',
    agentInvocationId: 'invocation-close',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: 'tool-close',
    executionId: 'execution-close',
    idempotencyKey: 'run-close:invocation-close:tool-close',
    toolName: 'wb_close',
    args: {},
    argsDigest: 'sha256:close',
    issuedAt: Date.now(),
    deadlineAt: Date.now() + 10_000,
    attempt: 1,
    target: {
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      messageId: 'invocation-close',
    },
    activeEffectBudgetMs: 2_000,
    postcondition: {
      kind: 'whiteboard_closed',
      normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
      desiredOpen: false,
    },
    ...overrides,
  };
}

function openRequest(): WhiteboardOpenClientEffectRequest {
  const close = closeRequest();
  return {
    ...close,
    executionId: 'execution-open',
    toolCallId: 'tool-open',
    idempotencyKey: 'run-close:invocation-close:tool-open',
    toolName: 'wb_open',
    postcondition: {
      kind: 'whiteboard_open',
      normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
      desiredOpen: true,
    },
  };
}

function visibilityTarget(effect: WhiteboardCloseClientEffectRequest): WhiteboardVisibilityTarget {
  return {
    requestId: effect.target.requestId,
    sessionId: effect.target.sessionId,
    stageId: effect.target.stageId,
    sceneId: effect.target.sceneId,
    bindingVersion: 1,
  };
}

function accepted(
  effect: WhiteboardCloseClientEffectRequest,
  target = visibilityTarget(effect),
): Extract<ClientEffectAck, { status: 'accepted'; visibilityTarget: unknown }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'accepted-close',
    observedAt: Date.now(),
    status: 'accepted',
    visibilityTarget: target,
  };
}

function committed(
  effect: WhiteboardCloseClientEffectRequest,
  target = visibilityTarget(effect),
): Extract<ClientEffectAck, { status: 'effect_committed'; visibilityTarget: unknown }> {
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    executionId: effect.executionId,
    idempotencyKey: effect.idempotencyKey,
    clientEventId: 'committed-close',
    observedAt: Date.now(),
    status: 'effect_committed',
    visibilityTarget: target,
    postcondition: {
      kind: 'whiteboard_closed',
      normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
      desiredOpen: false,
      observedOpen: false,
      visibilityChanged: true,
    },
  };
}

const coordinators: ClientEffectCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators) coordinator.clearForTests();
  coordinators.length = 0;
});

describe('ClientEffectCoordinator wb_close', () => {
  it('accepts only exact visibility-target ACKs and mandatory close observations', () => {
    const effect = closeRequest();
    const acceptedAck = accepted(effect);
    const committedAck = committed(effect);
    expect(isClientEffectAck(acceptedAck)).toBe(true);
    expect(isClientEffectAck(committedAck)).toBe(true);
    expect(isClientEffectAck({ ...acceptedAck, unexpected: true })).toBe(false);
    expect(
      isClientEffectAck({
        ...acceptedAck,
        visibilityTarget: { ...acceptedAck.visibilityTarget, whiteboardId: 'fabricated' },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...committedAck,
        postcondition: { ...committedAck.postcondition, observedOpen: true },
      }),
    ).toBe(false);
    const { visibilityChanged: _visibilityChanged, ...missing } = committedAck.postcondition;
    expect(isClientEffectAck({ ...committedAck, postcondition: missing })).toBe(false);
    expect(
      isClientEffectAck({
        ...committedAck,
        postcondition: { ...committedAck.postcondition, extra: true },
      }),
    ).toBe(false);
  });

  it('settles only after an exact committed close observation', async () => {
    const effect = closeRequest();
    const coordinator = new ClientEffectCoordinator();
    coordinators.push(coordinator);
    const registration = coordinator.register(effect);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registration.delivery.acknowledgementToken,
        accepted(effect),
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'accepted' } });
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registration.delivery.acknowledgementToken,
        committed(effect, { ...visibilityTarget(effect), sceneId: 'wrong-scene' }),
      ),
    ).toMatchObject({ kind: 'invalid' });
    const committedAck = committed(effect);
    expect(
      coordinator.acknowledge(
        effect.executionId,
        registration.delivery.acknowledgementToken,
        committedAck,
      ),
    ).toMatchObject({ kind: 'applied', snapshot: { status: 'effect_committed' } });
    await expect(registration.result).resolves.toMatchObject({
      status: 'effect_committed',
      visibilityTarget: committedAck.visibilityTarget,
      committedObservation: committedAck.postcondition,
    });
  });

  it('shares one stage visibility owner with wb_open but not across sessions', () => {
    const coordinator = new ClientEffectCoordinator();
    coordinators.push(coordinator);
    coordinator.register(closeRequest());
    expect(() => coordinator.register(openRequest())).toThrow('CLIENT_EFFECT_RESOURCE_BUSY');
    expect(() =>
      coordinator.register(
        closeRequest({
          executionId: 'execution-other-session',
          toolCallId: 'tool-other-session',
          idempotencyKey: 'run-close:invocation-close:tool-other-session',
          target: {
            ...closeRequest().target,
            requestId: 'request-2',
            sessionId: 'session-2',
          },
        }),
      ),
    ).not.toThrow();

    const reverse = new ClientEffectCoordinator();
    coordinators.push(reverse);
    reverse.register(openRequest());
    expect(() => reverse.register(closeRequest())).toThrow('CLIENT_EFFECT_RESOURCE_BUSY');
  });
});
