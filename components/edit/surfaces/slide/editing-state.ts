import type { PPTElement } from '@/lib/types/slides';

/**
 * The slide surface's text-editing policy: a single selected text element is,
 * by definition, the element being edited (there is no separate
 * "selected-not-editing" state for text). Anything else — empty selection,
 * multi-selection, a non-text element — resolves to "" (not editing).
 *
 * This is the value the surface writes into the canvas store's
 * `editingElementId`, which the renderer's `TextElementOperate` reads to swap
 * its dashed select frame for a clean solid editing frame.
 */
export function resolveEditingElementId(
  activeElementIdList: readonly string[],
  elements: readonly PPTElement[],
): string {
  if (activeElementIdList.length !== 1) return '';
  const id = activeElementIdList[0];
  const element = elements.find((el) => el.id === id);
  return element?.type === 'text' ? id : '';
}
