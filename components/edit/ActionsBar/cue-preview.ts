import type { Action } from '@/lib/types/action';

/**
 * Which canvas effect a cue glyph replays on hover.
 * `none` = tooltip only, no canvas effect (the cue has no bound slide element).
 */
export type CuePreview =
  | { kind: 'spotlight'; elementId: string }
  | { kind: 'laser'; elementId: string }
  | { kind: 'none' };

/**
 * Decide how a cue should replay on the edit canvas.
 *
 * A `laser` cue must replay as the real laser pointer — NOT a spotlight (the
 * original ActionsBar fired `setSpotlight` for every cue, so laser cues were
 * wrongly rendered as a spotlight). Every other element-bound cue (spotlight,
 * play_video, whiteboard draws that carry a slide elementId) keeps the
 * spotlight highlight. A cue with no bound element gets no canvas preview.
 */
export function cuePreviewFor(action: Action): CuePreview {
  const elementId = (action as { elementId?: string }).elementId;
  if (!elementId) return { kind: 'none' };
  if (action.type === 'laser') return { kind: 'laser', elementId };
  return { kind: 'spotlight', elementId };
}
