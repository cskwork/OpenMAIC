import { describe, expect, test } from 'vitest';
import { resolveEditingElementId } from '@/components/edit/surfaces/slide/editing-state';
import { createDefaultImageElement, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';

describe('resolveEditingElementId', () => {
  const text = createDefaultTextElement('t1');
  const image = createDefaultImageElement('i1', 'gen_img_x');

  test('returns "" when nothing is selected', () => {
    expect(resolveEditingElementId([], [text])).toBe('');
  });

  test('returns "" for a multi-selection', () => {
    expect(resolveEditingElementId(['t1', 'i1'], [text, image])).toBe('');
  });

  test('returns "" when the single selection is not a text element', () => {
    expect(resolveEditingElementId(['i1'], [text, image])).toBe('');
  });

  test('returns "" when the selected id is not found', () => {
    expect(resolveEditingElementId(['ghost'], [text])).toBe('');
  });

  test('returns the id when a single text element is selected', () => {
    expect(resolveEditingElementId(['t1'], [text, image])).toBe('t1');
  });
});
