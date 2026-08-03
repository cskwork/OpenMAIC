import { afterEach, describe, expect, it } from 'vitest';
import { EvalStateManager } from '@/eval/whiteboard-layout/state-manager';
import { useStageStore } from '@/lib/store/stage';
import type { Stage, Whiteboard } from '@/lib/types/stage';

function board(id: string, elementId: string): Whiteboard {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements: [{ id: elementId, type: 'text', content: elementId } as never],
    background: { type: 'solid', color: '#fff' },
    animations: [],
  };
}

describe('EvalStateManager whiteboard binding', () => {
  let manager: EvalStateManager | undefined;

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    useStageStore.getState().clearStore();
  });

  it('reads the Authority-selected active board instead of the array tail', () => {
    const stage: Stage = {
      id: 'eval-multi-board',
      name: 'Eval multi-board',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [board('active-first', 'first-element'), board('inactive-last', 'last-element')],
    };
    manager = new EvalStateManager({
      stage,
      scenes: [],
      currentSceneId: null,
    });

    expect(manager.getWhiteboardElements().map(({ id }) => id)).toEqual(['first-element']);
  });
});
