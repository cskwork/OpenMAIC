import { describe, expect, test } from 'vitest';
import { resolveEditingElementId } from '@/components/edit/surfaces/slide/editing-state';
import type { PPTElement, PPTTextElement } from '@/lib/types/slides';

function textElement(id: string): PPTTextElement {
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

function nonTextElement(id: string): PPTElement {
  return { id, type: 'image' } as unknown as PPTElement;
}

describe('resolveEditingElementId', () => {
  test('returns "" when nothing is selected', () => {
    expect(resolveEditingElementId([], [textElement('t1')])).toBe('');
  });

  test('returns "" for a multi-selection', () => {
    expect(
      resolveEditingElementId(['t1', 'i1'], [textElement('t1'), nonTextElement('i1')]),
    ).toBe('');
  });

  test('returns "" when the single selection is not a text element', () => {
    expect(resolveEditingElementId(['i1'], [nonTextElement('i1')])).toBe('');
  });

  test('returns "" when the selected id is not found', () => {
    expect(resolveEditingElementId(['ghost'], [textElement('t1')])).toBe('');
  });

  test('returns the id when a single text element is selected', () => {
    expect(resolveEditingElementId(['t1'], [textElement('t1'), nonTextElement('i1')])).toBe('t1');
  });
});
