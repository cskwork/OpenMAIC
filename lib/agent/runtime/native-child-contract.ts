import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';

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

export type ServerToolExecutionStatus =
  | 'succeeded'
  | 'rejected'
  | 'execution_failed'
  | 'timeout'
  | 'cancelled';

export interface ToolExecutionSummary {
  request: ServerExecutionRequest;
  status: ServerToolExecutionStatus;
  isError: boolean;
  startedAt: number;
  completedAt: number;
  details?: unknown;
}

export type ChildRunStatus = 'completed' | 'exhausted' | 'cancelled' | 'failed';

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
  history?: AgentMessage[];
  abortSignal?: AbortSignal;
  now?: () => number;
  createExecutionId?: () => string;
}
