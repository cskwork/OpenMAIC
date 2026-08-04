import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createRevisionedDrawCodeDigests,
  createRevisionedEditCodeDigests,
  isRevisionedDrawCodeCommittedReceipt,
  isRevisionedEditCodeCommittedReceipt,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedDrawCodeExpectedDescriptor,
  type RevisionedEditCodeExpectedDescriptor,
  type RevisionedEditCodeIntent,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  deriveRevisionedCodeEditLineId,
  deriveRevisionedElementId,
  digestWhiteboardCodeV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { normalizeWhiteboardCodeV1 } from '@/lib/agent/runtime/client-effect-contract';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { PPTCodeElement } from '@openmaic/dsl';

function codeElement(lines?: PPTCodeElement['lines']): PPTCodeElement {
  return {
    id: 'code-existing',
    type: 'code',
    language: 'typescript',
    lines: lines ?? [
      { id: 'legacy-A', content: 'const a = 1;' },
      { id: 'legacy-B', content: 'console.log(a);' },
      { id: 'legacy-C', content: 'export { a };' },
    ],
    fileName: 'existing.ts',
    showLineNumbers: true,
    fontSize: 14,
    left: 80,
    top: 60,
    width: 600,
    height: 300,
    rotate: 0,
  };
}

function board(id: string, elements: Whiteboard['elements'] = []): Whiteboard {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements,
    background: { type: 'solid', color: '#ffffff' },
    animations: [],
  };
}

function stage(elements: Whiteboard['elements'] = [codeElement()]): Stage {
  return {
    id: 'stage-1',
    name: 'Preserve non-whiteboard fields',
    createdAt: 1,
    updatedAt: 2,
    whiteboard: [board('board-1', elements), board('board-2')],
  };
}

function harness(opts: { open?: boolean; elements?: Whiteboard['elements'] } = {}) {
  let open = opts.open ?? true;
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: stage(opts.elements) }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  const writeOpen = vi.fn((value: boolean) => {
    open = value;
  });
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => writeOpen(whiteboardOpen),
  });
  authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
  return { store, authority, writeOpen, readOpen: () => open };
}

const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
};

function expected(authority: WhiteboardEnvironmentAuthority) {
  const snapshot = authority.querySnapshot();
  if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
  return {
    stageId: snapshot.value.stageId,
    whiteboardId: snapshot.value.activeWhiteboardId,
    revision: snapshot.value.revision,
  };
}

function editInput(
  authority: WhiteboardEnvironmentAuthority,
  executionId: string,
  intent: RevisionedEditCodeIntent,
) {
  const expectedBinding = expected(authority);
  const deadlineAt = Date.now() + 10_000;
  const digests = createRevisionedEditCodeDigests({
    executionId,
    expectedBinding,
    authenticatedTarget,
    deadlineAt,
    intent,
  })!;
  return {
    executionId,
    requestDigest: digests.requestDigest,
    expected: expectedBinding,
    authenticatedTarget,
    deadlineAt,
    intentDigest: digests.intentDigest,
    intent: digests.normalizedIntent,
  };
}

describe('WhiteboardEnvironmentAuthority Stage 3B Batch 3 Code', () => {
  it('derives canonical Code Draw state and exact receipt without changing unrelated state', () => {
    const { store, authority } = harness({ open: false, elements: [] });
    const before = structuredClone(store.getState().stage!);
    const expectedBinding = expected(authority);
    const executionId = 'draw-code-authority';
    const deadlineAt = Date.now() + 10_000;
    const intent = {
      language: 'ts',
      code: 'function f() {\r\n  return 1;\r\n}\r\n',
      x: 80,
      y: 60,
      width: 600,
      height: 300,
      fileName: 'example.ts',
    };
    const digests = createRevisionedDrawCodeDigests({
      executionId,
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent,
    })!;
    const input = {
      executionId,
      requestDigest: digests.requestDigest,
      expected: expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intentDigest: digests.intentDigest,
      intent: digests.normalizedIntent,
    };
    const result = authority.transactRevisionedDrawCode(input);
    if (!result.ok || result.receipt.outcome !== 'committed') throw new Error('Expected commit.');
    const spec = normalizeWhiteboardCodeV1(intent);
    const descriptor: RevisionedDrawCodeExpectedDescriptor = {
      kind: 'wb_draw_code_v2',
      intentDigest: digests.intentDigest,
      stableElementId: deriveRevisionedElementId(executionId),
      expectedCodeDigest: digestWhiteboardCodeV1Sync(spec),
      expectedLineIds: ['L1', 'L2', 'L3', 'L4'],
    };
    expect(
      isRevisionedDrawCodeCommittedReceipt(
        verifyRevisionedWhiteboardAuthorityReceipt(result.receipt)!,
        descriptor,
      ),
    ).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0].elements[0]).toMatchObject({
      id: descriptor.stableElementId,
      type: 'code',
      language: 'typescript',
      lines: [
        { id: 'L1', content: 'function f() {' },
        { id: 'L2', content: '  return 1;' },
        { id: 'L3', content: '}' },
        { id: 'L4', content: '' },
      ],
    });
    const after = store.getState().stage!;
    expect({ ...after, whiteboard: undefined }).toEqual({ ...before, whiteboard: undefined });
    expect(after.whiteboard?.[1]).toEqual(before.whiteboard?.[1]);
    expect(authority.transactRevisionedDrawCode(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: result.receipt,
    });
    expect(after.whiteboard?.[0].elements).toHaveLength(1);
  });

  it.each([
    {
      name: 'insert_after',
      intent: {
        elementId: 'code-existing',
        operation: 'insert_after',
        lineId: 'legacy-A',
        content: 'first\nsecond',
      } as const,
      contents: ['const a = 1;', 'first', 'second', 'console.log(a);', 'export { a };'],
      newCount: 2,
    },
    {
      name: 'insert_before',
      intent: {
        elementId: 'code-existing',
        operation: 'insert_before',
        lineId: 'legacy-B',
        content: 'before',
      } as const,
      contents: ['const a = 1;', 'before', 'console.log(a);', 'export { a };'],
      newCount: 1,
    },
    {
      name: 'delete_lines',
      intent: {
        elementId: 'code-existing',
        operation: 'delete_lines',
        lineIds: ['legacy-A', 'legacy-C'],
      } as const,
      contents: ['console.log(a);'],
      newCount: 0,
    },
    {
      name: 'replace_lines',
      intent: {
        elementId: 'code-existing',
        operation: 'replace_lines',
        lineIds: ['legacy-A', 'legacy-C'],
        content: 'replacement-1\nreplacement-2\nreplacement-3',
      } as const,
      contents: ['replacement-1', 'replacement-2', 'replacement-3', 'console.log(a);'],
      newCount: 1,
    },
  ])(
    'executes $name from actual Authority state with stable IDs',
    ({ intent, contents, newCount }) => {
      const { store, authority } = harness();
      const beforeStage = structuredClone(store.getState().stage!);
      const input = editInput(
        authority,
        'edit-' + intent.operation,
        structuredClone(intent) as RevisionedEditCodeIntent,
      );
      const result = authority.transactRevisionedEditCode(input);
      if (!result.ok || result.receipt.outcome !== 'committed') throw new Error('Expected commit.');
      const newLineIds = Array.from({ length: newCount }, (_, index) =>
        deriveRevisionedCodeEditLineId(input.executionId, index + 1),
      );
      const descriptor: RevisionedEditCodeExpectedDescriptor = {
        kind: 'wb_edit_code_v2',
        intentDigest: input.intentDigest,
        stableElementId: 'code-existing',
        expectedNewLineIds: newLineIds,
      };
      expect(
        isRevisionedEditCodeCommittedReceipt(
          verifyRevisionedWhiteboardAuthorityReceipt(result.receipt)!,
          descriptor,
        ),
      ).toBe(true);
      if (intent.operation === 'insert_after') {
        const exact = (value: unknown) => {
          const validated = verifyRevisionedWhiteboardAuthorityReceipt(value);
          return validated ? isRevisionedEditCodeCommittedReceipt(validated, descriptor) : false;
        };
        const reordered = structuredClone(result.receipt);
        if (reordered.outcome !== 'committed') throw new Error('Expected committed receipt.');
        const reorderedDelta = reordered.delta as { newLineIds: string[] };
        reorderedDelta.newLineIds.reverse();
        expect(exact(reordered)).toBe(false);

        const missing = structuredClone(result.receipt);
        if (missing.outcome !== 'committed') throw new Error('Expected committed receipt.');
        (missing.delta as { newLineIds: string[] }).newLineIds.pop();
        expect(exact(missing)).toBe(false);

        const unlisted = structuredClone(result.receipt);
        if (unlisted.outcome !== 'committed') throw new Error('Expected committed receipt.');
        (unlisted.postcondition as { orderedLineIds: string[] }).orderedLineIds.push(
          deriveRevisionedCodeEditLineId(input.executionId, newCount + 1),
        );
        expect(exact(unlisted)).toBe(false);

        const forgedFlag = structuredClone(result.receipt);
        if (forgedFlag.outcome !== 'committed') throw new Error('Expected committed receipt.');
        (forgedFlag.delta as { codeChanged: boolean }).codeChanged = false;
        expect(exact(forgedFlag)).toBe(false);

        const forgedCount = structuredClone(result.receipt);
        if (forgedCount.outcome !== 'committed') throw new Error('Expected committed receipt.');
        (forgedCount.delta as { elementCountAfter: number }).elementCountAfter += 1;
        expect(exact(forgedCount)).toBe(false);

        const extraKey = structuredClone(result.receipt);
        if (extraKey.outcome !== 'committed') throw new Error('Expected committed receipt.');
        (extraKey.postcondition as Record<string, unknown>).forged = true;
        expect(exact(extraKey)).toBe(false);
      }
      const element = store.getState().stage?.whiteboard?.[0].elements[0] as PPTCodeElement;
      expect(element.lines.map(({ content }) => content)).toEqual(contents);
      const afterStage = store.getState().stage!;
      expect({ ...afterStage, whiteboard: undefined }).toEqual({
        ...beforeStage,
        whiteboard: undefined,
      });
      expect(afterStage.whiteboard?.[1]).toEqual(beforeStage.whiteboard?.[1]);
      expect(result.receipt.delta).toMatchObject({
        codeChanged: true,
        visibilityChanged: false,
        newLineIds,
      });
      expect(authority.transactRevisionedEditCode(input)).toMatchObject({
        ok: true,
        replayed: true,
        receipt: result.receipt,
      });
    },
  );

  it('distinguishes true no-op from visibility-only change without writing edit metadata', () => {
    const noOp = harness({ open: true });
    const listener = vi.fn();
    noOp.authority.subscribe(listener);
    const sameIntent = {
      elementId: 'code-existing',
      operation: 'replace_lines' as const,
      lineIds: ['legacy-A'],
      content: 'const a = 1;',
    };
    const first = noOp.authority.transactRevisionedEditCode(
      editInput(noOp.authority, 'edit-true-noop', sameIntent),
    );
    expect(first).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'committed',
        changed: false,
        previousBinding: { revision: 0 },
        currentBinding: { revision: 0 },
        delta: { codeChanged: false, visibilityChanged: false, newLineIds: [] },
      },
    });
    expect(listener).not.toHaveBeenCalled();
    expect(noOp.writeOpen).not.toHaveBeenCalled();
    expect(noOp.store.getState().stage?.whiteboard?.[0].elements[0]).not.toHaveProperty(
      'executionId',
    );

    const visibility = harness({ open: false });
    const second = visibility.authority.transactRevisionedEditCode(
      editInput(visibility.authority, 'edit-visibility-only', sameIntent),
    );
    expect(second).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'committed',
        changed: true,
        currentBinding: { revision: 1 },
        delta: { codeChanged: false, visibilityChanged: true, newLineIds: [] },
      },
    });
    expect(visibility.readOpen()).toBe(true);
    expect(visibility.writeOpen).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'blank insert',
      intent: {
        elementId: 'code-existing',
        operation: 'insert_after',
        lineId: 'legacy-A',
        content: '',
      } as RevisionedEditCodeIntent,
      expectedIds: (executionId: string) => [
        'legacy-A',
        deriveRevisionedCodeEditLineId(executionId, 1),
        'legacy-B',
        'legacy-C',
      ],
      expectedContents: ['const a = 1;', '', 'console.log(a);', 'export { a };'],
    },
    {
      name: 'out-of-source-order blank replace',
      intent: {
        elementId: 'code-existing',
        operation: 'replace_lines',
        lineIds: ['legacy-C', 'legacy-A'],
        content: '',
      } as RevisionedEditCodeIntent,
      expectedIds: () => ['legacy-B', 'legacy-C'],
      expectedContents: ['console.log(a);', ''],
    },
    {
      name: 'delete all',
      intent: {
        elementId: 'code-existing',
        operation: 'delete_lines',
        lineIds: ['legacy-A', 'legacy-B', 'legacy-C'],
      } as RevisionedEditCodeIntent,
      expectedIds: () => [],
      expectedContents: [],
    },
  ])(
    'preserves Legacy operation parity for $name',
    ({ name, intent, expectedIds, expectedContents }) => {
      const { store, authority } = harness();
      const executionId = 'parity-' + name.replaceAll(' ', '-');
      const result = authority.transactRevisionedEditCode(
        editInput(authority, executionId, intent),
      );
      expect(result).toMatchObject({ ok: true, receipt: { outcome: 'committed' } });
      const element = store.getState().stage?.whiteboard?.[0].elements[0] as PPTCodeElement;
      expect(element.lines.map(({ id }) => id)).toEqual(expectedIds(executionId));
      expect(element.lines.map(({ content }) => content)).toEqual(expectedContents);
    },
  );

  it('increments revision once when both code and visibility change', () => {
    const { authority, readOpen } = harness({ open: false });
    const result = authority.transactRevisionedEditCode(
      editInput(authority, 'edit-code-and-visibility', {
        elementId: 'code-existing',
        operation: 'replace_lines',
        lineIds: ['legacy-A'],
        content: 'const a = 2;',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'committed',
        changed: true,
        previousBinding: { revision: 0 },
        currentBinding: { revision: 1 },
        delta: { codeChanged: true, visibilityChanged: true },
      },
    });
    expect(readOpen()).toBe(true);
  });

  it('fails closed for duplicate targets, missing targets and deterministic generated-ID collision', () => {
    const duplicate = harness();
    const duplicateBefore = structuredClone(duplicate.store.getState().stage);
    expect(
      createRevisionedEditCodeDigests({
        executionId: 'edit-duplicate',
        expectedBinding: expected(duplicate.authority),
        authenticatedTarget,
        deadlineAt: Date.now() + 10_000,
        intent: {
          elementId: 'code-existing',
          operation: 'delete_lines',
          lineIds: ['legacy-A', 'legacy-A'],
        },
      }),
    ).toBeNull();
    expect(duplicate.store.getState().stage).toEqual(duplicateBefore);

    const missing = harness();
    const missingResult = missing.authority.transactRevisionedEditCode(
      editInput(missing.authority, 'edit-missing', {
        elementId: 'code-existing',
        operation: 'delete_lines',
        lineIds: ['missing-line'],
      }),
    );
    expect(missingResult).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'TARGET_PRECONDITION_FAILED' } },
    });

    const wrongType = harness({
      elements: [{ id: 'code-existing', type: 'text', content: 'not code' } as never],
    });
    expect(
      wrongType.authority.transactRevisionedEditCode(
        editInput(wrongType.authority, 'edit-wrong-type', {
          elementId: 'code-existing',
          operation: 'delete_lines',
          lineIds: ['legacy-A'],
        }),
      ),
    ).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'TARGET_PRECONDITION_FAILED' } },
    });

    const duplicateElement = harness({ elements: [codeElement(), codeElement()] });
    expect(
      duplicateElement.authority.transactRevisionedEditCode(
        editInput(duplicateElement.authority, 'edit-duplicate-element', {
          elementId: 'code-existing',
          operation: 'delete_lines',
          lineIds: ['legacy-A'],
        }),
      ),
    ).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'TARGET_PRECONDITION_FAILED' } },
    });

    const executionId = 'edit-collision';
    const collisionId = deriveRevisionedCodeEditLineId(executionId, 1);
    const collision = harness({
      elements: [
        codeElement([
          { id: 'legacy-A', content: 'a' },
          { id: collisionId, content: 'b' },
        ]),
      ],
    });
    const collisionResult = collision.authority.transactRevisionedEditCode(
      editInput(collision.authority, executionId, {
        elementId: 'code-existing',
        operation: 'insert_after',
        lineId: 'legacy-A',
        content: 'new',
      }),
    );
    expect(collisionResult).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'TARGET_PRECONDITION_FAILED' } },
    });
    expect(collision.store.getState().stage?.whiteboard?.[0].elements).toEqual([
      codeElement([
        { id: 'legacy-A', content: 'a' },
        { id: collisionId, content: 'b' },
      ]),
    ]);
  });

  it.each([
    {
      name: 'changed edit',
      open: false,
      intent: {
        elementId: 'code-existing',
        operation: 'delete_lines',
        lineIds: ['legacy-A'],
      } as RevisionedEditCodeIntent,
    },
    {
      name: 'true no-op',
      open: true,
      intent: {
        elementId: 'code-existing',
        operation: 'replace_lines',
        lineIds: ['reserved-prefix'],
        content: 'reserved',
      } as RevisionedEditCodeIntent,
    },
  ])(
    'rejects a preserved same-execution CE2 namespace before writes for $name',
    ({ open, intent }) => {
      const executionId = 'edit-reserved-prefix';
      const reservedId = deriveRevisionedCodeEditLineId(executionId, 99);
      const resolvedIntent =
        intent.operation === 'replace_lines' ? { ...intent, lineIds: [reservedId] } : intent;
      const state = harness({
        open,
        elements: [
          codeElement([
            { id: reservedId, content: 'reserved' },
            { id: 'legacy-A', content: 'legacy' },
          ]),
        ],
      });
      const before = structuredClone(state.store.getState().stage);
      const listener = vi.fn();
      state.authority.subscribe(listener);
      const result = state.authority.transactRevisionedEditCode(
        editInput(state.authority, executionId, resolvedIntent),
      );
      expect(result).toMatchObject({
        ok: true,
        receipt: {
          outcome: 'rejected',
          changed: false,
          mutationMayHaveCommitted: false,
          error: { code: 'TARGET_PRECONDITION_FAILED' },
        },
      });
      expect(state.store.getState().stage).toEqual(before);
      expect(state.readOpen()).toBe(open);
      expect(state.writeOpen).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(state.authority.querySnapshot()).toMatchObject({
        ok: true,
        value: { revision: 0, open },
      });
    },
  );
});
