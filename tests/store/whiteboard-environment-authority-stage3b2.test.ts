import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createRevisionedDrawTextDigests,
  type RevisionedDrawTextIntent,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
  WhiteboardEnvironmentAuthority,
} from '@/lib/store/whiteboard-environment-authority';
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

function stage(): Stage {
  return {
    id: 'stage-1',
    name: 'Preserve me',
    createdAt: 1,
    updatedAt: 2,
    whiteboard: [
      board('board-1', [
        {
          id: 'existing',
          type: 'text',
          content: 'existing',
          left: 1,
          top: 2,
          width: 100,
          height: 40,
          rotate: 0,
          defaultFontName: 'Arial',
          defaultColor: '#000000',
        },
      ]),
      board('board-2'),
    ],
  };
}

function createHarness() {
  let open = false;
  const store = createStore<{ stage: Stage | null }>(() => ({ stage: stage() }));
  const authority = new WhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore({
    getState: () => ({ whiteboardOpen: open }),
    setState: ({ whiteboardOpen }) => {
      open = whiteboardOpen;
    },
  });
  authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
  return { store, authority };
}

function drawInput(
  authority: WhiteboardEnvironmentAuthority,
  executionId = 'draw-1',
  intent: RevisionedDrawTextIntent = { content: 'hello', x: 100, y: 120 },
) {
  const snapshot = authority.querySnapshot();
  if (!snapshot.ok || snapshot.value.stageId === null) throw new Error('Expected snapshot.');
  const expected = {
    stageId: snapshot.value.stageId,
    whiteboardId: snapshot.value.activeWhiteboardId,
    revision: snapshot.value.revision,
  };
  const authenticatedTarget = {
    childInvocationId: 'child-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    sceneId: 'scene-1',
  };
  const deadlineAt = Date.now() + 10_000;
  const digests = createRevisionedDrawTextDigests({
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

describe('WhiteboardEnvironmentAuthority Stage 3B-2 draw text', () => {
  it('rejects replacement of the stable browser target registry', () => {
    const { authority } = createHarness();
    expect(() =>
      authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true }),
    ).toThrow('REVISIONED_WHITEBOARD_TARGET_REGISTRY_CONFLICT');
  });

  it('derives exact state/receipt, preserves other domains, and replays without a second write', () => {
    const { store, authority } = createHarness();
    const before = structuredClone(store.getState().stage!);
    const input = drawInput(authority);
    const first = authority.transactRevisionedDrawText(input);
    if (!first.ok) throw new Error(first.code);

    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        outcome: 'committed',
        previousBinding: { revision: 0 },
        currentBinding: { revision: 1 },
        delta: {
          kind: 'whiteboard_text_created_v2',
          elementCountBefore: 1,
          elementCountAfter: 2,
        },
        postcondition: {
          kind: 'whiteboard_text_exists_v2',
          matchingElementCount: 1,
        },
      },
    });
    const after = store.getState().stage!;
    expect({ ...after, whiteboard: undefined }).toEqual({ ...before, whiteboard: undefined });
    expect(after.whiteboard?.[1]).toEqual(before.whiteboard?.[1]);
    expect(after.whiteboard?.[0].elements[0]).toEqual(before.whiteboard?.[0].elements[0]);
    expect(after.whiteboard?.[0].elements).toHaveLength(2);

    const replay = authority.transactRevisionedDrawText(input);
    expect(replay).toMatchObject({ ok: true, replayed: true, receipt: first.receipt });
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
    expect(authority.querySnapshot()).toMatchObject({ ok: true, value: { revision: 1 } });
  });

  it('journals and replays an uncertain receipt after a partial open-write failure', () => {
    const store = createStore<{ stage: Stage | null }>(() => ({ stage: stage() }));
    const authority = new WhiteboardEnvironmentAuthority(store);
    let open = false;
    const writeOpen = vi.fn(() => {
      throw new Error('open write failed');
    });
    authority.configureOpenStore({
      getState: () => ({ whiteboardOpen: open }),
      setState: ({ whiteboardOpen }) => {
        writeOpen();
        open = whiteboardOpen;
      },
    });
    authority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
    const input = drawInput(authority, 'draw-partial-open');

    const first = authority.transactRevisionedDrawText(input);
    const replay = authority.transactRevisionedDrawText(input);
    if (!first.ok || !replay.ok) throw new Error('Expected uncertain Authority receipts.');

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
    expect(replay).toMatchObject({ ok: true, replayed: true, receipt: first.receipt });
    expect(writeOpen).toHaveBeenCalledTimes(1);
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(2);
  });

  it('returns uncertain when a draw listener or exact postcondition cannot be verified', () => {
    const listenerHarness = createHarness();
    listenerHarness.authority.subscribe(() => {
      throw new Error('listener failed');
    });
    const listenerResult = listenerHarness.authority.transactRevisionedDrawText(
      drawInput(listenerHarness.authority, 'draw-listener-failure'),
    );
    expect(listenerResult).toMatchObject({
      ok: true,
      receipt: { outcome: 'uncertain', changed: true, mutationMayHaveCommitted: true },
    });

    const rawStore = createStore<{ stage: Stage | null }>(() => ({ stage: stage() }));
    const tamperingStore = {
      getState: rawStore.getState,
      setState: ({ stage: nextStage }: { stage: Stage | null }) => {
        const copied = structuredClone(nextStage);
        const created = copied?.whiteboard?.[0]?.elements.at(-1);
        if (created && created.type === 'text') created.content = 'tampered after plan';
        rawStore.setState({ stage: copied });
      },
    };
    const tamperedAuthority = new WhiteboardEnvironmentAuthority(tamperingStore);
    let open = false;
    tamperedAuthority.configureOpenStore({
      getState: () => ({ whiteboardOpen: open }),
      setState: ({ whiteboardOpen }) => {
        open = whiteboardOpen;
      },
    });
    tamperedAuthority.configureAuthenticatedTargetRegistry({ validateAndConsume: () => true });
    const tampered = tamperedAuthority.transactRevisionedDrawText(
      drawInput(tamperedAuthority, 'draw-postcondition-failure'),
    );
    expect(tampered).toMatchObject({
      ok: true,
      receipt: { outcome: 'uncertain', changed: true, mutationMayHaveCommitted: true },
    });
  });

  it('rejects forged request/intent digests before mutation', () => {
    const { store, authority } = createHarness();
    const input = drawInput(authority);
    const result = authority.transactRevisionedDrawText({
      ...input,
      intent: { ...input.intent, content: 'forged' },
    });
    expect(result).toMatchObject({ ok: false, code: 'MUTATION_REQUEST_INVALID' });
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    expect(authority.querySnapshot()).toMatchObject({ ok: true, value: { revision: 0 } });
  });

  it('fails re-entry with RESOURCE_BUSY and performs no nested mutation', () => {
    const { store, authority } = createHarness();
    const input = drawInput(authority);
    let nested: ReturnType<typeof authority.transactRevisionedDrawText> | undefined;
    const outer = authority.transact({
      label: 'test.outer',
      writes: [
        {
          label: 'nested',
          write: () => {
            nested = authority.transactRevisionedDrawText(input);
          },
        },
      ],
    });
    expect(outer).toMatchObject({ ok: true, changed: false });
    expect(nested).toMatchObject({ ok: false, code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY });
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    expect(authority.querySnapshot()).toMatchObject({ ok: true, value: { revision: 0 } });
  });
});
