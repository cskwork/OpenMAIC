/**
 * Pure, client-safe helpers for outline specialization.
 *
 * Kept separate from outline-specializer.ts (which imports the server-only
 * prompt loader transitively via outline-generator) so the outline editor — a
 * client component — can import resetConfigForType without pulling `fs` into
 * the client bundle.
 */
import type { SceneOutline } from '@/lib/types/generation';

/** Stable djb2 hash over the intent fields that drive specialization. */
export function computeIntentHash(outline: SceneOutline): string {
  const intent = JSON.stringify({
    type: outline.type,
    title: outline.title ?? '',
    brief: outline.brief ?? '',
    description: outline.description ?? '',
    keyPoints: outline.keyPoints ?? [],
  });
  let h = 5381;
  for (let i = 0; i < intent.length; i++) {
    h = (((h << 5) + h) ^ intent.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Whether the outline already carries the config its `type` needs. */
export function hasRequiredConfig(outline: SceneOutline): boolean {
  switch (outline.type) {
    case 'interactive':
      return Boolean(outline.widgetType && outline.widgetOutline);
    case 'pbl':
      return Boolean(outline.pblConfig);
    case 'quiz':
      return Boolean(outline.quizConfig);
    case 'slide':
    default:
      return true;
  }
}

/**
 * Editor patch applied when the user changes a scene's type: set the new type
 * and clear every type-specific config (present-but-undefined so the spread in
 * the editor's updateOutline overwrites stale values), plus the cache tag.
 */
export function resetConfigForType(type: SceneOutline['type']): Partial<SceneOutline> {
  return {
    type,
    quizConfig: undefined,
    widgetType: undefined,
    widgetOutline: undefined,
    pblConfig: undefined,
    interactiveConfig: undefined,
    specializedFor: undefined,
  };
}
