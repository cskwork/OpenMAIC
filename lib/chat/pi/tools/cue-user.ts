import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import type { StatelessEvent } from '@/lib/types/chat';
import type { CueUserReason, TerminalDecision, TerminalRequest } from '../terminal-control';

const CueUserParams = Type.Object({
  reason: Type.Union(
    [
      Type.Literal('explicit_user_turn'),
      Type.Literal('clarification_required'),
      Type.Literal('task_complete_followup'),
    ],
    {
      description:
        'Why the real user is needed: an explicit user turn, focused clarification, or follow-up after requested outcomes are complete.',
    },
  ),
  prompt: Type.Optional(
    Type.String({
      description: 'Optional short prompt for handing the turn back to the user.',
    }),
  ),
  missingFields: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'For clarification_required only: trusted missing-information fields this prompt asks the user to supply.',
    }),
  ),
});

type CueUserParams = Static<typeof CueUserParams>;

type CueUserSkipReason =
  | 'no_agent_turns'
  | 'no_substantive_teacher_turn'
  | 'no_substantive_teaching_turn';

export function buildCueUserTool(opts: {
  cueUser: (data: Extract<StatelessEvent, { type: 'cue_user' }>['data']) => Promise<boolean>;
  getLastAgentId: () => string | undefined;
  canCueUser?: () => boolean;
  cueUserSkipReason?: CueUserSkipReason;
  isSessionClosed?: () => boolean;
  terminalPreflight?: (request: Extract<TerminalRequest, { kind: 'cue_user' }>) => TerminalDecision;
}): AgentTool<typeof CueUserParams> {
  return {
    name: 'cue_user',
    label: 'Cue user',
    description:
      'Hand the classroom turn back to the user after the useful classroom agent turns are complete.',
    parameters: CueUserParams,
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: CueUserParams) => {
      const terminalDecision = opts.terminalPreflight?.({
        kind: 'cue_user',
        source: 'director_tool',
        reason: params.reason as CueUserReason,
        prompt: params.prompt,
        missingFields: params.missingFields,
      });
      if (terminalDecision && terminalDecision.status !== 'allowed') {
        return {
          content: [
            {
              type: 'text',
              text:
                terminalDecision.code === 'TASK_INCOMPLETE'
                  ? `TASK_INCOMPLETE: complete these requested outcomes before cueing the user: ${terminalDecision.pendingOutcomes.map((outcome) => outcome.id).join(', ')}.`
                  : `${terminalDecision.code}: ${terminalDecision.reason}`,
            },
          ],
          details: {
            emitted: false,
            skipped: true,
            reason: terminalDecision.code,
            terminalControl: terminalDecision,
          },
        };
      }

      if (opts.isSessionClosed?.()) {
        return {
          content: [
            {
              type: 'text',
              text: 'The classroom session is already closed. Do not cue the user again.',
            },
          ],
          details: { emitted: false, skipped: true, reason: 'session_closed' },
        };
      }

      if (opts.canCueUser && !opts.canCueUser()) {
        const reason = opts.cueUserSkipReason ?? 'no_agent_turns';
        return {
          content: [
            {
              type: 'text',
              text:
                reason === 'no_substantive_teacher_turn'
                  ? 'Call the teacher for a visible answer before cueing the user.'
                  : reason === 'no_substantive_teaching_turn'
                    ? 'Call the teacher or teaching assistant for a visible answer before cueing the user.'
                    : 'Call at least one classroom agent before cueing the user.',
            },
          ],
          details: { emitted: false, skipped: true, reason },
        };
      }

      const emitted = await opts.cueUser({
        fromAgentId: opts.getLastAgentId(),
        prompt: params.prompt,
      });
      return {
        content: [
          {
            type: 'text',
            text: emitted
              ? 'The user has been cued for the next classroom turn.'
              : 'The user was already cued for this classroom turn.',
          },
        ],
        details: {
          emitted,
          ...(terminalDecision
            ? {
                cueReason: params.reason,
                terminalControl: terminalDecision,
              }
            : {}),
        },
      };
    },
  };
}
