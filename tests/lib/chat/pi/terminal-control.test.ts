import { describe, expect, it } from 'vitest';
import {
  createInclassTerminalController,
  validateInclassTaskContract,
  type TerminalRuntimeContext,
} from '@/lib/chat/pi/terminal-control';

const READY_CONTEXT: TerminalRuntimeContext = {
  hasTeachingSubstantiveTurn: true,
  hasVisibleAgentTurn: true,
  hasAgentContent: true,
  userCued: false,
  sessionClosed: false,
};

describe('Pi Inclass terminal control', () => {
  it('advances requested outcomes only from a substantive trusted Runtime child result', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
    });

    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'child-empty',
      agentId: 'student-1',
      outcomeId: 'student_analysis',
      status: 'empty',
      substantive: false,
    });
    expect(controller.getTrace().revision).toBe(0);
    expect(controller.getTrace().outcomes[0].status).toBe('pending');

    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'child-without-outcome',
      agentId: 'student-1',
      status: 'completed',
      substantive: true,
    });
    expect(controller.getTrace().revision).toBe(0);
    expect(controller.getTrace().outcomes[0].status).toBe('pending');

    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'child-success',
      agentId: 'student-1',
      outcomeId: 'student_analysis',
      status: 'completed',
      substantive: true,
    });
    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'child-success',
      agentId: 'student-1',
      outcomeId: 'student_analysis',
      status: 'completed',
      substantive: true,
    });

    expect(controller.getTrace()).toMatchObject({
      revision: 1,
      outcomes: [
        {
          id: 'student_analysis',
          status: 'completed',
          completedBy: {
            agentInvocationId: 'child-success',
            source: 'runtime_child_result',
            revision: 1,
          },
        },
      ],
      updates: [
        {
          revision: 1,
          outcomeId: 'student_analysis',
          agentInvocationId: 'child-success',
        },
      ],
    });
  });

  it('rejects wrong-agent and unknown-outcome completion claims', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
    });

    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'wrong-agent',
      agentId: 'teacher-1',
      outcomeId: 'student_analysis',
      status: 'completed',
      substantive: true,
    });
    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'unknown-outcome',
      agentId: 'student-1',
      outcomeId: 'not_requested',
      status: 'completed',
      substantive: true,
    });

    expect(controller.getTrace()).toMatchObject({
      revision: 0,
      outcomes: [{ id: 'student_analysis', status: 'pending' }],
      updates: [],
    });
  });

  it('does not let an invalid event poison a later valid event with the same invocation id', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
    });
    const event = {
      source: 'runtime_child_result' as const,
      agentInvocationId: 'student-run-1',
      agentId: 'student-1',
      outcomeId: 'student_analysis',
    };

    controller.recordChildResult({ ...event, status: 'failed', substantive: false });
    controller.recordChildResult({ ...event, status: 'completed', substantive: true });

    expect(controller.getTrace()).toMatchObject({
      revision: 1,
      outcomes: [{ id: 'student_analysis', status: 'completed' }],
    });
  });

  it('completes at most one outcome for one child event even for a directly constructed seed', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [
          { id: 'duplicate', agentId: 'student-1' },
          { id: 'duplicate', agentId: 'student-1' },
        ],
      },
    });

    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'student-run-1',
      agentId: 'student-1',
      outcomeId: 'duplicate',
      status: 'completed',
      substantive: true,
    });

    expect(controller.getTrace().outcomes.map((outcome) => outcome.status)).toEqual([
      'completed',
      'pending',
    ]);
    expect(controller.getTrace().updates).toHaveLength(1);
  });

  it('returns TASK_INCOMPLETE, then allows follow-up after the trusted child completes', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
    });

    const rejected = controller.preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'task_complete_followup',
      },
      READY_CONTEXT,
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      code: 'TASK_INCOMPLETE',
      revision: 0,
      pendingOutcomes: [{ id: 'student_analysis' }],
    });

    controller.recordChildResult({
      source: 'runtime_child_result',
      agentInvocationId: 'student-run-1',
      agentId: 'student-1',
      outcomeId: 'student_analysis',
      status: 'completed',
      substantive: true,
    });
    const allowed = controller.preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'task_complete_followup',
      },
      READY_CONTEXT,
    );

    expect(allowed).toMatchObject({
      status: 'allowed',
      code: 'ALLOWED',
      revision: 2,
      pendingOutcomes: [],
    });
    expect(controller.getTrace().decisions.map((entry) => entry.code)).toEqual([
      'TASK_INCOMPLETE',
      'ALLOWED',
    ]);
  });

  it('allows focused clarification only for trusted missing information', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'compare_plans', agentId: 'teacher-1' }],
        missingInformation: ['plan_names'],
      },
    });

    const allowed = controller.preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'clarification_required',
        prompt: '你指的是哪两个方案？',
        missingFields: ['plan_names'],
      },
      {
        ...READY_CONTEXT,
        hasTeachingSubstantiveTurn: false,
        hasVisibleAgentTurn: false,
      },
    );

    expect(allowed).toMatchObject({
      status: 'allowed',
      code: 'ALLOWED',
      pendingOutcomes: [{ id: 'compare_plans' }],
    });
  });

  it('rejects a model-only clarification claim that does not match trusted missing state', () => {
    const controller = createInclassTerminalController({
      seed: { requestedOutcomes: [] },
    });

    const result = controller.preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'clarification_required',
        prompt: 'Please clarify.',
        missingFields: ['invented_field'],
      },
      READY_CONTEXT,
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'CLARIFICATION_NOT_REQUIRED',
    });
  });

  it('allows an explicit real-user turn only when trusted request state records it', () => {
    const denied = createInclassTerminalController({
      seed: { requestedOutcomes: [] },
    }).preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'explicit_user_turn',
      },
      READY_CONTEXT,
    );
    const allowed = createInclassTerminalController({
      seed: {
        requestedOutcomes: [],
        explicitUserTurnRequested: true,
      },
    }).preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'explicit_user_turn',
      },
      READY_CONTEXT,
    );

    expect(denied).toMatchObject({
      status: 'rejected',
      code: 'EXPLICIT_USER_TURN_NOT_REQUESTED',
    });
    expect(allowed).toMatchObject({ status: 'allowed', code: 'ALLOWED' });
  });

  it('keeps legacy user-turn semantics in observe-only mode when no contract is supplied', () => {
    const controller = createInclassTerminalController();

    const result = controller.preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'explicit_user_turn',
        prompt: '请你回答。',
      },
      READY_CONTEXT,
    );

    expect(result).toMatchObject({ status: 'allowed', code: 'ALLOWED' });
    expect(controller.getTrace().mode).toBe('observe_only');
  });

  it('keeps early observe-only cue attempts as non-exhausting legacy skips', () => {
    const controller = createInclassTerminalController({ maxRejections: 2 });
    const context = {
      ...READY_CONTEXT,
      hasTeachingSubstantiveTurn: false,
      hasVisibleAgentTurn: false,
      hasAgentContent: false,
    };

    for (const reason of ['explicit_user_turn', 'clarification_required'] as const) {
      expect(
        controller.preflight(
          {
            kind: 'cue_user',
            source: 'director_tool',
            reason,
            prompt: 'Please answer.',
          },
          context,
        ),
      ).toMatchObject({
        status: 'rejected',
        code: 'NO_SUBSTANTIVE_TEACHING_TURN',
      });
    }

    const trace = controller.getTrace();
    expect(trace).toMatchObject({
      mode: 'observe_only',
      rejectionCount: 0,
    });
    expect(trace.terminal).toBeUndefined();
  });

  it('preserves observe-only Runtime fallback after any agent content', () => {
    const controller = createInclassTerminalController();

    const result = controller.preflight(
      {
        kind: 'cue_user',
        source: 'runtime_fallback',
        reason: 'task_complete_followup',
      },
      {
        ...READY_CONTEXT,
        hasTeachingSubstantiveTurn: false,
      },
    );

    expect(result).toMatchObject({ status: 'allowed', code: 'ALLOWED' });
  });

  it('records an exhausted reason when Runtime finalization has no agent content', () => {
    const controller = createInclassTerminalController();

    const result = controller.preflight(
      {
        kind: 'cue_user',
        source: 'runtime_fallback',
        reason: 'task_complete_followup',
      },
      {
        ...READY_CONTEXT,
        hasTeachingSubstantiveTurn: false,
        hasVisibleAgentTurn: false,
        hasAgentContent: false,
      },
    );

    expect(result).toMatchObject({
      status: 'exhausted',
      code: 'RUNTIME_FALLBACK_POLICY_REJECTED',
    });
  });

  it('allows an explicit user ending to close despite pending outcomes', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
        explicitEndRequested: true,
      },
    });

    const result = controller.preflight(
      {
        kind: 'close_session',
        source: 'director_tool',
        endReason: 'user_done',
      },
      READY_CONTEXT,
    );

    expect(result).toMatchObject({
      status: 'allowed',
      code: 'ALLOWED',
      pendingOutcomes: [{ id: 'student_analysis' }],
    });
  });

  it('rejects close_session with pending outcomes when no explicit end was requested', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
    });

    const result = controller.preflight(
      {
        kind: 'close_session',
        source: 'director_tool',
        endReason: 'user_done',
      },
      READY_CONTEXT,
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'TASK_INCOMPLETE',
      pendingOutcomes: [{ id: 'student_analysis' }],
    });
  });

  it('commits at most one terminal transition per Director request', () => {
    const controller = createInclassTerminalController();
    const first = controller.preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'task_complete_followup',
      },
      READY_CONTEXT,
    );
    const second = controller.preflight(
      {
        kind: 'close_session',
        source: 'director_tool',
        endReason: 'user_done',
      },
      READY_CONTEXT,
    );

    expect(first.status).toBe('allowed');
    expect(second).toMatchObject({
      status: 'rejected',
      code: 'TERMINAL_ALREADY_REACHED',
    });
    expect(controller.getTrace().terminal).toEqual({
      kind: 'cue_user',
      reason: 'task_complete_followup',
      revision: 1,
    });
  });

  it('bounds repeated rejections and returns a Runtime-generated exhausted reason', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
      maxRejections: 2,
    });
    const request = {
      kind: 'cue_user' as const,
      source: 'director_tool' as const,
      reason: 'task_complete_followup' as const,
    };

    expect(controller.preflight(request, READY_CONTEXT).code).toBe('TASK_INCOMPLETE');
    expect(controller.preflight(request, READY_CONTEXT)).toMatchObject({
      status: 'exhausted',
      code: 'TERMINAL_REJECTION_BUDGET_EXHAUSTED',
    });
    expect(controller.getTrace()).toMatchObject({
      terminal: {
        kind: 'runtime_exhausted',
        reason: 'TERMINAL_REJECTION_BUDGET_EXHAUSTED',
      },
      exhaustedReason: 'TERMINAL_REJECTION_BUDGET_EXHAUSTED',
    });
  });

  it('prevents Runtime fallback from bypassing pending outcomes', () => {
    const controller = createInclassTerminalController({
      seed: {
        requestedOutcomes: [{ id: 'student_analysis', agentId: 'student-1' }],
      },
    });

    const result = controller.preflight(
      {
        kind: 'cue_user',
        source: 'runtime_fallback',
        reason: 'task_complete_followup',
      },
      READY_CONTEXT,
    );

    expect(result).toMatchObject({
      status: 'exhausted',
      code: 'RUNTIME_FALLBACK_POLICY_REJECTED',
      pendingOutcomes: [{ id: 'student_analysis' }],
    });
  });

  it('enforces the terminal wall-clock budget', () => {
    let clock = 100;
    const controller = createInclassTerminalController({
      now: () => clock,
      wallClockBudgetMs: 10,
    });
    clock = 110;

    const result = controller.preflight(
      {
        kind: 'cue_user',
        source: 'director_tool',
        reason: 'task_complete_followup',
      },
      READY_CONTEXT,
    );

    expect(result).toMatchObject({
      status: 'exhausted',
      code: 'TERMINAL_WALL_CLOCK_EXHAUSTED',
    });
  });

  it('enforces the terminal decision budget independently of rejection count', () => {
    const controller = createInclassTerminalController({
      seed: { requestedOutcomes: [] },
      maxDecisions: 1,
      maxRejections: 5,
    });
    const request = {
      kind: 'cue_user' as const,
      source: 'director_tool' as const,
      reason: 'clarification_required' as const,
      prompt: 'Clarify?',
      missingFields: ['not_trusted'],
    };

    expect(controller.preflight(request, READY_CONTEXT)).toMatchObject({
      status: 'rejected',
      code: 'CLARIFICATION_NOT_REQUIRED',
    });
    expect(controller.preflight(request, READY_CONTEXT)).toMatchObject({
      status: 'exhausted',
      code: 'TERMINAL_DECISION_BUDGET_EXHAUSTED',
    });
  });

  it('records a Runtime-generated terminal reason when the Director tool budget is exhausted', () => {
    const controller = createInclassTerminalController();

    expect(controller.recordRuntimeExhaustion('director_tool_call_budget')).toMatchObject({
      status: 'exhausted',
      code: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
    });
    expect(controller.getTrace()).toMatchObject({
      terminal: {
        kind: 'runtime_exhausted',
        reason: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
      },
      exhaustedReason: 'DIRECTOR_TOOL_CALL_BUDGET_EXHAUSTED',
    });
  });

  it('validates requested outcomes against the available request-scoped agents', () => {
    expect(
      validateInclassTaskContract(
        {
          requestedOutcomes: [{ id: 'student_analysis', agentId: 'missing-student' }],
        },
        new Set(['teacher-1']),
      ),
    ).toContain('unavailable agent');
    expect(
      validateInclassTaskContract(
        {
          requestedOutcomes: [{ id: 'teacher_answer', agentId: 'teacher-1' }],
        },
        new Set(['teacher-1']),
      ),
    ).toBeUndefined();
  });
});
