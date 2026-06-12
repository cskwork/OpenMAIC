'use client';

/**
 * MAIC Agent — editor AI sidebar (right rail), mainstream agent-GUI layout:
 * assistant output is full-width text (markdown) with slim inline tool rows in
 * chronological order; user messages are compact neutral bubbles; a typing
 * indicator shows while the run streams. Brand color is reserved for accents
 * (send button, focus ring, status). Drag-resizable from the left edge.
 * Wiring (ExternalStore over the pi AgentEvent SSE stream) lives in
 * use-agent-runtime.
 */
import { useCallback, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
} from '@assistant-ui/react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { useAgentRuntime } from '@/lib/agent/client/use-agent-runtime';
import { MarkdownText } from './markdown-text';
import { RegenerateSceneActionsUI } from './regenerate-tool-ui';

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 384;

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/40"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}

function AssistantMessage() {
  // Show typing dots while the run streams and nothing has arrived yet.
  const showDots = useMessage((m) => {
    const hasContent = m.content.some(
      (p) => (p.type === 'text' && p.text.length > 0) || p.type === 'tool-call',
    );
    return !hasContent && m.status?.type === 'running';
  });

  return (
    <MessagePrimitive.Root className="min-w-0">
      {showDots ? (
        <TypingDots />
      ) : (
        <div className="min-w-0 text-[13.5px] leading-relaxed text-foreground">
          <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

export function AgentPanel({ scene }: { scene?: { id: string; title: string } }) {
  const runtime = useAgentRuntime({ scene });

  // Drag-to-resize from the left edge (pointer capture, direct DOM write).
  const railRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragRef = useRef<{ startX: number; startW: number; lastW: number; pointerId: number } | null>(null);

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startW = railRef.current?.getBoundingClientRect().width ?? width;
      dragRef.current = { startX: e.clientX, startW, lastW: startW, pointerId: e.pointerId };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best effort */
      }
      document.body.style.cursor = 'col-resize';
    },
    [width],
  );
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, d.startW + (d.startX - e.clientX)));
    d.lastW = next;
    if (railRef.current) railRef.current.style.width = `${next}px`;
  }, []);
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
    setWidth(d.lastW);
    dragRef.current = null;
    document.body.style.cursor = '';
  }, []);

  return (
    <aside
      ref={railRef}
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background"
    >
      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="group absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-col-resize touch-none"
      >
        <div className="absolute left-0.5 top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-border" />
      </div>

      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border px-4 pl-5">
        <span className="size-1.5 rounded-full bg-primary" />
        <span className="text-[12px] font-medium tracking-[0.14em] text-foreground/80">MAIC Agent</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground/60">beta</span>
      </header>

      <AssistantRuntimeProvider runtime={runtime}>
        <RegenerateSceneActionsUI />

        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 space-y-6 overflow-y-auto px-4 py-5 scroll-smooth">
            <ThreadPrimitive.Empty>
              <div className="mx-auto mt-14 flex max-w-[260px] flex-col items-center text-center">
                <p className="text-sm font-medium text-foreground">有什么想改的？</p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                  让 Agent 编辑当前页面，或重新生成讲解旁白。
                </p>
                <ThreadPrimitive.Suggestion
                  prompt="重新生成这一页的讲解旁白，让它和页面内容保持一致"
                  autoSend
                  method="replace"
                  className="mt-5 w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-left text-[12px] leading-snug text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                >
                  重新生成这一页的讲解旁白
                </ThreadPrimitive.Suggestion>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>

          <ThreadPrimitive.ScrollToBottom className="absolute bottom-2 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-0">
            <ChevronDown className="size-4" />
          </ThreadPrimitive.ScrollToBottom>

          <div className="px-3 pb-3 pt-1">
            <ComposerPrimitive.Root className="relative rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
              <ComposerPrimitive.Input
                rows={1}
                autoFocus
                placeholder="描述对这一页的修改…"
                className="max-h-36 w-full resize-none bg-transparent py-3 pl-3.5 pr-11 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/60"
              />
              <ComposerPrimitive.Send className="absolute bottom-2 right-2 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30">
                <ArrowUp className="size-3.5" />
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </aside>
  );
}
