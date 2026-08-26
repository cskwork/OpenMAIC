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
 * The composer UI helpers that build on this definition — caret-relative query
 * resolution (`slashQuery`), whole-handle Backspace (`deleteSkillHandleBefore`),
 * inline pill segmentation (`segmentSkillHandles`), handle insertion
 * (`insertSkillHandle` / `seedSlashQuery`) — are the workbench chat slice's
 * half of this module and are ported below (the agent-runtime slice ported the
 * base definition first; the whole file remains shared, one definition for
 * every rule that has an opinion about `/handle` text).
 */

import { composerTokens, tokenAtCaret, type ComposerToken } from './composer-tokens';

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

/**
 * The `/` query being typed AT THE CARET, or null.
 *
 * The caret is what makes this the token the user is on rather than the draft as a
 * whole. `caret` is REQUIRED, and callers pass the textarea's live `selectionStart`.
 */
export function slashQuery(draft: string, caret: number): string | null {
  return skillHandleName(tokenAtCaret(draft, caret).text);
}

/** A draft with a handle written into it, and where the caret goes next. */
export interface SkillHandleInsertion {
  readonly draft: string;
  readonly caret: number;
}

/**
 * Backspace over a whole handle.
 *
 * A handle is one thing to the reader and one thing to the model, so deleting it
 * one character at a time — leaving `/k12-core-literacy-plannin`, which resolves
 * to nothing — is the wrong unit. With the caret immediately after a handle (or
 * after the space that follows it) one Backspace takes the whole run.
 *
 * Deliberately narrow. It fires ONLY on a collapsed caret sitting at the END of a
 * handle token; anywhere else this returns null and the browser's own editing
 * behaviour stands. Callers must also skip it while an IME is composing.
 */
export function deleteSkillHandleBefore(draft: string, caret: number): SkillHandleInsertion | null {
  if (caret <= 0 || caret > draft.length) return null;
  // The insertion leaves a single trailing space, so the caret usually sits after
  // it rather than against the handle. Step over exactly one.
  const probe = draft[caret - 1] === ' ' ? caret - 1 : caret;
  const token = tokenAtCaret(draft, probe);
  /**
   * The caret has to be at the token's END, not inside it.
   */
  if (token.end !== probe) return null;
  if (!skillHandleName(token.text)) return null;
  return { draft: draft.slice(0, token.start) + draft.slice(caret), caret: token.start };
}

/** One run of the draft, as the mirror layer draws it. */
export interface ComposerTextSegment {
  readonly text: string;
  /** True when this run is a handle that resolves to an installed skill. */
  readonly skill: boolean;
}

/**
 * Cut the draft into plain runs and skill-handle runs, in order.
 *
 * This is what the inline pill is: the composer's mirror layer draws a rounded
 * ground behind the handles this returns (see `components/workbench/composer-input`).
 * Concatenating every `text` back together always reproduces the draft exactly —
 * the pill is decoration over unchanged text, never a transformation of it.
 *
 * A handle counts only when the WHOLE token names an INSTALLED skill.
 */
export function segmentSkillHandles(
  text: string,
  installedNames: readonly string[],
): readonly ComposerTextSegment[] {
  if (text.length === 0) return [];
  const installed = new Set(installedNames);
  if (installed.size === 0) return [{ text, skill: false }];
  const segments: ComposerTextSegment[] = [];
  let plainFrom = 0;
  for (const token of composerTokens(text)) {
    const name = skillHandleName(token.text);
    if (!name || !installed.has(name)) continue;
    if (token.start > plainFrom)
      segments.push({ text: text.slice(plainFrom, token.start), skill: false });
    segments.push({ text: token.text, skill: true });
    plainFrom = token.end;
  }
  if (plainFrom < text.length) segments.push({ text: text.slice(plainFrom), skill: false });
  return segments;
}

/**
 * Write `/skill-name` into the draft AT THE CARET.
 *
 * From the `/` menu the caret sits in the query being typed, so the handle
 * REPLACES that token. From the `+` menu there is no query, so the handle opens a
 * slot exactly where the caret is. Spacing is added only where it is missing, on
 * both sides; the trailing space keeps the next keystroke from extending the
 * handle into a name that no longer resolves.
 */
export function insertSkillHandle(
  draft: string,
  skillName: string,
  caret: number,
): SkillHandleInsertion {
  const handle = `/${skillName}`;
  const token: ComposerToken = tokenAtCaret(draft, caret);
  // A `/query` at the caret is what the menu was filtering, so it is what the
  // pick replaces. Anything else — prose, an `@` token, whitespace — is left
  // alone and the handle goes in beside it.
  const replacing = skillHandleName(token.text) !== null;
  // Where a handle that replaces nothing goes: the caret itself when it sits on
  // whitespace, and otherwise the END of the token it is in.
  const at = token.start === token.end ? token.start : token.end;
  const start = replacing ? token.start : at;
  const end = replacing ? token.end : start;
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' ';
  const trail = /^\s/.test(after) ? '' : ' ';
  const inserted = `${lead}${handle}${trail}`;
  return { draft: `${before}${inserted}${after}`, caret: start + inserted.length };
}

/**
 * Seed a `/` query token at the caret — the skill button's way of opening the
 * slash menu without typing. Returns null when a query is already live at the
 * caret — there is nothing to seed.
 */
export function seedSlashQuery(draft: string, caret: number): SkillHandleInsertion | null {
  if (slashQuery(draft, caret) !== null) return null;
  const token: ComposerToken = tokenAtCaret(draft, caret);
  // When the caret is inside a word, the seed goes to the word's END.
  const at = token.start === token.end ? token.start : token.end;
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' ';
  const inserted = `${lead}/`;
  return { draft: `${before}${inserted}${after}`, caret: at + inserted.length };
}

export type { ComposerToken } from './composer-tokens';
export { composerTokens, tokenAtCaret } from './composer-tokens';
