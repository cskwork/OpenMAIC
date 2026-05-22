import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildInsertItems,
  deleteSlideElement,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';

function seedEmptySlideSession() {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  useSlideEditSession.setState({
    history: {
      past: [],
      present: { type: 'slide', canvas: { id: 's', elements: [] } } as any,
      future: [],
    },
  } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe('slide insert palette', () => {
  beforeEach(seedEmptySlideSession);
  afterEach(() => vi.restoreAllMocks());

  it('exposes a text-box and an image insert item', () => {
    const items = buildInsertItems((k) => k);
    expect(items.map((i) => i.id)).toEqual(['insert-text', 'insert-image']);
    expect(items[1].popoverContent).toBeTypeOf('function');
    expect(items[0].onInvoke).toBeTypeOf('function');
  });

  it('text-box invoke dispatches element.add with a text element', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    buildInsertItems((k) => k)[0].onInvoke();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'element.add',
        element: expect.objectContaining({ type: 'text' }),
      }),
    );
  });
});

describe('slide element deletion', () => {
  beforeEach(seedEmptySlideSession);
  afterEach(() => vi.restoreAllMocks());

  it('deleteSlideElement dispatches an element.delete op', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    deleteSlideElement('img-9');
    expect(spy).toHaveBeenCalledWith({ type: 'element.delete', elementId: 'img-9' });
  });
});
