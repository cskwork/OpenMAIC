import { describe, expect, it } from 'vitest';
import { RevisionedWhiteboardTargetRegistry } from '@/lib/agent/client/revisioned-whiteboard-target-registry';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedDrawTextDigests,
  type RevisionedWhiteboardEffectDelivery,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';

function delivery(
  deadlineAt: number,
  executionId = 'execution-1',
): RevisionedWhiteboardEffectDelivery {
  const expectedBinding = { stageId: 'stage-1', whiteboardId: null, revision: 0 };
  const authenticatedTarget = {
    childInvocationId: 'child-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    sceneId: 'scene-1',
  };
  const intent = { content: 'hello', x: 100, y: 120 };
  const digests = createRevisionedDrawTextDigests({
    executionId,
    expectedBinding,
    authenticatedTarget,
    deadlineAt,
    intent,
  })!;
  return {
    protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
    executionId,
    requestDigest: digests.requestDigest,
    toolName: 'wb_draw_text',
    expectedBinding,
    authenticatedTarget,
    deadlineAt,
    intent,
    acknowledgementToken: 'ack-token',
  };
}

describe('RevisionedWhiteboardTargetRegistry', () => {
  it('snapshots caller-owned delivery and consumes the exact authenticated target once', () => {
    let now = 1_000;
    let sceneId = 'scene-1';
    const registry = new RevisionedWhiteboardTargetRegistry({ now: () => now });
    const input = delivery(2_000);
    const requestDigest = input.requestDigest;
    const readCurrentStageId = () => 'stage-1';
    const readCurrentSceneId = () => sceneId;
    const environment = {
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId,
      readCurrentSceneId,
    };
    const claim = registry.register(input, environment);
    input.intent.content = 'mutated after reservation';
    input.authenticatedTarget.sceneId = 'forged-scene';
    input.expectedBinding.revision = 99;
    environment.readCurrentStageId = () => 'caller-mutated-stage';
    environment.readCurrentSceneId = () => 'caller-mutated-scene';

    expect(
      registry.validateAndConsume({
        executionId: 'execution-1',
        requestDigest,
        intentDigest: claim.intentDigest,
        authenticatedTarget: {
          childInvocationId: 'child-1',
          requestId: 'request-1',
          sessionId: 'session-1',
          sceneId: 'scene-1',
        },
        expectedStageId: 'stage-1',
        deadlineAt: 2_000,
      }),
    ).toBe(true);
    expect(registry.getSizeForTests()).toBe(0);

    const second = delivery(3_000);
    environment.readCurrentStageId = readCurrentStageId;
    environment.readCurrentSceneId = readCurrentSceneId;
    registry.register(second, environment);
    sceneId = 'scene-2';
    const secondDigest = createRevisionedDrawTextDigests({
      executionId: second.executionId,
      expectedBinding: second.expectedBinding,
      authenticatedTarget: second.authenticatedTarget,
      deadlineAt: second.deadlineAt,
      intent: second.intent,
    })!.intentDigest;
    expect(
      registry.validateAndConsume({
        executionId: second.executionId,
        requestDigest: second.requestDigest,
        intentDigest: secondDigest,
        authenticatedTarget: second.authenticatedTarget,
        expectedStageId: second.expectedBinding.stageId,
        deadlineAt: second.deadlineAt,
      }),
    ).toBe(false);
    expect(registry.getSizeForTests()).toBe(0);
    now = 3_001;
  });

  it('binds one stable browser environment and rejects reader replacement', () => {
    const registry = new RevisionedWhiteboardTargetRegistry();
    const environment = {
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => 'stage-1',
      readCurrentSceneId: () => 'scene-1',
    };
    registry.register(delivery(Date.now() + 1_000), environment);

    expect(() =>
      registry.register(delivery(Date.now() + 1_000, 'execution-2'), {
        ...environment,
        readCurrentStageId: () => 'stage-1',
      }),
    ).toThrow('REVISIONED_WHITEBOARD_TARGET_ENVIRONMENT_CONFLICT');
  });

  it('rejects conflicts and enforces count, byte and TTL bounds', () => {
    let now = 1_000;
    const environment = {
      requestId: 'request-1',
      sessionId: 'session-1',
      readCurrentStageId: () => 'stage-1',
      readCurrentSceneId: () => 'scene-1',
    };
    const registry = new RevisionedWhiteboardTargetRegistry({
      now: () => now,
      maxClaims: 1,
    });
    const first = delivery(2_000);
    registry.register(first, environment);
    expect(() =>
      registry.register({ ...first, acknowledgementToken: 'different' }, environment),
    ).toThrow('REVISIONED_WHITEBOARD_TARGET_REGISTRATION_CONFLICT');
    const second = delivery(2_000, 'execution-2');
    expect(() => registry.register(second, environment)).toThrow(
      'REVISIONED_WHITEBOARD_TARGET_REGISTRY_CAPACITY_EXCEEDED',
    );
    now = 2_001;
    expect(registry.getSizeForTests()).toBe(0);

    const byteBounded = new RevisionedWhiteboardTargetRegistry({ maxBytes: 1 });
    expect(() => byteBounded.register(delivery(Date.now() + 1_000), environment)).toThrow(
      'REVISIONED_WHITEBOARD_TARGET_REGISTRY_CAPACITY_EXCEEDED',
    );
  });
});
