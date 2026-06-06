import type { AgentTool } from '@earendil-works/pi-agent-core';
import { makeRegenerateSceneActionsTool, type RegenerateActionsDeps } from './regenerate-scene-actions';

/** Deps needed to build the v0 toolset (request-scoped: LLM access uses the resolved model). */
export type ToolsetDeps = RegenerateActionsDeps;

/** Build the v0 toolset. v0 = the headline regenerate-actions tool only. */
export function buildToolset(deps: ToolsetDeps): AgentTool<never, never>[] {
  return [makeRegenerateSceneActionsTool(deps) as never];
}

/** v0 allowlist — the enabled subset. Widen here to grant capability. */
export const V0_ALLOWLIST: ReadonlySet<string> = new Set(['regenerate_scene_actions']);
