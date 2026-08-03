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
  type ClientEffectExecutionRequest,
  type ClientQueryExecutionRequest,
  type NativeClientEffectHandler,
  type NativeClientQueryHandler,
  type NativeChildToolBudgetUsage,
  type NativeToolCategory,
  type RuntimeAgentToolResult,
  type RunNativeChildOptions,
  type ServerExecutionRequest,
  type ServerToolExecutionStatus,
  type ToolExecutionSummary,
} from './native-child-contract';

type PendingExecution = {
  request: ServerExecutionRequest | ClientQueryExecutionRequest | ClientEffectExecutionRequest;
  startedAt: number;
};

const NATIVE_TOOL_CATEGORIES = new Set<NativeToolCategory>(['mutation', 'read', 'other']);

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

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`runNativeChild requires ${name} to be a non-negative integer`);
  }
}

function categoryLimit(
  category: NativeToolCategory,
  budgets: RunNativeChildOptions['toolBudgets'],
): number {
  switch (category) {
    case 'mutation':
      return budgets.maxMutationExecutions;
    case 'read':
      return budgets.maxReadExecutions;
    case 'other':
      return budgets.maxOtherToolExecutions;
  }
}

function categoryUsage(category: NativeToolCategory, usage: NativeChildToolBudgetUsage): number {
  switch (category) {
    case 'mutation':
      return usage.mutationExecutions;
    case 'read':
      return usage.readExecutions;
    case 'other':
      return usage.otherToolExecutions;
  }
}

function incrementCategoryUsage(
  category: NativeToolCategory,
  usage: NativeChildToolBudgetUsage,
): void {
  switch (category) {
    case 'mutation':
      usage.mutationExecutions += 1;
      return;
    case 'read':
      usage.readExecutions += 1;
      return;
    case 'other':
      usage.otherToolExecutions += 1;
  }
}

function aggregateUsage(usage: NativeChildToolBudgetUsage): number {
  return usage.mutationExecutions + usage.readExecutions + usage.otherToolExecutions;
}

/**
 * Run one native-tool-capable Child through Pi's production Agent loop.
 *
 * Server-side tools execute directly. Client-backed effects are delegated to a
 * request-scoped handler which settles only after the browser ACK lifecycle.
 */
export async function runNativeChild(opts: RunNativeChildOptions): Promise<ChildRunResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('runNativeChild requires a positive finite timeoutMs');
  }
  if (!Number.isInteger(opts.depth) || opts.depth < 0) {
    throw new Error('runNativeChild requires a non-negative integer depth');
  }
  requireNonNegativeInteger('maxMutationExecutions', opts.toolBudgets.maxMutationExecutions);
  requireNonNegativeInteger('maxReadExecutions', opts.toolBudgets.maxReadExecutions);
  requireNonNegativeInteger('maxOtherToolExecutions', opts.toolBudgets.maxOtherToolExecutions);
  if (
    !Number.isInteger(opts.toolBudgets.maxToolCallAttempts) ||
    opts.toolBudgets.maxToolCallAttempts <= 0
  ) {
    throw new Error('runNativeChild requires maxToolCallAttempts to be a positive integer');
  }
  if (opts.toolBudgets.maxAggregateToolExecutions !== undefined) {
    requireNonNegativeInteger(
      'maxAggregateToolExecutions',
      opts.toolBudgets.maxAggregateToolExecutions,
    );
  }

  const now = opts.now ?? Date.now;
  const createExecutionId = opts.createExecutionId ?? nanoid;
  const allowedToolNames = opts.allowedToolNames ?? new Set(opts.tools.map((tool) => tool.name));
  const registeredToolNames = new Set(opts.tools.map((tool) => tool.name));
  if (registeredToolNames.size !== opts.tools.length) {
    throw new Error('runNativeChild requires unique registered tool names');
  }
  for (const toolName of registeredToolNames) {
    const category = opts.toolCategories.get(toolName);
    if (!category) {
      throw new Error(`runNativeChild is missing a category for registered tool: ${toolName}`);
    }
    if (!NATIVE_TOOL_CATEGORIES.has(category)) {
      throw new Error(
        `runNativeChild received an invalid category for registered tool: ${toolName}`,
      );
    }
  }
  for (const toolName of opts.toolCategories.keys()) {
    if (!registeredToolNames.has(toolName)) {
      throw new Error(`runNativeChild received a category for an unregistered tool: ${toolName}`);
    }
  }
  const clientEffectHandlers =
    opts.clientEffectHandlers ?? new Map<string, NativeClientEffectHandler>();
  const clientQueryHandlers =
    opts.clientQueryHandlers ?? new Map<string, NativeClientQueryHandler>();
  for (const toolName of clientEffectHandlers.keys()) {
    if (!registeredToolNames.has(toolName)) {
      throw new Error(`Native Child client effect handler has no registered tool: ${toolName}`);
    }
    if (clientQueryHandlers.has(toolName)) {
      throw new Error(
        `Native Child tool cannot be both client query and client effect: ${toolName}`,
      );
    }
  }
  for (const toolName of clientQueryHandlers.keys()) {
    if (!registeredToolNames.has(toolName)) {
      throw new Error(`Native Child client query handler has no registered tool: ${toolName}`);
    }
  }
  const deadlineAt = now() + opts.timeoutMs;
  const pendingExecutions = new Map<string, PendingExecution>();
  const toolExecutions: ToolExecutionSummary[] = [];
  const toolSettlements = new Map<string, ServerToolExecutionStatus>();
  const startedToolExecutions = new Set<string>();
  let sequence = 0;
  const toolBudgetUsage: NativeChildToolBudgetUsage = {
    mutationExecutions: 0,
    readExecutions: 0,
    otherToolExecutions: 0,
    toolCallAttempts: 0,
  };
  let timedOut = false;
  let externallyCancelled = false;
  let exhaustedCategory: NativeToolCategory | undefined;
  let aggregateToolBudgetExhausted = false;
  let toolCallAttemptBudgetExhausted = false;
  let duplicateToolCallIdDetected = false;
  const seenToolCallIds = new Set<string>();
  const budgetRejectedToolCalls = new Set<string>();
  const attemptRejectedToolCalls = new Set<string>();
  const duplicateRejectedToolCalls = new Set<string>();
  const toolReportedErrors = new Set<string>();
  let assistantTurnSequence = 0;
  let visibleOutput = '';

  const boundedTools = opts.tools.map(
    (tool): AgentTool => ({
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        if (duplicateRejectedToolCalls.has(toolCallId)) {
          toolSettlements.set(toolCallId, 'rejected');
          return {
            content: [{ type: 'text', text: 'Duplicate Native Child tool-call ID rejected.' }],
            details: { code: 'DUPLICATE_TOOL_CALL_ID' },
            terminate: true,
          };
        }
        if (attemptRejectedToolCalls.has(toolCallId)) {
          toolSettlements.set(toolCallId, 'rejected');
          return {
            content: [
              {
                type: 'text',
                text: `Native Child tool-call attempt budget (${opts.toolBudgets.maxToolCallAttempts}) exhausted.`,
              },
            ],
            details: { code: 'TOOL_CALL_ATTEMPT_BUDGET_EXHAUSTED' },
            terminate: true,
          };
        }
        if (budgetRejectedToolCalls.has(toolCallId)) {
          toolSettlements.set(toolCallId, 'rejected');
          return {
            content: [
              {
                type: 'text',
                text: aggregateToolBudgetExhausted
                  ? 'Native Child aggregate tool execution budget exhausted.'
                  : `Native Child ${exhaustedCategory ?? 'categorized'} tool execution budget exhausted.`,
              },
            ],
            details: {
              code: aggregateToolBudgetExhausted
                ? 'AGGREGATE_TOOL_BUDGET_EXHAUSTED'
                : `${(exhaustedCategory ?? 'categorized').toUpperCase()}_TOOL_BUDGET_EXHAUSTED`,
            },
            terminate: true,
          };
        }
        startedToolExecutions.add(toolCallId);
        try {
          const pending = pendingExecutions.get(toolCallId);
          const clientEffectHandler = clientEffectHandlers.get(tool.name);
          const clientQueryHandler = clientQueryHandlers.get(tool.name);
          const result = await executeWithAbort(() => {
            if (clientQueryHandler) {
              if (!pending || pending.request.kind !== 'client_query') {
                throw new Error('Native Child client query is missing its execution envelope.');
              }
              return clientQueryHandler({
                request: pending.request,
                params,
                signal,
              });
            }
            if (clientEffectHandler) {
              if (!pending || pending.request.kind !== 'client_effect') {
                throw new Error('Native Child client effect is missing its execution envelope.');
              }
              return clientEffectHandler({
                request: pending.request,
                params,
                signal,
              });
            }
            return tool.execute(toolCallId, params, signal, onUpdate);
          }, signal);
          const runtimeResult = result as RuntimeAgentToolResult;
          const reportedError = runtimeResult.isError === true;
          if (reportedError) toolReportedErrors.add(toolCallId);
          toolSettlements.set(
            toolCallId,
            reportedError ? (runtimeResult.executionStatus ?? 'execution_failed') : 'succeeded',
          );
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
    if (duplicateToolCallIdDetected) {
      return stoppedStream('Duplicate Native Child tool-call ID rejected.');
    }
    if (aggregateToolBudgetExhausted) {
      return stoppedStream('Native Child aggregate tool execution budget exhausted.');
    }
    if (exhaustedCategory) {
      return stoppedStream(`Native Child ${exhaustedCategory} tool execution budget exhausted.`);
    }
    if (toolCallAttemptBudgetExhausted) {
      return stoppedStream(
        `Native Child tool-call attempt budget (${opts.toolBudgets.maxToolCallAttempts}) exhausted.`,
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
        !duplicateRejectedToolCalls.has(context.toolCall.id) &&
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

  const unsubscribe = child.subscribe(async (event: AgentEvent) => {
    if (event.type === 'turn_start') {
      assistantTurnSequence += 1;
      return;
    }
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta' &&
      opts.onVisibleTextDelta
    ) {
      const forwarded = await opts.onVisibleTextDelta({
        agentInvocationId: opts.agentInvocationId,
        assistantTurnSequence: Math.max(assistantTurnSequence, 1),
        delta: event.assistantMessageEvent.delta,
      });
      visibleOutput += forwarded;
      return;
    }
    if (event.type === 'tool_execution_start') {
      const issuedAt = now();
      sequence += 1;
      toolBudgetUsage.toolCallAttempts += 1;
      if (toolBudgetUsage.toolCallAttempts > opts.toolBudgets.maxToolCallAttempts) {
        toolCallAttemptBudgetExhausted = true;
        attemptRejectedToolCalls.add(event.toolCallId);
        child.abort();
        return;
      }
      if (seenToolCallIds.has(event.toolCallId)) {
        duplicateToolCallIdDetected = true;
        duplicateRejectedToolCalls.add(event.toolCallId);
        child.abort();
        return;
      }
      seenToolCallIds.add(event.toolCallId);
      const category = opts.toolCategories.get(event.toolName);
      if (category) {
        const aggregateLimit = opts.toolBudgets.maxAggregateToolExecutions;
        if (aggregateLimit !== undefined && aggregateUsage(toolBudgetUsage) >= aggregateLimit) {
          aggregateToolBudgetExhausted = true;
          budgetRejectedToolCalls.add(event.toolCallId);
        } else if (
          categoryUsage(category, toolBudgetUsage) >= categoryLimit(category, opts.toolBudgets)
        ) {
          exhaustedCategory = category;
          budgetRejectedToolCalls.add(event.toolCallId);
        } else {
          incrementCategoryUsage(category, toolBudgetUsage);
        }
      }
      if (budgetRejectedToolCalls.has(event.toolCallId)) child.abort();
      pendingExecutions.set(event.toolCallId, {
        request: {
          protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
          kind: clientQueryHandlers.has(event.toolName)
            ? 'client_query'
            : clientEffectHandlers.has(event.toolName)
              ? 'client_effect'
              : 'server',
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
    await opts.onSettled?.(opts.agentInvocationId);
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
  const forwardedVisibleOutput = visibleOutput || undefined;

  if (timedOut) {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'exhausted',
      visibleOutput: forwardedVisibleOutput,
      toolExecutions,
      toolBudgetUsage,
      stopReason: 'timeout',
      usage,
    };
  }
  if (externallyCancelled) {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'cancelled',
      visibleOutput: forwardedVisibleOutput,
      toolExecutions,
      toolBudgetUsage,
      stopReason: 'aborted',
      usage,
    };
  }
  if (
    toolCallAttemptBudgetExhausted ||
    duplicateToolCallIdDetected ||
    aggregateToolBudgetExhausted ||
    exhaustedCategory !== undefined ||
    finalAssistant?.stopReason === 'length'
  ) {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'exhausted',
      visibleOutput: forwardedVisibleOutput,
      toolExecutions,
      toolBudgetUsage,
      stopReason: toolCallAttemptBudgetExhausted
        ? 'tool_call_attempt_budget'
        : duplicateToolCallIdDetected
          ? 'duplicate_tool_call_id'
          : aggregateToolBudgetExhausted
            ? 'aggregate_tool_budget'
            : exhaustedCategory
              ? `${exhaustedCategory}_tool_budget`
              : 'output_token_limit',
      usage,
    };
  }
  if (finalAssistant?.stopReason === 'aborted') {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'cancelled',
      visibleOutput: forwardedVisibleOutput,
      toolExecutions,
      toolBudgetUsage,
      stopReason: 'aborted',
      usage,
    };
  }
  if (runError || finalAssistant?.stopReason === 'error') {
    return {
      agentInvocationId: opts.agentInvocationId,
      status: 'failed',
      finalOutput,
      visibleOutput: forwardedVisibleOutput,
      toolExecutions,
      toolBudgetUsage,
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
    visibleOutput: forwardedVisibleOutput,
    toolExecutions,
    toolBudgetUsage,
    stopReason: finalAssistant?.stopReason ?? 'stop',
    usage,
  };
}
