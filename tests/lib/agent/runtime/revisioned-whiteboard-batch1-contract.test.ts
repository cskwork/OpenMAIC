import { describe, expect, it } from 'vitest';
import {
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
} from '@/lib/agent/runtime/client-effect-contract';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedDrawLineDigests,
  createRevisionedDrawShapeDigests,
  createRevisionedWhiteboardAcceptedAck,
  createRevisionedWhiteboardTerminalAck,
  isRevisionedWhiteboardCommittedReceiptForExpected,
  isRevisionedWhiteboardEffectDelivery,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedDrawLineExpectedDescriptor,
  type RevisionedDrawLineIntent,
  type RevisionedDrawShapeExpectedDescriptor,
  type RevisionedDrawShapeIntent,
  type RevisionedWhiteboardCommittedReceipt,
  type RevisionedWhiteboardExpectedDescriptor,
  type RevisionedWhiteboardAuthorityReceipt,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  deriveRevisionedElementId,
  deriveRevisionedWhiteboardId,
  digestWhiteboardLineV1Sync,
  digestWhiteboardShapeV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';

const expectedBinding = { stageId: 'stage-1', whiteboardId: null, revision: 0 } as const;
const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
} as const;

describe('Stage 3B Batch 1 strict multi-tool contract', () => {
  it('canonicalizes Shape/Line with v1-compatible digests and strict delivery discrimination', async () => {
    const deadlineAt = Date.now() + 10_000;
    const shape = createRevisionedDrawShapeDigests({
      executionId: 'shape-1',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: { shape: 'rectangle', x: 10, y: 20, width: 30, height: 40 },
    })!;
    const shapeSpec = normalizeWhiteboardShapeV1(shape.normalizedIntent);
    expect(shape.normalizedIntent).toMatchObject({ fillColor: '#5b9bd5' });
    expect(digestWhiteboardShapeV1Sync(shapeSpec)).toBe(await digestWhiteboardShapeV1(shapeSpec));

    const shapeDelivery = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      executionId: 'shape-1',
      requestDigest: shape.requestDigest,
      toolName: 'wb_draw_shape',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: shape.normalizedIntent,
      acknowledgementToken: 'ack-shape',
    } as const;
    expect(isRevisionedWhiteboardEffectDelivery(shapeDelivery)).toBe(true);
    expect(
      isRevisionedWhiteboardEffectDelivery({
        ...shapeDelivery,
        intent: { shape: 'rectangle', x: 10, y: 20, width: 30, height: 40 },
      }),
    ).toBe(false);
    expect(
      isRevisionedWhiteboardEffectDelivery({ ...shapeDelivery, toolName: 'wb_draw_line' }),
    ).toBe(false);
    expect(
      isRevisionedWhiteboardEffectDelivery({
        ...shapeDelivery,
        intent: { ...shapeDelivery.intent, width: 1_001 },
      }),
    ).toBe(false);

    const line = createRevisionedDrawLineDigests({
      executionId: 'line-1',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: { startX: 10, startY: 20, endX: 30, endY: 40 },
    })!;
    const lineSpec = normalizeWhiteboardLineV1(line.normalizedIntent);
    expect(line.normalizedIntent).toMatchObject({
      color: '#333333',
      width: 2,
      style: 'solid',
      points: ['', ''],
    });
    expect(digestWhiteboardLineV1Sync(lineSpec)).toBe(await digestWhiteboardLineV1(lineSpec));
    expect(
      createRevisionedDrawLineDigests({
        executionId: 'line-zero',
        expectedBinding,
        authenticatedTarget,
        deadlineAt,
        intent: { startX: 10, startY: 20, endX: 10, endY: 20 },
      }),
    ).toBeNull();
  });

  it.each(['shape', 'line'] as const)(
    'requires the exact %s descriptor and receipt before coordinator settlement',
    (kind) => {
      const executionId = `${kind}-exact`;
      const deadlineAt = Date.now() + 10_000;
      const stableElementId = deriveRevisionedElementId(executionId);
      const prepared =
        kind === 'shape'
          ? createRevisionedDrawShapeDigests({
              executionId,
              expectedBinding,
              authenticatedTarget,
              deadlineAt,
              intent: { shape: 'circle', x: 10, y: 20, width: 30, height: 40 },
            })!
          : createRevisionedDrawLineDigests({
              executionId,
              expectedBinding,
              authenticatedTarget,
              deadlineAt,
              intent: { startX: 10, startY: 20, endX: 30, endY: 40 },
            })!;
      const expected: RevisionedDrawShapeExpectedDescriptor | RevisionedDrawLineExpectedDescriptor =
        kind === 'shape'
          ? {
              kind: 'wb_draw_shape_v2',
              intentDigest: prepared.intentDigest,
              stableElementId,
              expectedShapeDigest: digestWhiteboardShapeV1Sync(
                normalizeWhiteboardShapeV1(
                  prepared.normalizedIntent as Readonly<RevisionedDrawShapeIntent>,
                ),
              ),
            }
          : {
              kind: 'wb_draw_line_v2',
              intentDigest: prepared.intentDigest,
              stableElementId,
              expectedLineDigest: digestWhiteboardLineV1Sync(
                normalizeWhiteboardLineV1(
                  prepared.normalizedIntent as Readonly<RevisionedDrawLineIntent>,
                ),
              ),
            };
      const coordinator = new RevisionedWhiteboardCoordinator({ createToken: () => 'ack-token' });
      const registration = coordinator.register({
        executionId,
        requestDigest: prepared.requestDigest,
        toolName: kind === 'shape' ? 'wb_draw_shape' : 'wb_draw_line',
        expectedBinding,
        authenticatedTarget,
        deadlineAt,
        intentDigest: prepared.intentDigest,
        observationAuthorizationDigest: `sha256:${'a'.repeat(64)}`,
        expectedMutation: expected,
      });
      expect(registration.kind).toBe('pending');
      if (registration.kind !== 'pending') throw new Error('Expected pending registration.');
      expect(
        coordinator.applyAck(
          registration.acknowledgementToken,
          createRevisionedWhiteboardAcceptedAck({
            executionId,
            requestDigest: prepared.requestDigest,
            targetBinding: { stageId: 'stage-1', whiteboardId: null, observedRevision: 0 },
          }),
        ),
      ).toMatchObject({ kind: 'applied' });

      const observedDigest =
        kind === 'shape'
          ? (expected as RevisionedDrawShapeExpectedDescriptor).expectedShapeDigest
          : (expected as RevisionedDrawLineExpectedDescriptor).expectedLineDigest;
      const whiteboardId = deriveRevisionedWhiteboardId(executionId);
      const receipt: RevisionedWhiteboardAuthorityReceipt = {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        outcome: 'committed',
        executionId,
        requestDigest: prepared.requestDigest,
        toolName: kind === 'shape' ? 'wb_draw_shape' : 'wb_draw_line',
        previousBinding: expectedBinding,
        currentBinding: { stageId: 'stage-1', whiteboardId, revision: 1 },
        changed: true,
        mutationMayHaveCommitted: false,
        delta: {
          kind: kind === 'shape' ? 'whiteboard_shape_created_v2' : 'whiteboard_line_created_v2',
          normalizationVersion:
            kind === 'shape'
              ? CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION
              : CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
          whiteboardId,
          stableElementId,
          createdWhiteboard: true,
          visibilityChanged: true,
          elementCountBefore: 0,
          elementCountAfter: 1,
        },
        postcondition: {
          kind: kind === 'shape' ? 'whiteboard_shape_exists_v2' : 'whiteboard_line_exists_v2',
          normalizationVersion:
            kind === 'shape'
              ? CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION
              : CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
          whiteboardId,
          stableElementId,
          elementType: kind,
          ...(kind === 'shape'
            ? { observedShapeDigest: observedDigest }
            : { observedLineDigest: observedDigest }),
          matchingElementCount: 1,
        },
      };
      expect(
        coordinator.applyAck(
          registration.acknowledgementToken,
          createRevisionedWhiteboardTerminalAck({
            ...receipt,
            currentBinding: {
              ...receipt.currentBinding,
              whiteboardId: 'forged-whiteboard',
            },
            delta: {
              ...((receipt as RevisionedWhiteboardCommittedReceipt).delta as Record<
                string,
                unknown
              >),
              whiteboardId: 'forged-whiteboard',
            },
            postcondition: {
              ...((receipt as RevisionedWhiteboardCommittedReceipt).postcondition as Record<
                string,
                unknown
              >),
              whiteboardId: 'forged-whiteboard',
            },
          } as RevisionedWhiteboardAuthorityReceipt),
        ),
      ).toMatchObject({ kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_DRAW_RECEIPT_INVALID' });
      expect(coordinator.getTerminal(executionId)).toBeNull();
      expect(
        coordinator.applyAck(
          registration.acknowledgementToken,
          createRevisionedWhiteboardTerminalAck({
            ...receipt,
            postcondition: {
              ...((receipt as RevisionedWhiteboardCommittedReceipt).postcondition as Record<
                string,
                unknown
              >),
              ...(kind === 'shape'
                ? { observedShapeDigest: `sha256:${'f'.repeat(64)}` }
                : { observedLineDigest: `sha256:${'f'.repeat(64)}` }),
            },
          } as RevisionedWhiteboardAuthorityReceipt),
        ),
      ).toMatchObject({ kind: 'invalid', reason: 'REVISIONED_WHITEBOARD_DRAW_RECEIPT_INVALID' });
      expect(
        coordinator.applyAck(
          registration.acknowledgementToken,
          createRevisionedWhiteboardTerminalAck(receipt),
        ),
      ).toMatchObject({ kind: 'applied', status: 'committed' });
    },
  );

  it.each([
    {
      toolName: 'wb_draw_text',
      descriptorKind: 'wb_draw_text_v2',
      deltaKind: 'whiteboard_text_created_v2',
      postconditionKind: 'whiteboard_text_exists_v2',
      normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
      elementType: 'text',
      expectedDigestKey: 'expectedContentDigest',
      observedDigestKey: 'observedContentDigest',
    },
    {
      toolName: 'wb_draw_shape',
      descriptorKind: 'wb_draw_shape_v2',
      deltaKind: 'whiteboard_shape_created_v2',
      postconditionKind: 'whiteboard_shape_exists_v2',
      normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
      elementType: 'shape',
      expectedDigestKey: 'expectedShapeDigest',
      observedDigestKey: 'observedShapeDigest',
    },
    {
      toolName: 'wb_draw_line',
      descriptorKind: 'wb_draw_line_v2',
      deltaKind: 'whiteboard_line_created_v2',
      postconditionKind: 'whiteboard_line_exists_v2',
      normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
      elementType: 'line',
      expectedDigestKey: 'expectedLineDigest',
      observedDigestKey: 'observedLineDigest',
    },
  ] as const)(
    'rejects $toolName committed receipts that switch or non-deterministically create a board',
    (fixture) => {
      const executionId = `binding-${fixture.toolName}`;
      const stableElementId = deriveRevisionedElementId(executionId);
      const intentDigest = `sha256:${'a'.repeat(64)}`;
      const observedDigest = `sha256:${'b'.repeat(64)}`;
      const expected = {
        kind: fixture.descriptorKind,
        intentDigest,
        stableElementId,
        [fixture.expectedDigestKey]: observedDigest,
      } as RevisionedWhiteboardExpectedDescriptor;
      const makeReceipt = (
        previousBinding: { stageId: string; whiteboardId: string | null; revision: number },
        currentWhiteboardId: string,
        createdWhiteboard: boolean,
      ) =>
        verifyRevisionedWhiteboardAuthorityReceipt({
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          outcome: 'committed',
          executionId,
          requestDigest: `sha256:${'c'.repeat(64)}`,
          toolName: fixture.toolName,
          previousBinding,
          currentBinding: {
            stageId: previousBinding.stageId,
            whiteboardId: currentWhiteboardId,
            revision: previousBinding.revision + 1,
          },
          changed: true,
          mutationMayHaveCommitted: false,
          delta: {
            kind: fixture.deltaKind,
            normalizationVersion: fixture.normalizationVersion,
            whiteboardId: currentWhiteboardId,
            stableElementId,
            createdWhiteboard,
            visibilityChanged: previousBinding.whiteboardId === null,
            elementCountBefore: previousBinding.whiteboardId === null ? 0 : 1,
            elementCountAfter: previousBinding.whiteboardId === null ? 1 : 2,
          },
          postcondition: {
            kind: fixture.postconditionKind,
            normalizationVersion: fixture.normalizationVersion,
            whiteboardId: currentWhiteboardId,
            stableElementId,
            elementType: fixture.elementType,
            [fixture.observedDigestKey]: observedDigest,
            matchingElementCount: 1,
          },
        });

      const existingBoard = { stageId: 'stage-1', whiteboardId: 'board-a', revision: 7 };
      const switched = makeReceipt(existingBoard, 'board-b', false);
      const nonDeterministicCreate = makeReceipt(
        { stageId: 'stage-1', whiteboardId: null, revision: 0 },
        'forged-created-board',
        true,
      );
      const retained = makeReceipt(existingBoard, 'board-a', false);
      const deterministicCreate = makeReceipt(
        { stageId: 'stage-1', whiteboardId: null, revision: 0 },
        deriveRevisionedWhiteboardId(executionId),
        true,
      );
      if (!switched || !nonDeterministicCreate || !retained || !deterministicCreate) {
        throw new Error('Expected shape-validated receipt fixtures.');
      }

      expect(isRevisionedWhiteboardCommittedReceiptForExpected(switched, expected)).toBe(false);
      expect(
        isRevisionedWhiteboardCommittedReceiptForExpected(nonDeterministicCreate, expected),
      ).toBe(false);
      expect(isRevisionedWhiteboardCommittedReceiptForExpected(retained, expected)).toBe(true);
      expect(isRevisionedWhiteboardCommittedReceiptForExpected(deterministicCreate, expected)).toBe(
        true,
      );
    },
  );

  it('rejects a descriptor/tool mismatch before a browser delivery can be authorized', () => {
    const coordinator = new RevisionedWhiteboardCoordinator();
    expect(() =>
      coordinator.register({
        executionId: 'descriptor-mismatch',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        toolName: 'wb_draw_shape',
        expectedBinding,
        authenticatedTarget,
        deadlineAt: Date.now() + 10_000,
        intentDigest: `sha256:${'b'.repeat(64)}`,
        observationAuthorizationDigest: `sha256:${'c'.repeat(64)}`,
        expectedMutation: {
          kind: 'wb_draw_line_v2',
          intentDigest: `sha256:${'b'.repeat(64)}`,
          stableElementId: 'element-1',
          expectedLineDigest: `sha256:${'d'.repeat(64)}`,
        },
      }),
    ).toThrow('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
  });

  it.each(['wb_draw_text', 'wb_draw_shape', 'wb_draw_line'] as const)(
    'rejects %s registration when its exact expected descriptor is missing',
    (toolName) => {
      const coordinator = new RevisionedWhiteboardCoordinator();
      expect(() =>
        coordinator.register({
          executionId: `missing-descriptor-${toolName}`,
          requestDigest: `sha256:${'a'.repeat(64)}`,
          toolName,
          expectedBinding,
          authenticatedTarget,
          deadlineAt: Date.now() + 10_000,
          intentDigest: `sha256:${'b'.repeat(64)}`,
          observationAuthorizationDigest: `sha256:${'c'.repeat(64)}`,
        }),
      ).toThrow('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
    },
  );
});
