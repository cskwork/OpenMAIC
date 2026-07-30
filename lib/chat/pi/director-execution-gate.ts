import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';

export type DirectorExecutionBlockCode =
  | 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED'
  | 'TERMINAL_ALREADY_REACHED';

export interface DirectorExecutionBlock {
  code: DirectorExecutionBlockCode;
  reason: string;
}

export interface DirectorToolExecutionGate {
  reserveAttempt(toolCallId: string): DirectorExecutionBlock | undefined;
  beforeExecute(toolCallId: string): DirectorExecutionBlock | undefined;
  finishAttempt(toolCallId: string): void;
  getAttemptCount(): number;
}

export function createDirectorToolExecutionGate(opts: {
  maxToolCalls: number;
  isTerminalReached: () => boolean;
}): DirectorToolExecutionGate {
  if (!Number.isInteger(opts.maxToolCalls) || opts.maxToolCalls <= 0) {
    throw new Error('Director tool execution requires a positive integer maxToolCalls');
  }

  let attemptCount = 0;
  const reservations = new Map<string, { blocked?: DirectorExecutionBlock }>();

  const reserveAttempt = (toolCallId: string): DirectorExecutionBlock | undefined => {
    attemptCount += 1;
    let blocked: DirectorExecutionBlock | undefined;
    if (opts.isTerminalReached()) {
      blocked = {
        code: 'TERMINAL_ALREADY_REACHED',
        reason: 'A terminal transition has already been reached for this Director request.',
      };
    } else if (attemptCount > opts.maxToolCalls) {
      blocked = {
        code: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
        reason: `Director tool-call budget (${opts.maxToolCalls}) exhausted.`,
      };
    }
    reservations.set(toolCallId, blocked ? { blocked } : {});
    return blocked;
  };

  return {
    reserveAttempt,
    beforeExecute(toolCallId) {
      if (!reservations.has(toolCallId)) {
        reserveAttempt(toolCallId);
      }
      const reservation = reservations.get(toolCallId);
      reservations.delete(toolCallId);
      return reservation?.blocked;
    },
    finishAttempt(toolCallId) {
      reservations.delete(toolCallId);
    },
    getAttemptCount() {
      return attemptCount;
    },
  };
}

export function guardDirectorToolsWithExecutionGate(
  tools: AgentTool[],
  gate: DirectorToolExecutionGate,
): AgentTool[] {
  return tools.map(
    (tool): AgentTool => ({
      ...tool,
      execute: async (toolCallId, args, signal, onUpdate) => {
        const blocked = gate.beforeExecute(toolCallId);
        if (blocked) {
          return {
            content: [{ type: 'text', text: `${blocked.code}: ${blocked.reason}` }],
            details: {
              skipped: true,
              reason: blocked.code,
              directorExecutionGuard: true,
            },
            terminate: true,
          };
        }
        return tool.execute(toolCallId, args, signal, onUpdate);
      },
    }),
  );
}

export function attachDirectorToolExecutionGate(
  director: Pick<Agent, 'subscribe' | 'abort'>,
  gate: DirectorToolExecutionGate,
): () => void {
  return director.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      const blocked = gate.reserveAttempt(event.toolCallId);
      if (blocked) director.abort();
      return;
    }
    if (event.type === 'tool_execution_end') {
      gate.finishAttempt(event.toolCallId);
    }
  });
}
