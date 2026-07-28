import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';

export const TOOL_EXECUTION_PROTOCOL_VERSION = 'maic.tool-execution.v1';

export type ExecutionKind = 'server' | 'client_effect' | 'server_proposal_client_commit';

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

export type NativeClientEffectHandler = (opts: {
  request: ClientEffectExecutionRequest;
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
  request: ServerExecutionRequest | ClientEffectExecutionRequest;
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
  maxToolExecutions: number;
  maxToolCallAttempts: number;
  allowedToolNames?: ReadonlySet<string>;
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
}
