import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createRevisionedClearDigests,
  createRevisionedDeleteDigests,
  createRevisionedEditCodeDigests,
  isRevisionedClearCommittedReceipt,
  isRevisionedDeleteCommittedReceipt,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedClearExpectedDescriptor,
  type RevisionedDeleteExpectedDescriptor,
  type RevisionedEditCodeIntent,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  digestWhiteboardContentV1Sync,
  digestWhiteboardMembershipV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import {
  WhiteboardEnvironmentAuthority,
  type WhiteboardAuthorityHistoryStore,
} from '@/lib/store/whiteboard-environment-authority';
import type { PPTElement } from '@openmaic/dsl';
import type { Stage, Whiteboard } from '@/lib/types/stage';

const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
};

function text(id: string, content = id): PPTElement {
  return {
    id,
    type: 'text',
    content: `<p>${content}</p>`,
    left: 40,
    top: 40,
    width: 240,
    height: 80,
    rotate: 0,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
  };
}

function code(): PPTElement {
  return {
    id: 'code-existing',
    type: 'code',
    language: 'typescript',
    lines: [
      { id: 'legacy-A', content: 'const a = 1;' },
      { id: 'legacy-B', content: 'console.log(a);' },
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

function board(elements: PPTElement[] = [text('text-1'), text('text-2')]): Whiteboard {
  return {
    id: 'board-1',
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements,
    background: { type: 'solid', color: '#ffffff' },
    animations: [],
  };
}

function stage(whiteboards: Whiteboard[]): Stage {
  return {
    id: 'stage-1',
    name: 'Preserve non-whiteboard fields',
    createdAt: 1,
    updatedAt: 2,
    whiteboard: whiteboards,
  };
}

function harness(input: {
  elements?: PPTElement[];
  withBoard?: boolean;
  open?: boolean;
  historyStore?: WhiteboardAuthorityHistoryStore;
  writeOpen?: (value: boolean) => void;
}) {
  let open = input.open ?? true;
  const withBoard = input.withBoard ?? true;
  const store = createStore<{ stage: Stage | null }>(() => ({
    stage: stage(withBoard ? [board(input.elements)] : []),
  }));
  const authority = new WhiteboardEnvironmentAuthority(store, () => open, {
    historyStore: input.historyStore,
  });
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      input.writeOpen?.(whiteboardOpen);
      open = whiteboardOpen;
    },
  });
  authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
  return { authority, store, readOpen: () => open };
}

function binding(authority: WhiteboardEnvironmentAuthority) {
  const snapshot = authority.querySnapshot();
  if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
  return {
    stageId: snapshot.value.stageId,
    whiteboardId: snapshot.value.activeWhiteboardId,
    revision: snapshot.value.revision,
  };
}

function deleteInput(
  authority: WhiteboardEnvironmentAuthority,
  executionId: string,
  elementId = 'text-1',
) {
  const expected = binding(authority);
  const deadlineAt = Date.now() + 10_000;
  const digests = createRevisionedDeleteDigests({
    executionId,
    expectedBinding: expected,
    authenticatedTarget,
    deadlineAt,
    intent: { elementId },
  })!;
  return {
    executionId,
    requestDigest: digests.requestDigest,
    expected,
    authenticatedTarget,
    deadlineAt,
    intentDigest: digests.intentDigest,
    intent: digests.normalizedIntent,
  };
}

function clearInput(authority: WhiteboardEnvironmentAuthority, executionId: string) {
  const expected = binding(authority);
  const deadlineAt = Date.now() + 10_000;
  const digests = createRevisionedClearDigests({
    executionId,
    expectedBinding: expected,
    authenticatedTarget,
    deadlineAt,
    intent: {},
  })!;
  return {
    executionId,
    requestDigest: digests.requestDigest,
    expected,
    authenticatedTarget,
    deadlineAt,
    intentDigest: digests.intentDigest,
    intent: digests.normalizedIntent,
  };
}

function editInput(
  authority: WhiteboardEnvironmentAuthority,
  executionId: string,
  intent: RevisionedEditCodeIntent,
) {
  const expected = binding(authority);
  const deadlineAt = Date.now() + 10_000;
  const digests = createRevisionedEditCodeDigests({
    executionId,
    expectedBinding: expected,
    authenticatedTarget,
    deadlineAt,
    intent,
  })!;
  return {
    executionId,
    requestDigest: digests.requestDigest,
    expected,
    authenticatedTarget,
    deadlineAt,
    intentDigest: digests.intentDigest,
    intent: digests.normalizedIntent,
  };
}

function historyStore(input?: {
  throwAfter?: boolean;
  invalidReceipt?: boolean;
  disposition?: 'inserted' | 'existing';
}) {
  const pushExactSnapshot = vi.fn((elements: PPTElement[], boardContentDigest: string) => {
    if (input?.invalidReceipt) {
      return { snapshotIndex: -1, boardContentDigest, inserted: true };
    }
    const receipt = {
      snapshotIndex: 0,
      boardContentDigest,
      inserted: input?.disposition !== 'existing',
    };
    if (input?.throwAfter) throw new Error('history listener failed after an unprovable call');
    return receipt;
  });
  return {
    store: { getState: () => ({ pushExactSnapshot }) } satisfies WhiteboardAuthorityHistoryStore,
    pushExactSnapshot,
  };
}

describe('WhiteboardEnvironmentAuthority Stage 3B Batch 5 destructive mutations', () => {
  it('binds one stable history store idempotently and rejects a different store', () => {
    const first = historyStore();
    const second = historyStore();
    const { authority } = harness({ historyStore: first.store });
    expect(() => authority.configureHistoryStore(first.store)).not.toThrow();
    expect(() => authority.configureHistoryStore(second.store)).toThrow(
      'REVISIONED_WHITEBOARD_HISTORY_STORE_CONFLICT',
    );
  });

  it.each([{ open: true }, { open: false }])(
    'deletes exactly one element and preserves all other state (open=$open)',
    ({ open }) => {
      const { authority, store, readOpen } = harness({ open });
      const beforeStage = structuredClone(store.getState().stage!);
      const input = deleteInput(authority, `delete-${String(open)}`);
      const result = authority.transactRevisionedDelete(input);
      if (!result.ok || result.receipt.outcome !== 'committed') throw new Error('Expected commit.');
      const expected: RevisionedDeleteExpectedDescriptor = {
        kind: 'wb_delete_v2',
        intentDigest: input.intentDigest,
        stableElementId: 'text-1',
      };
      expect(
        isRevisionedDeleteCommittedReceipt(
          verifyRevisionedWhiteboardAuthorityReceipt(result.receipt)!,
          expected,
        ),
      ).toBe(true);
      expect(result.receipt).toMatchObject({
        changed: true,
        currentBinding: { whiteboardId: 'board-1', revision: 1 },
        delta: {
          stableElementId: 'text-1',
          observedElementType: 'text',
          visibilityChanged: !open,
          elementCountBefore: 2,
          elementCountAfter: 1,
        },
      });
      expect(readOpen()).toBe(true);
      expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([text('text-2')]);
      expect({ ...store.getState().stage!, whiteboard: undefined }).toEqual({
        ...beforeStage,
        whiteboard: undefined,
      });
      expect(authority.transactRevisionedDelete(input)).toMatchObject({
        ok: true,
        replayed: true,
        receipt: result.receipt,
      });
    },
  );

  it('rejects missing and duplicate delete targets before any mutation', () => {
    const missing = harness({});
    const missingBefore = structuredClone(missing.store.getState().stage);
    expect(
      missing.authority.transactRevisionedDelete(
        deleteInput(missing.authority, 'delete-missing', 'not-present'),
      ),
    ).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'TARGET_PRECONDITION_FAILED' } },
    });
    expect(missing.store.getState().stage).toEqual(missingBefore);

    const duplicate = harness({ elements: [text('same'), text('same', 'second')] });
    const duplicateBefore = structuredClone(duplicate.store.getState().stage);
    expect(
      duplicate.authority.transactRevisionedDelete(
        deleteInput(duplicate.authority, 'delete-duplicate', 'same'),
      ),
    ).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'TARGET_PRECONDITION_FAILED' } },
    });
    expect(duplicate.store.getState().stage).toEqual(duplicateBefore);
  });

  it('serializes Delete/Edit in both orders using one aggregate revision CAS', () => {
    const editIntent: RevisionedEditCodeIntent = {
      elementId: 'code-existing',
      operation: 'insert_after',
      lineId: 'legacy-A',
      content: 'const b = 2;',
    };

    const deleteFirst = harness({ elements: [code()] });
    const deleteRequest = deleteInput(deleteFirst.authority, 'delete-before-edit', 'code-existing');
    const staleEditRequest = editInput(deleteFirst.authority, 'edit-after-delete', editIntent);
    expect(deleteFirst.authority.transactRevisionedDelete(deleteRequest)).toMatchObject({
      ok: true,
      receipt: { outcome: 'committed', currentBinding: { revision: 1 } },
    });
    expect(deleteFirst.authority.transactRevisionedEditCode(staleEditRequest)).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'STALE_STATE' }, changed: false },
    });
    expect(deleteFirst.store.getState().stage?.whiteboard?.[0].elements).toEqual([]);

    const editFirst = harness({ elements: [code()] });
    const editRequest = editInput(editFirst.authority, 'edit-before-delete', editIntent);
    const staleDeleteRequest = deleteInput(
      editFirst.authority,
      'delete-after-edit',
      'code-existing',
    );
    expect(editFirst.authority.transactRevisionedEditCode(editRequest)).toMatchObject({
      ok: true,
      receipt: { outcome: 'committed', currentBinding: { revision: 1 } },
    });
    expect(editFirst.authority.transactRevisionedDelete(staleDeleteRequest)).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'STALE_STATE' }, changed: false },
    });
    const edited = editFirst.store.getState().stage?.whiteboard?.[0].elements[0];
    expect(edited).toMatchObject({ id: 'code-existing', type: 'code' });
    if (edited?.type !== 'code') throw new Error('Expected code element.');
    expect(edited.lines).toHaveLength(3);
  });

  it.each([
    { withBoard: false, open: true, boardState: 'no_board' },
    { withBoard: true, open: false, boardState: 'preserved_empty' },
  ])('commits exact Clear no-op branch $boardState', ({ withBoard, open, boardState }) => {
    const { authority, store, readOpen } = harness({ withBoard, elements: [], open });
    const before = structuredClone(store.getState().stage);
    const input = clearInput(authority, `clear-${boardState}`);
    const result = authority.transactRevisionedClear(input);
    if (!result.ok || result.receipt.outcome !== 'committed') throw new Error('Expected commit.');
    const expected: RevisionedClearExpectedDescriptor = {
      kind: 'wb_clear_v2',
      intentDigest: input.intentDigest,
    };
    expect(
      isRevisionedClearCommittedReceipt(
        verifyRevisionedWhiteboardAuthorityReceipt(result.receipt)!,
        expected,
      ),
    ).toBe(true);
    expect(result.receipt).toMatchObject({
      changed: false,
      currentBinding: { revision: 0 },
      delta: { boardState, cleared: false },
      postcondition: { boardState, observedOpen: open },
    });
    expect(store.getState().stage).toEqual(before);
    expect(readOpen()).toBe(open);
  });

  it.each(['inserted', 'existing'] as const)(
    'clears a non-empty board with a verified %s canonical history snapshot',
    (disposition) => {
      const history = historyStore({ disposition });
      const { authority, store, readOpen } = harness({ open: false, historyStore: history.store });
      const beforeElements = structuredClone(store.getState().stage!.whiteboard![0].elements);
      const expectedContentDigest = digestWhiteboardContentV1Sync(beforeElements);
      const expectedMembershipDigest = digestWhiteboardMembershipV1Sync(
        beforeElements.map((element) => ({ id: element.id, type: element.type })),
      );
      const input = clearInput(authority, `clear-${disposition}`);
      const result = authority.transactRevisionedClear(input);
      if (!result.ok || result.receipt.outcome !== 'committed') throw new Error('Expected commit.');
      expect(result.receipt).toMatchObject({
        changed: true,
        currentBinding: { whiteboardId: 'board-1', revision: 1 },
        delta: {
          boardState: 'cleared_existing',
          cleared: true,
          visibilityChanged: true,
          elementCountBefore: 2,
          elementCountAfter: 0,
        },
        postcondition: {
          observedMembershipDigestBefore: expectedMembershipDigest,
          boardContentDigestBefore: expectedContentDigest,
          historySnapshotDigest: expectedContentDigest,
          historyDisposition: disposition,
        },
      });
      expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
      expect(history.pushExactSnapshot).toHaveBeenCalledWith(beforeElements, expectedContentDigest);
      expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
      expect(readOpen()).toBe(true);
      expect(authority.transactRevisionedClear(input)).toMatchObject({
        ok: true,
        replayed: true,
        receipt: result.receipt,
      });
      expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an unconfigured history dependency before history/domain mutation', () => {
    const { authority, store, readOpen } = harness({ open: false });
    const before = structuredClone(store.getState().stage);
    const input = clearInput(authority, 'clear-history-unconfigured');
    const first = authority.transactRevisionedClear(input);
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        outcome: 'rejected',
        error: { code: 'TARGET_PRECONDITION_FAILED' },
        changed: false,
      },
    });
    expect(store.getState().stage).toEqual(before);
    expect(readOpen()).toBe(false);
    expect(authority.transactRevisionedClear(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: first.ok ? first.receipt : undefined,
    });
  });

  it.each(['throw', 'invalid'] as const)(
    'treats a called-but-unprovable history sink (%s) as uncertain without domain writes',
    (failureMode) => {
      const history = historyStore({
        throwAfter: failureMode === 'throw',
        invalidReceipt: failureMode === 'invalid',
      });
      const { authority, store, readOpen } = harness({ open: false, historyStore: history.store });
      const before = structuredClone(store.getState().stage);
      const input = clearInput(authority, 'clear-history-uncertain');
      const first = authority.transactRevisionedClear(input);
      expect(first).toMatchObject({
        ok: true,
        receipt: {
          outcome: 'uncertain',
          changed: false,
          mutationMayHaveCommitted: true,
          currentBinding: { revision: 0 },
        },
      });
      expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
      expect(store.getState().stage).toEqual(before);
      expect(readOpen()).toBe(false);
      expect(authority.transactRevisionedClear(input)).toMatchObject({
        ok: true,
        replayed: true,
        receipt: first.ok ? first.receipt : undefined,
      });
      expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it('attempts the planned open write after a pre-mutation Stage write exception', () => {
    const currentStage = stage([board()]);
    const history = historyStore();
    let open = false;
    let stageWriteAttempts = 0;
    let openWriteAttempts = 0;
    const authority = new WhiteboardEnvironmentAuthority(
      {
        getState: () => ({ stage: currentStage }),
        setState: () => {
          stageWriteAttempts += 1;
          throw new Error('Stage write failed before mutation');
        },
      },
      () => open,
      { historyStore: history.store },
    );
    authority.configureOpenStore({
      getState: () => ({ whiteboardOpen: open }),
      setState: ({ whiteboardOpen }) => {
        openWriteAttempts += 1;
        open = whiteboardOpen;
      },
    });
    authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
    const input = clearInput(authority, 'clear-stage-write-uncertain');

    const first = authority.transactRevisionedClear(input);
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        outcome: 'uncertain',
        changed: true,
        mutationMayHaveCommitted: true,
        currentBinding: { revision: 1 },
      },
    });
    expect(stageWriteAttempts).toBe(1);
    expect(openWriteAttempts).toBe(1);
    expect(open).toBe(true);
    expect(currentStage.whiteboard?.[0].elements).toHaveLength(2);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);

    expect(authority.transactRevisionedClear(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: first.ok ? first.receipt : undefined,
    });
    expect(stageWriteAttempts).toBe(1);
    expect(openWriteAttempts).toBe(1);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reports an open write exception after Clear as changed uncertain and exact-replays it', () => {
    const history = historyStore();
    const { authority, store, readOpen } = harness({
      open: false,
      historyStore: history.store,
      writeOpen: () => {
        throw new Error('Open write failed');
      },
    });
    const input = clearInput(authority, 'clear-open-write-uncertain');

    const first = authority.transactRevisionedClear(input);
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        outcome: 'uncertain',
        changed: true,
        mutationMayHaveCommitted: true,
        currentBinding: { revision: 1 },
      },
    });
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    expect(readOpen()).toBe(false);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);

    expect(authority.transactRevisionedClear(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: first.ok ? first.receipt : undefined,
    });
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
  });

  it('fails closed when postcondition recapture observes a different final membership', () => {
    const history = historyStore();
    const { authority, store } = harness({ open: true, historyStore: history.store });
    let tampered = false;
    const unsubscribe = store.subscribe((state) => {
      if (tampered || !state.stage) return;
      tampered = true;
      store.setState({
        stage: {
          ...state.stage,
          whiteboard: [board([text('postcondition-tamper')])],
        },
      });
    });
    const input = clearInput(authority, 'clear-postcondition-uncertain');

    const first = authority.transactRevisionedClear(input);
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        outcome: 'uncertain',
        changed: true,
        mutationMayHaveCommitted: true,
        currentBinding: { revision: 1 },
      },
    });
    expect(store.getState().stage?.whiteboard?.[0].elements.map(({ id }) => id)).toEqual([
      'postcondition-tamper',
    ]);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);

    expect(authority.transactRevisionedClear(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: first.ok ? first.receipt : undefined,
    });
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('attempts visibility after a Stage listener throws and reports the partial settlement uncertain', () => {
    const history = historyStore();
    const { authority, store, readOpen } = harness({
      open: false,
      historyStore: history.store,
    });
    const unsubscribe = store.subscribe(() => {
      throw new Error('Stage listener failed after state update');
    });
    const input = clearInput(authority, 'clear-stage-listener-uncertain');
    const result = authority.transactRevisionedClear(input);
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'uncertain',
        changed: true,
        mutationMayHaveCommitted: true,
        currentBinding: { revision: 1 },
      },
    });
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    expect(readOpen()).toBe(true);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('reports post-domain listener failure as uncertain and exact-replays one history write', () => {
    const history = historyStore();
    const { authority, store } = harness({ historyStore: history.store });
    authority.subscribe(() => {
      throw new Error('authority listener failed after clear');
    });
    const input = clearInput(authority, 'clear-listener-uncertain');
    const first = authority.transactRevisionedClear(input);
    expect(first).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'uncertain',
        changed: true,
        mutationMayHaveCommitted: true,
        currentBinding: { revision: 1 },
      },
    });
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
    expect(authority.transactRevisionedClear(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: first.ok ? first.receipt : undefined,
    });
    expect(history.pushExactSnapshot).toHaveBeenCalledTimes(1);
  });
});
