import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createRevisionedCloseDigests,
  createRevisionedOpenDigests,
  isRevisionedLifecycleCommittedReceipt,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type RevisionedCloseExpectedDescriptor,
  type RevisionedOpenExpectedDescriptor,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { deriveRevisionedWhiteboardId } from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';

function board(): Whiteboard {
  return {
    id: 'board-1',
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements: [
      {
        id: 'text-1',
        type: 'text',
        content: '<p>preserve me</p>',
        left: 40,
        top: 40,
        width: 300,
        height: 80,
        rotate: 0,
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#333333',
      },
    ],
    background: { type: 'solid', color: '#fefefe' },
    animations: [],
  };
}

function stage(whiteboards: Whiteboard[]): Stage {
  return {
    id: 'stage-1',
    name: 'Preserve Stage metadata',
    createdAt: 1,
    updatedAt: 2,
    whiteboard: whiteboards,
  };
}

const authenticatedTarget = {
  childInvocationId: 'child-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
};

function harness(input: {
  whiteboardId: string | null;
  open: boolean;
  writeOpen?: (value: boolean) => void;
}) {
  let open = input.open;
  const store = createStore<{ stage: Stage | null }>(() => ({
    stage: stage(input.whiteboardId ? [board()] : []),
  }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  const writeOpen = vi.fn((value: boolean) => {
    open = value;
    input.writeOpen?.(value);
  });
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => writeOpen(whiteboardOpen),
  });
  authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
  return {
    authority,
    store,
    writeOpen,
    readOpen: () => open,
    setOpen: (value: boolean) => (open = value),
  };
}

function expected(authority: WhiteboardEnvironmentAuthority) {
  const snapshot = authority.querySnapshot();
  if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
  return {
    stageId: snapshot.value.stageId,
    whiteboardId: snapshot.value.activeWhiteboardId,
    revision: snapshot.value.revision,
  };
}

function lifecycleInput(
  authority: WhiteboardEnvironmentAuthority,
  toolName: 'wb_open' | 'wb_close',
  executionId: string,
) {
  const expectedBinding = expected(authority);
  const deadlineAt = Date.now() + 10_000;
  const input = {
    executionId,
    expectedBinding,
    authenticatedTarget,
    deadlineAt,
    intent: {},
  };
  const digests =
    toolName === 'wb_open'
      ? createRevisionedOpenDigests(input)!
      : createRevisionedCloseDigests(input)!;
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

describe('WhiteboardEnvironmentAuthority Stage 3B Batch 4 lifecycle', () => {
  it.each([
    { toolName: 'wb_open' as const, whiteboardId: null, open: false, changed: true, revision: 1 },
    { toolName: 'wb_open' as const, whiteboardId: null, open: true, changed: true, revision: 1 },
    {
      toolName: 'wb_open' as const,
      whiteboardId: 'board-1',
      open: false,
      changed: true,
      revision: 1,
    },
    {
      toolName: 'wb_open' as const,
      whiteboardId: 'board-1',
      open: true,
      changed: false,
      revision: 0,
    },
    { toolName: 'wb_close' as const, whiteboardId: null, open: true, changed: true, revision: 1 },
    { toolName: 'wb_close' as const, whiteboardId: null, open: false, changed: false, revision: 0 },
    {
      toolName: 'wb_close' as const,
      whiteboardId: 'board-1',
      open: true,
      changed: true,
      revision: 1,
    },
    {
      toolName: 'wb_close' as const,
      whiteboardId: 'board-1',
      open: false,
      changed: false,
      revision: 0,
    },
  ])(
    '$toolName from binding=$whiteboardId open=$open',
    ({ toolName, whiteboardId, open, changed, revision }) => {
      const { authority, store, writeOpen, readOpen } = harness({ whiteboardId, open });
      const stageBefore = structuredClone(store.getState().stage!);
      const executionId = `${toolName}-${whiteboardId ?? 'null'}-${String(open)}`;
      const input = lifecycleInput(authority, toolName, executionId);
      const listener = vi.fn();
      authority.subscribe(listener);
      const result =
        toolName === 'wb_open'
          ? authority.transactRevisionedOpen(input)
          : authority.transactRevisionedClose(input);
      if (!result.ok || result.receipt.outcome !== 'committed') {
        throw new Error('Expected lifecycle commit.');
      }
      const descriptor = {
        kind: `${toolName}_v2`,
        intentDigest: input.intentDigest,
      } as RevisionedOpenExpectedDescriptor | RevisionedCloseExpectedDescriptor;
      expect(
        isRevisionedLifecycleCommittedReceipt(
          verifyRevisionedWhiteboardAuthorityReceipt(result.receipt)!,
          descriptor,
        ),
      ).toBe(true);
      expect(result.receipt).toMatchObject({ changed, currentBinding: { revision } });
      expect(readOpen()).toBe(toolName === 'wb_open');
      expect(listener).toHaveBeenCalledTimes(changed ? 1 : 0);
      expect(writeOpen).toHaveBeenCalledTimes(open === (toolName === 'wb_open') ? 0 : 1);

      const stageAfter = store.getState().stage!;
      expect({ ...stageAfter, whiteboard: undefined }).toEqual({
        ...stageBefore,
        whiteboard: undefined,
      });
      if (whiteboardId) {
        expect(stageAfter.whiteboard).toEqual(stageBefore.whiteboard);
        expect(result.receipt.postcondition).toMatchObject({
          boardState: 'preserved_existing',
          elementCountBefore: 1,
          elementCountAfter: 1,
        });
      } else if (toolName === 'wb_open') {
        expect(stageAfter.whiteboard).toEqual([
          {
            id: deriveRevisionedWhiteboardId(executionId),
            viewportSize: 1000,
            viewportRatio: 16 / 9,
            elements: [],
            background: { type: 'solid', color: '#ffffff' },
            animations: [],
          },
        ]);
        expect(result.receipt.postcondition).toMatchObject({
          boardState: 'created_empty',
          elementCountAfter: 0,
        });
      } else {
        expect(stageAfter.whiteboard).toEqual([]);
        expect(result.receipt.postcondition).toEqual({
          kind: 'whiteboard_visibility_observed_v2',
          boardState: 'no_board',
          whiteboardId: null,
          observedOpen: false,
        });
      }

      expect(
        toolName === 'wb_open'
          ? authority.transactRevisionedOpen(input)
          : authority.transactRevisionedClose(input),
      ).toMatchObject({ ok: true, replayed: true, receipt: result.receipt });
      expect(listener).toHaveBeenCalledTimes(changed ? 1 : 0);
    },
  );

  it('returns STALE_STATE before mutation and leaves visibility and action authority unchanged', () => {
    const { authority, store, readOpen, setOpen } = harness({
      whiteboardId: 'board-1',
      open: true,
    });
    const stale = lifecycleInput(authority, 'wb_close', 'close-stale');
    const currentStage = store.getState().stage!;
    expect(
      authority.transact({
        label: 'advance-revision',
        writes: [
          {
            label: 'close',
            write: () => setOpen(false),
          },
        ],
      }),
    ).toMatchObject({ ok: true, changed: true });
    const result = authority.transactRevisionedClose(stale);
    expect(result).toMatchObject({
      ok: true,
      receipt: { outcome: 'rejected', error: { code: 'STALE_STATE' }, changed: false },
    });
    expect(readOpen()).toBe(false);
    expect(store.getState().stage?.whiteboard?.[0]).toEqual(currentStage.whiteboard?.[0]);
  });

  it('reports a partial visibility write as uncertain and exact-replays it', () => {
    const { authority, readOpen } = harness({
      whiteboardId: 'board-1',
      open: true,
      writeOpen: () => {
        throw new Error('listener write failed after commit');
      },
    });
    const input = lifecycleInput(authority, 'wb_close', 'close-uncertain');
    const result = authority.transactRevisionedClose(input);
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        outcome: 'uncertain',
        changed: true,
        mutationMayHaveCommitted: true,
        currentBinding: { revision: 1 },
      },
    });
    expect(readOpen()).toBe(false);
    expect(authority.transactRevisionedClose(input)).toMatchObject({
      ok: true,
      replayed: true,
      receipt: result.ok ? result.receipt : undefined,
    });
  });
});
