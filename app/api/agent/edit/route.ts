/**
 * MAIC Agent PoC — SSE transport endpoint.
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
import { buildAgent, buildSystemPrompt } from '@/lib/agent/poc/build-agent';
import { createLogger } from '@/lib/logger';

const log = createLogger('MAIC Agent PoC');

export const maxDuration = 60;

interface AgentEditBody {
  message: string;
  scene?: { id: string; title: string };
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

  const { model, modelInfo, thinkingConfig, modelString } = await resolveModelFromRequest(req, body);
  const streamFn = createCallLlmStreamFn({
    languageModel: model,
    maxOutputTokens: modelInfo?.outputWindow,
    thinkingConfig,
    source: 'maic-agent-poc',
  });

  const agent = buildAgent({ streamFn, systemPrompt: buildSystemPrompt(body.scene) });
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
