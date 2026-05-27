/**
 * Font resolution used by the PPTX import pipeline.
 *
 * STUB: pass-through implementation. Every requested font is reported as
 * already on the whitelist, so transform never records replacements into
 * `replacedFonts`. This loses the "we replaced Microsoft YaHei with X"
 * UI signal but works for any font name.
 *
 * To harden later: port PPTist's font whitelist + style-based fallback
 * (Sans / Serif / Hand / Display / Mono buckets) and implement real
 * matching against `FONTS`.
 */

export interface ResolvedFont {
  /** Cleaned-up source font name (empty when input was nullish). */
  original: string;
  /** Font name to render with — either the original or its replacement. */
  resolved: string;
  /** 'whitelist' = no replacement; 'fallback' / other = replaced and should be bucketed. */
  source: 'whitelist' | 'fallback' | 'styled';
}

function cleanFontName(raw: string | undefined | null): string {
  if (!raw) return '';
  // Strip the first family from a comma-separated list and unquote it.
  const first = raw.split(',')[0] ?? '';
  return first.trim().replace(/^['"]+|['"]+$/g, '');
}

export function resolveFont(rawName: string | undefined | null): ResolvedFont {
  const cleaned = cleanFontName(rawName);
  return {
    original: cleaned,
    resolved: cleaned,
    source: 'whitelist',
  };
}
