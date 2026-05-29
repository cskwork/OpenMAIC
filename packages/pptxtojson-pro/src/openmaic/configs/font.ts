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

export function resolveFont(rawName: string | undefined | null): ResolvedFont {
  const cleaned = cleanFontName(rawName);
  if (!cleaned) {
    return { original: '', resolved: '', source: 'whitelist' };
  }

  // 1. Already a self-hosted font — keep, canonicalize casing.
  const canonical = SELF_HOSTED_LOOKUP.get(cleaned.toLowerCase());
  if (canonical) {
    return { original: cleaned, resolved: canonical, source: 'whitelist' };
  }

  // 2. Common PPT/system font → category → primary self-hosted font.
  const category =
    FONT_ALIAS_TO_CATEGORY[cleaned] ??
    FONT_ALIAS_TO_CATEGORY[cleaned.toLowerCase()];
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
