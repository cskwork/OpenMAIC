/**
 * The `/handle` text form of a skill.
 *
 * A skill is TEXT aimed at the model: the system prompt lists every installed
 * skill (`<available_skills>`) and the agent opens the one it needs with pi's
 * native `read` tool. The `/` affordance writes `/skill-name ` into the draft,
 * and that is all a skill is on the wire. The server-side handle readers
 * (`lib/server/agent-runtime/skills.ts`) and the preload path share this same
 * definition of what a handle looks like, so the text the user saw highlighted
 * and the text the server recognizes cannot disagree.
 *
 * The composer UI helpers that build on this definition (caret-relative query
 * resolution, whole-handle Backspace, inline pill segmentation, handle
 * insertion) belong to the workbench UI slice and are not ported here.
 */

/**
 * The skill NAME a token spells, or null when the token is not a handle at all.
 *
 * A `/` starting the token, and a name with no second slash in it. `'/'` on its
 * own spells the EMPTY name — a live query with nothing typed after it yet —
 * and every caller that needs a real skill checks the name is non-empty by
 * looking it up.
 */
export function skillHandleName(token: string): string | null {
  if (!token.startsWith('/')) return null;
  const name = token.slice(1);
  return name.includes('/') ? null : name;
}

// NOTE: the composer-surface helpers (`slashQuery`, `deleteSkillHandleBefore`,
// `segmentSkillHandles`, `insertSkillHandle`) are intentionally not ported in
// this slice — they drive workbench input-box affordances that ship with the
// workbench UI slice, and the agent runtime needs only `skillHandleName` (plus
// `composerTokens` / `tokenAtCaret` from composer-tokens.ts) to recognize the
// handles the server reads out of message text.

export type { ComposerToken } from './composer-tokens';
export { composerTokens, tokenAtCaret } from './composer-tokens';
