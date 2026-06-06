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
    'You are the MAIC Editor assistant.',
    'You help the user edit the slide they are currently viewing.',
    sceneLine,
    'When the user asks to regenerate or re-sync the actions/narration for the current scene after editing its content, call the `regenerate_scene_actions` tool with the appropriate scene data.',
    'For anything else, reply briefly in one or two sentences.',
  ].join(' ');
}
