'use client';

/**
 * MAIC Agent PoC — editor AI sidebar.
 *
 * Mounted in the StageGrid `rightSlot`. Renders an assistant-ui thread driven by
 * the pi AgentEvent stream (see use-agent-runtime). Headless primitives, styled
 * minimally with Tailwind so it sits inside the editor chrome.
 */
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { useAgentRuntime } from '@/lib/agent/poc/client/use-agent-runtime';

function TextPart({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>;
}

function ToolFallback(props: { toolName: string; args: unknown; result?: unknown; isError?: boolean }) {
  return (
    <div className="my-1 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 font-mono text-xs text-violet-900">
      <div className="font-semibold">🔧 {props.toolName}</div>
      <div className="mt-0.5 text-violet-700">{JSON.stringify(props.args)}</div>
      {props.result !== undefined ? (
        <div className={`mt-1 ${props.isError ? 'text-red-600' : 'text-emerald-700'}`}>
          {props.isError ? '✗' : '✓'} {JSON.stringify((props.result as { details?: unknown })?.details ?? props.result)}
        </div>
      ) : null}
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="my-1 max-w-[85%] rounded-2xl bg-zinc-900 px-3 py-2 text-sm text-white">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="my-1 max-w-[90%] rounded-2xl bg-zinc-100 px-3 py-2 text-zinc-900">
        <MessagePrimitive.Parts
          components={{
            Text: TextPart,
            tools: { Fallback: ToolFallback as never },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

export function AgentPanel({ scene }: { scene?: { id: string; title: string } }) {
  const runtime = useAgentRuntime({ scene });

  return (
    <aside className="flex h-full w-[340px] flex-col border-l border-zinc-200 bg-white">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2.5">
        <span className="text-sm font-semibold text-zinc-800">MAIC Agent</span>
        <span className="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[10px] text-violet-700">PoC</span>
      </header>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-3 py-3">
            <ThreadPrimitive.Empty>
              <p className="mt-8 text-center text-xs text-zinc-400">
                Try: &ldquo;rename this slide to Introduction&rdquo;
              </p>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="flex items-end gap-2 border-t border-zinc-200 p-2">
            <ComposerPrimitive.Input
              rows={1}
              placeholder="Ask the agent to edit this slide…"
              className="flex-1 resize-none rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
            <ComposerPrimitive.Send className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-40">
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </aside>
  );
}
