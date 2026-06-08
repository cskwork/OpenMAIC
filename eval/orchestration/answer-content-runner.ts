/**
 * Agent Answer-Content Eval (#511 / #599 follow-up — the CONTENT layer)
 *
 * The director question-answering eval (answering-runner.ts) only checks that
 * the DIRECTOR routes to the teacher. It never generates the teacher's reply,
 * so it cannot catch the failure mode where the director routes correctly but
 * the dispatched agent's FIRST sentence still drifts (greets / opens a lecture /
 * pivots) and only a LATER turn answers — "first sentence drifts, second answers".
 *
 * This eval closes that gap. For each scenario it runs the REAL agent-generate
 * inputs — buildStructuredPrompt() + convertMessagesToOpenAI() — against the
 * model, parses the structured output with the app's runtime parser, and uses an
 * LLM judge to decide:
 *   - leads_with_answer  : did the FIRST sentence(s) address the literal ask?
 *   - answered_anywhere  : did the reply address it AT ALL (even if late)?
 * The gap (answered_anywhere && !leads_with_answer) quantifies the
 * drift-then-answer pathology directly.
 *
 * Scenarios are synthetic and anonymized, authored from a real-world failure
 * taxonomy (opening-lecture override, ignored format/capability/navigation
 * request, ignored correction, frustration re-ask, adjacent pivot, vague
 * clarify) plus clean controls. No real user data is included.
 *
 * A/B (mirrors answering-runner's rule-13 strip):
 *   - baseline  : agent-system with the "Answering the User's Question" section stripped
 *   - with_rule : agent-system as-shipped
 *
 * Pass criterion: with_rule mean leads_with_answer rate >= EVAL_PASS_THRESHOLD
 * (default 0.7). Δ vs baseline is reported as informational.
 *
 * Required env:
 *   EVAL_AGENT_MODEL   Model used to generate the agent reply (or DEFAULT_MODEL)
 *   EVAL_JUDGE_MODEL   Model used as the answer judge
 * Optional env:
 *   EVAL_SAMPLES        Samples per (scenario, variant). Default 3.
 *   EVAL_PASS_THRESHOLD Min with_rule leads rate per scenario. Default 0.7.
 *   EVAL_SCENARIO       Filter to a single scenario by case_id.
 *
 * Output: eval/orchestration/results-answer-content/<model>/<timestamp>/report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callLLM } from '@/lib/ai/llm';
import { buildStructuredPrompt } from '@/lib/orchestration/prompt-builder';
import { convertMessagesToOpenAI } from '@/lib/orchestration/summarizers/message-converter';
import { createParserState, parseStructuredChunk } from '@/lib/orchestration/stateless-generate';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { judgeAnswer, type AnswerVerdict } from './answer-content-judge';

const OUTPUT_DIR = 'eval/orchestration/results-answer-content';

const TEACHER_ACTIONS = [
  'spotlight',
  'laser',
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_delete',
  'wb_clear',
  'wb_close',
];

// ==================== Types ====================

interface ScenarioAgentSpec {
  id: string;
  name: string;
  role: string;
  priority: number;
  persona: string;
}

interface ScenarioTurn {
  role: 'user' | 'agent';
  agentId?: string;
  text: string;
}

interface ContentScenario {
  case_id: string;
  category: string;
  description: string;
  agents: ScenarioAgentSpec[];
  teacherAgentId: string;
  turns: ScenarioTurn[];
  answerKey: string;
  expectedPreFix?: string;
}

type Variant = 'baseline' | 'with_rule';

interface SampleResult {
  variant: Variant;
  leadText: string;
  fullText: string;
  verdict: AnswerVerdict;
  error?: string;
}

interface VariantAgg {
  samples: SampleResult[];
  leadsRate: number;
  answeredRate: number;
}

interface ScenarioResult {
  case_id: string;
  category: string;
  description: string;
  expectedPreFix?: string;
  baseline: VariantAgg;
  withRule: VariantAgg;
  delta: number;
  passes: boolean;
}

// ==================== Input construction ====================

/** Build a full AgentConfig for the teacher from the scenario spec. */
function buildTeacherConfig(scenario: ContentScenario): AgentConfig {
  const spec = scenario.agents.find((a) => a.id === scenario.teacherAgentId) ?? scenario.agents[0];
  return {
    id: spec.id,
    name: spec.name,
    role: spec.role,
    persona: spec.persona,
    avatar: '🧑‍🏫',
    color: '#6d28d9',
    allowedActions: TEACHER_ACTIONS,
    priority: spec.priority,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: true,
  };
}

/** Minimal store state: no slides, whiteboard closed — keeps the prompt focused
 * on the conversation while still exercising the real builder. */
function buildStoreState(): StatelessChatRequest['storeState'] {
  return {
    stage: null,
    scenes: [],
    currentSceneId: null,
    mode: 'autonomous',
    whiteboardOpen: false,
  } as unknown as StatelessChatRequest['storeState'];
}

/** Turn list -> the UIMessage[] shape convertMessagesToOpenAI expects. */
function buildMessages(scenario: ContentScenario): StatelessChatRequest['messages'] {
  const nameById = new Map(scenario.agents.map((a) => [a.id, a.name]));
  const messages = scenario.turns.map((turn, i) => {
    if (turn.role === 'user') {
      return {
        id: `user-${i}`,
        role: 'user' as const,
        parts: [{ type: 'text', text: turn.text }],
        metadata: { senderName: 'You', originalRole: 'user', createdAt: i },
      };
    }
    const agentId = turn.agentId ?? scenario.teacherAgentId;
    return {
      id: `assistant-${i}`,
      role: 'assistant' as const,
      parts: [{ type: 'text', text: turn.text }],
      metadata: { agentId, senderName: nameById.get(agentId) ?? agentId, createdAt: i },
    };
  });
  return messages as unknown as StatelessChatRequest['messages'];
}

/** Prior agent turns -> AgentTurnSummary[] for peer context in the prompt. */
function buildAgentResponses(scenario: ContentScenario): AgentTurnSummary[] {
  const nameById = new Map(scenario.agents.map((a) => [a.id, a.name]));
  return scenario.turns
    .filter((t) => t.role === 'agent')
    .map((t) => {
      const agentId = t.agentId ?? scenario.teacherAgentId;
      return {
        agentId,
        agentName: nameById.get(agentId) ?? agentId,
        contentPreview: t.text.slice(0, 200),
        actionCount: 0,
        whiteboardActions: [],
      };
    });
}

/**
 * Remove the "# Answering the User's Question" section from an assembled agent
 * system prompt to build the pre-fix baseline. Decoupled from the heading
 * wording beyond the stable leading phrase; bounded by the next section header.
 */
function stripAnsweringSection(prompt: string): string {
  const re = /\n# Answering the User's Question[\s\S]*?(?=\n# Current State)/;
  if (!re.test(prompt)) {
    throw new Error(
      'answer-content-runner: "# Answering the User\'s Question" section not found in agent prompt; baseline cannot be constructed',
    );
  }
  return prompt.replace(re, '\n');
}

/** Extract ordered text blocks from a structured agent response. */
function extractTexts(raw: string): string[] {
  const state = createParserState();
  const result = parseStructuredChunk(raw, state);
  if (result.textChunks.length > 0) return result.textChunks;

  // Fallback: strip fences and JSON.parse the array directly.
  try {
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    const arr = JSON.parse(cleaned.slice(start, end + 1)) as Array<Record<string, unknown>>;
    return arr
      .filter((it) => it.type === 'text' && typeof it.content === 'string')
      .map((it) => it.content as string);
  } catch {
    return [];
  }
}

// ==================== Sampling ====================

function lastUserMessage(scenario: ContentScenario): string {
  for (let i = scenario.turns.length - 1; i >= 0; i--) {
    if (scenario.turns[i].role === 'user') return scenario.turns[i].text;
  }
  return '';
}

async function sampleVariant(
  scenario: ContentScenario,
  variant: Variant,
  systemPrompt: string,
  openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  agentModel: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  judgeModel: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  studentMessage: string,
  samples: number,
): Promise<SampleResult[]> {
  const tasks = Array.from({ length: samples }, async (): Promise<SampleResult> => {
    try {
      const gen = await callLLM(
        {
          model: agentModel,
          messages: [{ role: 'system', content: systemPrompt }, ...openaiMessages],
        },
        `eval-answer-content-${variant}`,
      );
      const texts = extractTexts(gen.text);
      const leadText = texts[0] ?? '';
      const fullText = texts.join(' ');
      const verdict = await judgeAnswer(
        judgeModel,
        studentMessage,
        scenario.answerKey,
        leadText,
        fullText,
      );
      return { variant, leadText, fullText, verdict };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        variant,
        leadText: '',
        fullText: '',
        verdict: { leads_with_answer: false, answered_anywhere: false, reason: msg, error: true },
        error: msg,
      };
    }
  });
  return Promise.all(tasks);
}

function aggregate(samples: SampleResult[]): VariantAgg {
  const usable = samples.filter((s) => !s.error && !s.verdict.error);
  const n = usable.length || 1;
  const leadsRate = usable.filter((s) => s.verdict.leads_with_answer).length / n;
  const answeredRate = usable.filter((s) => s.verdict.answered_anywhere).length / n;
  return { samples, leadsRate, answeredRate };
}

// ==================== Reporting ====================

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function writeReport(
  runDir: string,
  results: ScenarioResult[],
  modelStr: string,
  judgeStr: string,
  samples: number,
  threshold: number,
): string {
  const lines: string[] = [];
  const overallPass = results.every((r) => r.passes);
  const meanBaseLeads = results.reduce((a, r) => a + r.baseline.leadsRate, 0) / results.length;
  const meanRuleLeads = results.reduce((a, r) => a + r.withRule.leadsRate, 0) / results.length;
  const meanRuleAnswered =
    results.reduce((a, r) => a + r.withRule.answeredRate, 0) / results.length;

  lines.push(`# Agent Answer-Content Eval`, ``);
  lines.push(`- **Date**: ${new Date().toISOString()}`);
  lines.push(`- **Agent model**: ${modelStr}`);
  lines.push(`- **Judge model**: ${judgeStr}`);
  lines.push(`- **Samples per (scenario, variant)**: ${samples}`);
  lines.push(`- **with_rule leads-with-answer threshold**: ${pct(threshold)}`);
  lines.push(``);
  lines.push(`## Aggregate`, ``);
  lines.push(`| Variant | Mean leads-with-answer | Mean answered-anywhere |`);
  lines.push(`|---|---|---|`);
  lines.push(`| baseline (no answering rule) | ${pct(meanBaseLeads)} | — |`);
  lines.push(`| with_rule (as-shipped) | ${pct(meanRuleLeads)} | ${pct(meanRuleAnswered)} |`);
  lines.push(``);
  lines.push(
    `**Drift-then-answer gap (with_rule)**: answered-anywhere ${pct(meanRuleAnswered)} − leads ${pct(meanRuleLeads)} = **${pct(Math.max(0, meanRuleAnswered - meanRuleLeads))}** of replies answered only AFTER a drifting opener.`,
  );
  lines.push(``);
  lines.push(`Overall verdict: **${overallPass ? 'PASS' : 'FAIL'}**`, ``);

  lines.push(`## Per scenario`, ``);
  lines.push(
    `| # | case_id | category | baseline leads | with_rule leads | with_rule answered | Δ leads | pass? |`,
  );
  lines.push(`|---|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.case_id} | ${r.category} | ${pct(r.baseline.leadsRate)} | ${pct(r.withRule.leadsRate)} | ${pct(r.withRule.answeredRate)} | ${pct(r.delta)} | ${r.passes ? '✓' : '✗'} |`,
    );
  });
  lines.push(``);

  lines.push(`## Detail`, ``);
  for (const r of results) {
    lines.push(`### ${r.case_id} ${r.passes ? '✓' : '✗'}`, ``);
    lines.push(`- ${r.description}`);
    lines.push(
      `- baseline leads ${pct(r.baseline.leadsRate)}; with_rule leads ${pct(r.withRule.leadsRate)} / answered ${pct(r.withRule.answeredRate)}; Δ leads ${pct(r.delta)}`,
    );
    lines.push(``, `<details><summary>with_rule samples</summary>`, ``);
    for (const s of r.withRule.samples) {
      if (s.error) {
        lines.push(`- ERROR: ${s.error}`);
        continue;
      }
      const tag = s.verdict.leads_with_answer
        ? 'LEADS'
        : s.verdict.answered_anywhere
          ? 'DRIFT→answered'
          : 'DRIFT';
      lines.push(`- **${tag}** — lead: "${s.leadText.slice(0, 140)}" — ${s.verdict.reason}`);
    }
    lines.push(``, `</details>`, ``);
  }

  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

// ==================== Main ====================

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
}

function loadScenarios(): ContentScenario[] {
  const p = path.join(getCurrentDir(), 'scenarios/answer-content.json');
  const scenarios = JSON.parse(fs.readFileSync(p, 'utf-8')) as ContentScenario[];
  const filter = process.env.EVAL_SCENARIO;
  return filter ? scenarios.filter((s) => s.case_id === filter) : scenarios;
}

async function main() {
  const modelStr = process.env.EVAL_AGENT_MODEL || process.env.DEFAULT_MODEL;
  const judgeStr = process.env.EVAL_JUDGE_MODEL;
  if (!modelStr) {
    console.error(
      'Error: EVAL_AGENT_MODEL (or DEFAULT_MODEL) must be set. Example: EVAL_AGENT_MODEL=google:gemini-3-flash-preview',
    );
    process.exit(1);
  }
  if (!judgeStr) {
    console.error(
      'Error: EVAL_JUDGE_MODEL must be set. Example: EVAL_JUDGE_MODEL=anthropic:claude-haiku-4-5',
    );
    process.exit(1);
  }
  const samples = Number(process.env.EVAL_SAMPLES || '3');
  const threshold = Number(process.env.EVAL_PASS_THRESHOLD || '0.7');

  console.log('=== Agent Answer-Content Eval ===');
  console.log(`Agent: ${modelStr} | Judge: ${judgeStr} | Samples/variant: ${samples}`);

  const { model: agentModel } = await resolveEvalModel(
    'EVAL_AGENT_MODEL',
    process.env.DEFAULT_MODEL,
  );
  const { model: judgeModel } = await resolveEvalModel('EVAL_JUDGE_MODEL');
  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenario(s)`);
  const runDir = createRunDir(OUTPUT_DIR, modelStr);
  console.log(`Output: ${runDir}`);

  const results: ScenarioResult[] = [];
  for (const sc of scenarios) {
    process.stdout.write(`  - ${sc.case_id} ... `);

    const teacher = buildTeacherConfig(sc);
    const storeState = buildStoreState();
    const agentResponses = buildAgentResponses(sc);
    const withRulePrompt = buildStructuredPrompt(
      teacher,
      storeState,
      undefined,
      [],
      undefined,
      agentResponses,
    );
    const baselinePrompt = stripAnsweringSection(withRulePrompt);
    const openaiMessages = convertMessagesToOpenAI(buildMessages(sc), sc.teacherAgentId);
    const studentMessage = lastUserMessage(sc);

    const [bs, ws] = await Promise.all([
      sampleVariant(
        sc,
        'baseline',
        baselinePrompt,
        openaiMessages,
        agentModel,
        judgeModel,
        studentMessage,
        samples,
      ),
      sampleVariant(
        sc,
        'with_rule',
        withRulePrompt,
        openaiMessages,
        agentModel,
        judgeModel,
        studentMessage,
        samples,
      ),
    ]);
    const baseline = aggregate(bs);
    const withRule = aggregate(ws);
    const delta = withRule.leadsRate - baseline.leadsRate;
    const passes = withRule.leadsRate >= threshold;
    results.push({
      case_id: sc.case_id,
      category: sc.category,
      description: sc.description,
      expectedPreFix: sc.expectedPreFix,
      baseline,
      withRule,
      delta,
      passes,
    });
    console.log(
      `baseline=${pct(baseline.leadsRate)} with_rule=${pct(withRule.leadsRate)} answered=${pct(withRule.answeredRate)} ${passes ? 'PASS' : 'FAIL'}`,
    );
  }

  const reportPath = writeReport(runDir, results, modelStr, judgeStr, samples, threshold);
  const overallPass = results.every((r) => r.passes);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Verdict: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
