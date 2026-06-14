/**
 * MAIC Agent — agent runtime construction.
 *
 * Stands up a pi `Agent` with:
 * - injected StreamFn (-> OpenMAIC connector),
 * - request-scoped tools supplied by the route,
 * - a `beforeToolCall` allowlist gate (v0 capability restriction = tool allowlist,
 *   NOT a hardcoded workflow). Adding capability later = widening this set.
 * - a `afterToolCall` quota hook (v0 stub: unlimited).
 */
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { makeAllowlistGate } from './allowlist';
import { makeQuotaHook } from './quota';
import { V0_ALLOWLIST } from '../tools/registry';

// pi needs *a* model object on state; the injected StreamFn ignores it and uses
// OpenMAIC's resolved model, so this is a metadata stub (high contextWindow so
// the harness never tries to compact).
const STUB_MODEL = {
  id: 'maic-connector',
  name: 'maic-connector',
  api: 'unknown',
  provider: 'unknown',
  baseUrl: '',
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} as unknown as Model<Api>;

export interface BuildAgentOptions {
  streamFn: StreamFn;
  systemPrompt: string;
  tools: AgentTool<never, never>[];
}

export function buildAgent(opts: BuildAgentOptions): Agent {
  return new Agent({
    streamFn: opts.streamFn,
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: STUB_MODEL,
      tools: opts.tools,
    },
    beforeToolCall: makeAllowlistGate(V0_ALLOWLIST),
    afterToolCall: makeQuotaHook({ remaining: () => Number.MAX_SAFE_INTEGER }),
  });
}

export function buildSystemPrompt(scene?: { id: string; title: string }): string {
  const sceneLine = scene
    ? `The current slide is id="${scene.id}" with title "${scene.title}".`
    : 'There is no active slide.';
  return [
    'You are the MAIC Editor assistant, embedded in the slide editor sidebar.',
    sceneLine,
    // Capability boundary — keep this tight. The agent has exactly ONE tool
    // (regenerate_scene_actions). Without firm limits the model cheerfully
    // claims it can rewrite slide text, images and layout, which it cannot.
    "Your ONLY capability is regenerating the current scene's spoken narration and its playback actions (讲解旁白/动作), by calling the `regenerate_scene_actions` tool with only the sceneId — outline and content are resolved automatically, so never fabricate them.",
    'You CANNOT do anything else. You cannot edit slide text, titles, bullets, images, layout, colors or styles; you cannot add, delete, reorder or duplicate slides; you cannot insert quizzes or modify the whiteboard; you cannot edit the slide / PPT / canvas directly. The user edits slide content themselves on the canvas.',
    'When asked to do anything outside regenerating the narration, do NOT claim or imply you can. Briefly say you cannot do that yet, note that they can edit the slide directly on the canvas, and offer to regenerate the narration to match once they are done.',
    "Keep replies to one or two sentences. Reply in the user's language.",
  ].join(' ');
}
