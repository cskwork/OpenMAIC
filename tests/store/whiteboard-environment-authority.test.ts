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
  WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
  WHITEBOARD_AUTHORITY_STALE_STATE,
  WHITEBOARD_AUTHORITY_UNCERTAIN,
  WhiteboardEnvironmentAuthority,
  getDefaultWhiteboardEnvironmentAuthority,
  getWhiteboardEnvironmentAuthority,
  type WhiteboardAuthorityTransactionResult,
} from '@/lib/store/whiteboard-environment-authority';
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

function createAuthority(whiteboards: Whiteboard[] = [whiteboard('wb-a')]) {
  let open = false;
  const store = createStore<{ stage: Stage | null }>(() => ({
    stage: stage('stage-a', whiteboards),
  }));
  const authority = getWhiteboardEnvironmentAuthority(store);
  authority.configureOpenReader(() => open);
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
});
