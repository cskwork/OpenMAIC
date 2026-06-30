/**
 * Concrete schema-codegen entry points.
 *
 * JSON Schema is not generic, so the build-time generator needs a concrete
 * instantiation of the generic {@link Scene}. This aliases the contract's
 * default `Scene<Action, SceneContent>`. Internal to schema codegen — it is
 * intentionally NOT re-exported from `index.ts`, so it does not widen the
 * public type surface.
 *
 * Scope: `SceneContent` is the contract-owned union (`SlideContent | QuizContent`),
 * so the generated `scene.schema.json` covers those kinds. The app-side
 * `interactive` / `pbl` content kinds are not part of the contract — apps that
 * widen `Scene`'s `TContent` own the schema for their own content shapes.
 */
import type { Scene, SlideContent, QuizContent } from './stage.js';
import type { Action } from './action.js';

// Discriminated per scene kind so the generated schema ties `type` to the
// matching `content.type` (a slide-typed scene must carry slide content, a
// quiz-typed scene quiz content). This keeps scene.schema.json consistent with
// `validateScene`'s scene/content agreement check, instead of accepting any
// `SceneType` × `SlideContent | QuizContent` cross-product.
type SlideScene = Omit<Scene<Action, SlideContent>, 'type'> & { type: 'slide' };
type QuizScene = Omit<Scene<Action, QuizContent>, 'type'> & { type: 'quiz' };

export type SerializedScene = SlideScene | QuizScene;
