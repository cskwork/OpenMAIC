/**
 * Outline specializer — derive-on-confirm of type-specific config.
 *
 * The scene `type` is authoritative. When the user changes a scene's type in
 * the editor, the matching config (widgetOutline / pblConfig / quizConfig) is
 * missing. This module derives it at scene-content time so generation produces
 * the declared type instead of silently reverting to slide.
 *
 * Cache: `SceneOutline.specializedFor` stores the intent hash the current
 * config was derived for. When it matches and the required config is present,
 * specialization is a no-op (no extra LLM call). The derived outline is carried
 * back as the scene-content route's `effectiveOutline`, which the client feeds
 * into the pipeline — so re-confirming unchanged intent costs nothing.
 */
import type { SceneOutline, WidgetOutline } from '@/lib/types/generation';
import type { WidgetType } from '@/lib/types/widgets';
import type { AICallFn } from './pipeline-types';
import { sanitizeProceduralSkillOutline } from './outline-generator';
import { parseJsonResponse } from './json-repair';
import { createLogger } from '@/lib/logger';

const log = createLogger('OutlineSpecializer');

const WIDGET_TYPES: WidgetType[] = ['simulation', 'diagram', 'code', 'game', 'visualization3d'];

// Pure, client-safe helpers live in a separate module so the client editor can
// import resetConfigForType without pulling this server-only file (and its
// fs-backed prompt loader, via outline-generator) into the client bundle.
import { computeIntentHash, hasRequiredConfig } from './outline-specializer-helpers';
export {
  computeIntentHash,
  hasRequiredConfig,
  resetConfigForType,
} from './outline-specializer-helpers';

export function deriveQuizConfig(outline: SceneOutline): NonNullable<SceneOutline['quizConfig']> {
  return (
    outline.quizConfig ?? {
      questionCount: 3,
      difficulty: 'medium',
      questionTypes: ['single'],
    }
  );
}

export function derivePblConfig(outline: SceneOutline): NonNullable<SceneOutline['pblConfig']> {
  if (outline.pblConfig) return outline.pblConfig;
  const skills = outline.keyPoints?.length ? outline.keyPoints : [outline.title];
  return {
    projectTopic: outline.title,
    projectDescription: outline.brief?.trim() || outline.description || outline.title,
    targetSkills: skills,
    issueCount: 3,
  };
}

/**
 * Classify an interactive scene into one widget type + a minimal widget outline.
 * Most widget-content variables fall back to the outline's common fields
 * (title/description/keyPoints) downstream, so a minimal `{ concept }` is enough
 * to render. Defaults to `diagram` if the LLM is unavailable or returns garbage.
 */
export async function deriveWidgetConfig(
  outline: SceneOutline,
  aiCall: AICallFn,
): Promise<{ widgetType: WidgetType; widgetOutline: WidgetOutline }> {
  if (outline.widgetType && outline.widgetOutline) {
    return { widgetType: outline.widgetType, widgetOutline: outline.widgetOutline };
  }
  const system = [
    'You classify ONE lesson scene into exactly one interactive widget type and produce a minimal outline.',
    'Widget types:',
    '- simulation: physics/chemistry/science you explore by changing variables',
    '- diagram: processes, structures, hierarchies, relationships',
    '- code: programming / algorithms',
    '- game: practice through play (quiz-like, puzzle, strategy)',
    '- visualization3d: 3D models (molecules, solar system, anatomy, geometry)',
    'Return ONLY JSON: {"widgetType":"<one of the five>","widgetOutline":{"concept":"<short phrase>"}}',
  ].join('\n');
  const user = `Title: ${outline.title}\nBrief: ${outline.brief ?? ''}\nDescription: ${
    outline.description ?? ''
  }\nKey points:\n${(outline.keyPoints ?? []).join('\n')}`;
  try {
    const raw = await aiCall(system, user);
    const parsed = parseJsonResponse<{ widgetType?: string; widgetOutline?: WidgetOutline }>(raw);
    const widgetType = WIDGET_TYPES.includes(parsed?.widgetType as WidgetType)
      ? (parsed!.widgetType as WidgetType)
      : 'diagram';
    const widgetOutline: WidgetOutline = { concept: outline.title, ...(parsed?.widgetOutline ?? {}) };
    return { widgetType, widgetOutline };
  } catch (err) {
    log.warn(`deriveWidgetConfig failed for "${outline.title}", defaulting to diagram: ${String(err)}`);
    return { widgetType: 'diagram', widgetOutline: { concept: outline.title } };
  }
}

export interface SpecializeDeps {
  aiCall: AICallFn;
  hasLanguageModel: boolean;
  /** Vocational procedural-skill is gated; mirrors applyOutlineFallbacks' option. */
  allowProceduralSkill?: boolean;
  /** Injectable for tests; defaults to deriveWidgetConfig. */
  deriveWidget?: typeof deriveWidgetConfig;
}

/**
 * Ensure the outline carries the config its declared `type` needs, deriving it
 * on demand. Cache: when `specializedFor` matches the current intent hash AND
 * the required config is present, the outline is returned untouched (no LLM).
 */
export async function specializeOutline(
  outline: SceneOutline,
  deps: SpecializeDeps,
): Promise<SceneOutline> {
  // Vocational procedural-skill is gated: when not enabled, upstream renders it
  // as a diagram instead of the procedural widget. Preserve that before any
  // type-based specialization (it yields a valid interactive+diagram outline).
  if (outline.widgetType === 'procedural-skill' && !deps.allowProceduralSkill) {
    const sanitized = sanitizeProceduralSkillOutline(outline);
    return { ...sanitized, specializedFor: computeIntentHash(sanitized) };
  }

  const hash = computeIntentHash(outline);

  if (outline.specializedFor === hash && hasRequiredConfig(outline)) {
    return outline;
  }

  switch (outline.type) {
    case 'quiz':
      return { ...outline, quizConfig: deriveQuizConfig(outline), specializedFor: hash };

    case 'pbl': {
      if (!deps.hasLanguageModel) {
        log.warn(`PBL "${outline.title}" has no language model; rendering as slide`);
        const asSlide: SceneOutline = { ...outline, type: 'slide' };
        return { ...asSlide, specializedFor: computeIntentHash(asSlide) };
      }
      return { ...outline, pblConfig: derivePblConfig(outline), specializedFor: hash };
    }

    case 'interactive': {
      const derive = deps.deriveWidget ?? deriveWidgetConfig;
      const { widgetType, widgetOutline } = await derive(outline, deps.aiCall);
      return { ...outline, widgetType, widgetOutline, specializedFor: hash };
    }

    case 'slide':
    default:
      return { ...outline, specializedFor: hash };
  }
}
