import { describe, expect, test } from 'vitest';
import { buildFloatingActions } from '@/components/edit/surfaces/slide/use-slide-surface';
import type { PPTElement, PPTTextElement } from '@/lib/types/slides';

const t = (key: string) => key;

function textElement(id = 't1'): PPTTextElement {
  return {
    id,
    type: 'text',
    left: 0,
    top: 0,
    width: 200,
    height: 60,
    rotate: 0,
    content: '<p>x</p>',
    defaultFontName: 'Inter',
    defaultColor: '#111827',
  };
}

function nonTextElement(id = 'i1'): PPTElement {
  return { id, type: 'image' } as unknown as PPTElement;
}

describe('buildFloatingActions', () => {
  test('returns no actions when nothing is selected', () => {
    expect(buildFloatingActions(t, undefined)).toEqual([]);
  });

  test('a selected text element no longer surfaces a text-format action', () => {
    const actions = buildFloatingActions(t, textElement());
    expect(actions.some((action) => action.id === 'text-format')).toBe(false);
  });

  test('a selected text element surfaces exactly the delete action', () => {
    expect(buildFloatingActions(t, textElement()).map((a) => a.id)).toEqual(['delete']);
  });

  test('a selected image element still surfaces the delete action', () => {
    expect(buildFloatingActions(t, nonTextElement()).map((a) => a.id)).toEqual(['delete']);
  });
});
