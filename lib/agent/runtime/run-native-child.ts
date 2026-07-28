import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import { buildAgent } from './build-agent';
import {
  TOOL_EXECUTION_PROTOCOL_VERSION,
  type AgentUsage,
  type ChildRunResult,
  type RuntimeAgentToolResult,
  type RunNativeChildOptions,
  type ServerExecutionRequest,
  type ServerToolExecutionStatus,
  type ToolExecutionSummary,
} from './native-child-contract';

type PendingExecution = {
  request: ServerExecutionRequest;
  startedAt: number;
};

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

async function executeWithAbort<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return execute();

  // This bounds the Runtime's settlement even when a tool ignores AbortSignal.
  // It cannot forcibly stop arbitrary JavaScript that keeps running, so effectful
  // server tools must still honor the signal; any late resolve/reject is observed
  // by the attached handlers below but cannot change the settled Pi tool result.
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let operation: Promise<T>;
    try {
      operation = execute();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function terminalStreamEvent(
  reason: string,
  stopReason: 'aborted' | 'error',
): Extract<AssistantMessageEvent, { type: 'error' }> {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'unknown',
    provider: 'unknown',
    model: 'maic-native-child-runtime',
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage: reason,
    timestamp: Date.now(),
  };
  return { type: 'error', reason: stopReason, error: message };
}

function stoppedStream(reason: string): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push(terminalStreamEvent(reason, 'error')));
  return stream;
}

function abortAwareStream(
  streamFn: StreamFn,
  args: Parameters<StreamFn>,
): ReturnType<typeof createAssistantMessageEventStream> {
  const proxy = createAssistantMessageEventStream();
  const signal = args[2]?.signal;
  let settled = false;

  const settle = (event: Extract<AssistantMessageEvent, { type: 'done' | 'error' }>) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    proxy.push(event);
  };
  const onAbort = () => settle(terminalStreamEvent('Native Child transport aborted.', 'aborted'));

  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
    return proxy;
  }

  // Pi awaits both the StreamFn promise and its event stream without racing the
  // run signal. Proxying here gives the Runtime a hard settlement boundary. A
  // non-cooperative transport may keep running, but late resolution, rejection,
  // or events are observed by this task and cannot mutate the settled proxy.
  void Promise.resolve()
    .then(() => {
      if (settled) return undefined;
      return streamFn(...args);
    })
    .then(async (source) => {
      if (!source || settled) return;
      try {
        for await (const event of source) {
          if (settled) return;
          if (event.type === 'done' || event.type === 'error') {
            settle(event);
            return;
          }
          proxy.push(event);
        }
        settle(
          terminalStreamEvent('Native Child transport ended without a terminal event.', 'error'),
        );
      } catch (error) {
        settle(
          terminalStreamEvent(
            error instanceof Error ? error.message : 'Native Child transport failed.',
            'error',
          ),
        );
      }
    })
    .catch((error: unknown) => {
      settle(
        terminalStreamEvent(
          error instanceof Error ? error.message : 'Native Child transport failed.',
          'error',
        ),
      );
    });

  return proxy;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function digestToolArguments(args: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(args));
  return `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`;
}

function lastAssistantMessage(messages: AgentMessage[]) {
  return messages.findLast(
    (message): message is Extract<AgentMessage, { role: 'assistant' }> =>
      message.role === 'assistant',
  );
}

function assistantText(messages: AgentMessage[]): string | undefined {
  const message = lastAssistantMessage(messages);
  if (!message) return undefined;
  const text = message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  return text || undefined;
}

function collectUsage(messages: AgentMessage[]): AgentUsage | undefined {
  const usage = messages.reduce<AgentUsage>(
    (total, message) => {
      if (message.role !== 'assistant') return total;
      total.inputTokens += message.usage.input;
      total.outputTokens += message.usage.output;
      total.cacheReadTokens += message.usage.cacheRead;
      total.cacheWriteTokens += message.usage.cacheWrite;
      total.totalTokens += message.usage.totalTokens;
      return total;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
  );
  return usage.totalTokens > 0 ? usage : undefined;
}

function resultDetails(result: AgentToolResult<unknown>): unknown {
  return result.details;
}

/**
 * Run one native-tool-capable Child through Pi's production Agent loop.
 *
 * This seam intentionally handles only server-side tools. Client-backed effects
 * require the ACK/commit lifecycle introduced in Phase 2.
 */
export async function runNativeChild(opts: RunNativeChildOptions): Promise<ChildRunResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('runNativeChild requires a positive finite timeoutMs');
  }
  if (!Number.isInteger(opts.depth) || opts.depth < 0) {
    throw new Error('runNativeChild requires a non-negative integer depth');
  }
  if (!Number.isInteger(opts.maxToolExecutions) || opts.maxToolExecutions <= 0) {
    throw new Error('runNativeChild requires a positive integer maxToolExecutions');
  }
  if (!Number.isInteger(opts.maxToolCallAttempts) || opts.maxToolCallAttempts <= 0) {
    throw new Error('runNativeChild requires a positive integer maxToolCallAttempts');
  }
  if (opts.maxToolCallAttempts < opts.maxToolExecutions) {
    throw new Error('maxToolCallAttempts must be greater than or equal to maxToolExecutions');
  }

  const now = opts.now ?? Date.now;
  const createExecutionId = opts.createExecutionId ?? nanoid;
  const allowedToolNames = opts.allowedToolNames ?? new Set(opts.tools.map((tool) => tool.name));
  const registeredToolNames = new Set(opts.tools.map((tool) => tool.name));
  const deadlineAt = now() + opts.timeoutMs;
  const pendingExecutions = new Map<string, PendingExecution>();
  const toolExecutions: ToolExecutionSummary[] = [];
  const toolSettlements = new Map<string, ServerToolExecutionStatus>();
  const startedToolExecutions = new Set<string>();
  let sequence = 0;
  let toolCallAttempts = 0;
  let executedToolCount = 0;
  let timedOut = false;
  let externallyCancelled = false;
  let toolBudgetExhausted = false;
  let toolCallAttemptBudgetExhausted = false;
  const budgetRejectedToolCalls = new Set<string>();
  const attemptRejectedToolCalls = new Set<string>();
  const toolReportedErrors = new Set<string>();

  const boundedTools = opts.tools.map(
    (tool): AgentTool => ({
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        if (attemptRejectedToolCalls.has(toolCallId)) {
          toolSettlements.set(toolCallId, 'rejected');
          return {
            content: [
              {
                type: 'text',
                text: `Native Child tool-call attempt budget (${opts.maxToolCallAttempts}) exhausted.`,
              },
            ],
            details: { code: 'TOOL_CALL_ATTEMPT_BUDGET_EXHAUSTED' },
            terminate: true,
          };
        }
        if (executedToolCount >= opts.maxToolExecutions) {
          toolBudgetExhausted = true;
          budgetRejectedToolCalls.add(toolCallId);
          toolSettlements.set(toolCallId, 'rejected');
          return {
            content: [
              {
                type: 'text',
                text: `Native Child tool execution budget (${opts.maxToolExecutions}) exhausted.`,
              },
            ],
            details: { code: 'TOOL_EXECUTION_BUDGET_EXHAUSTED' },
            terminate: true,
          };
        }
        executedToolCount += 1;
        startedToolExecutions.add(toolCallId);
        try {
          const result = await executeWithAbort(
            () => tool.execute(toolCallId, params, signal, onUpdate),
            signal,
          );
          const reportedError = (result as RuntimeAgentToolResult).isError === true;
          if (reportedError) toolReportedErrors.add(toolCallId);
          toolSettlements.set(toolCallId, reportedError ? 'execution_failed' : 'succeeded');
          return result;
        } catch (error) {
          toolSettlements.set(
            toolCallId,
            timedOut ? 'timeout' : externallyCancelled ? 'cancelled' : 'execution_failed',
          );
          throw error;
        }
      },
    }),
  );

  const boundedStreamFn: StreamFn = (...args) => {
    if (toolBudgetExhausted) {
      return stoppedStream(
        `Native Child tool execution budget (${opts.maxToolExecutions}) exhausted.`,
      );
    }
    if (toolCallAttemptBudgetExhausted) {
      return stoppedStream(
        `Native Child tool-call attempt budget (${opts.maxToolCallAttempts}) exhausted.`,
      );
    }
    return abortAwareStream(opts.streamFn, args);
  };

  const child = buildAgent({
    streamFn: boundedStreamFn,
    systemPrompt: opts.systemPrompt,
    tools: boundedTools,
    allowedToolNames,
    history: opts.history,
    afterToolCall: (context) => {
      if (
        !budgetRejectedToolCalls.has(context.toolCall.id) &&
        !attemptRejectedToolCalls.has(context.toolCall.id) &&
        !toolReportedErrors.has(context.toolCall.id)
      ) {
        return undefined;
      }
      return {
        isError: true,
        ...(!toolReportedErrors.has(context.toolCall.id) ? { terminate: true } : {}),
      };
    },
  });

  const statusFor = (
    toolCallId: string,
    toolName: string,
    isError: boolean,
  ): ServerToolExecutionStatus => {
    const settledStatus = toolSettlements.get(toolCallId);
    if (settledStatus) return settledStatus;
    if (attemptRejectedToolCalls.has(toolCallId)) return 'rejected';
    if (budgetRejectedToolCalls.has(toolCallId)) return 'rejected';
    if (!registeredToolNames.has(toolName) || !allowedToolNames.has(toolName)) return 'rejected';
    if (!startedToolExecutions.has(toolCallId)) return 'rejected';
    return isError ? 'execution_failed' : 'succeeded';
  };

  const unsubscribe = child.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      const issuedAt = now();
      sequence += 1;
      toolCallAttempts += 1;
      if (toolCallAttempts > opts.maxToolCallAttempts) {
        toolCallAttemptBudgetExhausted = true;
        attemptRejectedToolCalls.add(event.toolCallId);
      }
      pendingExecutions.set(event.toolCallId, {
        request: {
          protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
          kind: 'server',
          traceId: opts.traceId,
          runId: opts.runId,
          agentInvocationId: opts.agentInvocationId,
          agentId: opts.agentId,
          depth: opts.depth,
          sequence,
          toolCallId: event.toolCallId,
          executionId: createExecutionId(),
          idempotencyKey: `${opts.runId}:${opts.agentInvocationId}:${event.toolCallId}`,
          toolName: event.toolName,
          args: event.args,
          argsDigest: digestToolArguments(event.args),
          issuedAt,
          deadlineAt,
          attempt: 1,
        },
        startedAt: issuedAt,
      });
      return;
    }

    if (event.type !== 'tool_execution_end') return;
    const pending = pendingExecutions.get(event.toolCallId);
    if (!pending) return;
    pendingExecutions.delete(event.toolCallId);
    const status = statusFor(event.toolCallId, event.toolName, event.isError);
    toolExecutions.push({
      request: pending.request,
      status,
      isError: status !== 'succeeded',
      startedAt: pending.startedAt,
      completedAt: now(),
      details: resultDetails(event.result),
    });
  });

  const abortChild = () => {
    externallyCancelled = true;
    child.abort();
  };
  if (opts.abortSignal?.aborted) {
    externallyCancelled = true;
  } else {
    opts.abortSignal?.addEventListener('abort', abortChild, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    child.abort();
  }, opts.timeoutMs);

  let runError: unknown;
  try {
    if (!externallyCancelled) {
      await child.prompt(opts.prompt);
      await child.waitForIdle();
    }
  } catch (error) {
    runError = error;
  } finally {
    clearTimeout(timeout);
    opts.abortSignal?.removeEventListener('abort', abortChild);
    unsubscribe();
  }

  const terminalToolStatus: ServerToolExecutionStatus = timedOut
    ? 'timeout'
    : externallyCancelled
      ? 'cancelled'
      : 'execution_failed';
  for (const pending of pendingExecutions.values()) {
    toolExecutions.push({
      request: pending.request,
      status: terminalToolStatus,
      isError: true,
      startedAt: pending.startedAt,
      completedAt: now(),
    });
  }
  pendingExecutions.clear();

  const messages = child.state.messages;
  const finalAssistant = lastAssistantMessage(messages);
  const finalOutput = assistantText(messages);
  const usage = collectUsage(messages);

  if (timedOut) {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'exhausted',
      toolExecutions,
      stopReason: 'timeout',
      usage,
    };
  }
  if (externallyCancelled) {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'cancelled',
      toolExecutions,
      stopReason: 'aborted',
      usage,
    };
  }
  if (
    toolCallAttemptBudgetExhausted ||
    toolBudgetExhausted ||
    finalAssistant?.stopReason === 'length'
  ) {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'exhausted',
      toolExecutions,
      stopReason: toolCallAttemptBudgetExhausted
        ? 'tool_call_attempt_budget'
        : toolBudgetExhausted
          ? 'tool_execution_budget'
          : 'output_token_limit',
      usage,
    };
  }
  if (finalAssistant?.stopReason === 'aborted') {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'cancelled',
      toolExecutions,
      stopReason: 'aborted',
      usage,
    };
  }
  if (runError || finalAssistant?.stopReason === 'error') {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'failed',
      finalOutput,
      toolExecutions,
      stopReason:
        finalAssistant?.errorMessage ??
        (runError instanceof Error ? runError.message : 'child_run_failed'),
      usage,
    };
  }

  return {
    agentInvocationId: opts.agentInvocationId,
    status: 'completed',
    finalOutput,
    toolExecutions,
    stopReason: finalAssistant?.stopReason ?? 'stop',
    usage,
  };
}
