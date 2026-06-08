/**
 * LLM-as-judge for the agent answer-content eval.
 *
 * Given the student's latest message and the AI teacher's reply, decides:
 *   - leads_with_answer : does the FIRST sentence already address the literal
 *                         question / request? (this is the bug we hunt —
 *                         "first sentence drifts, a later one answers")
 *   - answered_anywhere : does the reply address it AT ALL, even if late?
 *
 * The gap (answered_anywhere && !leads_with_answer) is exactly the
 * "drift-then-answer" pathology this eval targets.
 *
 * Unlike the director routing eval (deterministic TEACHER/USER/END check),
 * answer quality is not mechanically decidable, so we use an LLM judge —
 * mirroring eval/outline-language/judge.ts.
 */

import { generateText, type LanguageModel } from 'ai';

export interface AnswerVerdict {
  /** First sentence(s) already address the literal question/request. */
  leads_with_answer: boolean;
  /** The reply addresses it at all, even if buried after a lead that drifts. */
  answered_anywhere: boolean;
  reason: string;
  /** Set when the judge response could not be parsed. */
  error?: boolean;
}

const JUDGE_SYSTEM_PROMPT = `You evaluate whether an AI teacher's reply ANSWERS the student's most recent message in a live classroom.

You are given:
1. The student's latest message
2. An "answer key" describing what a correct reply must do
3. The AI's FIRST sentence(s) (its opening)
4. The AI's FULL reply

A reply "addresses" the message when it does what the answer key asks: gives the specific value/formula/yes-no/definition/steps; OR for a vague request, asks ONE specific clarifying question; OR for an error report, acknowledges/corrects it; OR for a format/capability request (e.g. "in Chinese", "make a video", "skip the page"), honors it or directly says it cannot / what it will do instead.

Fairness for specific request types:
- LANGUAGE / FORMAT requests are satisfied when the reply is PRIMARILY in the requested language/format. Keeping individual technical terms, proper nouns, or formulas in their standard (often English) form is normal and still counts as honoring the request — do not penalize that code-switching.
- NAVIGATION / PACING requests ("skip to the next page", "move on") are satisfied when the reply acknowledges the request AND transitions to the next slide's content/topic. A verbal transition counts; an explicit page-turn action is NOT required. Only continuing to narrate the SAME current slide, or ignoring the request, counts as not addressing it.

A reply does NOT address it when it instead: greets ("Welcome!"), launches an opening lecture ("Today we examine…"), pivots to an adjacent (non-requested) topic, reacts to peers, asks a rhetorical lead-in unrelated to the request, or answers a different question than the one asked.

Judge TWO things independently:
- leads_with_answer: is the literal question/request addressed in the FIRST sentence(s) (field 3)?
- answered_anywhere: is it addressed ANYWHERE in the FULL reply (field 4), even if the opening drifted?

Be reasonable, not pedantic about wording. A correct answer phrased differently from the answer key still passes. Judge substance, not politeness.

Respond with ONLY a JSON object, no code fences:
{"leads_with_answer": true/false, "answered_anywhere": true/false, "reason": "1-2 sentences"}`;

export async function judgeAnswer(
  judgeModel: LanguageModel,
  studentMessage: string,
  answerKey: string,
  leadReply: string,
  fullReply: string,
): Promise<AnswerVerdict> {
  const result = await generateText({
    model: judgeModel,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: `Student's latest message: "${studentMessage}"

Answer key (what a correct reply must do): "${answerKey}"

AI's FIRST sentence(s): "${leadReply || '(no text — only actions / empty)'}"

AI's FULL reply: "${fullReply || '(no text — only actions / empty)'}"`,
    temperature: 0,
  });

  try {
    const text = result.text.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(text) as Partial<AnswerVerdict>;
    return {
      leads_with_answer: Boolean(parsed.leads_with_answer),
      answered_anywhere: Boolean(parsed.answered_anywhere),
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return {
      leads_with_answer: false,
      answered_anywhere: false,
      reason: `Failed to parse judge response: ${result.text.slice(0, 200)}`,
      error: true,
    };
  }
}
