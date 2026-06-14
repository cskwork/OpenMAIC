'use client';

/**
 * MAIC Agent v0 — client runtime.
 *
 * Drives an assistant-ui ExternalStore from the server's pi `AgentEvent` SSE
 * stream. A run produces multiple assistant turns (tool-call turn, wrap-up
 * turn); we keep each turn's ordered content as it streams (`turnsRef`) and
 * flatten chronologically via `mergeAssistantParts`, so tool cards and text
 * render in the order they actually happened. The assistant message carries a
 * streaming `status` (running → complete/error) for proper streaming UI.
 *
 * When a `regenerate_scene_actions` tool result arrives, its `details` payload
 * is applied to the editor's Dexie-backed stage store (guarded against empty
 * actions). Scene/stage context is read from `useStageStore` at send-time and
 * POSTed so the tool never relies on model-fabricated data.
 */
import { useCallback, useRef, useState } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { useStageStore } from '@/lib/store/stage';
import type { SceneContextMap } from '@/app/api/agent/edit/route';
import { mergeAssistantParts, type PiPart } from './merge-assistant-parts';
export type { AssistantPart, PiPart } from './merge-assistant-parts';

interface PiAssistantContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface UseAgentRuntimeOptions {
  scene?: { id: string; title: string };
}

function extractText(message: AppendMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function toPiParts(content: PiAssistantContent[]): PiPart[] {
  const parts: PiPart[] = [];
  for (const c of content) {
    if (c.type === 'text') {
      parts.push({ type: 'text', text: c.text ?? '' });
    } else if (c.type === 'toolCall' && c.id) {
      parts.push({
        type: 'toolCall',
        id: c.id,
        name: c.name ?? 'tool',
        arguments: c.arguments ?? {},
      });
    }
  }
  return parts;
}

export function useAgentRuntime(opts: UseAgentRuntimeOptions) {
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  // Per-run accumulated state: chronological turns + tool results.
  const turnsRef = useRef<PiPart[][]>([]);
  const toolResultsRef = useRef<Map<string, { result: unknown; isError: boolean }>>(new Map());
  const errorRef = useRef<string>('');
  const phaseRef = useRef<'running' | 'complete' | 'error'>('complete');
  // Aborts the in-flight run; closing the fetch body cancels the server stream
  // (the route's ReadableStream.cancel() calls agent.abort()).
  const abortRef = useRef<AbortController | null>(null);

  const buildAssistant = useCallback((id: string): ThreadMessageLike => {
    const parts = mergeAssistantParts({
      turns: turnsRef.current,
      toolResults: toolResultsRef.current,
      error: errorRef.current,
    });
    const status: ThreadMessageLike['status'] =
      phaseRef.current === 'running'
        ? { type: 'running' }
        : phaseRef.current === 'error'
          ? { type: 'incomplete', reason: 'error' }
          : { type: 'complete', reason: 'stop' };
    return { role: 'assistant', id, content: parts as ThreadMessageLike['content'], status };
  }, []);

  const handleEvent = useCallback((event: AgentEvent, refresh: () => void) => {
    switch (event.type) {
      case 'message_start': {
        const msg = (event as { message?: { role?: string } }).message;
        if (msg?.role === 'assistant') {
          turnsRef.current.push([]); // a new assistant turn begins
          refresh();
        }
        break;
      }
      case 'message_update':
      case 'message_end': {
        const msg = (
          event as {
            message?: { role?: string; content?: PiAssistantContent[]; errorMessage?: string };
          }
        ).message;
        if (msg?.role !== 'assistant') break;
        if (msg.errorMessage) errorRef.current = msg.errorMessage;
        if (Array.isArray(msg.content)) {
          if (turnsRef.current.length === 0) turnsRef.current.push([]);
          // Replace the CURRENT turn's content wholesale (pi re-emits the full
          // accumulated turn on each update) — order within the turn is kept.
          turnsRef.current[turnsRef.current.length - 1] = toPiParts(msg.content);
        }
        refresh();
        break;
      }
      case 'tool_execution_end': {
        const e = event as {
          toolCallId: string;
          result?: { details?: unknown };
          isError?: boolean;
        };
        toolResultsRef.current.set(e.toolCallId, { result: e.result, isError: !!e.isError });
        const details = (e.result?.details ?? {}) as { sceneId?: string; actions?: unknown };
        // Apply only non-empty actions — an empty array would destructively
        // wipe the scene's existing narration on a failed generation.
        if (details.sceneId && Array.isArray(details.actions) && details.actions.length > 0) {
          useStageStore.getState().updateScene(details.sceneId, { actions: details.actions });
        }
        refresh();
        break;
      }
      default:
        break;
    }
  }, []);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const userText = extractText(message);
      if (!userText) return;

      const turnId = `t-${Date.now()}`;
      const assistantId = `a-${turnId}`;
      turnsRef.current = [];
      toolResultsRef.current = new Map();
      errorRef.current = '';
      phaseRef.current = 'running';
      const abort = new AbortController();
      abortRef.current = abort;

      const userMsg: ThreadMessageLike = {
        role: 'user',
        id: `u-${turnId}`,
        content: [{ type: 'text', text: userText }],
      };
      setMessages((prev) => [...prev, userMsg, buildAssistant(assistantId)]);
      setIsRunning(true);

      // This run is "current" only while it still owns abortRef. Once the user
      // stops and starts another run, a newer onNew takes abortRef — late SSE
      // events from this (superseded) run must not rewrite the new message.
      const isCurrent = () => abortRef.current === abort;

      const refresh = () => {
        if (!isCurrent()) return;
        setMessages((prev) => {
          const next = prev.slice();
          next[next.length - 1] = buildAssistant(assistantId);
          return next;
        });
      };

      try {
        // Trusted scene context from the client store — the route injects it
        // into the tool deps so the model never fabricates outline/content.
        const storeState = useStageStore.getState();
        const { scenes, outlines, stage } = storeState;
        const sceneContextMap: SceneContextMap = {};
        for (const scene of scenes) {
          const outline = outlines.find((o) => o.order === scene.order) ?? {
            id: scene.id,
            type: scene.type,
            title: scene.title,
            description: '',
            keyPoints: [],
            order: scene.order,
          };
          sceneContextMap[scene.id] = {
            outline,
            allOutlines:
              outlines.length > 0
                ? outlines
                : scenes.map((s) => ({
                    id: s.id,
                    type: s.type,
                    title: s.title,
                    description: '',
                    keyPoints: [],
                    order: s.order,
                  })),
            content: scene.content,
            stageId: scene.stageId,
            languageDirective: stage?.languageDirective,
          };
        }

        const res = await fetch('/api/agent/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: userText, scene: opts.scene, sceneContextMap }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`agent request failed: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const json = line.slice(5).trim();
            if (!json || json === '{}') continue;
            let event: AgentEvent;
            try {
              event = JSON.parse(json) as AgentEvent;
            } catch {
              continue;
            }
            // Skip late events from a superseded run (don't apply stale tool
            // results to the stage or rewrite the new run's message).
            if (isCurrent()) handleEvent(event, refresh);
          }
        }
      } catch (err) {
        // User-initiated stop — keep whatever streamed, don't surface an error.
        if (abort.signal.aborted) {
          phaseRef.current = 'complete';
        } else {
          errorRef.current = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
          phaseRef.current = 'error';
        }
      } finally {
        // If the user stopped this run and immediately started a new one, a
        // newer onNew has already taken over abortRef and the message list.
        // This (superseded) run must NOT reset isRunning or rewrite the last
        // message, or it would clobber the new run.
        const superseded = abortRef.current !== abort;
        if (!superseded) {
          abortRef.current = null;
          if (phaseRef.current === 'running') phaseRef.current = 'complete';
          setIsRunning(false);
          setMessages((prev) => {
            const next = prev.slice();
            next[next.length - 1] = buildAssistant(assistantId);
            return next;
          });
        }
      }
    },
    [buildAssistant, handleEvent, opts.scene],
  );

  // Stop the current response: abort the fetch (cancels the server stream) and
  // drop the running flag immediately for a snappy UI; onNew's finally then
  // finalizes the assistant message with whatever had already streamed.
  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
    setIsRunning(false);
  }, []);

  return useExternalStoreRuntime({
    messages,
    isRunning,
    onNew,
    onCancel,
    convertMessage: (m) => m,
  });
}
