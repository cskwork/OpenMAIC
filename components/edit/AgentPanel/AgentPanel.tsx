'use client';

/**
 * MAIC Agent — editor AI sidebar (right rail).
 *
 * Composes assistant-ui primitives into a polished chat: markdown-rendered
 * assistant replies, brand-accent user bubbles, and a receipt-style tool-call
 * card (see regenerate-tool-ui). Themed on the project's shadcn tokens so it
 * fits the editor chrome (light/dark) and uses the OpenMAIC primary accent.
 * Wiring (ExternalStore over the pi AgentEvent SSE stream) is unchanged.
 */
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { ArrowUp, ChevronDown, Sparkles } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils/cn';
import { useAgentRuntime } from '@/lib/agent/client/use-agent-runtime';
import { MarkdownText } from './markdown-text';
import { RegenerateSceneActionsUI } from './regenerate-tool-ui';

function AgentGlyph({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15',
        className,
      )}
    >
      <Sparkles className="size-4" />
    </span>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground [overflow-wrap:anywhere]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const reduce = useReducedMotion();
  return (
    <MessagePrimitive.Root className="flex gap-2.5">
      <AgentGlyph className="mt-0.5 size-7" />
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="min-w-0 flex-1 space-y-1.5 pt-0.5"
      >
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </motion.div>
    </MessagePrimitive.Root>
  );
}

const SUGGESTIONS = [
  '重新生成这一页的讲解旁白，让它和页面内容保持一致',
  'Regenerate this slide’s narration to match its content',
];

export function AgentPanel({ scene }: { scene?: { id: string; title: string } }) {
  const runtime = useAgentRuntime({ scene });

  return (
    <aside className="flex h-full w-[360px] flex-col border-l border-border bg-background">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <AgentGlyph className="size-8" />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold leading-tight text-foreground">MAIC Agent</span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            edit assistant · beta
          </span>
        </div>
      </header>

      <AssistantRuntimeProvider runtime={runtime}>
        {/* registers the regenerate_scene_actions tool card with the runtime */}
        <RegenerateSceneActionsUI />

        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto px-3.5 py-4 scroll-smooth">
            <ThreadPrimitive.Empty>
              <div className="mx-auto mt-10 flex max-w-[260px] flex-col items-center text-center">
                <AgentGlyph className="size-11 [&_svg]:size-5" />
                <p className="mt-3 text-sm font-medium text-foreground">Edit this scene with AI</p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  Ask the agent to re-sync this slide’s narration with its content.
                </p>
                <div className="mt-4 flex w-full flex-col gap-1.5">
                  {SUGGESTIONS.map((prompt) => (
                    <ThreadPrimitive.Suggestion
                      key={prompt}
                      prompt={prompt}
                      autoSend
                      method="replace"
                      className="rounded-lg border border-border bg-card px-3 py-2 text-left text-[12px] leading-snug text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
                    >
                      {prompt}
                    </ThreadPrimitive.Suggestion>
                  ))}
                </div>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>

          <ThreadPrimitive.ScrollToBottom className="absolute bottom-2 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-0">
            <ChevronDown className="size-4" />
          </ThreadPrimitive.ScrollToBottom>

          <div className="border-t border-border p-3">
            <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
              <ComposerPrimitive.Input
                rows={1}
                autoFocus
                placeholder="Ask the agent to edit this scene…"
                className="max-h-32 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
              />
              <ComposerPrimitive.Send className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30">
                <ArrowUp className="size-4" />
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </aside>
  );
}
