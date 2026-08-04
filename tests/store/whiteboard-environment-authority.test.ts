import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createStageAPI } from '@/lib/api/stage-api';
import { useCanvasStore } from '@/lib/store/canvas';
import {
  claimStageSceneLoadToken,
  isCurrentStageSceneLoadToken,
  useStageStore,
} from '@/lib/store/stage';
import {
  WHITEBOARD_AUTHORITY_BYPASS,
  WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
  WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
  WHITEBOARD_AUTHORITY_STALE_STATE,
  WHITEBOARD_AUTHORITY_TARGET_CHANGED,
  WHITEBOARD_AUTHORITY_UNCERTAIN,
  WhiteboardEnvironmentAuthority,
  getDefaultWhiteboardEnvironmentAuthority,
  getWhiteboardEnvironmentAuthority,
  type WhiteboardAuthorityTransactionResult,
} from '@/lib/store/whiteboard-environment-authority';
import { isRevisionedWhiteboardAuthorityReceipt } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import { setStageStoreStateThroughAuthority } from '@/tests/helpers/whiteboard-authority';

function whiteboard(id: string): Whiteboard {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements: [],
    background: { type: 'solid', color: '#fff' },
    animations: [],
  };
}

function stage(id: string, whiteboards: Whiteboard[] = []): Stage {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    whiteboard: whiteboards,
  };
}

function whiteboardsOf(value: Stage | null): readonly Whiteboard[] {
  return value?.whiteboard ?? [];
}

function createAuthority(
  whiteboards: Whiteboard[] = [whiteboard('wb-a')],
  targetRegistry = { validateAndConsume: () => true },
) {
  let open = false;
  const store = createStore<{ stage: Stage | null }>(() => ({
    stage: stage('stage-a', whiteboards),
  }));
  const authority = getWhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  authority.configureAuthenticatedTargetRegistry(targetRegistry);
  return {
    store,
    authority,
    setOpen(value: boolean) {
      open = value;
    },
  };
}

function snapshot(authority: WhiteboardEnvironmentAuthority) {
  const result = authority.querySnapshot();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.value;
}

const revisionedRequestDigest = `sha256:${'a'.repeat(64)}`;
const revisionedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
} as const;

function revisionedDelivery() {
  return {
    authenticatedTarget: revisionedTarget,
    deadlineAt: Date.now() + 60_000,
  };
}

afterEach(() => {
  useCanvasStore.getState().setWhiteboardClearing(false);
  useCanvasStore.getState().setWhiteboardOpen(false);
  useStageStore.getState().clearStore();
});

describe('WhiteboardEnvironmentAuthority', () => {
  it('selects the UI-visible first board for multi-board hydration', () => {
    const { authority } = createAuthority([whiteboard('first'), whiteboard('second')]);

    expect(snapshot(authority)).toMatchObject({
      stageId: 'stage-a',
      activeWhiteboardId: 'first',
      revision: 0,
      open: false,
    });
  });

  it('advances exactly once for a changed transaction with several sub-changes', () => {
    const { authority, store, setOpen } = createAuthority();
    const before = snapshot(authority);
    const result = authority.transact({
      label: 'test.multi-change',
      expected: before,
      writes: [
        {
          label: 'add-element',
          write: () => {
            const current = store.getState().stage!;
            store.setState({
              stage: {
                ...current,
                whiteboard: current.whiteboard!.map((board) =>
                  board.id === 'wb-a'
                    ? {
                        ...board,
                        elements: [
                          ...board.elements,
                          { id: 'element-a', type: 'text', content: 'hello' } as never,
                        ],
                      }
                    : board,
                ),
              },
            });
          },
        },
        { label: 'open', write: () => setOpen(true) },
      ],
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(snapshot(authority)).toMatchObject({ revision: before.revision + 1, open: true });
  });

  it('does not advance revision for a verified no-op', () => {
    const { authority } = createAuthority();
    const before = snapshot(authority);

    expect(authority.transact({ label: 'test.noop', expected: before, writes: [] })).toMatchObject({
      ok: true,
      changed: false,
      snapshot: { revision: before.revision },
    });
  });

  it('does not advance revision when JSON object insertion order changes only', () => {
    const { authority, store } = createAuthority();
    const before = snapshot(authority);
    const current = store.getState().stage!;
    const board = current.whiteboard![0];

    const result = authority.transact({
      label: 'test.reordered-keys',
      expected: before,
      writes: [
        {
          label: 'replace-equivalent-board',
          write: () =>
            store.setState({
              stage: {
                ...current,
                whiteboard: [
                  {
                    ...board,
                    background: { color: '#fff', type: 'solid' },
                  },
                ],
              },
            }),
        },
      ],
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(snapshot(authority).revision).toBe(before.revision);
  });

  it('allows only one mutation to commit from the same revision', () => {
    const { authority, store } = createAuthority();
    const expected = snapshot(authority);
    const first = authority.transact({
      label: 'test.first',
      expected,
      writes: [
        {
          label: 'first-write',
          write: () => {
            const current = store.getState().stage!;
            store.setState({ stage: { ...current, name: 'domain-unchanged' } });
            const board = current.whiteboard![0];
            store.setState({
              stage: {
                ...current,
                whiteboard: [{ ...board, elements: [{ id: 'one', type: 'text' } as never] }],
              },
            });
          },
        },
      ],
    });
    const second = authority.transact({
      label: 'test.second',
      expected,
      writes: [{ label: 'must-not-run', write: () => store.setState({ stage: null }) }],
    });

    expect(first).toMatchObject({ ok: true, changed: true });
    expect(second).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_STALE_STATE,
      mutationMayHaveCommitted: false,
    });
    expect(store.getState().stage?.id).toBe('stage-a');
  });

  it('retains active binding on same-stage replacement and falls back on deletion', () => {
    const { authority, store } = createAuthority([whiteboard('wb-a'), whiteboard('wb-b')]);
    const activateB = authority.transact({
      label: 'test.activate-b',
      preferredActiveWhiteboardId: 'wb-b',
      writes: [
        {
          label: 'move-b-first',
          write: () =>
            store.setState({ stage: stage('stage-a', [whiteboard('wb-b'), whiteboard('wb-a')]) }),
        },
      ],
    });
    expect(activateB).toMatchObject({ ok: true, snapshot: { activeWhiteboardId: 'wb-b' } });

    const replacement = authority.canonicalizeStageReplacement(
      stage('stage-a', [whiteboard('wb-a'), whiteboard('wb-b')]),
    );
    expect(replacement.whiteboard?.map(({ id }) => id)).toEqual(['wb-b', 'wb-a']);
    expect(
      authority.transact({
        label: 'test.replace',
        writes: [{ label: 'replace', write: () => store.setState({ stage: replacement }) }],
      }),
    ).toMatchObject({ ok: true, snapshot: { activeWhiteboardId: 'wb-b' } });

    expect(
      authority.transact({
        label: 'test.delete-active',
        writes: [
          {
            label: 'delete-b',
            write: () => store.setState({ stage: stage('stage-a', [whiteboard('wb-a')]) }),
          },
        ],
      }),
    ).toMatchObject({ ok: true, snapshot: { activeWhiteboardId: 'wb-a' } });
    expect(
      authority.transact({
        label: 'test.delete-last',
        writes: [{ label: 'delete-a', write: () => store.setState({ stage: stage('stage-a') }) }],
      }),
    ).toMatchObject({ ok: true, snapshot: { activeWhiteboardId: null } });
  });

  it('fails queries and nested mutations with RESOURCE_BUSY during a transaction', () => {
    const { authority, store, setOpen } = createAuthority();
    let nestedQuery: ReturnType<typeof authority.querySnapshot> | undefined;
    let nestedMutation: ReturnType<typeof authority.transact> | undefined;
    const unsubscribe = store.subscribe(() => {
      nestedQuery = authority.querySnapshot();
      nestedMutation = authority.transact({ label: 'test.reentrant', writes: [] });
      throw new Error('synchronous listener failed');
    });

    const result = authority.transact({
      label: 'test.listener-failure',
      writes: [
        {
          label: 'content-write',
          write: () => {
            const current = store.getState().stage!;
            store.setState({ stage: { ...current, whiteboard: [] } });
          },
        },
        { label: 'later-open-write', write: () => setOpen(true) },
      ],
    });
    unsubscribe();

    expect(nestedQuery).toMatchObject({ ok: false, code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY });
    expect(nestedMutation).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
      mutationMayHaveCommitted: false,
    });
    expect(result).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_UNCERTAIN,
      changed: true,
      mutationMayHaveCommitted: true,
      snapshot: { revision: 1, open: true, activeWhiteboardId: null },
    });
    expect(authority.isTransactionActive()).toBe(false);
  });

  it('settles uncertain when a listener throws even if the whiteboard aggregate is unchanged', () => {
    const { authority, store } = createAuthority();
    const unsubscribe = store.subscribe(() => {
      throw new Error('metadata listener failed after commit');
    });
    const current = store.getState().stage!;

    const result = authority.transact({
      label: 'test.metadata-listener-failure',
      writes: [
        {
          label: 'metadata-write',
          write: () => store.setState({ stage: { ...current, name: 'renamed' } }),
        },
      ],
    });
    unsubscribe();

    expect(result).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_UNCERTAIN,
      changed: false,
      mutationMayHaveCommitted: true,
      snapshot: { revision: 0 },
    });
    expect(store.getState().stage?.name).toBe('renamed');
    expect(authority.isTransactionActive()).toBe(false);
  });

  it('fails closed after an unapproved direct domain write', () => {
    const { authority, store } = createAuthority();
    store.setState({ stage: stage('stage-a', [whiteboard('outside')]) });

    expect(authority.querySnapshot()).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_BYPASS,
    });
    expect(authority.transact({ label: 'test.after-bypass', writes: [] })).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_BYPASS,
      changed: false,
      mutationMayHaveCommitted: false,
    });
  });

  it('detects a direct write even for content that collided under the old 32-bit hash', () => {
    const original = {
      ...whiteboard('wb-a'),
      elements: [
        {
          id: 'element-a',
          type: 'text',
          content: '<p>03pwu</p>',
        } as Whiteboard['elements'][number],
      ],
    };
    const replacement = {
      ...original,
      elements: [
        {
          id: 'element-a',
          type: 'text',
          content: '<p>0a5fa</p>',
        } as Whiteboard['elements'][number],
      ],
    };
    const { authority, store } = createAuthority([original]);

    store.setState({ stage: stage('stage-a', [replacement]) });

    expect(authority.querySnapshot()).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_BYPASS,
    });
  });

  it('routes StageAPI writers through the same revision and active binding authority', () => {
    const { authority, store } = createAuthority();
    const api = createStageAPI(store as never);
    const before = snapshot(authority);

    const created = api.whiteboard.create();
    expect(created.success).toBe(true);
    expect(snapshot(authority)).toMatchObject({
      revision: before.revision + 1,
      activeWhiteboardId: created.data?.id,
    });

    expect(api.whiteboard.delete(created.data!.id).success).toBe(true);
    expect(snapshot(authority)).toMatchObject({
      revision: before.revision + 2,
      activeWhiteboardId: 'wb-a',
    });
  });

  it('revisions whiteboardOpen but excludes whiteboardClearing', () => {
    setStageStoreStateThroughAuthority({
      stage: stage('default-stage', [whiteboard('default-wb')]),
    });
    const authority = getDefaultWhiteboardEnvironmentAuthority()!;
    const before = snapshot(authority);

    useCanvasStore.getState().setWhiteboardClearing(true);
    expect(snapshot(authority).revision).toBe(before.revision);

    useCanvasStore.getState().setWhiteboardOpen(!before.open);
    expect(snapshot(authority).revision).toBe(before.revision + 1);
  });

  it('returns RESOURCE_BUSY from the real Canvas writer instead of silently dropping it', () => {
    setStageStoreStateThroughAuthority({
      stage: stage('default-stage', [whiteboard('default-wb')]),
    });
    const authority = getDefaultWhiteboardEnvironmentAuthority()!;
    useCanvasStore.getState().setWhiteboardOpen(false);
    let nestedResult: WhiteboardAuthorityTransactionResult | undefined;

    const outer = authority.transact({
      label: 'test.canvas-adapter-reentrancy',
      writes: [
        {
          label: 'nested-canvas-writer',
          write: () => {
            nestedResult = useCanvasStore.getState().setWhiteboardOpen(true);
          },
        },
      ],
    });

    expect(nestedResult).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
      mutationMayHaveCommitted: false,
    });
    expect(outer).toMatchObject({ ok: true, changed: false });
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
  });

  it('returns RESOURCE_BUSY from the real Stage writer without reporting a replacement', () => {
    setStageStoreStateThroughAuthority({
      stage: stage('default-stage', [whiteboard('default-wb')]),
    });
    const authority = getDefaultWhiteboardEnvironmentAuthority()!;
    const loadToken = claimStageSceneLoadToken();
    let nestedResult: WhiteboardAuthorityTransactionResult | undefined;

    const outer = authority.transact({
      label: 'test.stage-adapter-reentrancy',
      writes: [
        {
          label: 'nested-stage-writer',
          write: () => {
            nestedResult = useStageStore
              .getState()
              .setStage(stage('replacement-stage', [whiteboard('replacement-wb')]));
          },
        },
      ],
    });

    expect(nestedResult).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
      mutationMayHaveCommitted: false,
    });
    expect(outer).toMatchObject({ ok: true, changed: false });
    expect(useStageStore.getState().stage?.id).toBe('default-stage');
    expect(isCurrentStageSceneLoadToken(loadToken)).toBe(true);
  });

  it('returns RESOURCE_BUSY from the real store clear without clearing the stage', () => {
    setStageStoreStateThroughAuthority({
      stage: stage('default-stage', [whiteboard('default-wb')]),
    });
    const authority = getDefaultWhiteboardEnvironmentAuthority()!;
    const loadToken = claimStageSceneLoadToken();
    let nestedResult: WhiteboardAuthorityTransactionResult | undefined;

    const outer = authority.transact({
      label: 'test.clear-store-adapter-reentrancy',
      writes: [
        {
          label: 'nested-store-clear',
          write: () => {
            nestedResult = useStageStore.getState().clearStore();
          },
        },
      ],
    });

    expect(nestedResult).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
      mutationMayHaveCommitted: false,
    });
    expect(outer).toMatchObject({ ok: true, changed: false });
    expect(useStageStore.getState().stage?.id).toBe('default-stage');
    expect(isCurrentStageSceneLoadToken(loadToken)).toBe(true);
  });

  it('classifies an expected stage mismatch as TARGET_CHANGED instead of STALE_STATE', () => {
    const { authority, store } = createAuthority();
    const expected = snapshot(authority);
    expect(
      authority.transact({
        label: 'test.switch-stage',
        writes: [{ label: 'switch', write: () => store.setState({ stage: stage('stage-b') }) }],
      }),
    ).toMatchObject({ ok: true, changed: true });

    expect(authority.transact({ label: 'test.old-stage', expected, writes: [] })).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_TARGET_CHANGED,
      mutationMayHaveCommitted: false,
    });
  });

  it('commits create, open and draw under one revisioned CAS and returns an exact receipt', () => {
    const { authority } = createAuthority([]);
    const nextStage = stage('stage-a', [
      {
        ...whiteboard('wb-created'),
        elements: [{ id: 'text-1', type: 'text', content: 'hello' } as never],
      },
    ]);
    const result = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-create-draw',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_draw_text',
      label: 'test.revisioned-create-draw',
      expected: { stageId: 'stage-a', whiteboardId: null, revision: 0 },
      plan: {
        ok: true,
        nextWhiteboards: whiteboardsOf(nextStage),
        nextOpen: true,
        preferredActiveWhiteboardId: 'wb-created',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        outcome: 'committed',
        changed: true,
        previousBinding: { whiteboardId: null, revision: 0 },
        currentBinding: { whiteboardId: 'wb-created', revision: 1 },
      },
    });
    expect(result.ok && isRevisionedWhiteboardAuthorityReceipt(result.receipt)).toBe(true);
    expect(snapshot(authority)).toMatchObject({
      activeWhiteboardId: 'wb-created',
      revision: 1,
      open: true,
    });
  });

  it('rejects stale and target-changed mutations before planning or writing', () => {
    const { authority, store, setOpen } = createAuthority();
    const expected = snapshot(authority);
    authority.transact({
      label: 'test.advance',
      writes: [{ label: 'open', write: () => setOpen(true) }],
    });
    const stale = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-stale',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_open',
      label: 'test.stale',
      expected: {
        stageId: expected.stageId!,
        whiteboardId: expected.activeWhiteboardId,
        revision: expected.revision,
      },
      plan: {
        ok: true,
        nextWhiteboards: whiteboardsOf(store.getState().stage),
        nextOpen: false,
      },
    });
    expect(stale).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'STALE_STATE' } },
    });

    authority.transact({
      label: 'test.change-target',
      writes: [{ label: 'switch', write: () => store.setState({ stage: stage('stage-b') }) }],
    });
    const targetChanged = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-target-changed',
      requestDigest: `sha256:${'b'.repeat(64)}`,
      toolName: 'wb_open',
      label: 'test.target-changed',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 1 },
      plan: {
        ok: true,
        nextWhiteboards: whiteboardsOf(store.getState().stage),
        nextOpen: false,
      },
    });
    expect(targetChanged).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'TARGET_CHANGED' } },
    });
  });

  it('replays one terminal receipt and fails closed on an execution identity conflict', () => {
    const { authority, store } = createAuthority();
    const plan = {
      ok: true as const,
      nextWhiteboards: whiteboardsOf(store.getState().stage),
      nextOpen: false,
    };
    const input = {
      ...revisionedDelivery(),
      executionId: 'execution-replay',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_open' as const,
      label: 'test.replay',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      plan,
    };

    const first = authority.transactRevisioned(input);
    const replay = authority.transactRevisioned(input);
    const conflict = authority.transactRevisioned({
      ...input,
      requestDigest: `sha256:${'c'.repeat(64)}`,
    });
    const toolConflict = authority.transactRevisioned({
      ...input,
      toolName: 'wb_close',
    });
    const targetConflict = authority.transactRevisioned({
      ...input,
      authenticatedTarget: { ...revisionedTarget, sceneId: 'scene-2' },
    });
    const bindingConflict = authority.transactRevisioned({
      ...input,
      expected: { ...input.expected, revision: 99 },
    });

    expect(first).toMatchObject({ ok: true, replayed: false, receipt: { outcome: 'committed' } });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (first.ok && replay.ok) expect(replay.receipt).toEqual(first.receipt);
    expect(conflict).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'EXECUTION_ID_CONFLICT' } },
    });
    expect(toolConflict).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'EXECUTION_ID_CONFLICT' } },
    });
    expect(targetConflict).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'EXECUTION_ID_CONFLICT' } },
    });
    expect(bindingConflict).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'EXECUTION_ID_CONFLICT' } },
    });
  });

  it('snapshots caller-owned identity, intent, Store state and journal receipt', () => {
    const { authority, store } = createAuthority();
    const expected = { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 };
    const authenticatedTarget = {
      childInvocationId: 'child-alias',
      requestId: 'request-alias',
      sessionId: 'session-alias',
      sceneId: 'scene-original',
    };
    const intendedBoard = whiteboard('intent-board');
    const input = {
      executionId: 'execution-alias-snapshot',
      requestDigest: `sha256:${'9'.repeat(64)}`,
      toolName: 'wb_open' as const,
      label: 'test.alias-snapshot',
      expected,
      authenticatedTarget,
      deadlineAt: Date.now() + 60_000,
      plan: {
        ok: true as const,
        nextWhiteboards: [intendedBoard],
        nextOpen: true,
      },
    };

    const first = authority.transactRevisioned(input);
    expect(first).toMatchObject({ ok: true, replayed: false, receipt: { outcome: 'committed' } });
    if (!first.ok) throw new Error('Expected committed revisioned mutation.');
    expect(Object.isFrozen(first.receipt)).toBe(true);
    expect(Object.isFrozen(first.receipt.currentBinding)).toBe(true);
    expect(Reflect.set(first.receipt.currentBinding, 'revision', 99)).toBe(false);

    expected.revision = 99;
    authenticatedTarget.sceneId = 'scene-mutated';
    intendedBoard.elements.push({ id: 'late', type: 'text', content: 'late' } as never);

    expect(store.getState().stage?.whiteboard?.[0]?.elements).toEqual([]);
    expect(authority.querySnapshot()).toMatchObject({ ok: true });
    expect(authority.transactRevisioned(input)).toMatchObject({
      ok: true,
      replayed: false,
      receipt: { outcome: 'rejected', error: { code: 'EXECUTION_ID_CONFLICT' } },
    });

    const exactReplay = authority.transactRevisioned({
      ...input,
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      authenticatedTarget: {
        childInvocationId: 'child-alias',
        requestId: 'request-alias',
        sessionId: 'session-alias',
        sceneId: 'scene-original',
      },
    });
    expect(exactReplay).toMatchObject({ ok: true, replayed: true });
    if (exactReplay.ok) expect(exactReplay.receipt).toEqual(first.receipt);
  });

  it('rejects an invalid authenticated mutation identity before planning', () => {
    const { authority, store } = createAuthority();

    expect(
      authority.transactRevisioned({
        ...revisionedDelivery(),
        executionId: 'execution-invalid',
        requestDigest: 'not-a-digest',
        toolName: 'wb_open',
        label: 'test.invalid-identity',
        expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
        plan: {
          ok: true,
          nextWhiteboards: whiteboardsOf(store.getState().stage),
          nextOpen: false,
        },
      }),
    ).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
    });
  });

  it('keeps the revisioned execution journal bounded', () => {
    const { authority, store } = createAuthority();
    const delivery = revisionedDelivery();
    for (let index = 0; index < 257; index += 1) {
      const result = authority.transactRevisioned({
        ...delivery,
        executionId: `execution-bounded-${index}`,
        requestDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
        toolName: 'wb_open',
        label: 'test.bounded-journal',
        expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
        plan: {
          ok: true,
          nextWhiteboards: whiteboardsOf(store.getState().stage),
          nextOpen: false,
        },
      });
      expect(result).toMatchObject(
        index < 256 ? { ok: true } : { ok: false, code: 'REVISIONED_JOURNAL_CAPACITY_EXCEEDED' },
      );
    }

    expect(authority.getRevisionedJournalSizeForTests()).toBe(256);
    expect(
      authority.transactRevisioned({
        ...delivery,
        executionId: 'execution-bounded-0',
        requestDigest: `sha256:${'0'.repeat(64)}`,
        toolName: 'wb_open',
        label: 'test.bounded-journal-replay',
        expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
        plan: {
          ok: true,
          nextWhiteboards: whiteboardsOf(store.getState().stage),
          nextOpen: false,
        },
      }),
    ).toMatchObject({ ok: true, replayed: true });
  });

  it('returns an uncertain receipt after an unverifiable committed write', () => {
    const { authority, store } = createAuthority();
    const current = store.getState().stage!;
    const nextStage = {
      ...current,
      whiteboard: [
        {
          ...current.whiteboard![0],
          elements: [{ id: 'text-1', type: 'text', content: 'hello' } as never],
        },
      ],
    };
    authority.subscribe(() => {
      throw new Error('listener failed after mutation');
    });
    const result = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-uncertain',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_draw_text',
      label: 'test.uncertain',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      plan: {
        ok: true,
        nextWhiteboards: whiteboardsOf(nextStage),
        nextOpen: false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'uncertain',
        changed: true,
        mutationMayHaveCommitted: true,
        currentBinding: { revision: 1 },
      },
    });
  });

  it('revalidates the authenticated delivery target inside the critical section', () => {
    let validateTarget = () => true;
    const targetRegistry = { validateAndConsume: () => validateTarget() };
    const { authority, store } = createAuthority([whiteboard('wb-a')], targetRegistry);
    const before = store.getState().stage;
    let validatedWhileLocked = false;
    const expected = { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 };
    const authenticatedTarget = {
      childInvocationId: 'child-target-auth',
      requestId: 'request-target-auth',
      sessionId: 'session-target-auth',
      sceneId: 'scene-target-auth',
    };
    const plan = {
      ok: true as const,
      nextWhiteboards: [whiteboard('replacement')],
      nextOpen: true,
    };
    const input = {
      executionId: 'execution-target-auth',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_open' as const,
      label: 'test.target-auth',
      expected,
      authenticatedTarget,
      deadlineAt: Date.now() + 60_000,
      plan,
    };
    validateTarget = () => {
      validatedWhileLocked = authority.isTransactionActive();
      input.executionId = 'execution-mutated';
      input.requestDigest = `sha256:${'f'.repeat(64)}`;
      Reflect.set(input, 'toolName', 'wb_close');
      expected.revision = 99;
      authenticatedTarget.sceneId = 'scene-mutated';
      plan.nextWhiteboards[0].id = 'caller-mutated';
      plan.nextOpen = false;
      return false;
    };
    const result = authority.transactRevisioned(input);

    expect(validatedWhileLocked).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'rejected',
        executionId: 'execution-target-auth',
        requestDigest: revisionedRequestDigest,
        toolName: 'wb_open',
        error: { code: 'AUTHENTICATED_TARGET_CHANGED' },
      },
    });
    expect(store.getState().stage).toBe(before);

    expect(
      authority.transactRevisioned({
        ...input,
        executionId: 'execution-target-auth',
        requestDigest: revisionedRequestDigest,
        toolName: 'wb_open',
        expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
        authenticatedTarget: {
          childInvocationId: 'child-target-auth',
          requestId: 'request-target-auth',
          sessionId: 'session-target-auth',
          sceneId: 'scene-target-auth',
        },
      }),
    ).toMatchObject({ ok: true, replayed: true });
  });

  it('attempts both trusted store writes even when the first write throws', () => {
    const currentStage: Stage | null = stage('stage-a', [whiteboard('wb-a')]);
    let open = false;
    let stageWriteAttempts = 0;
    let openWriteAttempts = 0;
    const authority = new WhiteboardEnvironmentAuthority({
      getState: () => ({ stage: currentStage }),
      setState: () => {
        stageWriteAttempts += 1;
        throw new Error('stage write failed');
      },
    });
    authority.configureOpenStore({
      getState: () => ({ whiteboardOpen: open }),
      setState: ({ whiteboardOpen }) => {
        openWriteAttempts += 1;
        open = whiteboardOpen;
      },
    });
    authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });

    const result = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-partial-write',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_open',
      label: 'test.partial-write',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      plan: {
        ok: true,
        nextWhiteboards: [whiteboard('wb-b')],
        nextOpen: true,
      },
    });

    expect(stageWriteAttempts).toBe(1);
    expect(openWriteAttempts).toBe(1);
    expect(open).toBe(true);
    expect(currentStage?.whiteboard?.[0]?.id).toBe('wb-a');
    expect(result).toMatchObject({
      ok: true,
      receipt: { outcome: 'uncertain', mutationMayHaveCommitted: true },
    });
  });

  it('expires journal entries without allowing an expired execution to run again', () => {
    let now = 1_000;
    const store = createStore<{ stage: Stage | null }>(() => ({
      stage: stage('stage-a', [whiteboard('wb-a')]),
    }));
    const authority = new WhiteboardEnvironmentAuthority(store, () => false, {
      now: () => now,
      maxRevisionedJournalEntries: 1,
      revisionedJournalReplayGraceMs: 30,
    });
    const input = {
      executionId: 'execution-expiring',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_open' as const,
      label: 'test.expiring',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      authenticatedTarget: revisionedTarget,
      deadlineAt: 1_100,
      plan: {
        ok: true as const,
        nextWhiteboards: whiteboardsOf(store.getState().stage),
        nextOpen: false,
      },
    };
    expect(authority.transactRevisioned(input)).toMatchObject({ ok: true });
    now = 1_130;
    expect(authority.getRevisionedJournalSizeForTests()).toBe(0);
    expect(authority.transactRevisioned(input)).toMatchObject({
      ok: false,
      code: 'REVISIONED_WHITEBOARD_DEADLINE_EXCEEDED',
    });
  });

  it('rejects callback-shaped plans and caller-supplied receipt claims before mutation', () => {
    const { authority, store } = createAuthority();
    const before = store.getState().stage;
    const callbackPlan = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-async-write',
      requestDigest: revisionedRequestDigest,
      toolName: 'wb_open',
      label: 'test.async-write',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      plan: (() => ({
        ok: true,
      })) as never,
    });
    expect(callbackPlan).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
    });
    expect(store.getState().stage).toBe(before);

    const fakeReceiptClaims = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-invalid-receipt',
      requestDigest: `sha256:${'d'.repeat(64)}`,
      toolName: 'wb_open',
      label: 'test.invalid-receipt',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      plan: {
        ok: true,
        nextWhiteboards: whiteboardsOf(store.getState().stage),
        nextOpen: false,
        delta: { createdElementId: 'missing' },
        postcondition: { elementExists: true, elementId: 'missing' },
      } as never,
    });
    expect(fakeReceiptClaims).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
    });
    expect(store.getState().stage).toBe(before);
  });

  it('preserves Stage identity and non-whiteboard fields for a whiteboard-domain intent', () => {
    const { authority, store } = createAuthority();
    const current = store.getState().stage!;
    current.name = 'Authoritative Stage';
    current.updatedAt = 42;

    const result = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-domain-only',
      requestDigest: `sha256:${'e'.repeat(64)}`,
      toolName: 'wb_open',
      label: 'test.domain-only',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-a', revision: 0 },
      plan: {
        ok: true,
        nextWhiteboards: [whiteboard('wb-b')],
        nextOpen: true,
      },
    });

    expect(result).toMatchObject({ ok: true, receipt: { outcome: 'committed' } });
    expect(store.getState().stage).toMatchObject({
      id: 'stage-a',
      name: 'Authoritative Stage',
      updatedAt: 42,
    });
    expect(store.getState().stage?.whiteboard?.map(({ id }) => id)).toEqual(['wb-b']);

    const forbiddenStageReplacement = authority.transactRevisioned({
      ...revisionedDelivery(),
      executionId: 'execution-stage-replacement',
      requestDigest: `sha256:${'f'.repeat(64)}`,
      toolName: 'wb_open',
      label: 'test.stage-replacement',
      expected: { stageId: 'stage-a', whiteboardId: 'wb-b', revision: 1 },
      plan: {
        ok: true,
        nextWhiteboards: [whiteboard('wb-c')],
        nextOpen: true,
        nextStage: stage('stage-b', [whiteboard('wb-c')]),
      } as never,
    });
    expect(forbiddenStageReplacement).toMatchObject({
      ok: false,
      code: WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
    });
    expect(store.getState().stage?.id).toBe('stage-a');
  });
});
