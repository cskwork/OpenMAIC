/**
 * Provider-neutral per-agent voice design.
 *
 * A `VoiceDesign` is a free-text natural-language description of an agent's
 * vocal identity (not personality) — e.g. "a middle-aged male teacher with a
 * warm low-pitched voice, speaking in a calm, encouraging way". It is consumed
 * by any TTS provider: as an inline voice prompt where supported, or as the
 * seed for a registered/cloned voice (see `voice-registration.ts`). It is
 * deliberately NOT structured: what makes a good voice description differs per
 * provider, so providers shape their own prompts from the text.
 */

export type VoiceDesign = string;

const VOICE_DESIGN_PROMPT_MAX_CHARS = 200;

/** Prefix for deterministic auto-voice ids (provider-neutral, backend-name-safe). */
export const AUTO_VOICE_ID_PREFIX = 'auto-' as const;

/**
 * Compose the description into a synthesis-safe prompt: strips parentheses
 * (VoxCPM uses `(prompt)text` delimiters, so a paren in the descriptor/persona
 * would corrupt the bootstrap synthesis prompt) and control chars, capped.
 */
export function buildVoiceDesignPrompt(design: VoiceDesign): string {
  return (design || '')
    .replace(/[\p{C}]+/gu, ' ')
    .replace(/[()（）]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, VOICE_DESIGN_PROMPT_MAX_CHARS)
    .trim();
}

const REF_TEXT_MIN_CHARS = 20;
const REF_TEXT_MAX_CHARS = 300;

/**
 * Coerce an arbitrary (LLM-produced) value into a usable refText — the seed
 * script an auto voice speaks when bootstrapping its reference clip, persisted
 * on the agent profile as the clip's exact transcript. Strips parentheses
 * (they delimit the VoxCPM `(prompt)text` syntax) and control chars, and
 * rejects scripts too short to be a meaningful seed (the ~5-10s spoken-length
 * target itself is enforced by the profile-generation prompts, not here —
 * a character count can't measure duration across languages).
 */
export function normalizeRefText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/[\p{C}]+/gu, ' ')
    .replace(/[()（）]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, REF_TEXT_MAX_CHARS)
    .trim();
  return cleaned.length >= REF_TEXT_MIN_CHARS ? cleaned : undefined;
}

/** Coerce an arbitrary (LLM-produced) value into a VoiceDesign, or undefined. */
export function normalizeVoiceDesign(raw: unknown): VoiceDesign | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text || undefined;
}

/**
 * Deterministic voice id derived from the descriptor (+ provider + model).
 * Stable across re-synthesis, recomputable anywhere from the descriptor on the
 * agent, and namespaced by provider so a shared registry can't collide.
 *
 * Note: language is intentionally NOT part of the id — the descriptor text is
 * already written in the course language, and language only selects the one-time
 * bootstrap sample sentence (which affects neither output language nor timbre).
 * Keeping it out means every TTS path (narration passes a directive, discussion
 * passes a locale) resolves to the SAME id for the same agent.
 *
 * refText IS part of the id: the registered clip is synthesized from it, so the
 * same design with a different seed script is a different reference recording.
 * Sharing one id across refTexts would silently reuse whichever clip registered
 * first and break the "refText is the exact transcript" contract.
 */
export async function getDeterministicVoiceId(
  design: VoiceDesign,
  opts: { providerId?: string; model?: string; refText?: string } = {},
): Promise<string> {
  const seed = [
    opts.providerId || '',
    design,
    opts.model || '',
    // Appended conditionally so pre-refText voices keep their historical ids
    // (and their cached/registered clips) instead of re-registering en masse.
    ...(opts.refText ? [opts.refText] : []),
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${AUTO_VOICE_ID_PREFIX}${hex.slice(0, 16)}`;
}
