import { describe, expect, it } from 'vitest';
import {
  CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
  digestWhiteboardContentV1,
} from '@/lib/agent/runtime/client-effect-contract';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedCloseDigests,
  createRevisionedOpenDigests,
  isRevisionedLifecycleCommittedReceipt,
  isRevisionedWhiteboardEffectDelivery,
  normalizeRevisionedWhiteboardLifecycleIntent,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedCloseExpectedDescriptor,
  type RevisionedOpenExpectedDescriptor,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  deriveRevisionedWhiteboardId,
  digestWhiteboardContentV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';

const target = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
};

function digests(toolName: 'wb_open' | 'wb_close', whiteboardId: string | null = 'board-1') {
  const input = {
    executionId: `execution-${toolName}`,
    expectedBinding: { stageId: 'stage-1', whiteboardId, revision: 3 },
    authenticatedTarget: target,
    deadlineAt: 9_999_999_999_999,
    intent: {},
  };
  return toolName === 'wb_open'
    ? createRevisionedOpenDigests(input)!
    : createRevisionedCloseDigests(input)!;
}

function validated(value: unknown) {
  const receipt = verifyRevisionedWhiteboardAuthorityReceipt(value);
  if (!receipt) throw new Error('Expected a shape-valid receipt.');
  return receipt;
}

describe('Stage 3B Batch 4 lifecycle contract', () => {
  it('normalizes only the exact empty lifecycle intent and keeps digest parity', async () => {
    expect(normalizeRevisionedWhiteboardLifecycleIntent({})).toEqual({});
    expect(normalizeRevisionedWhiteboardLifecycleIntent({ reason: 'done' })).toBeNull();
    expect(normalizeRevisionedWhiteboardLifecycleIntent([])).toBeNull();
    expect(digests('wb_open').intentDigest).toBe(digests('wb_close').intentDigest);
    expect(digestWhiteboardContentV1Sync([])).toBe(
      CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
    );
    await expect(digestWhiteboardContentV1([])).resolves.toBe(
      CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
    );
  });

  it.each(['wb_open', 'wb_close'] as const)(
    'validates strict %s delivery and rejects lifecycle intent extras',
    (toolName) => {
      const created = digests(toolName);
      const delivery = {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        executionId: `execution-${toolName}`,
        requestDigest: created.requestDigest,
        toolName,
        expectedBinding: { stageId: 'stage-1', whiteboardId: 'board-1', revision: 3 },
        authenticatedTarget: target,
        deadlineAt: 9_999_999_999_999,
        intent: {},
        acknowledgementToken: 'ack-1',
      };
      expect(isRevisionedWhiteboardEffectDelivery(delivery)).toBe(true);
      expect(
        isRevisionedWhiteboardEffectDelivery({ ...delivery, intent: { reason: 'done' } }),
      ).toBe(false);
      expect(isRevisionedWhiteboardEffectDelivery({ ...delivery, reason: 'done' })).toBe(false);
    },
  );

  it.each([
    { toolName: 'wb_open' as const, descriptorKind: 'wb_close_v2' as const },
    { toolName: 'wb_close' as const, descriptorKind: 'wb_open_v2' as const },
  ])('rejects missing and cross-tool lifecycle descriptors for $toolName', (value) => {
    const created = digests(value.toolName);
    const registration = {
      executionId: `execution-${value.toolName}`,
      requestDigest: created.requestDigest,
      toolName: value.toolName,
      expectedBinding: { stageId: 'stage-1', whiteboardId: 'board-1', revision: 3 },
      authenticatedTarget: target,
      deadlineAt: 9_999_999_999_999,
      intentDigest: created.intentDigest,
      observationAuthorizationDigest: `sha256:${'b'.repeat(64)}`,
    };
    const coordinator = new RevisionedWhiteboardCoordinator();
    expect(() => coordinator.register(registration)).toThrow(
      'REVISIONED_WHITEBOARD_REGISTRATION_INVALID',
    );
    expect(() =>
      coordinator.register({
        ...registration,
        expectedMutation: {
          kind: value.descriptorKind,
          intentDigest: created.intentDigest,
        },
      }),
    ).toThrow('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
    coordinator.clearForTests();
  });

  it('verifies existing-board Open/Close, including visibility no-op', () => {
    const cases = [
      { toolName: 'wb_open' as const, previousOpen: false, currentOpen: true, changed: true },
      { toolName: 'wb_open' as const, previousOpen: true, currentOpen: true, changed: false },
      { toolName: 'wb_close' as const, previousOpen: true, currentOpen: false, changed: true },
      { toolName: 'wb_close' as const, previousOpen: false, currentOpen: false, changed: false },
    ];
    for (const value of cases) {
      const created = digests(value.toolName);
      const expected = {
        kind: `${value.toolName}_v2`,
        intentDigest: created.intentDigest,
      } as RevisionedOpenExpectedDescriptor | RevisionedCloseExpectedDescriptor;
      const receipt = validated({
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        outcome: 'committed',
        executionId: `execution-${value.toolName}`,
        requestDigest: created.requestDigest,
        toolName: value.toolName,
        previousBinding: { stageId: 'stage-1', whiteboardId: 'board-1', revision: 3 },
        currentBinding: {
          stageId: 'stage-1',
          whiteboardId: 'board-1',
          revision: 3 + (value.changed ? 1 : 0),
        },
        changed: value.changed,
        mutationMayHaveCommitted: false,
        delta:
          value.toolName === 'wb_open'
            ? {
                kind: 'whiteboard_opened_v2',
                previousOpen: value.previousOpen,
                currentOpen: true,
                created: false,
                visibilityChanged: value.previousOpen !== value.currentOpen,
              }
            : {
                kind: 'whiteboard_closed_v2',
                previousOpen: value.previousOpen,
                currentOpen: false,
                visibilityChanged: value.previousOpen !== value.currentOpen,
              },
        postcondition: {
          kind: 'whiteboard_visibility_observed_v2',
          boardState: 'preserved_existing',
          normalizationVersion: 'maic.whiteboard-content.v1',
          whiteboardId: 'board-1',
          observedOpen: value.currentOpen,
          elementCountBefore: 2,
          elementCountAfter: 2,
          boardContentDigestBefore: CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
          boardContentDigestAfter: CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
        },
      });
      expect(isRevisionedLifecycleCommittedReceipt(receipt, expected)).toBe(true);

      const forged = structuredClone(receipt);
      if (forged.outcome !== 'committed') throw new Error('Expected committed.');
      (forged.postcondition as Record<string, unknown>).forged = true;
      expect(isRevisionedLifecycleCommittedReceipt(validated(forged), expected)).toBe(false);
    }
  });

  it('verifies created-empty Open and rejects forged board IDs or before claims', () => {
    const executionId = 'execution-wb_open';
    const created = digests('wb_open', null);
    const expected: RevisionedOpenExpectedDescriptor = {
      kind: 'wb_open_v2',
      intentDigest: created.intentDigest,
    };
    const receipt = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId,
      requestDigest: created.requestDigest,
      toolName: 'wb_open',
      previousBinding: { stageId: 'stage-1', whiteboardId: null, revision: 3 },
      currentBinding: {
        stageId: 'stage-1',
        whiteboardId: deriveRevisionedWhiteboardId(executionId),
        revision: 4,
      },
      changed: true,
      mutationMayHaveCommitted: false,
      delta: {
        kind: 'whiteboard_opened_v2',
        previousOpen: true,
        currentOpen: true,
        created: true,
        visibilityChanged: false,
      },
      postcondition: {
        kind: 'whiteboard_visibility_observed_v2',
        boardState: 'created_empty',
        normalizationVersion: 'maic.whiteboard-content.v1',
        whiteboardId: deriveRevisionedWhiteboardId(executionId),
        observedOpen: true,
        elementCountAfter: 0,
        boardContentDigestAfter: CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
      },
    };
    expect(isRevisionedLifecycleCommittedReceipt(validated(receipt), expected)).toBe(true);
    expect(
      isRevisionedLifecycleCommittedReceipt(
        validated({
          ...receipt,
          currentBinding: { ...receipt.currentBinding, whiteboardId: 'forged-board' },
          postcondition: { ...receipt.postcondition, whiteboardId: 'forged-board' },
        }),
        expected,
      ),
    ).toBe(false);
    expect(
      isRevisionedLifecycleCommittedReceipt(
        validated({
          ...receipt,
          postcondition: { ...receipt.postcondition, elementCountBefore: 0 },
        }),
        expected,
      ),
    ).toBe(false);
  });

  it.each([
    { previousOpen: true, changed: true, revision: 4 },
    { previousOpen: false, changed: false, revision: 3 },
  ])('verifies nullable Close without fabricating board content: %o', (value) => {
    const created = digests('wb_close', null);
    const expected: RevisionedCloseExpectedDescriptor = {
      kind: 'wb_close_v2',
      intentDigest: created.intentDigest,
    };
    const receipt = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId: 'execution-wb_close',
      requestDigest: created.requestDigest,
      toolName: 'wb_close',
      previousBinding: { stageId: 'stage-1', whiteboardId: null, revision: 3 },
      currentBinding: { stageId: 'stage-1', whiteboardId: null, revision: value.revision },
      changed: value.changed,
      mutationMayHaveCommitted: false,
      delta: {
        kind: 'whiteboard_closed_v2',
        previousOpen: value.previousOpen,
        currentOpen: false,
        visibilityChanged: value.previousOpen,
      },
      postcondition: {
        kind: 'whiteboard_visibility_observed_v2',
        boardState: 'no_board',
        whiteboardId: null,
        observedOpen: false,
      },
    };
    expect(isRevisionedLifecycleCommittedReceipt(validated(receipt), expected)).toBe(true);
    expect(
      isRevisionedLifecycleCommittedReceipt(
        validated({
          ...receipt,
          postcondition: {
            ...receipt.postcondition,
            boardContentDigestAfter: 'sha256:'.padEnd(71, '0'),
          },
        }),
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a shape-valid but lifecycle-invalid terminal through the coordinator ACK seam', () => {
    const executionId = 'close-ack-negative';
    const deadlineAt = Date.now() + 10_000;
    const expectedBinding = { stageId: 'stage-1', whiteboardId: null, revision: 3 };
    const created = createRevisionedCloseDigests({
      executionId,
      expectedBinding,
      authenticatedTarget: target,
      deadlineAt,
      intent: {},
    })!;
    const coordinator = new RevisionedWhiteboardCoordinator({ createToken: () => 'ack-token' });
    coordinator.register({
      executionId,
      requestDigest: created.requestDigest,
      toolName: 'wb_close',
      expectedBinding,
      authenticatedTarget: target,
      deadlineAt,
      intentDigest: created.intentDigest,
      observationAuthorizationDigest: `sha256:${'b'.repeat(64)}`,
      expectedMutation: { kind: 'wb_close_v2', intentDigest: created.intentDigest },
    });
    expect(
      coordinator.applyAck('ack-token', {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'accepted',
        executionId,
        requestDigest: created.requestDigest,
        targetBinding: {
          stageId: 'stage-1',
          whiteboardId: null,
          observedRevision: 3,
        },
      }),
    ).toMatchObject({ kind: 'applied', status: 'accepted' });
    const receipt = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId,
      requestDigest: created.requestDigest,
      toolName: 'wb_close',
      previousBinding: expectedBinding,
      currentBinding: { ...expectedBinding, revision: 4 },
      changed: true,
      mutationMayHaveCommitted: false,
      delta: {
        kind: 'whiteboard_closed_v2',
        previousOpen: true,
        currentOpen: false,
        visibilityChanged: true,
      },
      postcondition: {
        kind: 'whiteboard_visibility_observed_v2',
        boardState: 'no_board',
        whiteboardId: null,
        observedOpen: false,
        forged: true,
      },
    };
    expect(
      coordinator.applyAck('ack-token', {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_committed',
        executionId,
        requestDigest: created.requestDigest,
        receipt,
      }),
    ).toEqual({ kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_DRAW_RECEIPT_INVALID' });
    coordinator.clearForTests();
  });

  it.each([
    'wrong revision',
    'wrong element count',
    'wrong content digest',
    'wrong postcondition branch',
  ] as const)('rejects lifecycle terminal ACK with %s', (forgery) => {
    const executionId = 'close-ack-matrix';
    const deadlineAt = Date.now() + 10_000;
    const expectedBinding = { stageId: 'stage-1', whiteboardId: 'board-1', revision: 3 };
    const created = createRevisionedCloseDigests({
      executionId,
      expectedBinding,
      authenticatedTarget: target,
      deadlineAt,
      intent: {},
    })!;
    const coordinator = new RevisionedWhiteboardCoordinator({ createToken: () => 'ack-token' });
    coordinator.register({
      executionId,
      requestDigest: created.requestDigest,
      toolName: 'wb_close',
      expectedBinding,
      authenticatedTarget: target,
      deadlineAt,
      intentDigest: created.intentDigest,
      observationAuthorizationDigest: `sha256:${'b'.repeat(64)}`,
      expectedMutation: { kind: 'wb_close_v2', intentDigest: created.intentDigest },
    });
    expect(
      coordinator.applyAck('ack-token', {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'accepted',
        executionId,
        requestDigest: created.requestDigest,
        targetBinding: {
          stageId: 'stage-1',
          whiteboardId: 'board-1',
          observedRevision: 3,
        },
      }),
    ).toMatchObject({ kind: 'applied', status: 'accepted' });
    const receipt = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId,
      requestDigest: created.requestDigest,
      toolName: 'wb_close',
      previousBinding: expectedBinding,
      currentBinding: { ...expectedBinding, revision: 4 },
      changed: true,
      mutationMayHaveCommitted: false,
      delta: {
        kind: 'whiteboard_closed_v2',
        previousOpen: true,
        currentOpen: false,
        visibilityChanged: true,
      },
      postcondition: {
        kind: 'whiteboard_visibility_observed_v2',
        boardState: 'preserved_existing',
        normalizationVersion: 'maic.whiteboard-content.v1',
        whiteboardId: 'board-1',
        observedOpen: false,
        elementCountBefore: 0,
        elementCountAfter: 0,
        boardContentDigestBefore: CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
        boardContentDigestAfter: CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
      },
    };
    const forgedReceipt =
      forgery === 'wrong revision'
        ? { ...receipt, currentBinding: { ...receipt.currentBinding, revision: 5 } }
        : forgery === 'wrong element count'
          ? {
              ...receipt,
              postcondition: { ...receipt.postcondition, elementCountAfter: 1 },
            }
          : forgery === 'wrong content digest'
            ? {
                ...receipt,
                postcondition: {
                  ...receipt.postcondition,
                  boardContentDigestAfter: `sha256:${'0'.repeat(64)}`,
                },
              }
            : {
                ...receipt,
                postcondition: {
                  kind: 'whiteboard_visibility_observed_v2',
                  boardState: 'no_board',
                  whiteboardId: null,
                  observedOpen: false,
                },
              };
    expect(
      coordinator.applyAck('ack-token', {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        status: 'effect_committed',
        executionId,
        requestDigest: created.requestDigest,
        receipt: forgedReceipt,
      }),
    ).toMatchObject({ kind: 'invalid' });
    coordinator.clearForTests();
  });
});
