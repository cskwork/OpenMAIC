'use client';

/**
 * MAIC Agent PoC — client runtime.
 *
 * Drives an assistant-ui ExternalStore from the server's pi `AgentEvent` SSE
 * stream. This is the second integration seam of option B: assistant-ui's
 * ExternalStoreRuntime fed by pi events (it matches tool results to tool calls
 * by toolCallId; we render them as `tool-call` content parts).
 *
 * A single agent run can produce MULTIPLE assistant turns (the tool-call turn,
 * then a wrap-up turn). We ACCUMULATE across turns into one assistant message:
 * tool calls are upserted by id (so the tool card from the first turn survives
 * the wrap-up turn), the latest non-empty assistant text wins, and a turn error
 * surfaces as text. When a `set_slide_title` tool result arrives, its op
 * (`details`) is applied to the editor's Dexie-backed stage store.
 */
import { useCallback, useRef, useState } from 'react';
import { useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { useStageStore } from '@/lib/store/stage';

type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown; isError?: boolean };

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

export function useAgentRuntime(opts: UseAgentRuntimeOptions) {
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  // Per-run accumulated state (merged across assistant turns).
  const toolCallsRef = useRef<Map<string, { name: string; args: Record<string, unknown> }>>(new Map());
  const toolOrderRef = useRef<string[]>([]);
  const toolResultsRef = useRef<Map<string, { result: unknown; isError: boolean }>>(new Map());
  const textRef = useRef<string>('');
  const errorRef = useRef<string>('');

  const buildAssistant = useCallback((id: string): ThreadMessageLike => {
    const parts: AssistantPart[] = [];
    const text = textRef.current || errorRef.current;
    if (text) parts.push({ type: 'text', text });
    for (const tcId of toolOrderRef.current) {
      const tc = toolCallsRef.current.get(tcId);
      if (!tc) continue;
      const tr = toolResultsRef.current.get(tcId);
      parts.push({
        type: 'tool-call',
        toolCallId: tcId,
        toolName: tc.name,
        args: tc.args,
        ...(tr ? { result: tr.result, isError: tr.isError } : {}),
      });
    }
    if (parts.length === 0) parts.push({ type: 'text', text: '' });
    return { role: 'assistant', id, content: parts as ThreadMessageLike['content'] };
  }, []);

  const handleEvent = useCallback(
    (event: AgentEvent, assistantId: string, refresh: () => void) => {
      switch (event.type) {
        case 'message_start':
        case 'message_update':
        case 'message_end': {
          const msg = (event as { message?: { role?: string; content?: PiAssistantContent[]; errorMessage?: string } })
            .message;
          if (msg?.role !== 'assistant') break;
          if (msg.errorMessage) errorRef.current = msg.errorMessage;
          if (Array.isArray(msg.content)) {
            // latest non-empty assistant text for this turn wins
            const turnText = msg.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text as string)
              .join('');
            if (turnText) textRef.current = turnText;
            // upsert tool calls by id (survives across turns)
            for (const c of msg.content) {
              if (c.type === 'toolCall' && c.id) {
                if (!toolCallsRef.current.has(c.id)) toolOrderRef.current.push(c.id);
                toolCallsRef.current.set(c.id, { name: c.name ?? 'tool', args: c.arguments ?? {} });
              }
            }
          }
          refresh();
          break;
        }
        case 'tool_execution_end': {
          const e = event as { toolCallId: string; result?: { details?: unknown }; isError?: boolean };
          toolResultsRef.current.set(e.toolCallId, { result: e.result, isError: !!e.isError });
          const details = (e.result?.details ?? {}) as { sceneId?: string; title?: string };
          if (details.sceneId && typeof details.title === 'string') {
            useStageStore.getState().updateScene(details.sceneId, { title: details.title });
          }
          refresh();
          break;
        }
        default:
          break;
      }
    },
    [],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const userText = extractText(message);
      if (!userText) return;

      const turnId = `t-${Date.now()}`;
      const assistantId = `a-${turnId}`;
      toolCallsRef.current = new Map();
      toolOrderRef.current = [];
      toolResultsRef.current = new Map();
      textRef.current = '';
      errorRef.current = '';

      const userMsg: ThreadMessageLike = { role: 'user', id: `u-${turnId}`, content: [{ type: 'text', text: userText }] };
      setMessages((prev) => [...prev, userMsg, buildAssistant(assistantId)]);
      setIsRunning(true);

      const refresh = () =>
        setMessages((prev) => {
          const next = prev.slice();
          next[next.length - 1] = buildAssistant(assistantId);
          return next;
        });

      try {
        const res = await fetch('/api/agent/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: userText, scene: opts.scene }),
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
            handleEvent(event, assistantId, refresh);
          }
        }
      } catch (err) {
        errorRef.current = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
        setMessages((prev) => {
          const next = prev.slice();
          next[next.length - 1] = buildAssistant(assistantId);
          return next;
        });
      } finally {
        setIsRunning(false);
      }
    },
    [buildAssistant, handleEvent, opts.scene],
  );

  return useExternalStoreRuntime({
    messages,
    isRunning,
    onNew,
    // We store ThreadMessageLike directly; identity converter satisfies the
    // adapter's requirement when the store type isn't the internal ThreadMessage.
    convertMessage: (m) => m,
  });
}
