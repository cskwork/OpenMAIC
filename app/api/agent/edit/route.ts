/**
 * MAIC Agent — SSE transport endpoint.
 *
 * Hosts a server-side pi Agent and streams its `AgentEvent`s to the editor
 * sidebar as Server-Sent Events. The whole feature is gated behind the master
 * editor flag.
 */
import type { NextRequest } from 'next/server';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { buildAgent, buildSystemPrompt } from '@/lib/agent/runtime/build-agent';
import { buildToolset } from '@/lib/agent/tools/registry';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';

const log = createLogger('MAIC Agent');

export const maxDuration = 60;

/**
 * Scene/stage context map sent by the client.
 * Keyed by scene id; the client reads `useStageStore` to build this so the
 * server never has to access a (non-existent) server-side scene store.
 */
export type SceneContextMap = Record<string, SceneContext>;

interface AgentEditBody {
  message: string;
  scene?: { id: string; title: string };
  /**
   * Trusted scene/stage context for every scene the agent may act on.
   * The client includes the active scene (and all sibling scenes) so the
   * `regenerate_scene_actions` tool can resolve outline + content without
   * relying on model-fabricated arguments.
   */
  sceneContextMap?: SceneContextMap;
}

export async function POST(req: NextRequest) {
  if (!isMaicEditorEnabled()) {
    return new Response('Not found', { status: 404 });
  }

  const body = (await req.json()) as AgentEditBody & Record<string, unknown>;
  const message = (body.message ?? '').toString().trim();
  if (!message) {
    return new Response('message is required', { status: 400 });
  }

  // Resolve via the 'maic-agent' stage so operators can route the editor agent
  // to a dedicated model via MODEL_ROUTES (per-stage config). When unrouted it
  // falls back to the client's active frontend model config (x-model headers +
  // thinkingConfig body), then DEFAULT_MODEL — see resolveModel.
  const { model, modelInfo, thinkingConfig, modelString } = await resolveModelFromRequest(
    req,
    body,
    'maic-agent',
  );

  const aiCall = async (system: string, prompt: string): Promise<string> => {
    const r = await callLLM(
      { model, system, prompt, maxOutputTokens: modelInfo?.outputWindow },
      'maic-agent-regen',
      undefined,
      thinkingConfig,
    );
    return r.text;
  };

  const sceneContextMap: SceneContextMap = body.sceneContextMap ?? {};
  const tools = buildToolset({
    aiCall,
    getSceneContext: (sceneId) => sceneContextMap[sceneId],
  });

  const abortController = new AbortController();
  const streamFn = createCallLlmStreamFn({
    languageModel: model,
    maxOutputTokens: modelInfo?.outputWindow,
    thinkingConfig,
    source: 'maic-agent',
    abortSignal: abortController.signal,
  });

  const agent = buildAgent({ streamFn, systemPrompt: buildSystemPrompt(body.scene), tools });
  log.info(`agent edit turn [model=${modelString}] scene=${body.scene?.id ?? 'none'}`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* controller closed */
        }
      };
      const unsubscribe = agent.subscribe((event) => {
        send(event);
      });
      try {
        await agent.prompt(message);
        await agent.waitForIdle();
      } catch (err) {
        log.error(`agent run failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        unsubscribe();
        try {
          controller.enqueue(encoder.encode('event: close\ndata: {}\n\n'));
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
    cancel() {
      agent.abort();
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
