import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';

export type CueUserReason =
  | 'explicit_user_turn'
  | 'clarification_required'
  | 'task_complete_followup';

export interface InclassRequestedOutcome {
  id: string;
  agentId: string;
  description?: string;
}

export interface InclassTaskContractSeed {
  requestedOutcomes: InclassRequestedOutcome[];
  missingInformation?: string[];
  explicitUserTurnRequested?: boolean;
  explicitEndRequested?: boolean;
}

export interface TrustedChildResultEvent {
  source: 'runtime_child_result';
  agentInvocationId: string;
  agentId: string;
  outcomeId?: string;
  status: 'completed' | 'empty' | 'failed';
  /** Mechanical signal only: the child produced visible text or an action. */
  substantive: boolean;
}

export interface TerminalRuntimeContext {
  hasTeachingSubstantiveTurn: boolean;
  hasVisibleAgentTurn: boolean;
  hasAgentContent: boolean;
  userCued: boolean;
  sessionClosed: boolean;
}

export type TerminalRequest =
  | {
      kind: 'cue_user';
      source: 'director_tool' | 'runtime_fallback';
      reason: CueUserReason;
      prompt?: string;
      missingFields?: string[];
    }
  | {
      kind: 'close_session';
      source: 'director_tool';
      endReason?: string;
    }
  | {
      kind: 'runtime_exhausted';
      source: 'runtime';
      reason: 'director_tool_call_budget';
    };

export type TerminalDecisionStatus = 'allowed' | 'rejected' | 'exhausted';
export type TerminalPreflightRequest = Exclude<TerminalRequest, { kind: 'runtime_exhausted' }>;

export interface TerminalDecision {
  status: TerminalDecisionStatus;
  code:
    | 'ALLOWED'
    | 'TASK_INCOMPLETE'
    | 'CLARIFICATION_NOT_REQUIRED'
    | 'EXPLICIT_USER_TURN_NOT_REQUESTED'
    | 'NO_SUBSTANTIVE_TEACHING_TURN'
    | 'NO_VISIBLE_AGENT_TURN'
    | 'TERMINAL_ALREADY_REACHED'
    | 'TERMINAL_DECISION_BUDGET_EXHAUSTED'
    | 'TERMINAL_REJECTION_BUDGET_EXHAUSTED'
    | 'TERMINAL_WALL_CLOCK_EXHAUSTED'
    | 'RUNTIME_FALLBACK_POLICY_REJECTED'
    | 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED';
  reason: string;
  revision: number;
  pendingOutcomes: InclassRequestedOutcome[];
  missingInformation: string[];
}

export interface InclassOutcomeState extends InclassRequestedOutcome {
  status: 'pending' | 'completed';
  completedBy?: {
    agentInvocationId: string;
    source: TrustedChildResultEvent['source'];
    revision: number;
  };
}

export interface TaskStateUpdate {
  revision: number;
  outcomeId: string;
  agentId: string;
  agentInvocationId: string;
  source: TrustedChildResultEvent['source'];
}

export interface TerminalDecisionTraceEntry {
  sequence: number;
  request: TerminalRequest;
  status: TerminalDecisionStatus;
  code: TerminalDecision['code'];
  revision: number;
  pendingOutcomeIds: string[];
}

export interface TerminalControlTrace {
  mode: 'enforced' | 'observe_only';
  revision: number;
  outcomes: InclassOutcomeState[];
  missingInformation: string[];
  updates: TaskStateUpdate[];
  decisions: TerminalDecisionTraceEntry[];
  terminal?: {
    kind: TerminalRequest['kind'];
    reason: string;
    revision: number;
  };
  decisionCount: number;
  rejectionCount: number;
  maxDecisions: number;
  maxRejections: number;
  deadlineAt: number;
  exhaustedReason?: TerminalDecision['code'];
}

export interface InclassTerminalController {
  recordChildResult(event: TrustedChildResultEvent): void;
  recordRuntimeExhaustion(reason: 'director_tool_call_budget'): TerminalDecision;
  preflight(request: TerminalPreflightRequest, context: TerminalRuntimeContext): TerminalDecision;
  getTrace(): TerminalControlTrace;
  getPromptState(): {
    mode: TerminalControlTrace['mode'];
    outcomes: InclassOutcomeState[];
    missingInformation: string[];
    explicitUserTurnRequested: boolean;
    explicitEndRequested: boolean;
  };
}

export interface DirectorToolExecutionGate {
  reserveAttempt(toolCallId: string): TerminalDecision | undefined;
  beforeExecute(toolCallId: string): TerminalDecision | undefined;
  finishAttempt(toolCallId: string): void;
  getAttemptCount(): number;
}

const DEFAULT_TASK_CONTRACT: InclassTaskContractSeed = { requestedOutcomes: [] };

function uniqueTrimmedStrings(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function validateInclassTaskContract(
  seed: InclassTaskContractSeed | undefined,
  availableAgentIds: ReadonlySet<string>,
): string | undefined {
  if (!seed) return undefined;
  if (!Array.isArray(seed.requestedOutcomes)) {
    return 'config.piTaskContract.requestedOutcomes must be an array';
  }
  if (seed.requestedOutcomes.length > 16) {
    return 'config.piTaskContract.requestedOutcomes may contain at most 16 outcomes';
  }
  const outcomeIds = new Set<string>();
  for (const outcome of seed.requestedOutcomes) {
    if (!outcome || typeof outcome !== 'object') {
      return 'Each requested outcome must be an object';
    }
    if (
      typeof outcome.id !== 'string' ||
      outcome.id.trim().length === 0 ||
      outcome.id !== outcome.id.trim() ||
      outcome.id.length > 128
    ) {
      return 'Each requested outcome requires a trimmed id of at most 128 characters';
    }
    if (outcomeIds.has(outcome.id)) {
      return `Duplicate requested outcome id: ${outcome.id}`;
    }
    outcomeIds.add(outcome.id);
    if (typeof outcome.agentId !== 'string' || !availableAgentIds.has(outcome.agentId)) {
      return `Requested outcome "${outcome.id}" references unavailable agent: ${String(outcome.agentId)}`;
    }
    if (
      outcome.description !== undefined &&
      (typeof outcome.description !== 'string' || outcome.description.length > 500)
    ) {
      return `Requested outcome "${outcome.id}" has an invalid description`;
    }
  }
  if (
    seed.missingInformation !== undefined &&
    (!Array.isArray(seed.missingInformation) ||
      seed.missingInformation.some((value) => typeof value !== 'string'))
  ) {
    return 'config.piTaskContract.missingInformation must be an array of strings';
  }
  if (
    seed.missingInformation &&
    (seed.missingInformation.length > 16 ||
      seed.missingInformation.some(
        (value) => value.trim().length === 0 || value !== value.trim() || value.length > 128,
      ))
  ) {
    return 'config.piTaskContract.missingInformation requires at most 16 trimmed values of at most 128 characters';
  }
  if (
    seed.explicitUserTurnRequested !== undefined &&
    typeof seed.explicitUserTurnRequested !== 'boolean'
  ) {
    return 'config.piTaskContract.explicitUserTurnRequested must be a boolean';
  }
  if (seed.explicitEndRequested !== undefined && typeof seed.explicitEndRequested !== 'boolean') {
    return 'config.piTaskContract.explicitEndRequested must be a boolean';
  }
  return undefined;
}

export function createInclassTerminalController(
  opts: {
    seed?: InclassTaskContractSeed;
    now?: () => number;
    wallClockBudgetMs?: number;
    maxDecisions?: number;
    maxRejections?: number;
  } = {},
): InclassTerminalController {
  const seed = opts.seed ?? DEFAULT_TASK_CONTRACT;
  const mode: TerminalControlTrace['mode'] = opts.seed ? 'enforced' : 'observe_only';
  const now = opts.now ?? Date.now;
  const maxDecisions = opts.maxDecisions ?? 4;
  const maxRejections = opts.maxRejections ?? 2;
  if (!Number.isInteger(maxDecisions) || maxDecisions <= 0) {
    throw new Error('Terminal control requires a positive integer maxDecisions');
  }
  if (!Number.isInteger(maxRejections) || maxRejections <= 0) {
    throw new Error('Terminal control requires a positive integer maxRejections');
  }
  const wallClockBudgetMs = opts.wallClockBudgetMs ?? 30_000;
  if (!Number.isFinite(wallClockBudgetMs) || wallClockBudgetMs <= 0) {
    throw new Error('Terminal control requires a positive finite wallClockBudgetMs');
  }

  const deadlineAt = now() + wallClockBudgetMs;
  const missingInformation = uniqueTrimmedStrings(seed.missingInformation);
  const outcomes = seed.requestedOutcomes.map(
    (outcome): InclassOutcomeState => ({
      id: outcome.id,
      agentId: outcome.agentId,
      ...(outcome.description ? { description: outcome.description } : {}),
      status: 'pending',
    }),
  );
  const updates: TaskStateUpdate[] = [];
  const decisions: TerminalDecisionTraceEntry[] = [];
  const seenAgentInvocations = new Set<string>();
  let revision = 0;
  let decisionCount = 0;
  let rejectionCount = 0;
  let exhaustedReason: TerminalDecision['code'] | undefined;
  let terminal: TerminalControlTrace['terminal'];

  const pendingOutcomes = (): InclassRequestedOutcome[] =>
    outcomes
      .filter((outcome) => outcome.status === 'pending')
      .map(({ id, agentId, description }) => ({
        id,
        agentId,
        ...(description ? { description } : {}),
      }));

  const decision = (
    request: TerminalRequest,
    status: TerminalDecisionStatus,
    code: TerminalDecision['code'],
    reason: string,
  ): TerminalDecision => {
    const result: TerminalDecision = {
      status,
      code,
      reason,
      revision,
      pendingOutcomes: pendingOutcomes(),
      missingInformation: [...missingInformation],
    };
    decisions.push({
      sequence: decisionCount,
      request,
      status,
      code,
      revision,
      pendingOutcomeIds: result.pendingOutcomes.map((outcome) => outcome.id),
    });
    return result;
  };

  const exhaust = (
    request: TerminalRequest,
    code: Extract<
      TerminalDecision['code'],
      | 'TERMINAL_DECISION_BUDGET_EXHAUSTED'
      | 'TERMINAL_REJECTION_BUDGET_EXHAUSTED'
      | 'TERMINAL_WALL_CLOCK_EXHAUSTED'
      | 'RUNTIME_FALLBACK_POLICY_REJECTED'
      | 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED'
    >,
  ): TerminalDecision => {
    exhaustedReason = code;
    if (!terminal) {
      revision += 1;
      terminal = { kind: 'runtime_exhausted', reason: code, revision };
    }
    return decision(request, 'exhausted', code, `Runtime terminal control exhausted: ${code}.`);
  };

  const reject = (
    request: TerminalRequest,
    code: Exclude<
      TerminalDecision['code'],
      | 'ALLOWED'
      | 'TERMINAL_DECISION_BUDGET_EXHAUSTED'
      | 'TERMINAL_REJECTION_BUDGET_EXHAUSTED'
      | 'TERMINAL_WALL_CLOCK_EXHAUSTED'
    >,
    reason: string,
  ): TerminalDecision => {
    if (
      request.kind === 'cue_user' &&
      request.source === 'runtime_fallback' &&
      code !== 'TERMINAL_ALREADY_REACHED'
    ) {
      return exhaust(request, 'RUNTIME_FALLBACK_POLICY_REJECTED');
    }
    const isLegacyObserveOnlySkip =
      mode === 'observe_only' &&
      (code === 'NO_SUBSTANTIVE_TEACHING_TURN' || code === 'NO_VISIBLE_AGENT_TURN');
    if (isLegacyObserveOnlySkip) {
      return decision(request, 'rejected', code, reason);
    }
    rejectionCount += 1;
    if (rejectionCount >= maxRejections) {
      return exhaust(request, 'TERMINAL_REJECTION_BUDGET_EXHAUSTED');
    }
    return decision(request, 'rejected', code, reason);
  };

  const allow = (request: TerminalRequest, reason: string): TerminalDecision => {
    revision += 1;
    terminal = {
      kind: request.kind,
      reason:
        request.kind === 'cue_user'
          ? request.reason
          : request.kind === 'close_session'
            ? (request.endReason ?? 'close_session')
            : request.reason,
      revision,
    };
    return decision(request, 'allowed', 'ALLOWED', reason);
  };

  return {
    recordChildResult(event) {
      if (seenAgentInvocations.has(event.agentInvocationId)) return;
      if (event.source !== 'runtime_child_result') return;
      if (event.status !== 'completed' || !event.substantive) return;

      for (const outcome of outcomes) {
        if (
          outcome.status !== 'pending' ||
          outcome.id !== event.outcomeId ||
          outcome.agentId !== event.agentId
        ) {
          continue;
        }
        revision += 1;
        outcome.status = 'completed';
        outcome.completedBy = {
          agentInvocationId: event.agentInvocationId,
          source: event.source,
          revision,
        };
        updates.push({
          revision,
          outcomeId: outcome.id,
          agentId: event.agentId,
          agentInvocationId: event.agentInvocationId,
          source: event.source,
        });
        seenAgentInvocations.add(event.agentInvocationId);
        break;
      }
    },

    preflight(request, context) {
      decisionCount += 1;
      if (now() >= deadlineAt) {
        return exhaust(request, 'TERMINAL_WALL_CLOCK_EXHAUSTED');
      }
      if (decisionCount > maxDecisions) {
        return exhaust(request, 'TERMINAL_DECISION_BUDGET_EXHAUSTED');
      }
      if (terminal || context.userCued || context.sessionClosed) {
        return reject(
          request,
          'TERMINAL_ALREADY_REACHED',
          'A terminal transition has already been reached for this Director request.',
        );
      }

      const pending = pendingOutcomes();
      if (request.kind === 'close_session') {
        if (!context.hasVisibleAgentTurn) {
          return reject(
            request,
            'NO_VISIBLE_AGENT_TURN',
            'A visible classroom closing line is required before close_session.',
          );
        }
        if (pending.length > 0 && seed.explicitEndRequested !== true) {
          return reject(
            request,
            'TASK_INCOMPLETE',
            'The requested virtual classroom outcomes are not complete.',
          );
        }
        return allow(request, 'The session may close.');
      }

      if (request.source === 'runtime_fallback' && mode === 'observe_only') {
        if (!context.hasAgentContent) {
          return reject(
            request,
            'NO_VISIBLE_AGENT_TURN',
            'A classroom agent turn is required before Runtime fallback can cue the user.',
          );
        }
        return allow(request, 'A visible classroom turn completed; return control to the user.');
      }

      if (mode === 'observe_only' && !context.hasTeachingSubstantiveTurn) {
        return reject(
          request,
          'NO_SUBSTANTIVE_TEACHING_TURN',
          'A substantive teacher or teaching-assistant turn is required before cueing the user.',
        );
      }

      if (request.reason === 'clarification_required') {
        const requestedMissingFields = uniqueTrimmedStrings(request.missingFields);
        const hasTrustedMissingField = requestedMissingFields.some((field) =>
          missingInformation.includes(field),
        );
        if (!request.prompt?.trim() || (mode === 'enforced' && !hasTrustedMissingField)) {
          return reject(
            request,
            'CLARIFICATION_NOT_REQUIRED',
            'Focused clarification is allowed only for trusted missing information.',
          );
        }
        return allow(request, 'Focused clarification is required before work can continue.');
      }

      if (request.reason === 'explicit_user_turn') {
        if (mode === 'enforced' && seed.explicitUserTurnRequested !== true) {
          return reject(
            request,
            'EXPLICIT_USER_TURN_NOT_REQUESTED',
            'The user did not explicitly request the real-user turn.',
          );
        }
        return allow(request, 'The user explicitly requested the real-user turn.');
      }

      if (!context.hasTeachingSubstantiveTurn) {
        return reject(
          request,
          'NO_SUBSTANTIVE_TEACHING_TURN',
          'A substantive teacher or teaching-assistant turn is required before follow-up.',
        );
      }
      if (pending.length > 0) {
        return reject(
          request,
          'TASK_INCOMPLETE',
          'The requested virtual classroom outcomes are not complete.',
        );
      }
      return allow(request, 'All requested outcomes are complete; the user may continue.');
    },

    getTrace() {
      return {
        mode,
        revision,
        outcomes: outcomes.map((outcome) => ({
          ...outcome,
          ...(outcome.completedBy ? { completedBy: { ...outcome.completedBy } } : {}),
        })),
        missingInformation: [...missingInformation],
        updates: updates.map((update) => ({ ...update })),
        decisions: decisions.map((entry) => ({
          ...entry,
          request: {
            ...entry.request,
            ...(entry.request.kind === 'cue_user' && entry.request.missingFields
              ? { missingFields: [...entry.request.missingFields] }
              : {}),
          },
          pendingOutcomeIds: [...entry.pendingOutcomeIds],
        })),
        ...(terminal ? { terminal: { ...terminal } } : {}),
        decisionCount,
        rejectionCount,
        maxDecisions,
        maxRejections,
        deadlineAt,
        ...(exhaustedReason ? { exhaustedReason } : {}),
      };
    },

    getPromptState() {
      return {
        mode,
        outcomes: outcomes.map((outcome) => ({ ...outcome })),
        missingInformation: [...missingInformation],
        explicitUserTurnRequested: seed.explicitUserTurnRequested === true,
        explicitEndRequested: seed.explicitEndRequested === true,
      };
    },

    recordRuntimeExhaustion(reason) {
      decisionCount += 1;
      const request: Extract<TerminalRequest, { kind: 'runtime_exhausted' }> = {
        kind: 'runtime_exhausted',
        source: 'runtime',
        reason,
      };
      if (terminal) {
        return decision(
          request,
          'rejected',
          'TERMINAL_ALREADY_REACHED',
          'A terminal transition has already been reached for this Director request.',
        );
      }
      return exhaust(request, 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED');
    },
  };
}

export function createDirectorToolExecutionGate(opts: {
  controller: InclassTerminalController;
  maxToolCalls: number;
}): DirectorToolExecutionGate {
  if (!Number.isInteger(opts.maxToolCalls) || opts.maxToolCalls <= 0) {
    throw new Error('Director tool execution requires a positive integer maxToolCalls');
  }

  let attemptCount = 0;
  const reservations = new Map<string, { blocked?: TerminalDecision }>();

  const reserveAttempt = (toolCallId: string): TerminalDecision | undefined => {
    attemptCount += 1;
    const trace = opts.controller.getTrace();
    let blocked: TerminalDecision | undefined;
    if (trace.terminal) {
      blocked = {
        status: trace.exhaustedReason ? 'exhausted' : 'rejected',
        code: trace.exhaustedReason ?? 'TERMINAL_ALREADY_REACHED',
        reason: trace.exhaustedReason
          ? `Runtime terminal control exhausted: ${trace.exhaustedReason}.`
          : 'A terminal transition has already been reached for this Director request.',
        revision: trace.revision,
        pendingOutcomes: trace.outcomes
          .filter((outcome) => outcome.status === 'pending')
          .map(({ id, agentId, description }) => ({
            id,
            agentId,
            ...(description ? { description } : {}),
          })),
        missingInformation: [...trace.missingInformation],
      };
    } else if (attemptCount > opts.maxToolCalls) {
      blocked = opts.controller.recordRuntimeExhaustion('director_tool_call_budget');
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
            content: [
              {
                type: 'text',
                text: `${blocked.code}: ${blocked.reason}`,
              },
            ],
            details: {
              skipped: true,
              reason: blocked.code,
              directorExecutionGuard: true,
              terminalControl: blocked,
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
