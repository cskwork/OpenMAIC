'use client';

/**
 * MAIC Agent — editor AI sidebar (right rail).
 *
 * Composes assistant-ui primitives into the chat: markdown-rendered assistant
 * replies (with a streaming lifecycle via message `status`), brand-accent user
 * bubbles, and a receipt-style tool-call card (see regenerate-tool-ui). Themed
 * on the project's shadcn tokens so it fits the editor chrome (light/dark).
 *
 * The rail is drag-resizable from its left edge, mirroring SlideNavRail: the
 * width is written directly to the DOM during the gesture (cursor-locked) and
 * committed to React state on pointer-up.
 */
import { useCallback, useRef, useState } from 'react';
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { ArrowUp, ChevronDown, Sparkles } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils/cn';
import { useAgentRuntime } from '@/lib/agent/client/use-agent-runtime';
import { MarkdownText } from './markdown-text';
import { RegenerateSceneActionsUI } from './regenerate-tool-ui';

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 384;

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground [overflow-wrap:anywhere]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const reduce = useReducedMotion();
  return (
    <MessagePrimitive.Root className="flex">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="min-w-0 flex-1 space-y-1.5"
      >
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </motion.div>
    </MessagePrimitive.Root>
  );
}

export function AgentPanel({ scene }: { scene?: { id: string; title: string } }) {
  const runtime = useAgentRuntime({ scene });

  // ── Drag-to-resize (left edge of the right rail) ──────────────────────────
  const railRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number; lastW: number; pointerId: number } | null>(null);

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startW = railRef.current?.getBoundingClientRect().width ?? width;
      dragRef.current = { startX: e.clientX, startW, lastW: startW, pointerId: e.pointerId };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture best-effort */
      }
      document.body.style.cursor = 'col-resize';
      setDragging(true);
    },
    [width],
  );

  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const delta = drag.startX - e.clientX; // drag the handle left → wider rail
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startW + delta));
    drag.lastW = next;
    if (railRef.current) railRef.current.style.width = `${next}px`;
  }, []);

  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
    setWidth(drag.lastW);
    dragRef.current = null;
    document.body.style.cursor = '';
    setDragging(false);
  }, []);

  return (
    <aside
      ref={railRef}
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background"
    >
      {/* resize handle — left edge, mirrors SlideNavRail */}
      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className={cn(
          'group absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-col-resize touch-none',
          'transition-colors hover:bg-primary/20',
          dragging && 'bg-primary/30',
        )}
      >
        <div className="absolute left-0 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-primary/60" />
      </div>

      <header className="flex items-center gap-2 border-b border-border px-4 py-3 pl-5">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">MAIC Agent</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">beta</span>
      </header>

      <AssistantRuntimeProvider runtime={runtime}>
        {/* registers the regenerate_scene_actions tool card with the runtime */}
        <RegenerateSceneActionsUI />

        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto px-4 py-4 scroll-smooth">
            <ThreadPrimitive.Empty>
              <div className="mx-auto mt-12 flex max-w-[280px] flex-col items-center text-center">
                <Sparkles className="size-6 text-primary/70" />
                <p className="mt-3 text-sm font-medium text-foreground">编辑当前场景</p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  让 Agent 把这一页的讲解旁白重新生成，与页面内容保持一致。
                </p>
                <ThreadPrimitive.Suggestion
                  prompt="重新生成这一页的讲解旁白，让它和页面内容保持一致"
                  autoSend
                  method="replace"
                  className="mt-4 w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-[12px] leading-snug text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
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

          <div className="border-t border-border p-3">
            <ComposerPrimitive.Root className="flex items-center gap-2 rounded-2xl border border-border bg-card pl-3.5 pr-1.5 transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
              <ComposerPrimitive.Input
                rows={1}
                autoFocus
                placeholder="让 Agent 编辑这一页…"
                className="max-h-32 min-h-[40px] min-w-0 flex-1 resize-none self-center bg-transparent py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
              />
              <ComposerPrimitive.Send className="grid size-8 shrink-0 place-items-center self-center rounded-xl bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30">
                <ArrowUp className="size-4" />
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </aside>
  );
}
