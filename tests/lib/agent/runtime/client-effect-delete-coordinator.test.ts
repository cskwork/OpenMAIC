import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
  isClientEffectAck,
  type ClientEffectAck,
  type ClientEffectRequest,
} from '@/lib/agent/runtime/client-effect-contract';
import { ClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

let coordinator = new ClientEffectCoordinator();

function deleteRequest(
  opts: {
    executionId?: string;
    whiteboardId?: string;
    elementId?: string;
  } = {},
): ClientEffectRequest {
  const executionId = opts.executionId ?? 'delete-1';
  const elementId = opts.elementId ?? 'element-1';
  return {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    kind: 'client_effect',
    traceId: 'trace-1',
    runId: 'run-1',
    agentInvocationId: 'message-1',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: `tool-${executionId}`,
    executionId,
    idempotencyKey: `run-1:message-1:${executionId}`,
    toolName: 'wb_delete',
    args: { elementId },
    argsDigest: `sha256:${elementId}`,
    issuedAt: Date.now(),
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
      kind: 'whiteboard_element_absent',
      normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
      stableElementId: elementId,
      expectedWhiteboardId: opts.whiteboardId ?? 'whiteboard-1',
      expectedElementType: 'text',
    },
  };
}

function editRequest(
  opts: {
    executionId?: string;
    whiteboardId?: string;
    elementId?: string;
  } = {},
): ClientEffectRequest {
  const executionId = opts.executionId ?? 'edit-1';
  const elementId = opts.elementId ?? 'element-1';
  return {
    ...deleteRequest({ executionId, whiteboardId: opts.whiteboardId, elementId }),
    toolName: 'wb_edit_code',
    postcondition: {
      kind: 'whiteboard_code_edited',
      stableElementId: elementId,
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
      expectedWhiteboardId: opts.whiteboardId ?? 'whiteboard-1',
      expectedBeforeCodeDigest: 'sha256:before',
      expectedAfterCodeDigest: 'sha256:after',
      expectedAfterCodeState: {
        language: 'typescript',
        lines: [{ id: 'L1', content: 'const x = 2;' }],
        bounds: { x: 0, y: 0, width: 300, height: 200 },
        showLineNumbers: true,
        fontSize: 14,
        rotate: 0,
      },
      noOp: false,
    },
  };
}

function ackBase(request: ClientEffectRequest) {
  return {
    protocolVersion: 'maic.tool-execution.v1' as const,
    executionId: request.executionId,
    idempotencyKey: request.idempotencyKey,
    observedAt: Date.now(),
  };
}

afterEach(() => {
  coordinator.clearForTests();
  coordinator = new ClientEffectCoordinator();
});

describe('wb_delete coordinator contract', () => {
  it('requires and persists the strict authoritative delete observation', async () => {
    const request = deleteRequest();
    const registered = coordinator.register(request);
    const binding = {
      ...request.target,
      whiteboardId: 'whiteboard-1',
      bindingVersion: 1,
    };
    const apply = (ack: ClientEffectAck) =>
      coordinator.acknowledge(request.executionId, registered.delivery.acknowledgementToken, ack);
    expect(
      apply({
        ...ackBase(request),
        clientEventId: 'accepted',
        status: 'accepted',
        targetBinding: binding,
      }).kind,
    ).toBe('applied');
    expect(
      apply({
        ...ackBase(request),
        clientEventId: 'committed',
        status: 'effect_committed',
        targetBinding: binding,
        postcondition: {
          kind: 'whiteboard_element_absent',
          normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
          stableElementId: 'element-1',
          whiteboardId: 'whiteboard-1',
          observedElementType: 'text',
          matchingElementCountBefore: 1,
          matchingElementCountAfter: 0,
          elementCountBefore: 2,
          elementCountAfter: 1,
          deleted: true,
        },
      }).kind,
    ).toBe('applied');
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_committed',
      committedObservation: {
        kind: 'whiteboard_element_absent',
        stableElementId: 'element-1',
        elementCountBefore: 2,
        elementCountAfter: 1,
      },
    });
  });

  it('rejects mismatched committed evidence and accepts pre-binding preparation failure', async () => {
    const request = deleteRequest();
    const registered = coordinator.register(request);
    const outcome = coordinator.acknowledge(
      request.executionId,
      registered.delivery.acknowledgementToken,
      {
        ...ackBase(request),
        clientEventId: 'failed',
        status: 'effect_failed',
        error: {
          code: 'CLIENT_EFFECT_DELETE_ELEMENT_NOT_FOUND',
          message: 'missing',
          retryable: false,
        },
      },
    );
    expect(outcome.kind).toBe('applied');
    await expect(registered.result).resolves.toMatchObject({
      status: 'effect_failed',
      error: { code: 'CLIENT_EFFECT_DELETE_ELEMENT_NOT_FOUND' },
    });
  });

  it('uses the same scoped ownership key as wb_edit_code without cross-board conflicts', () => {
    coordinator.register(deleteRequest());
    expect(() => coordinator.register(editRequest())).toThrow('CLIENT_EFFECT_RESOURCE_BUSY');
    expect(() =>
      coordinator.register(
        editRequest({ executionId: 'edit-other', whiteboardId: 'whiteboard-2' }),
      ),
    ).not.toThrow();

    coordinator.clearForTests();
    coordinator.register(editRequest());
    expect(() => coordinator.register(deleteRequest())).toThrow('CLIENT_EFFECT_RESOURCE_BUSY');
  });

  it('rejects non-exact or arithmetically impossible delete ACK payloads', () => {
    const request = deleteRequest();
    const binding = {
      requestId: request.target.requestId,
      sessionId: request.target.sessionId,
      stageId: request.target.stageId,
      sceneId: request.target.sceneId,
      whiteboardId: 'whiteboard-1',
      bindingVersion: 1,
    };
    const valid = {
      ...ackBase(request),
      clientEventId: 'committed',
      status: 'effect_committed' as const,
      targetBinding: binding,
      postcondition: {
        kind: 'whiteboard_element_absent' as const,
        normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
        stableElementId: 'element-1',
        whiteboardId: 'whiteboard-1',
        observedElementType: 'text' as const,
        matchingElementCountBefore: 1 as const,
        matchingElementCountAfter: 0 as const,
        elementCountBefore: 2,
        elementCountAfter: 1,
        deleted: true as const,
      },
    };
    expect(isClientEffectAck(valid)).toBe(true);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, elementCountAfter: 2 },
      }),
    ).toBe(false);
    expect(
      isClientEffectAck({
        ...valid,
        postcondition: { ...valid.postcondition, unexpected: true },
      }),
    ).toBe(false);
  });
});
