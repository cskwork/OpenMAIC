/**
 * Read-only support for PBL v1 scenes stored before the v2 cutover.
 *
 * This module is kept indefinitely so historical scenes remain renderable and
 * exportable. Writers must never import it to create or project legacy shapes;
 * v1 data is accepted only when it already exists in stored scene content.
 */
import type { PBLChatMessage, PBLMilestoneStatus, PBLProjectV2, PBLRole } from '../v2/types';

interface LegacyPBLProjectInfo {
  title: string;
  description: string;
}

interface LegacyPBLAgent {
  name: string;
  actor_role: string;
  role_division: 'management' | 'development';
  system_prompt: string;
  default_mode: string;
  delay_time: number;
  env: Record<string, unknown>;
  is_user_role: boolean;
  is_active: boolean;
  is_system_agent: boolean;
}

interface LegacyPBLIssue {
  id: string;
  title: string;
  description: string;
  person_in_charge: string;
  participants: string[];
  notes: string;
  parent_issue: string | null;
  index: number;
  is_done: boolean;
  is_active: boolean;
  generated_questions: string;
  question_agent_name: string;
  judge_agent_name: string;
}

interface LegacyPBLChatMessage {
  id: string;
  agent_name: string;
  message: string;
  timestamp: number;
  read_by: string[];
}

export interface PBLProjectConfig {
  projectInfo: LegacyPBLProjectInfo;
  agents: LegacyPBLAgent[];
  issueboard: {
    agent_ids: string[];
    issues: LegacyPBLIssue[];
    current_issue_id: string | null;
  };
  chat: { messages: LegacyPBLChatMessage[] };
  selectedRole?: string | null;
}

const LEGACY_INSTRUCTOR_ROLE_ID = 'role-compat-instructor';

export function upgradeLegacyPBLConfigToProjectV2(config: PBLProjectConfig): PBLProjectV2 {
  const now = new Date().toISOString();
  const language = detectLegacyLanguage(config);
  const instructorRole: PBLRole = {
    id: LEGACY_INSTRUCTOR_ROLE_ID,
    type: 'instructor',
    name: inferInstructorName(config),
    description: 'Guides the learner through the upgraded legacy PBL project.',
  };
  const orderedIssues = config.issueboard.issues.slice().sort((a, b) => a.index - b.index);
  const activeIssueId = inferActiveIssueId(config);
  const allDone = orderedIssues.length > 0 && orderedIssues.every((issue) => issue.is_done);
  const hasLegacyRuntime =
    !!config.selectedRole ||
    config.chat.messages.length > 0 ||
    orderedIssues.some((issue) => issue.is_done);

  return {
    uiPhase: allDone ? 'completed' : hasLegacyRuntime ? 'workspace' : 'hero',
    title: config.projectInfo.title || 'Project',
    description: config.projectInfo.description || '',
    proficiency: '',
    language,
    tags: [],
    status: allDone ? 'completed' : 'active',
    roles: [instructorRole],
    milestones: orderedIssues.map((issue, index) => {
      const status = legacyIssueStatus(issue, index, orderedIssues, activeIssueId);
      return {
        id: `legacy_ms_${issue.id}`,
        title: issue.title || `Task ${index + 1}`,
        description: issue.description || issue.notes || undefined,
        status,
        order: index,
        microtasks: [
          {
            id: `legacy_mt_${issue.id}`,
            title: issue.title || `Task ${index + 1}`,
            description: legacyMicrotaskDescription(issue),
            status:
              status === 'completed' ? 'completed' : status === 'active' ? 'in_progress' : 'todo',
            assignee: 'user',
            hints: issue.generated_questions ? [issue.generated_questions] : [],
            order: 0,
          },
        ],
        documents: issue.notes
          ? [
              {
                id: `doc_${issue.id}`,
                title: 'Legacy issue notes',
                content: issue.notes,
                docType: 'reference',
              },
            ]
          : [],
        briefing: issue.generated_questions || issue.description || issue.title,
        completionCriteria: legacyCompletionCriteria(language),
        debrief: legacyDebrief(language),
      };
    }),
    submissions: [],
    evaluations: [],
    threads: [
      {
        agentId: instructorRole.id,
        messages: config.chat.messages.map((message) => legacyChatMessage(message, config)),
      },
    ],
    engagementEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function isEmptyLegacyPBLConfig(config: PBLProjectConfig): boolean {
  return (
    config.projectInfo.title === '' &&
    config.projectInfo.description === '' &&
    config.agents.length === 0 &&
    config.issueboard.issues.length === 0 &&
    config.chat.messages.length === 0
  );
}

function legacyIssueStatus(
  issue: LegacyPBLIssue,
  index: number,
  issues: LegacyPBLIssue[],
  activeIssueId: string | null,
): PBLMilestoneStatus {
  if (issue.is_done) return 'completed';
  if (issue.id === activeIssueId) return 'active';

  const firstIncomplete = issues.find((candidate) => !candidate.is_done);
  if (!activeIssueId && (firstIncomplete ? issue.id === firstIncomplete.id : index === 0)) {
    return 'active';
  }
  return 'locked';
}

function legacyMicrotaskDescription(issue: LegacyPBLIssue): string | undefined {
  return [issue.description, issue.notes ? `Notes: ${issue.notes}` : ''].filter(Boolean).join('\n');
}

function legacyChatMessage(
  message: LegacyPBLChatMessage,
  config: PBLProjectConfig,
): PBLChatMessage {
  const isUser = isLegacyUserMessage(message, config);
  return {
    id: message.id,
    agentId: isUser ? undefined : LEGACY_INSTRUCTOR_ROLE_ID,
    roleType: isUser ? 'user' : 'instructor',
    content: message.message,
    ts: new Date(message.timestamp || Date.now()).toISOString(),
  };
}

function isLegacyUserMessage(message: LegacyPBLChatMessage, config: PBLProjectConfig): boolean {
  const selectedRole =
    config.selectedRole?.trim() || config.agents.find((agent) => agent.is_user_role)?.name?.trim();
  if (selectedRole) return message.agent_name === selectedRole;
  const agentNames = new Set(config.agents.map((agent) => agent.name));
  return !agentNames.has(message.agent_name);
}

function inferInstructorName(config: PBLProjectConfig): string {
  const activeIssue =
    config.issueboard.issues.find((issue) => issue.is_active && !issue.is_done) ??
    config.issueboard.issues.find(
      (issue) => issue.id === config.issueboard.current_issue_id && !issue.is_done,
    );
  if (activeIssue?.question_agent_name) return activeIssue.question_agent_name;
  const questionAgent = config.agents.find((agent) =>
    agent.name.toLowerCase().includes('question'),
  );
  return questionAgent?.name || 'Instructor';
}

function inferActiveIssueId(config: PBLProjectConfig): string | null {
  const issues = config.issueboard.issues;
  return (
    issues.find((issue) => issue.is_active && !issue.is_done)?.id ??
    issues.find((issue) => issue.id === config.issueboard.current_issue_id && !issue.is_done)?.id ??
    null
  );
}

function detectLegacyLanguage(config: PBLProjectConfig): string {
  const sample = [
    config.projectInfo.title,
    config.projectInfo.description,
    ...config.issueboard.issues.flatMap((issue) => [
      issue.title,
      issue.description,
      issue.notes,
      issue.generated_questions,
    ]),
  ].join('\n');
  if (/[\u3040-\u30ff]/.test(sample)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko-KR';
  if (/[\u0600-\u06ff]/.test(sample)) return 'ar-SA';
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru-RU';
  if (/[\u3400-\u9fff]/.test(sample)) return 'zh-CN';
  return 'en-US';
}

function legacyCompletionCriteria(language: string): string {
  return language.startsWith('zh')
    ? '\u5b66\u4e60\u8005\u5b8c\u6210\u8be5\u4efb\u52a1\uff0c\u5e76\u80fd\u89e3\u91ca\u81ea\u5df1\u7684\u89e3\u51b3\u601d\u8def\u3002'
    : 'The learner completes this task and can explain their reasoning.';
}

function legacyDebrief(language: string): string {
  return language.startsWith('zh')
    ? '\u603b\u7ed3\u672c\u4efb\u52a1\u7684\u5173\u952e\u6536\u83b7\uff0c\u5e76\u51c6\u5907\u8fdb\u5165\u4e0b\u4e00\u6b65\u3002'
    : 'Summarize the key takeaways from this task and prepare for the next step.';
}
