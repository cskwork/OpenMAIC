import type { Action } from '@/lib/types/action';

/**
 * Pure, immutable edit operations on a scene's `actions` list, plus a factory
 * for new actions. The ActionsBar timeline drives all of its editing — inline
 * speech text, drag-to-add, reorder, element targeting, delete — through these,
 * then persists the result with `useStageStore.updateScene(sceneId, { actions })`.
 */

/** Action types the timeline palette can add by drag. */
export type AddableType = 'speech' | 'spotlight' | 'laser' | 'wb_draw_text';

/** Build a fresh action of the given type with a stable id. */
export function makeAction(type: AddableType, id: string): Action {
  switch (type) {
    case 'speech':
      return { id, type: 'speech', text: '' } as unknown as Action;
    case 'spotlight':
      return { id, type: 'spotlight', elementId: '' } as unknown as Action;
    case 'laser':
      return { id, type: 'laser', elementId: '' } as unknown as Action;
    case 'wb_draw_text':
      return { id, type: 'wb_draw_text', content: '' } as unknown as Action;
  }
}

/** Insert `action` so it lands at position `index` (clamped). */
export function insertAt(actions: Action[], index: number, action: Action): Action[] {
  const i = Math.max(0, Math.min(index, actions.length));
  return [...actions.slice(0, i), action, ...actions.slice(i)];
}

/** Remove the action at `index` (no-op if out of range). */
export function removeAt(actions: Action[], index: number): Action[] {
  if (index < 0 || index >= actions.length) return actions;
  return [...actions.slice(0, index), ...actions.slice(index + 1)];
}

/**
 * Move the item at `from` to insertion slot `to` (an index into the ORIGINAL
 * array, i.e. one of the n+1 gaps). No-op when the slot is where it already is.
 */
export function move(actions: Action[], from: number, to: number): Action[] {
  if (from < 0 || from >= actions.length) return actions;
  if (to === from || to === from + 1) return actions;
  const next = actions.slice();
  const [item] = next.splice(from, 1);
  const dest = from < to ? to - 1 : to;
  next.splice(Math.max(0, Math.min(dest, next.length)), 0, item);
  return next;
}

/** Set a speech action's text (no-op if `index` isn't a speech action). */
export function setSpeechText(actions: Action[], index: number, text: string): Action[] {
  const a = actions[index];
  if (!a || a.type !== 'speech') return actions;
  const next = actions.slice();
  next[index] = { ...a, text } as Action;
  return next;
}

/** Set an action's bound `elementId` (no-op if out of range). */
export function setElementId(actions: Action[], index: number, elementId: string): Action[] {
  const a = actions[index];
  if (!a) return actions;
  const next = actions.slice();
  next[index] = { ...a, elementId } as Action;
  return next;
}

/** Stamp a speech action's cached `audioId` (no-op if not a speech action). */
export function setAudioId(actions: Action[], index: number, audioId: string): Action[] {
  const a = actions[index];
  if (!a || a.type !== 'speech') return actions;
  const next = actions.slice();
  next[index] = { ...a, audioId } as Action;
  return next;
}
