/**
 * Concrete schema-codegen entry point.
 *
 * JSON Schema is not generic, so the build-time generator needs a concrete
 * instantiation of the generic {@link Scene}. This is exactly the contract's
 * default `Scene<Action, SceneContent>` — it adds no constraint the public type
 * doesn't already express. It is kept here only so the generator has a named,
 * non-generic root; it is intentionally NOT re-exported from `index.ts`, so it
 * does not widen the public type surface.
 *
 * Scope: `SceneContent` is the contract-owned union (`SlideContent | QuizContent`),
 * so the generated `scene.schema.json` covers those content kinds. App-side
 * `interactive` / `pbl` content shapes are not part of the contract — apps that
 * widen `Scene`'s `TContent` own the schema for their own content shapes.
 */
import type { Scene, SceneContent } from './stage.js';
import type { Action } from './action.js';

export type SerializedScene = Scene<Action, SceneContent>;
