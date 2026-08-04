import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  applyWhiteboardCodeEditV1,
  digestWhiteboardCodeV1,
  digestWhiteboardEditableCodeStateV1,
  normalizeWhiteboardCodeV1,
  type WhiteboardEditableCodeState,
} from '@/lib/agent/runtime/client-effect-contract';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedWhiteboardAcceptedAck,
  createRevisionedWhiteboardTerminalAck,
  createRevisionedDrawCodeDigests,
  createRevisionedEditCodeDigests,
  expectedRevisionedCodeEditNewLineIds,
  isRevisionedWhiteboardEffectDelivery,
  verifyRevisionedWhiteboardAuthorityReceipt,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  deriveRevisionedCodeEditLineId,
  digestWhiteboardCodeV1Sync,
  digestWhiteboardEditableCodeStateV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';

const expectedBinding = { stageId: 'stage-1', whiteboardId: 'board-1', revision: 4 } as const;
const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
} as const;

const before: WhiteboardEditableCodeState = {
  language: 'typescript',
  lines: [
    { id: 'legacy-A', content: 'const a = 1;' },
    { id: 'legacy-B', content: 'console.log(a);' },
  ],
  fileName: 'example.ts',
  bounds: { x: 80, y: 60, width: 600, height: 300 },
  showLineNumbers: true,
  fontSize: 14,
  rotate: 0,
};

describe('Stage 3B Batch 3 strict Code contracts', () => {
  it('keeps synchronous Code digests identical to the frozen asynchronous v1 digests', async () => {
    const draw = normalizeWhiteboardCodeV1({
      language: 'ts',
      code: 'const a = 1;\r\nconsole.log(a);',
      x: 80,
      y: 60,
      width: 600,
      height: 300,
      fileName: 'example.ts',
    });
    expect(digestWhiteboardCodeV1Sync(draw)).toBe(await digestWhiteboardCodeV1(draw));
    expect(digestWhiteboardEditableCodeStateV1Sync(before)).toBe(
      await digestWhiteboardEditableCodeStateV1(before),
    );
  });

  it('uses the exact deterministic CE2 line-ID encoding without changing the legacy default', () => {
    expect(deriveRevisionedCodeEditLineId('执行-😀', 1)).toBe(
      'CE2_40b8f046881ccc5cebecc1e73d21f27f330221cbc55555c2ed77cde3e78e0ccf_1',
    );
    expect(deriveRevisionedCodeEditLineId('执行-😀', 200)).toMatch(/_200$/u);
    expect(() => deriveRevisionedCodeEditLineId('执行-😀', 0)).toThrow(
      'REVISIONED_WHITEBOARD_CODE_LINE_ORDINAL_INVALID',
    );

    const intent = {
      elementId: 'code-1',
      operation: 'insert_after' as const,
      lineId: 'legacy-A',
      content: 'first\nsecond',
    };
    const legacy = applyWhiteboardCodeEditV1({ before, intent, executionId: 'edit-1' });
    const revisioned = applyWhiteboardCodeEditV1({
      before,
      intent,
      executionId: 'edit-1',
      lineIdFactory: deriveRevisionedCodeEditLineId,
    });
    expect(legacy.newLineIds).toEqual(['CE_edit-1_2', 'CE_edit-1_3']);
    expect(revisioned.newLineIds).toEqual(expectedRevisionedCodeEditNewLineIds('edit-1', intent));
    expect(revisioned.after.lines.map(({ content }) => content)).toEqual(
      legacy.after.lines.map(({ content }) => content),
    );
  });

  it('strictly correlates Draw/Edit deliveries with their canonical request digests', () => {
    const deadlineAt = Date.now() + 10_000;
    const draw = createRevisionedDrawCodeDigests({
      executionId: 'draw-code-delivery',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: { language: 'ts', code: 'a\r\nb', x: 10, y: 20 },
    })!;
    const edit = createRevisionedEditCodeDigests({
      executionId: 'edit-code-delivery',
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent: {
        elementId: 'code-1',
        operation: 'replace_lines',
        lineIds: ['legacy-A'],
        content: 'updated\r\nnew',
      },
    })!;
    const common = {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      acknowledgementToken: 'ack-token',
    };
    const deliveries = [
      {
        ...common,
        executionId: 'draw-code-delivery',
        requestDigest: draw.requestDigest,
        toolName: 'wb_draw_code',
        intent: draw.normalizedIntent,
      },
      {
        ...common,
        executionId: 'edit-code-delivery',
        requestDigest: edit.requestDigest,
        toolName: 'wb_edit_code',
        intent: edit.normalizedIntent,
      },
    ] as const;
    for (const delivery of deliveries) {
      expect(isRevisionedWhiteboardEffectDelivery(delivery)).toBe(true);
      expect(
        isRevisionedWhiteboardEffectDelivery({
          ...delivery,
          intent: { ...delivery.intent, elementId: 'forged' },
        }),
      ).toBe(false);
    }
  });

  it.each(['wb_draw_code', 'wb_edit_code'] as const)(
    'requires the exact %s descriptor before coordinator registration',
    (toolName) => {
      const coordinator = new RevisionedWhiteboardCoordinator();
      expect(() =>
        coordinator.register({
          executionId: 'missing-' + toolName,
          requestDigest: 'sha256:' + 'a'.repeat(64),
          toolName,
          expectedBinding,
          authenticatedTarget,
          deadlineAt: Date.now() + 10_000,
          intentDigest: 'sha256:' + 'b'.repeat(64),
          observationAuthorizationDigest: 'sha256:' + 'c'.repeat(64),
        }),
      ).toThrow('REVISIONED_WHITEBOARD_REGISTRATION_INVALID');
    },
  );

  it('deep-snapshots Draw/Edit descriptor arrays before terminal authentication', async () => {
    const settle = async (input: {
      executionId: string;
      toolName: 'wb_draw_code' | 'wb_edit_code';
      expectedMutation:
        | {
            kind: 'wb_draw_code_v2';
            intentDigest: string;
            stableElementId: string;
            expectedCodeDigest: string;
            expectedLineIds: string[];
          }
        | {
            kind: 'wb_edit_code_v2';
            intentDigest: string;
            stableElementId: string;
            expectedNewLineIds: string[];
          };
      receipt: unknown;
      mutate: () => void;
    }) => {
      const coordinator = new RevisionedWhiteboardCoordinator();
      const requestDigest = 'sha256:' + 'a'.repeat(64);
      const registration = coordinator.register({
        executionId: input.executionId,
        requestDigest,
        toolName: input.toolName,
        expectedBinding,
        authenticatedTarget,
        deadlineAt: Date.now() + 10_000,
        intentDigest: input.expectedMutation.intentDigest,
        observationAuthorizationDigest: 'sha256:' + 'c'.repeat(64),
        expectedMutation: input.expectedMutation,
      });
      if (registration.kind !== 'pending') throw new Error('Expected pending registration.');
      input.mutate();
      expect(
        coordinator.applyAck(
          registration.acknowledgementToken,
          createRevisionedWhiteboardAcceptedAck({
            executionId: input.executionId,
            requestDigest,
            targetBinding: {
              stageId: expectedBinding.stageId,
              whiteboardId: expectedBinding.whiteboardId,
              observedRevision: expectedBinding.revision,
            },
          }),
        ),
      ).toMatchObject({ kind: 'applied' });
      const receipt = verifyRevisionedWhiteboardAuthorityReceipt(input.receipt);
      if (!receipt) throw new Error('Expected valid receipt fixture.');
      expect(
        coordinator.applyAck(
          registration.acknowledgementToken,
          createRevisionedWhiteboardTerminalAck(receipt),
        ),
      ).toMatchObject({ kind: 'applied', status: 'committed' });
      await expect(registration.terminal).resolves.toMatchObject({ status: 'committed' });
    };

    const drawLineIds = ['L1'];
    await settle({
      executionId: 'descriptor-draw-alias',
      toolName: 'wb_draw_code',
      expectedMutation: {
        kind: 'wb_draw_code_v2',
        intentDigest: 'sha256:' + 'b'.repeat(64),
        stableElementId: 'code-draw',
        expectedCodeDigest: 'sha256:' + 'd'.repeat(64),
        expectedLineIds: drawLineIds,
      },
      receipt: {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        outcome: 'committed',
        executionId: 'descriptor-draw-alias',
        requestDigest: 'sha256:' + 'a'.repeat(64),
        toolName: 'wb_draw_code',
        previousBinding: expectedBinding,
        currentBinding: { ...expectedBinding, revision: expectedBinding.revision + 1 },
        changed: true,
        mutationMayHaveCommitted: false,
        delta: {
          kind: 'whiteboard_code_created_v2',
          normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
          whiteboardId: 'board-1',
          stableElementId: 'code-draw',
          createdWhiteboard: false,
          visibilityChanged: false,
          elementCountBefore: 0,
          elementCountAfter: 1,
        },
        postcondition: {
          kind: 'whiteboard_code_exists_v2',
          normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
          whiteboardId: 'board-1',
          stableElementId: 'code-draw',
          elementType: 'code',
          observedCodeDigest: 'sha256:' + 'd'.repeat(64),
          orderedLineIds: ['L1'],
          matchingElementCount: 1,
        },
      },
      mutate: () => drawLineIds.push('L2'),
    });

    const editNewLineIds: string[] = [];
    await settle({
      executionId: 'descriptor-edit-alias',
      toolName: 'wb_edit_code',
      expectedMutation: {
        kind: 'wb_edit_code_v2',
        intentDigest: 'sha256:' + 'b'.repeat(64),
        stableElementId: 'code-edit',
        expectedNewLineIds: editNewLineIds,
      },
      receipt: {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        outcome: 'committed',
        executionId: 'descriptor-edit-alias',
        requestDigest: 'sha256:' + 'a'.repeat(64),
        toolName: 'wb_edit_code',
        previousBinding: expectedBinding,
        currentBinding: expectedBinding,
        changed: false,
        mutationMayHaveCommitted: false,
        delta: {
          kind: 'whiteboard_code_edited_v2',
          normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
          whiteboardId: 'board-1',
          stableElementId: 'code-edit',
          codeChanged: false,
          visibilityChanged: false,
          newLineIds: [],
          elementCountBefore: 1,
          elementCountAfter: 1,
        },
        postcondition: {
          kind: 'whiteboard_code_state_observed_v2',
          normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
          whiteboardId: 'board-1',
          stableElementId: 'code-edit',
          elementType: 'code',
          observedBeforeCodeDigest: 'sha256:' + 'e'.repeat(64),
          observedAfterCodeDigest: 'sha256:' + 'e'.repeat(64),
          orderedLineIds: ['legacy-A'],
          matchingElementCountBefore: 1,
          matchingElementCountAfter: 1,
        },
      },
      mutate: () => editNewLineIds.push(deriveRevisionedCodeEditLineId('descriptor-edit-alias', 1)),
    });
  });

  it('keeps Batch 3 internal-only and free of request-scoped shadow state', () => {
    const v2Source = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/pi/tools/native-whiteboard-v2-code.ts'),
      'utf8',
    );
    const callAgentSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/pi/tools/call-agent.ts'),
      'utf8',
    );
    expect(v2Source).not.toMatch(/NativeWhiteboard(?:Code|View)State/u);
    expect(v2Source).not.toMatch(/native-whiteboard-(?:code|view)-state/u);
    expect(callAgentSource).not.toMatch(/native-whiteboard-v2-code/u);
  });
});
