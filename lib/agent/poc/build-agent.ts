/**
 * MAIC Agent PoC — agent runtime construction.
 *
 * Stands up a pi `Agent` with:
 * - injected StreamFn (-> OpenMAIC connector),
 * - the v0 domain tool registered,
 * - a `beforeToolCall` allowlist gate (v0 capability restriction = tool allowlist,
 *   NOT a hardcoded workflow). Adding capability later = widening this set.
 */
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { setSlideTitleTool } from './tools/set-slide-title';

/** v0 allowlist: every registered tool that is actually enabled. */
const TOOL_ALLOWLIST = new Set<string>(['set_slide_title']);

// pi needs *a* model object on state; the injected StreamFn ignores it and uses
// OpenMAIC's resolved model, so this is a metadata stub (high contextWindow so
// the harness never tries to compact during the PoC).
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
}

export function buildAgent(opts: BuildAgentOptions): Agent {
  return new Agent({
    streamFn: opts.streamFn,
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: STUB_MODEL,
      tools: [setSlideTitleTool],
    },
    beforeToolCall: async (ctx) => {
      if (!TOOL_ALLOWLIST.has(ctx.toolCall.name)) {
        return { block: true, reason: `Tool "${ctx.toolCall.name}" is not enabled in this build.` };
      }
      return undefined;
    },
  });
}

export function buildSystemPrompt(scene?: { id: string; title: string }): string {
  const sceneLine = scene
    ? `The current slide is id="${scene.id}" with title "${scene.title}".`
    : 'There is no active slide.';
  return [
    'You are the MAIC Editor assistant (proof of concept).',
    'You help the user edit the slide they are currently viewing.',
    sceneLine,
    'When the user asks to rename, retitle, or change the slide title, call the `set_slide_title` tool with that exact sceneId and the new title. Do not ask for confirmation.',
    'For anything else, reply briefly in one or two sentences.',
  ].join(' ');
}
