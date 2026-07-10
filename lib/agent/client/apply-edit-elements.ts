/**
 * Host adapter: apply L1 EditIntents from `edit_elements` through the existing
 * slide edit session as ONE undo entry.
 *
 * EditableSlideCanvas's `onElementsChange` is not mounted in the app yet; this
 * adapter speaks the same EditIntent vocabulary so the canvas can take over
 * later without changing the tool contract. Mixed per-id props cannot use
 * slide-ops `element.updateMany` (shared patch), so we fold updates into one
 * `commitContent(..., true)`.
 */

import type { EditIntent } from '@openmaic/renderer/editing';
import type { PPTElement } from '@openmaic/dsl';
import { produce } from 'immer';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { useStageStore } from '@/lib/store/stage';
import type { SlideContent } from '@/lib/types/stage';

export interface EditElementsApplyDetails {
  sceneId?: string;
  intents?: EditIntent[] | null;
  updateCount?: number;
}

function applyIntentsToContent(content: SlideContent, intents: EditIntent[]): SlideContent {
  return produce(content, (draft) => {
    for (const intent of intents) {
      if (intent.type === 'element.update') {
        const el = draft.canvas.elements.find((e) => e.id === intent.id);
        if (!el) continue;
        Object.assign(el, intent.props);
      } else if (intent.type === 'element.updateMany') {
        for (const u of intent.updates) {
          const el = draft.canvas.elements.find((e) => e.id === u.id);
          if (!el) continue;
          Object.assign(el, u.props as Partial<PPTElement>);
        }
      }
      // Other EditIntent kinds are out of scope for this vertical.
    }
  });
}

/**
 * Apply validated intents for a scene. Returns true when something was written.
 * Prefers the open slide edit session (one undo via commitContent); falls back
 * to a stage-store write when no session is open for that scene.
 */
export function applyEditElementsIntents(sceneId: string, intents: EditIntent[]): boolean {
  if (!intents.length) return false;

  const session = useSlideEditSession.getState();
  if (session.sceneId === sceneId && session.history) {
    const next = applyIntentsToContent(session.history.present, intents);
    if (next === session.history.present) return false;
    session.commitContent(next, true);
    return true;
  }

  const scene = useStageStore.getState().getSceneById(sceneId);
  if (!scene || scene.content.type !== 'slide') return false;
  const next = applyIntentsToContent(scene.content as SlideContent, intents);
  useStageStore.getState().updateScene(sceneId, { content: next });
  return true;
}

/** True when tool details carry applyable edit_elements intents. */
export function hasEditElementsIntents(
  details: EditElementsApplyDetails | null | undefined,
): details is EditElementsApplyDetails & { sceneId: string; intents: EditIntent[] } {
  return (
    !!details &&
    typeof details.sceneId === 'string' &&
    Array.isArray(details.intents) &&
    details.intents.length > 0
  );
}
