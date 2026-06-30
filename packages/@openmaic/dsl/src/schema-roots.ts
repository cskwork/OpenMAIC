/**
 * Concrete schema-codegen entry points.
 *
 * JSON Schema is not generic, so the build-time generator needs a concrete
 * instantiation of the generic {@link Scene}. This aliases the contract's
 * default `Scene<Action, SceneContent>`. Internal to schema codegen — it is
 * intentionally NOT re-exported from `index.ts`, so it does not widen the
 * public type surface.
 */
import type { Scene, SceneContent } from './stage.js';
import type { Action } from './action.js';

export type SerializedScene = Scene<Action, SceneContent>;
