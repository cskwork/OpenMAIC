/**
 * Director Prompt Builder
 *
 * Constructs the system prompt for the director agent that decides
 * which agent should respond next in a multi-agent conversation.
 */

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { createLogger } from '@/lib/logger';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import type { WhiteboardActionRecord, AgentTurnSummary } from './types';

const log = createLogger('DirectorPrompt');

/**
 * Build the system prompt for the director agent
 *
 * @param agents - Available agent configurations
 * @param conversationSummary - Condensed summary of recent conversation
 * @param agentResponses - Agents that have already responded this round
 * @param turnCount - Current turn number in this round
 */
export function buildDirectorPrompt(
  agents: AgentConfig[],
  conversationSummary: string,
  agentResponses: AgentTurnSummary[],
  turnCount: number,
  discussionContext?: { topic: string; prompt?: string } | null,
  triggerAgentId?: string | null,
  whiteboardLedger?: WhiteboardActionRecord[],
  userProfile?: { nickname?: string; bio?: string },
  whiteboardOpen?: boolean,
): string {
  void whiteboardLedger;
  void whiteboardOpen;

  const agentList = agents
    .map((a) => `- id: "${a.id}", name: "${a.name}", role: ${a.role}, priority: ${a.priority}`)
    .join('\n');

  const respondedList =
    agentResponses.length > 0
      ? agentResponses
          .map(
            (r) =>
              `- ${r.agentName} (${r.agentId}): "${r.contentPreview}" [${r.actionCount} actions]`,
          )
          .join('\n')
      : 'None yet.';

  const isDiscussion = !!discussionContext;

  const discussionSection = isDiscussion
    ? `\n# Discussion Mode
Topic: "${discussionContext!.topic}"${discussionContext!.prompt ? `\nPrompt: "${discussionContext!.prompt}"` : ''}${triggerAgentId ? `\nInitiator: "${triggerAgentId}"` : ''}
This is a student-initiated discussion, not a Q&A session.\n`
    : '';

  const rule1 = isDiscussion
    ? `1. The discussion initiator${triggerAgentId ? ` ("${triggerAgentId}")` : ''} should speak first to kick off the topic. Then the teacher responds to guide the discussion. After that, other students may add their perspectives.`
    : "1. The teacher (role: teacher, highest priority) should usually speak first to address the user's question or topic.";

  const studentProfileSection =
    userProfile?.nickname || userProfile?.bio
      ? `
# Student Profile
Student name: ${userProfile.nickname || 'Unknown'}
${userProfile.bio ? `Background: ${userProfile.bio}` : ''}
`
      : '';

  const vars = {
    agentList,
    respondedList,
    conversationSummary,
    discussionSection,
    studentProfileSection,
    rule1,
    turnCountPlusOne: turnCount + 1,
  };

  const prompt = buildPrompt(PROMPT_IDS.DIRECTOR, vars);
  if (!prompt) {
    throw new Error('director prompt template failed to load');
  }
  return prompt.system;
}

/**
 * Parse the director's decision from its response
 *
 * @param content - Raw LLM response content
 * @returns Parsed decision with nextAgentId and shouldEnd flag
 */
export function parseDirectorDecision(content: string): {
  nextAgentId: string | null;
  shouldEnd: boolean;
} {
  try {
    const jsonMatch = content.match(/\{[\s\S]*?"next_agent"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const nextAgent = parsed.next_agent;

      if (!nextAgent || nextAgent === 'END') {
        return { nextAgentId: null, shouldEnd: true };
      }

      return { nextAgentId: nextAgent, shouldEnd: false };
    }
  } catch (_e) {
    log.warn('[Director] Failed to parse decision:', content.slice(0, 200));
  }

  return { nextAgentId: null, shouldEnd: true };
}
