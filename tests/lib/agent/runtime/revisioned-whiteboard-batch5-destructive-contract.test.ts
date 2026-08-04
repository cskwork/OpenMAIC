import { describe, expect, it } from 'vitest';
import {
  CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
  CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
  CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
  CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
  CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
} from '@/lib/agent/runtime/client-effect-contract';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedClearDigests,
  createRevisionedDeleteDigests,
  isRevisionedClearCommittedReceipt,
  isRevisionedDeleteCommittedReceipt,
  isRevisionedWhiteboardEffectDelivery,
  normalizeRevisionedClearIntent,
  normalizeRevisionedDeleteIntent,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedClearExpectedDescriptor,
  type RevisionedDeleteExpectedDescriptor,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';

const target = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
};
const binding = { stageId: 'stage-1', whiteboardId: 'board-1', revision: 3 };
const deadlineAt = 9_999_999_999_999;

function validated(value: unknown) {
  const receipt = verifyRevisionedWhiteboardAuthorityReceipt(value);
  if (!receipt) throw new Error('Expected shape-valid receipt.');
  return receipt;
}

function deleteDigests() {
  return createRevisionedDeleteDigests({
    executionId: 'delete-1',
    expectedBinding: binding,
    authenticatedTarget: target,
    deadlineAt,
    intent: { elementId: 'text-1' },
  })!;
}

function clearDigests(whiteboardId: string | null = 'board-1') {
  return createRevisionedClearDigests({
    executionId: 'clear-1',
    expectedBinding: { ...binding, whiteboardId },
    authenticatedTarget: target,
    deadlineAt,
    intent: {},
  })!;
}

describe('Stage 3B Batch 5 destructive contract', () => {
  it('normalizes strict Delete/Clear intent and rejects control characters or extras', () => {
    expect(normalizeRevisionedDeleteIntent({ elementId: 'text-1' })).toEqual({
      elementId: 'text-1',
    });
    expect(normalizeRevisionedDeleteIntent({ elementId: 'bad\nID' })).toBeNull();
    expect(normalizeRevisionedDeleteIntent({ elementId: 'text-1', reason: 'done' })).toBeNull();
    expect(normalizeRevisionedClearIntent({})).toEqual({});
    expect(normalizeRevisionedClearIntent({ reason: 'done' })).toBeNull();
    expect(normalizeRevisionedClearIntent([])).toBeNull();
  });

  it.each(['wb_delete', 'wb_clear'] as const)(
    'validates strict %s delivery without optional caller facts',
    (toolName) => {
      const created = toolName === 'wb_delete' ? deleteDigests() : clearDigests();
      const delivery = {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        executionId: toolName === 'wb_delete' ? 'delete-1' : 'clear-1',
        requestDigest: created.requestDigest,
        toolName,
        expectedBinding: binding,
        authenticatedTarget: target,
        deadlineAt,
        intent: created.normalizedIntent,
        acknowledgementToken: 'ack-1',
      };
      expect(isRevisionedWhiteboardEffectDelivery(delivery)).toBe(true);
      expect(
        isRevisionedWhiteboardEffectDelivery({ ...delivery, expectedElementType: 'text' }),
      ).toBe(false);
      expect(
        isRevisionedWhiteboardEffectDelivery({ ...delivery, intent: { reason: 'done' } }),
      ).toBe(false);
    },
  );

  it.each([
    { toolName: 'wb_delete' as const, wrongKind: 'wb_clear_v2' as const },
    { toolName: 'wb_clear' as const, wrongKind: 'wb_delete_v2' as const },
  ])(
    'rejects missing and cross-tool expected descriptor for $toolName',
    ({ toolName, wrongKind }) => {
      const created = toolName === 'wb_delete' ? deleteDigests() : clearDigests();
      const registration = {
        executionId: toolName === 'wb_delete' ? 'delete-1' : 'clear-1',
        requestDigest: created.requestDigest,
        toolName,
        expectedBinding: binding,
        authenticatedTarget: target,
        deadlineAt,
        intentDigest: created.intentDigest,
        observationAuthorizationDigest: `sha256:${'a'.repeat(64)}`,
      };
      const coordinator = new RevisionedWhiteboardCoordinator();
      expect(() => coordinator.register(registration)).toThrow(
        'REVISIONED_WHITEBOARD_REGISTRATION_INVALID',
      );
      expect(() =>
        coordinator.register({
          ...registration,
          expectedMutation:
            wrongKind === 'wb_clear_v2'
              ? { kind: wrongKind, intentDigest: created.intentDigest }
              : {
                  kind: wrongKind,
                  intentDigest: created.intentDigest,
                  stableElementId: 'text-1',
                },
        }),
      ).toThrow('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
      coordinator.clearForTests();
    },
  );

  it('accepts only the exact Delete proof and rejects board/type/count forgery', () => {
    const created = deleteDigests();
    const expected: RevisionedDeleteExpectedDescriptor = {
      kind: 'wb_delete_v2',
      intentDigest: created.intentDigest,
      stableElementId: 'text-1',
    };
    const receipt = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId: 'delete-1',
      requestDigest: created.requestDigest,
      toolName: 'wb_delete',
      previousBinding: binding,
      currentBinding: { ...binding, revision: 4 },
      changed: true,
      mutationMayHaveCommitted: false,
      delta: {
        kind: 'whiteboard_element_deleted_v2',
        normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
        whiteboardId: 'board-1',
        stableElementId: 'text-1',
        observedElementType: 'text',
        visibilityChanged: false,
        elementCountBefore: 2,
        elementCountAfter: 1,
      },
      postcondition: {
        kind: 'whiteboard_element_absent_v2',
        normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
        whiteboardId: 'board-1',
        stableElementId: 'text-1',
        observedElementType: 'text',
        matchingElementCountBefore: 1,
        matchingElementCountAfter: 0,
      },
    };
    expect(isRevisionedDeleteCommittedReceipt(validated(receipt), expected)).toBe(true);
    for (const forged of [
      { ...receipt, currentBinding: { ...receipt.currentBinding, whiteboardId: 'board-2' } },
      { ...receipt, delta: { ...receipt.delta, elementCountAfter: 0 } },
      { ...receipt, postcondition: { ...receipt.postcondition, observedElementType: 'shape' } },
      { ...receipt, postcondition: { ...receipt.postcondition, extra: true } },
    ]) {
      expect(isRevisionedDeleteCommittedReceipt(validated(forged), expected)).toBe(false);
    }
  });

  it.each([
    {
      boardState: 'no_board' as const,
      whiteboardId: null,
      changed: false,
      revision: 3,
      delta: {
        kind: 'whiteboard_cleared_v2',
        normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
        boardState: 'no_board',
        whiteboardId: null,
        cleared: false,
        visibilityChanged: false,
        elementCountBefore: 0,
        elementCountAfter: 0,
      },
      postcondition: {
        kind: 'whiteboard_membership_empty_v2',
        normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
        membershipNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
        boardState: 'no_board',
        whiteboardId: null,
        observedOpen: true,
        elementCountAfter: 0,
        observedMembershipDigestAfter: CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
      },
    },
    {
      boardState: 'preserved_empty' as const,
      whiteboardId: 'board-1',
      changed: false,
      revision: 3,
      delta: {
        kind: 'whiteboard_cleared_v2',
        normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
        boardState: 'preserved_empty',
        whiteboardId: 'board-1',
        cleared: false,
        visibilityChanged: false,
        elementCountBefore: 0,
        elementCountAfter: 0,
      },
      postcondition: {
        kind: 'whiteboard_membership_empty_v2',
        normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
        membershipNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
        boardContentNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
        boardState: 'preserved_empty',
        whiteboardId: 'board-1',
        observedOpen: false,
        elementCountBefore: 0,
        elementCountAfter: 0,
        observedMembershipDigestBefore: CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
        observedMembershipDigestAfter: CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
        observedBoardContentDigestAfter: CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
      },
    },
    {
      boardState: 'cleared_existing' as const,
      whiteboardId: 'board-1',
      changed: true,
      revision: 4,
      delta: {
        kind: 'whiteboard_cleared_v2',
        normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
        boardState: 'cleared_existing',
        whiteboardId: 'board-1',
        cleared: true,
        visibilityChanged: true,
        elementCountBefore: 2,
        elementCountAfter: 0,
      },
      postcondition: {
        kind: 'whiteboard_membership_empty_v2',
        normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
        membershipNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
        boardContentNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
        boardState: 'cleared_existing',
        whiteboardId: 'board-1',
        observedOpen: true,
        elementCountBefore: 2,
        elementCountAfter: 0,
        observedMembershipDigestBefore: `sha256:${'1'.repeat(64)}`,
        observedMembershipDigestAfter: CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
        boardContentDigestBefore: `sha256:${'2'.repeat(64)}`,
        observedBoardContentDigestAfter: CLIENT_EFFECT_EMPTY_WHITEBOARD_CONTENT_DIGEST_V1,
        historySnapshotDigest: `sha256:${'2'.repeat(64)}`,
        historyDisposition: 'inserted',
      },
    },
  ])('accepts exact Clear $boardState branch and rejects cross-branch fields', (value) => {
    const created = clearDigests(value.whiteboardId);
    const expected: RevisionedClearExpectedDescriptor = {
      kind: 'wb_clear_v2',
      intentDigest: created.intentDigest,
    };
    const receipt = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId: 'clear-1',
      requestDigest: created.requestDigest,
      toolName: 'wb_clear',
      previousBinding: { ...binding, whiteboardId: value.whiteboardId },
      currentBinding: {
        ...binding,
        whiteboardId: value.whiteboardId,
        revision: value.revision,
      },
      changed: value.changed,
      mutationMayHaveCommitted: false,
      delta: value.delta,
      postcondition: value.postcondition,
    };
    expect(isRevisionedClearCommittedReceipt(validated(receipt), expected)).toBe(true);
    expect(
      isRevisionedClearCommittedReceipt(
        validated({
          ...receipt,
          postcondition: { ...receipt.postcondition, forgedHistoryField: 'not-allowed' },
        }),
        expected,
      ),
    ).toBe(false);
  });
});
