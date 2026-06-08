/**
 * Font resolution used by the PPTX import pipeline.
 *
 * Pipeline:
 *   1. Self-hosted whitelist (the 22 woff2 fonts loaded via @font-face in the
 *      app shell) — kept as-is, canonicalized to the original casing.
 *   2. Alias map: well-known PPT/system Chinese & Latin font names → category
 *      → category's primary self-hosted font. Records as `source: 'fallback'`
 *      so the import pipeline can surface "we replaced X with Y" UI.
 *   3. Unknown — pass-through. Browser falls back per system; anything truly
 *      unrenderable stays the user's responsibility to whitelist.
 */

export type FontCategory = 'sans' | 'serif' | 'kai' | 'fangsong' | 'art';

export interface ResolvedFont {
  /** Cleaned-up source font name (empty when input was nullish). */
  original: string;
  /** Font name to render with — either the original or its replacement. */
  resolved: string;
  /** 'whitelist' = no replacement; 'fallback' = mapped via alias map; 'styled' = reserved. */
  source: 'whitelist' | 'fallback' | 'styled';
}

/**
 * 各风格类别的"主选"自托管字体。PPT 字体不在白名单时，按 category 映射到这里。
 * 选取依据：字宽 / 视觉与 Windows 同风格商业字体接近，以降低替换后的排版偏移风险。
 */
export const PRIMARY_FONT_BY_CATEGORY: Record<FontCategory, string> = {
  sans: 'SourceHanSans',
  serif: 'SourceHanSerif',
  kai: 'FangZhengKaiTi',
  fangsong: 'FangZhengFangSong',
  art: 'SourceHanSans',
};

/**
 * Self-hosted fonts (loaded via @font-face from /font/<name>.woff2 in the app).
 * Stored canonicalized; lookup is case-insensitive.
 */
const SELF_HOSTED_FONTS = [
  'SourceHanSans',
  'SourceHanSerif',
  'FangZhengHeiTi',
  'FangZhengKaiTi',
  'FangZhengShuSong',
  'FangZhengFangSong',
  'AlibabaPuHuiTi',
  'ZhuQueFangSong',
  'LXGWWenKai',
  'WenDingPLKaiTi',
  'DeYiHei',
  'MiSans',
  'CangerXiaowanzi',
  'YousheTitleBlack',
  'FengguangMingrui',
  'ShetuModernSquare',
  'ZcoolHappy',
  'ZizhiQuXiMai',
  'SucaiJishiKangkang',
  'SucaiJishiCoolSquare',
  'TuniuRounded',
  'RuiziZhenyan',
] as const;

const SELF_HOSTED_LOOKUP = new Map<string, string>(
  SELF_HOSTED_FONTS.map((name) => [name.toLowerCase(), name]),
);

/**
 * PPT 常见字体名 → 风格类别的别名表。
 * 命中后会替换为 PRIMARY_FONT_BY_CATEGORY[category]。
 *
 * 匹配规则：去引号、trim 后做"原样命中"或"toLowerCase 命中"。
 * 因此键统一存为：原始中文 / 全小写英文。
 */
const FONT_ALIAS_TO_CATEGORY: Record<string, FontCategory> = {
  // ---- 黑体 / 雅黑 / 等线（系统/商业 sans-serif）----
  微软雅黑: 'sans',
  '微软雅黑 light': 'sans',
  'microsoft yahei': 'sans',
  'microsoft yahei light': 'sans',
  'microsoft yahei ui': 'sans',
  'ms yahei': 'sans',
  黑体: 'sans',
  '黑体-简': 'sans',
  simhei: 'sans',
  stheiti: 'sans',
  'heiti sc': 'sans',
  'heiti tc': 'sans',
  苹方: 'sans',
  '苹方-简': 'sans',
  '苹方-繁': 'sans',
  'pingfang sc': 'sans',
  'pingfang tc': 'sans',
  'pingfang hk': 'sans',
  'hiragino sans': 'sans',
  'hiragino sans gb': 'sans',
  等线: 'sans',
  dengxian: 'sans',
  arial: 'sans',
  helvetica: 'sans',
  'helvetica neue': 'sans',
  tahoma: 'sans',
  verdana: 'sans',
  'segoe ui': 'sans',
  calibri: 'sans',
  'yu gothic': 'sans',
  'noto sans': 'sans',
  'noto sans cjk sc': 'sans',
  'noto sans cjk tc': 'sans',
  思源黑体: 'sans',
  'source han sans': 'sans',
  'source han sans hw': 'sans',

  // ---- 宋体（系统/商业 serif）----
  宋体: 'serif',
  新宋体: 'serif',
  simsun: 'serif',
  nsimsun: 'serif',
  'simsun-extb': 'serif',
  'songti sc': 'serif',
  'songti tc': 'serif',
  华文宋体: 'serif',
  stsong: 'serif',
  stzhongsong: 'serif',
  times: 'serif',
  'times new roman': 'serif',
  georgia: 'serif',
  'noto serif': 'serif',
  'noto serif cjk sc': 'serif',
  思源宋体: 'serif',
  'source han serif': 'serif',
  'source han serif hw': 'serif',

  // ---- 楷体 ----
  楷体: 'kai',
  '楷体-简': 'kai',
  楷体_gb2312: 'kai',
  kaiti: 'kai',
  'kaiti sc': 'kai',
  'kaiti tc': 'kai',
  stkaiti: 'kai',
  华文楷体: 'kai',
  dfkai: 'kai',
  'dfkai-sb': 'kai',
  biaukai: 'kai',

  // ---- 仿宋 ----
  仿宋: 'fangsong',
  仿宋_gb2312: 'fangsong',
  fangsong: 'fangsong',
  stfangsong: 'fangsong',
  'fangsong sc': 'fangsong',
  华文仿宋: 'fangsong',
};

function cleanFontName(raw: string | undefined | null): string {
  if (!raw) return '';
  // Strip the first family from a comma-separated list and unquote it.
  const first = raw.split(',')[0] ?? '';
  return first.trim().replace(/^['"]+|['"]+$/g, '');
}

// Region suffixes appended to CJK font display names (Source Han / Noto family etc).
// Trailing space-delimited tokens — checked case-insensitively.
const REGION_SUFFIXES = new Set([
  'cn', 'sc', 'tc', 'hc', 'hk', 'jp', 'kr', 'k',
  'simplified', 'traditional', 'japanese', 'korean',
  'gb', 'gb2312', 'gbk', 'big5',
]);

// Weight tokens that appear as trailing tokens on font display names. They do
// not change the family identity, only the weight axis — strip them so e.g.
// `思源宋体 CN Light` matches the `思源宋体` alias and maps to SourceHanSerif.
// (Faux-bold/light is the renderer's job, not the resolver's.)
const WEIGHT_SUFFIXES = new Set([
  'thin', 'extralight', 'ultralight', 'light', 'normal', 'regular', 'book',
  'medium', 'demibold', 'semibold', 'bold', 'extrabold', 'ultrabold',
  'heavy', 'black', 'ultra', 'extra',
  'italic', 'oblique',
  'condensed', 'extended',
]);

/**
 * Trailing-token stripper for cleaned font names: pops region/weight tokens
 * from the end and returns the base family identifier. Leaves whitespace-only
 * or single-token names alone so we never collapse `Light` (a brand name) to
 * empty. Operates on a tokens-from-the-end basis so embedded tokens in the
 * middle of a name are preserved.
 */
function stripTrailingFontSuffixes(name: string): string {
  if (!name) return name;
  const tokens = name.split(/\s+/);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1].toLowerCase();
    if (REGION_SUFFIXES.has(last) || WEIGHT_SUFFIXES.has(last)) {
      tokens.pop();
      continue;
    }
    break;
  }
  return tokens.join(' ');
}

export function resolveFont(rawName: string | undefined | null): ResolvedFont {
  const cleaned = cleanFontName(rawName);
  if (!cleaned) {
    return { original: '', resolved: '', source: 'whitelist' };
  }

  // 1. Already a self-hosted font — keep, canonicalize casing. Try the cleaned
  //    name first, then with trailing region/weight suffixes stripped, so
  //    `SourceHanSerif Bold` still resolves to the SourceHanSerif master.
  const stripped = stripTrailingFontSuffixes(cleaned);
  const canonical =
    SELF_HOSTED_LOOKUP.get(cleaned.toLowerCase()) ??
    (stripped !== cleaned ? SELF_HOSTED_LOOKUP.get(stripped.toLowerCase()) : undefined);
  if (canonical) {
    return { original: cleaned, resolved: canonical, source: 'whitelist' };
  }

  // 2. Common PPT/system font → category → primary self-hosted font.
  //    Try the cleaned name first, then progressively strip region/weight
  //    suffixes ("思源宋体 CN Light" → "思源宋体") so brand families with
  //    regional + weight variants don't each need a dedicated alias entry.
  const category =
    FONT_ALIAS_TO_CATEGORY[cleaned] ??
    FONT_ALIAS_TO_CATEGORY[cleaned.toLowerCase()] ??
    (stripped !== cleaned
      ? FONT_ALIAS_TO_CATEGORY[stripped] ??
        FONT_ALIAS_TO_CATEGORY[stripped.toLowerCase()]
      : undefined);
  if (category) {
    return {
      original: cleaned,
      resolved: PRIMARY_FONT_BY_CATEGORY[category],
      source: 'fallback',
    };
  }

  // 3. Unknown — pass through, let the browser fall back per system.
  return { original: cleaned, resolved: cleaned, source: 'whitelist' };
}
