import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createRevisionedDrawLineDigests,
  createRevisionedDrawShapeDigests,
  type RevisionedDrawLineIntent,
  type RevisionedDrawShapeIntent,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { WhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';
import type { Stage, Whiteboard } from '@/lib/types/stage';

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

function stage(whiteboards: Whiteboard[] = [board('board-1'), board('board-2')]): Stage {
  return {
    id: 'stage-1',
    name: 'Preserve non-whiteboard fields',
    createdAt: 1,
    updatedAt: 2,
    whiteboard: whiteboards,
  };
}

function harness(whiteboards?: Whiteboard[]) {
  let open = false;
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: stage(whiteboards) }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
  return { store, authority, readOpen: () => open };
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

describe('WhiteboardEnvironmentAuthority Stage 3B Batch 1 Draw Shape/Line', () => {
  it('derives an exact Shape state/receipt and replays without a second mutation', () => {
    const { store, authority } = harness();
    const beforeStage = structuredClone(store.getState().stage!);
    const expectedBinding = expected(authority);
    const executionId = 'shape-authority';
    const deadlineAt = Date.now() + 10_000;
    const intent: RevisionedDrawShapeIntent = {
      shape: 'triangle',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      fillColor: '#abcdef',
    };
    const digests = createRevisionedDrawShapeDigests({
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
    const first = authority.transactRevisionedDrawShape(input);
    if (!first.ok) throw new Error(first.code);

    expect(first).toMatchObject({
      replayed: false,
      receipt: {
        outcome: 'committed',
        toolName: 'wb_draw_shape',
        previousBinding: { revision: 0 },
        currentBinding: { revision: 1 },
        delta: {
          kind: 'whiteboard_shape_created_v2',
          elementCountBefore: 0,
          elementCountAfter: 1,
        },
        postcondition: {
          kind: 'whiteboard_shape_exists_v2',
          elementType: 'shape',
          matchingElementCount: 1,
        },
      },
    });
    const after = store.getState().stage!;
    expect({ ...after, whiteboard: undefined }).toEqual({ ...beforeStage, whiteboard: undefined });
    expect(after.whiteboard?.[1]).toEqual(beforeStage.whiteboard?.[1]);
    expect(after.whiteboard?.[0].elements[0]).toMatchObject({
      type: 'shape',
      fill: '#abcdef',
    });

    const replay = authority.transactRevisionedDrawShape(input);
    expect(replay).toMatchObject({ ok: true, replayed: true, receipt: first.receipt });
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    expect(authority.querySnapshot()).toMatchObject({ ok: true, value: { revision: 1 } });
  });

  it('creates/opens a board and draws an ordered Line in one revision', () => {
    const { store, authority, readOpen } = harness([]);
    const expectedBinding = expected(authority);
    const executionId = 'line-authority';
    const deadlineAt = Date.now() + 10_000;
    const intent: RevisionedDrawLineIntent = {
      startX: 400,
      startY: 200,
      endX: 100,
      endY: 50,
      color: '#123456',
      width: 4,
      style: 'dashed',
      points: ['arrow', ''],
    };
    const digests = createRevisionedDrawLineDigests({
      executionId,
      expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intent,
    })!;
    const result = authority.transactRevisionedDrawLine({
      executionId,
      requestDigest: digests.requestDigest,
      expected: expectedBinding,
      authenticatedTarget,
      deadlineAt,
      intentDigest: digests.intentDigest,
      intent: digests.normalizedIntent,
    });
    if (!result.ok) throw new Error(result.code);

    expect(result.receipt).toMatchObject({
      outcome: 'committed',
      toolName: 'wb_draw_line',
      changed: true,
      previousBinding: { whiteboardId: null, revision: 0 },
      currentBinding: { revision: 1 },
      delta: {
        kind: 'whiteboard_line_created_v2',
        createdWhiteboard: true,
        visibilityChanged: true,
        elementCountBefore: 0,
        elementCountAfter: 1,
      },
      postcondition: {
        kind: 'whiteboard_line_exists_v2',
        elementType: 'line',
        matchingElementCount: 1,
      },
    });
    expect(readOpen()).toBe(true);
    expect(store.getState().stage?.whiteboard).toHaveLength(1);
    expect(store.getState().stage?.whiteboard?.[0].elements[0]).toMatchObject({
      type: 'line',
      left: 100,
      top: 50,
      start: [300, 150],
      end: [0, 0],
      points: ['arrow', ''],
    });
  });
});
