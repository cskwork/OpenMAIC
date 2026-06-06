/**
 * `regenerate_scene_actions` agent tool
 *
 * Re-generates a scene's playback `actions` to match its (edited) content by
 * reusing the same server-side pipeline as `app/api/generate/scene-actions/route.ts`.
 *
 * The tool's `execute` runs inside the agent loop and has no access to the
 * request's resolved model, so the LLM call capability is injected via a
 * factory (`makeRegenerateSceneActionsTool`) — the route will supply `deps.aiCall`
 * built from the already-resolved model.
 *
 * The tool returns the regenerated actions in `details`; a later client task
 * reads `tool_execution_end` and applies the actions to the scene in the store.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  generateSceneActions,
  type SceneGenerationContext,
  type AgentInfo,
} from '@/lib/generation/generation-pipeline';
import type { Action } from '@/lib/types/action';

// ── Deps injection interface ─────────────────────────────────────────────────

export interface RegenerateActionsDeps {
  /**
   * Server-side LLM text call, model already resolved by the route.
   * Mirrors the `AICallFn` signature from the pipeline but without the
   * optional images arg (actions generation doesn't use vision).
   */
  aiCall: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

// ── Typebox parameter schema ─────────────────────────────────────────────────

export const RegenerateSceneActionsParams = Type.Object({
  sceneId: Type.String({
    description: 'The id of the scene whose actions should be regenerated.',
  }),
  outline: Type.Any({
    description: 'SceneOutline for the target scene (mirrors route POST body).',
  }),
  allOutlines: Type.Array(Type.Any(), {
    description: 'All scene outlines in the stage, in order (for cross-scene context).',
  }),
  content: Type.Any({
    description:
      'The current scene content (GeneratedSlideContent | GeneratedQuizContent | GeneratedInteractiveContent | GeneratedPBLContent).',
  }),
  stageId: Type.String({ description: 'The stage id that owns this scene.' }),
  agents: Type.Optional(
    Type.Array(Type.Any(), { description: 'Agent info for multi-agent stages.' }),
  ),
  previousSpeeches: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Speech texts from the previous scene for cross-scene coherence.',
    }),
  ),
  userProfile: Type.Optional(
    Type.String({ description: 'Free-text user profile for personalised narration.' }),
  ),
  languageDirective: Type.Optional(
    Type.String({ description: 'Language/locale directive forwarded to the generator.' }),
  ),
});

export type RegenerateSceneActionsParams = Static<typeof RegenerateSceneActionsParams>;

// ── Details shape returned to the client ────────────────────────────────────

export interface RegenerateSceneActionsDetails {
  sceneId: string;
  actions: Action[];
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeRegenerateSceneActionsTool(
  deps: RegenerateActionsDeps,
): AgentTool<typeof RegenerateSceneActionsParams, RegenerateSceneActionsDetails> {
  return {
    name: 'regenerate_scene_actions',
    label: 'Regenerate scene actions',
    description:
      'Re-generates the narration/playback actions for a scene to match its (edited) content. ' +
      'Use this after the scene content has been modified (e.g. slide elements changed, quiz questions updated) ' +
      'so that the actions stay in sync with what is actually on screen.',
    parameters: RegenerateSceneActionsParams,

    execute: async (_toolCallId, params) => {
      const {
        sceneId,
        outline,
        allOutlines,
        content,
        agents,
        previousSpeeches,
        userProfile,
        languageDirective,
      } = params;

      // ── Build cross-scene context (mirrors route.ts logic) ─────────────
      const allTitles: string[] = (allOutlines as Array<{ title: string }>).map((o) => o.title);
      const pageIndex = (allOutlines as Array<{ id: string }>).findIndex(
        (o) => o.id === (outline as { id: string }).id,
      );
      const ctx: SceneGenerationContext = {
        pageIndex: (pageIndex >= 0 ? pageIndex : 0) + 1,
        totalPages: allOutlines.length,
        allTitles,
        previousSpeeches: previousSpeeches ?? [],
      };

      // Wrap deps.aiCall to match AICallFn (adds optional images param)
      const aiCallFn = (
        systemPrompt: string,
        userPrompt: string,
        _images?: Array<{ id: string; src: string }>,
      ): Promise<string> => deps.aiCall(systemPrompt, userPrompt);

      // ── Generate actions ───────────────────────────────────────────────
      const actions = await generateSceneActions(outline as never, content as never, aiCallFn, {
        ctx,
        agents: agents as AgentInfo[] | undefined,
        userProfile,
        languageDirective,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Regenerated ${actions.length} actions for the scene.`,
          },
        ],
        details: { sceneId, actions },
      };
    },
  };
}
