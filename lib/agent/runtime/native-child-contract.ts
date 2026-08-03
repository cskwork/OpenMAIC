import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';

export const TOOL_EXECUTION_PROTOCOL_VERSION = 'maic.tool-execution.v1';

export type ExecutionKind =
  | 'server'
  | 'client_query'
  | 'client_effect'
  | 'server_proposal_client_commit';

export type NativeToolCategory = 'mutation' | 'read' | 'other';

export interface NativeChildToolBudgets {
  maxMutationExecutions: number;
  maxReadExecutions: number;
  maxOtherToolExecutions: number;
  maxToolCallAttempts: number;
  /** Temporary compatibility cap retained until the atomic public inventory cutover. */
  maxAggregateToolExecutions?: number;
}

export interface NativeChildToolBudgetUsage {
  mutationExecutions: number;
  readExecutions: number;
  otherToolExecutions: number;
  toolCallAttempts: number;
}

export interface ToolExecutionEnvelope {
  protocolVersion: typeof TOOL_EXECUTION_PROTOCOL_VERSION;
  kind: ExecutionKind;
  traceId: string;
  runId: string;
  agentInvocationId: string;
  agentId: string;
  depth: number;
  sequence: number;
  toolCallId: string;
  executionId: string;
  idempotencyKey: string;
  toolName: string;
  args: unknown;
  argsDigest: string;
  issuedAt: number;
  deadlineAt: number;
  attempt: number;
}

export interface ServerExecutionRequest extends ToolExecutionEnvelope {
  kind: 'server';
}

export interface ClientEffectExecutionRequest extends ToolExecutionEnvelope {
  kind: 'client_effect';
}

export interface ClientQueryExecutionRequest extends ToolExecutionEnvelope {
  kind: 'client_query';
}

export type NativeClientEffectHandler = (opts: {
  request: ClientEffectExecutionRequest;
  params: unknown;
  signal?: AbortSignal;
}) => Promise<RuntimeAgentToolResult>;

export type NativeClientQueryHandler = (opts: {
  request: ClientQueryExecutionRequest;
  params: unknown;
  signal?: AbortSignal;
}) => Promise<RuntimeAgentToolResult>;

export type ServerToolExecutionStatus =
  | 'succeeded'
  | 'rejected'
  | 'execution_failed'
  | 'timeout'
  | 'cancelled';

export interface ToolExecutionSummary {
  request: ServerExecutionRequest | ClientQueryExecutionRequest | ClientEffectExecutionRequest;
  status: ServerToolExecutionStatus;
  isError: boolean;
  startedAt: number;
  completedAt: number;
  details?: unknown;
}

export type ChildRunStatus = 'completed' | 'exhausted' | 'cancelled' | 'failed';

/**
 * OpenMAIC server tools may return structured failure details without throwing
 * so the same Agent can inspect the limitation and continue. Pi's upstream
 * AgentToolResult does not currently model that marker, so producer and Runtime
 * share this explicit extension instead of relying on unrelated duck typing.
 */
export type RuntimeAgentToolResult<TDetails = unknown> = AgentToolResult<TDetails> & {
  isError: boolean;
  /**
   * Runtime-authoritative settlement for a tool that returned a structured
   * error instead of throwing. This keeps timeout/cancellation trace semantics
   * distinct from an ordinary execution failure.
   */
  executionStatus?: Extract<
    ServerToolExecutionStatus,
    'execution_failed' | 'timeout' | 'cancelled'
  >;
};

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface ChildRunResult {
  agentInvocationId: string;
  status: ChildRunStatus;
  finalOutput?: string;
  /** Exact visible deltas forwarded to the classroom bubble across Pi turns. */
  visibleOutput?: string;
  toolExecutions: ToolExecutionSummary[];
  toolBudgetUsage: NativeChildToolBudgetUsage;
  stopReason: string;
  usage?: AgentUsage;
}

export interface RunNativeChildOptions {
  traceId: string;
  runId: string;
  agentInvocationId: string;
  agentId: string;
  depth: number;
  streamFn: StreamFn;
  systemPrompt: string;
  prompt: string;
  tools: AgentTool[];
  timeoutMs: number;
  toolBudgets: NativeChildToolBudgets;
  toolCategories: ReadonlyMap<string, NativeToolCategory>;
  allowedToolNames?: ReadonlySet<string>;
  clientQueryHandlers?: ReadonlyMap<string, NativeClientQueryHandler>;
  clientEffectHandlers?: ReadonlyMap<string, NativeClientEffectHandler>;
  onVisibleTextDelta?: (event: {
    agentInvocationId: string;
    assistantTurnSequence: number;
    delta: string;
  }) => string | Promise<string>;
  history?: AgentMessage[];
  abortSignal?: AbortSignal;
  now?: () => number;
  createExecutionId?: () => string;
  onSettled?: (agentInvocationId: string) => void | Promise<void>;
}
