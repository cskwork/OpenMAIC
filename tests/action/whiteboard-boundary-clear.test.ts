import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionEngine } from '@/lib/action/engine';
import { useCanvasStore } from '@/lib/store/canvas';

function createStageStore() {
  let state = {
    stage: {
      id: 'stage-1',
      name: 'Boundary test',
      whiteboard: [
        {
          id: 'wb-1',
          elements: [{ id: 'old-note', type: 'text', content: 'old topic' }],
        },
      ],
    },
  };
  return {
    store: {
      getState: () => state,
      setState: (updates: Partial<typeof state>) => {
        state = { ...state, ...updates };
      },
    },
    getElements: () => state.stage.whiteboard[0].elements,
    addExternalElement: () => {
      state = {
        ...state,
        stage: {
          ...state.stage,
          whiteboard: [
            {
              ...state.stage.whiteboard[0],
              elements: [
                ...state.stage.whiteboard[0].elements,
                { id: 'lecture-note', type: 'text', content: 'new during animation' },
              ],
            },
          ],
        },
      };
    },
  };
}

describe('ActionEngine guarded boundary clear', () => {
  afterEach(() => {
    vi.useRealTimers();
    useCanvasStore.getState().setWhiteboardOpen(false);
    useCanvasStore.getState().setWhiteboardClearing(false);
  });

  it('checks the guard again at commit time and preserves content added during animation', async () => {
    vi.useFakeTimers();
    useCanvasStore.getState().setWhiteboardOpen(true);
    const fixture = createStageStore();
    const rejected = vi.fn();
    const engine = new ActionEngine(fixture.store as never);

    const execution = engine.execute(
      { id: 'clear-1', type: 'wb_clear' },
      {
        whiteboardClearGuard: () => fixture.getElements().length === 1,
        onWhiteboardClearGuardRejected: rejected,
      },
    );

    await vi.advanceTimersByTimeAsync(100);
    fixture.addExternalElement();
    await vi.advanceTimersByTimeAsync(2_000);
    await execution;

    expect(rejected).toHaveBeenCalledOnce();
    expect(fixture.getElements().map((element) => element.id)).toEqual([
      'old-note',
      'lecture-note',
    ]);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);
  });
});
