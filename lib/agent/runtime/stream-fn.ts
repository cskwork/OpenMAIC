/**
 * MAIC Agent — pi StreamFn adapter (promoted from PoC).
 *
 * Bridges the pi agent loop's LLM call to OpenMAIC's existing AI-SDK-based
 * connector (`streamLLM`). pi's `StreamFn` is `(model, context, options) =>
 * AssistantMessageEventStream`; we ignore the pi-side `model` stub and route the
 * call through OpenMAIC's resolved Vercel `LanguageModel`, then map the AI SDK
 * `fullStream` parts back into pi's `AssistantMessageEvent` protocol.
 *
 * This is the core integration seam of option B (pi harness + project connector).
 * pi's loop drives multi-step + executes tools itself, so this only needs to turn
 * one LLM turn (assistant text + tool *calls*, not tool results) into pi events.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context as PiContext,
  Message as PiMessage,
  TextContent,
  ThinkingContent,
  Tool as PiTool,
  ToolCall,
  SimpleStreamOptions,
  StopReason,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  jsonSchema,
  stepCountIs,
  tool as aiTool,
  type LanguageModel,
  type FinishReason,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { streamLLM } from '@/lib/ai/llm';
import { normalizeUsage } from '@/lib/usage/normalize';
import type { ThinkingConfig } from '@/lib/types/provider';
import {
  captureToolCallMetadata,
  emitToolCallProviderOptions,
  type ToolCallProviderMetadata,
} from './provider-metadata';

/**
 * Local re-implementation of pi-ai's `AssistantMessageEventStream` queue. pi
 * exports the class as a *type* only (the `createAssistantMessageEventStream`
 * factory is not re-exported from the package root), so we build a structurally
 * identical event stream here and cast. Mirrors pi-ai utils/event-stream.ts.
 */
class LocalAssistantEventStream {
  private queue: AssistantMessageEvent[] = [];
  private waiting: ((r: IteratorResult<AssistantMessageEvent>) => void)[] = [];
  private done = false;
  private resolveFinal!: (m: AssistantMessage) => void;
  private finalPromise: Promise<AssistantMessage>;

  constructor() {
    this.finalPromise = new Promise((resolve) => {
      this.resolveFinal = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === 'done') {
      this.done = true;
      this.resolveFinal(event.message);
    } else if (event.type === 'error') {
      this.done = true;
      this.resolveFinal(event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const r = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) =>
          this.waiting.push(resolve),
        );
        if (r.done) return;
        yield r.value;
      }
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalPromise;
  }
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface CallLlmStreamFnOptions {
  /** Resolved Vercel AI SDK model instance (from resolveModelFromRequest). */
  languageModel: LanguageModel;
  maxOutputTokens?: number;
  thinkingConfig?: ThinkingConfig;
  source?: string;
  /** Optional abort signal forwarded to the underlying streamLLM call. */
  abortSignal?: AbortSignal;
}

/**
 * Map AI SDK v6 `fullStream` parts into pi `AssistantMessageEvent`s, threaded
 * onto a shared `partial` message. Stateful per turn (tracks the open text and
 * thinking content blocks). Extracted from `pump` so the part→event mapping —
 * especially the reasoning/thinking channel — is unit-testable without a live
 * `streamLLM` call.
 *
 * Reasoning parts (`reasoning-start`/`reasoning-delta`/`reasoning-end`, produced
 * by the provider layer's `extractReasoningMiddleware`) become pi
 * `thinking_*` events plus a `thinking` content block, kept separate from the
 * answer text so the UI can render a thinking panel and the body stays clean.
 */
export function createPartMapper(
  partial: AssistantMessage,
  push: (event: AssistantMessageEvent) => void,
) {
  // A single "active" content block (text or thinking). Switching delta type, a
  // tool call, an explicit reasoning-end, or finalize closes it — so interleaved
  // reasoning/text streams ("reason → answer → reason → answer") produce blocks
  // in arrival order instead of merging later text back into an earlier block.
  let active: { kind: 'text' | 'thinking'; index: number; buf: string } | null = null;

  const closeActive = () => {
    if (!active) return;
    if (active.kind === 'text') {
      push({ type: 'text_end', contentIndex: active.index, content: active.buf, partial });
    } else {
      push({ type: 'thinking_end', contentIndex: active.index, content: active.buf, partial });
    }
    active = null;
  };

  const handle = (part: Record<string, unknown>): void => {
    const type = part.type as string;
    if (type === 'text-delta' || type === 'text') {
      const delta = (part.text ?? part.delta ?? part.textDelta ?? '') as string;
      if (!delta) return;
      if (active?.kind !== 'text') {
        closeActive();
        const index = partial.content.length;
        partial.content.push({ type: 'text', text: '' } satisfies TextContent);
        active = { kind: 'text', index, buf: '' };
        push({ type: 'text_start', contentIndex: index, partial });
      }
      active.buf += delta;
      (partial.content[active.index] as TextContent).text = active.buf;
      push({ type: 'text_delta', contentIndex: active.index, delta, partial });
    } else if (type === 'reasoning-delta' || type === 'reasoning') {
      const delta = (part.text ?? part.delta ?? '') as string;
      if (!delta) return;
      if (active?.kind !== 'thinking') {
        closeActive();
        const index = partial.content.length;
        partial.content.push({ type: 'thinking', thinking: '' } as ThinkingContent);
        active = { kind: 'thinking', index, buf: '' };
        push({ type: 'thinking_start', contentIndex: index, partial });
      }
      active.buf += delta;
      (partial.content[active.index] as ThinkingContent).thinking = active.buf;
      push({ type: 'thinking_delta', contentIndex: active.index, delta, partial });
    } else if (type === 'reasoning-end') {
      if (active?.kind === 'thinking') closeActive();
    } else if (type === 'tool-call') {
      closeActive();
      const idx = partial.content.length;
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: (part.toolCallId ?? part.id) as string,
        name: (part.toolName ?? part.name) as string,
        arguments: (part.input ?? part.args ?? {}) as Record<string, unknown>,
      };
      // Capture provider-specific metadata (e.g. Gemini thought_signature) via
      // the typed seam so it can be re-emitted on the next turn.
      const meta = captureToolCallMetadata(part as never);
      if (meta)
        (toolCall as { providerMetadata?: ToolCallProviderMetadata }).providerMetadata = meta;
      partial.content.push(toolCall);
      push({ type: 'toolcall_start', contentIndex: idx, partial });
      push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial });
    } else if (type === 'error') {
      throw (part.error as Error) ?? new Error('LLM stream error');
    }
    // ignore other v6 parts (start/finish-step/source/...)
  };

  const finalize = (): void => {
    // Close whatever block is still open (the stream may omit a trailing end).
    closeActive();
  };

  return { handle, finalize };
}

/** Build a pi `StreamFn` that calls OpenMAIC's connector instead of pi-ai providers. */
export function createCallLlmStreamFn(opts: CallLlmStreamFnOptions): StreamFn {
  return ((_piModel, context: PiContext, streamOptions?: SimpleStreamOptions) => {
    const stream = new LocalAssistantEventStream();
    void pump(stream, context, opts, streamOptions);
    return stream as unknown as AssistantMessageEventStream;
  }) as StreamFn;
}

export function combineAbortSignals(
  requestSignal?: AbortSignal,
  agentSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!requestSignal) return agentSignal;
  if (!agentSignal || requestSignal === agentSignal) return requestSignal;
  return AbortSignal.any([requestSignal, agentSignal]);
}

function mapAiSdkFinishReason(opts: {
  finishReason?: FinishReason;
  hasToolCall: boolean;
  sawAbort: boolean;
}): StopReason {
  if (opts.sawAbort) return 'aborted';
  switch (opts.finishReason) {
    case 'length':
      return 'length';
    case 'tool-calls':
      return opts.hasToolCall ? 'toolUse' : 'error';
    case 'content-filter':
    case 'error':
    case 'other':
      return 'error';
    case 'stop':
    case undefined:
      // Some OpenAI-compatible providers emit a valid tool call with a generic
      // stop reason. Preserve that compatibility without allowing length/error
      // reasons to be overwritten by content inference.
      return opts.hasToolCall ? 'toolUse' : 'stop';
  }
}

function finishErrorMessage(reason: FinishReason | undefined): string {
  if (reason === 'tool-calls') {
    return 'LLM stream reported tool-calls without a parsed tool call.';
  }
  if (reason === 'content-filter') return 'LLM stream was blocked by the content filter.';
  if (reason === 'other') return 'LLM stream ended with an unrecognized finish reason.';
  return 'LLM stream reported an error finish reason.';
}

async function pump(
  stream: LocalAssistantEventStream,
  context: PiContext,
  opts: CallLlmStreamFnOptions,
  streamOptions?: SimpleStreamOptions,
): Promise<void> {
  const combinedAbortSignal = combineAbortSignals(opts.abortSignal, streamOptions?.signal);
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'unknown' as AssistantMessage['api'],
    provider: 'unknown' as AssistantMessage['provider'],
    model: 'maic-connector',
    usage: { ...EMPTY_USAGE },
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  try {
    const requestedMaxTokens = streamOptions?.maxTokens;
    const maxOutputTokens =
      opts.maxOutputTokens && requestedMaxTokens
        ? Math.min(opts.maxOutputTokens, requestedMaxTokens)
        : (requestedMaxTokens ?? opts.maxOutputTokens);
    const result = streamLLM(
      {
        model: opts.languageModel,
        system: context.systemPrompt,
        messages: toModelMessages(context.messages, {
          includeReasoning:
            typeof opts.languageModel !== 'string' &&
            opts.languageModel.provider === 'kimi.chat' &&
            opts.languageModel.modelId === 'kimi-k3',
        }),
        tools: toAiTools(context.tools ?? []),
        toolChoice: 'auto',
        // pi's loop owns multi-step; one LLM turn per streamFn call.
        stopWhen: stepCountIs(1),
        maxOutputTokens,
        // The request signal handles client/runtime cancellation, while Pi's
        // per-run signal handles Agent.abort() (for example the Director
        // tool-attempt hard cap). Neither cancellation source may mask the other.
        abortSignal: combinedAbortSignal,
      },
      opts.source ?? 'maic-agent',
      opts.thinkingConfig,
    );

    stream.push({ type: 'start', partial });

    const mapper = createPartMapper(partial, (event) => stream.push(event));
    let finishReason: FinishReason | undefined;
    let sawAbort = false;
    let abortReason: string | undefined;
    for await (const part of result.fullStream as AsyncIterable<Record<string, unknown>>) {
      if (part.type === 'finish') finishReason = part.finishReason as FinishReason | undefined;
      if (part.type === 'abort') {
        sawAbort = true;
        abortReason = typeof part.reason === 'string' ? part.reason : undefined;
      }
      mapper.handle(part);
    }
    mapper.finalize();

    if (sawAbort) {
      partial.stopReason = 'aborted';
      partial.errorMessage = abortReason ?? 'LLM stream was aborted.';
      stream.push({ type: 'error', reason: 'aborted', error: partial });
      return;
    }

    const usage = normalizeUsage(await result.usage);
    // AI SDK inputTokens includes cached input. Pi stores cached classes
    // separately, so subtract them before calculating its total.
    const uncachedInput = Math.max(
      0,
      usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens,
    );
    partial.usage = {
      input: uncachedInput,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheCreationTokens,
      totalTokens:
        uncachedInput + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const hasToolCall = partial.content.some((c) => (c as ToolCall).type === 'toolCall');
    const stopReason = mapAiSdkFinishReason({ finishReason, hasToolCall, sawAbort });
    partial.stopReason = stopReason;
    if (stopReason === 'error' || stopReason === 'aborted') {
      partial.errorMessage =
        stopReason === 'aborted' ? 'LLM stream was aborted.' : finishErrorMessage(finishReason);
      stream.push({ type: 'error', reason: stopReason, error: partial });
      return;
    }
    stream.push({ type: 'done', reason: stopReason, message: partial });
  } catch (err) {
    const aborted = combinedAbortSignal?.aborted === true;
    partial.stopReason = aborted ? 'aborted' : 'error';
    partial.errorMessage = err instanceof Error ? err.message : String(err);
    stream.push({
      type: 'error',
      reason: aborted ? 'aborted' : 'error',
      error: partial,
    });
  }
}

/** pi Message[] -> AI SDK ModelMessage[]. */
export function toModelMessages(
  messages: PiMessage[],
  options: { includeReasoning?: boolean } = {},
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((c) => (c.type === 'text' ? c.text : ''))
              .filter(Boolean)
              .join('\n');
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      for (const c of m.content) {
        if (c.type === 'text') parts.push({ type: 'text', text: c.text });
        else if (c.type === 'thinking' && options.includeReasoning) {
          parts.push({ type: 'reasoning', text: c.thinking });
        } else if (c.type === 'toolCall') {
          const part: Record<string, unknown> = {
            type: 'tool-call',
            toolCallId: c.id,
            toolName: c.name,
            input: c.arguments,
          };
          const meta = emitToolCallProviderOptions(
            (c as { providerMetadata?: ToolCallProviderMetadata }).providerMetadata,
          );
          if (meta) part.providerOptions = meta;
          parts.push(part);
        }
      }
      out.push({ role: 'assistant', content: parts } as unknown as ModelMessage);
    } else if (m.role === 'toolResult') {
      const text = m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            output: m.isError ? { type: 'error-text', value: text } : { type: 'text', value: text },
          },
        ],
      } as unknown as ModelMessage);
    }
  }
  return out;
}

/**
 * pi tools -> AI SDK ToolSet WITHOUT execute, so the model only *emits* tool
 * calls; pi's loop executes them. typebox schemas are JSON Schema, passed via
 * `jsonSchema()`.
 */
function toAiTools(tools: PiTool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = aiTool({
      description: t.description,
      inputSchema: jsonSchema((t as unknown as { parameters: object }).parameters),
    });
  }
  return set;
}
