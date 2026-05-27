/**
 * Text serializer — maps TextBody to HTML for pptxtojson `content` (Shape.content / Text.content).
 * Migration of pptx-renderer `TextRenderer.renderTextBody`: same inheritance and merge logic;
 * output is an HTML string instead of a DOM container. See textSerializer.md (this folder).
 */

import type { RenderContext } from './RenderContext';
import type { TextBody, TextParagraph, TextRun } from '../model/nodes/ShapeNode';
import type { PlaceholderInfo } from '../model/nodes/BaseNode';
import { SafeXmlNode } from '../parser/XmlParser';
import { resolveColor, resolveColorToCss } from './StyleResolver';
import { emuToPx, pctToDecimal, angleToDeg } from '../parser/units';
import { isAllowedExternalUrl } from '../utils/urlSafety';

// ---------------------------------------------------------------------------
// Wingdings / Symbol Font → Unicode Mapping
// ---------------------------------------------------------------------------

const SYMBOL_FONTS = new Set([
  'wingdings',
  'wingdings 2',
  'wingdings 3',
  'symbol',
  'webdings',
]);

function isSymbolFont(fontName: string | undefined): boolean {
  return !!fontName && SYMBOL_FONTS.has(fontName.toLowerCase());
}

const WINGDINGS: Record<number, string> = {
  0x66: '●', 0x67: '●', 0x6C: '●', 0x6D: '○', 0x6E: '■', 0x6F: '□',
  0x71: '✕', 0x72: '✓', 0x73: '☐', 0x74: '⬥', 0x75: '◆', 0x76: '❖',
  0x77: '⬜', 0x9C: '●', 0x9D: '○', 0x9E: '■', 0x9F: '□',
  0xA1: '✡', 0xA7: '✺', 0xAB: '⇨', 0xFC: '●',
  0xA8: '✶', 0xAA: '⇦', 0xAC: '⇧', 0xAD: '⇩',
  // Arrows
  0xE0: '→', 0xE1: '←', 0xE2: '↑', 0xE3: '↓',
  0xE4: '↔', 0xE5: '↕', 0xE6: '⇒', 0xE7: '⇐',
  0xE8: '⇑', 0xE9: '⇓', 0xEA: '⇔', 0xEB: '⇕',
  0xEF: '➔',
  // Miscellaneous
  0xD5: '✉', 0xD6: '☛', 0xD7: '☞', 0xD8: '✌', 0xFB: '⚫',
};

const WINGDINGS2: Record<number, string> = {
  0x9E: '◉', 0x9F: '⊙', 0x62: '①', 0x63: '②', 0x64: '③',
  0x65: '④', 0x66: '⑤', 0x67: '⑥', 0x68: '⑦', 0x69: '⑧',
  0x6A: '⑨', 0x6B: '⑩', 0x98: '⬥', 0x99: '◇', 0xA3: '✦',
  0xF0: '●', 0xF1: '○', 0xF2: '◉', 0xF3: '◎',
};

const WINGDINGS3: Record<number, string> = {
  0x7D: '▶', 0x7E: '◀', 0x7B: '▲', 0x7C: '▼',
  0x75: '►', 0x76: '◄', 0x77: '▸', 0x78: '◂',
};

const SYMBOL: Record<number, string> = {
  0xB7: '•', 0xD8: '≠', 0xB3: '≥', 0xA3: '≤',
  0xAE: '®', 0xA9: '©', 0xC6: '…',
};

function symbolFontCharToUnicode(char: string, fontName: string): string {
  if (!char || char.length === 0) return char;
  const font = fontName.toLowerCase();
  let code = char.codePointAt(0) ?? 0;
  if (code >= 0xF000 && code <= 0xF0FF) code -= 0xF000;

  let table: Record<number, string> | undefined;
  if (font === 'wingdings') table = WINGDINGS;
  else if (font === 'wingdings 2') table = WINGDINGS2;
  else if (font === 'wingdings 3') table = WINGDINGS3;
  else if (font === 'symbol') table = SYMBOL;

  if (table && table[code]) return table[code];
  return '•';
}

// ---------------------------------------------------------------------------
// Style Inheritance Helpers
// ---------------------------------------------------------------------------

/**
 * Find paragraph properties at a specific indent level from a list style node.
 * Tries lvl{n}pPr (where n = level + 1), then falls back to defPPr.
 */
function findStyleAtLevel(styleNode: SafeXmlNode | undefined, level: number): SafeXmlNode {
  if (!styleNode || !styleNode.exists()) {
    return new SafeXmlNode(null);
  }
  // Try level-specific style (lvl1pPr, lvl2pPr, etc.)
  const lvlNode = styleNode.child(`lvl${level + 1}pPr`);
  if (lvlNode.exists()) return lvlNode;
  // Fall back to default
  return styleNode.child('defPPr');
}

/**
 * Determine the placeholder category for style inheritance.
 * Returns 'title', 'body', or 'other'.
 */
function getPlaceholderCategory(
  placeholder: PlaceholderInfo | undefined,
): 'title' | 'body' | 'other' {
  if (!placeholder) return 'other';
  const t = placeholder.type;
  if (t === 'title' || t === 'ctrTitle') return 'title';
  if (
    t === 'body' ||
    t === 'subTitle' ||
    t === 'obj' ||
    t === 'dt' ||
    t === 'ftr' ||
    t === 'sldNum' ||
    !t
  ) {
    return 'body';
  }
  return 'other';
}

/**
 * Find a placeholder node in a list by matching type and/or idx.
 */
export function findPlaceholderNode(
  placeholders: SafeXmlNode[],
  info: PlaceholderInfo,
): SafeXmlNode | undefined {
  for (const ph of placeholders) {
    // Navigate to the ph element to read its attributes
    let phEl: SafeXmlNode | undefined;
    const nvSpPr = ph.child('nvSpPr');
    if (nvSpPr.exists()) {
      phEl = nvSpPr.child('nvPr').child('ph');
    }
    if (!phEl || !phEl.exists()) {
      const nvPicPr = ph.child('nvPicPr');
      if (nvPicPr.exists()) {
        phEl = nvPicPr.child('nvPr').child('ph');
      }
    }
    if (!phEl || !phEl.exists()) continue;

    const phType = phEl.attr('type');
    const phIdx = phEl.numAttr('idx');

    // Match by idx first (most specific), then by type
    if (info.idx !== undefined && phIdx === info.idx) return ph;
    if (info.type && phType === info.type) return ph;
  }
  return undefined;
}

/**
 * Extract lstStyle from a placeholder shape node.
 */
function getPlaceholderLstStyle(phNode: SafeXmlNode): SafeXmlNode | undefined {
  const txBody = phNode.child('txBody');
  if (!txBody.exists()) return undefined;
  const lstStyle = txBody.child('lstStyle');
  return lstStyle.exists() ? lstStyle : undefined;
}

/**
 * Merge a source paragraph property node onto a target style object.
 * Later calls override earlier values (higher priority wins).
 */
interface MergedParagraphStyle {
  align?: string;
  marginLeft?: number;
  textIndent?: number;
  lineHeight?: string;
  /** True when lineHeight comes from spcPts (absolute pt value). For CJK fonts, CSS line-height
   *  with absolute values may not produce exact spacing because the font's content area can exceed
   *  the line-height. When true, we use block-level line wrappers instead of <br> for line breaks. */
  lineHeightAbsolute?: boolean;
  spaceBefore?: number;
  spaceBeforePct?: number; // percentage of font size (0-1 range)
  spaceAfter?: number;
  spaceAfterPct?: number; // percentage of font size (0-1 range)
  bulletChar?: string;
  bulletFont?: string;
  bulletAutoNum?: string;
  bulletNone?: boolean;
  /** buSzPct: bullet size as percentage of font size (e.g. 73000 → 0.73). */
  bulletSizePct?: number;
  /** When set, bullet color is taken from this OOXML buClr node (a:buClr with srgbClr/schemeClr child). */
  bulletColorNode?: SafeXmlNode;
  defRPrs?: SafeXmlNode[];
}

function mergeParagraphProps(target: MergedParagraphStyle, pPr: SafeXmlNode): void {
  if (!pPr.exists()) return;

  const algn = pPr.attr('algn');
  if (algn) target.align = algn;

  const marL = pPr.numAttr('marL');
  if (marL !== undefined) target.marginLeft = emuToPx(marL);

  const indent = pPr.numAttr('indent');
  if (indent !== undefined) target.textIndent = emuToPx(indent);

  // Line spacing
  // OOXML spcPct: 100000 = "single spacing" = 1.0× the font's line height.
  // IMPORTANT: We must use UNITLESS CSS line-height values (e.g., 1.0, 1.2)
  // instead of percentages (e.g., 100%, 120%). CSS percentage line-height is
  // computed once against the element's own font-size and inherited as a FIXED
  // pixel value — so a parent div with line-height:120% and font-size:16px
  // inherits 19.2px to ALL children, even those with font-size:80pt.
  // Unitless values are inherited as-is and each child recomputes against its
  // own font-size.
  const lnSpc = pPr.child('lnSpc');
  if (lnSpc.exists()) {
    const spcPct = lnSpc.child('spcPct');
    if (spcPct.exists()) {
      const val = spcPct.numAttr('val');
      if (val !== undefined) {
        // OOXML 100000 → CSS unitless 1.0; OOXML 120000 → CSS 1.2
        target.lineHeight = `${parseFloat((val / 100000).toFixed(4))}`;
        // Reset the absolute flag: a spcPct override at a more specific level
        // must not leave a stale `lineHeightAbsolute=true` from an inherited
        // spcPts, otherwise the line wrapper would emit `height: 1.0` (no unit).
        target.lineHeightAbsolute = false;
      }
    }
    const spcPts = lnSpc.child('spcPts');
    if (spcPts.exists()) {
      const val = spcPts.numAttr('val');
      if (val !== undefined) {
        target.lineHeight = `${val / 100}pt`;
        target.lineHeightAbsolute = true;
      }
    }
  }

  // Space before
  const spcBef = pPr.child('spcBef');
  if (spcBef.exists()) {
    const spcPts = spcBef.child('spcPts');
    if (spcPts.exists()) {
      const val = spcPts.numAttr('val');
      if (val !== undefined) target.spaceBefore = val / 100;
    }
    const spcPct = spcBef.child('spcPct');
    if (spcPct.exists()) {
      const val = spcPct.numAttr('val');
      if (val !== undefined) target.spaceBeforePct = val / 100000; // store as ratio
    }
  }

  // Space after
  const spcAft = pPr.child('spcAft');
  if (spcAft.exists()) {
    const spcPts = spcAft.child('spcPts');
    if (spcPts.exists()) {
      const val = spcPts.numAttr('val');
      if (val !== undefined) target.spaceAfter = val / 100;
    }
    const spcPct = spcAft.child('spcPct');
    if (spcPct.exists()) {
      const val = spcPct.numAttr('val');
      if (val !== undefined) target.spaceAfterPct = val / 100000; // store as ratio
    }
  }

  // Bullets
  const buChar = pPr.child('buChar');
  if (buChar.exists()) {
    target.bulletChar = buChar.attr('char') || '';
    target.bulletNone = false;
  }
  const buAutoNum = pPr.child('buAutoNum');
  if (buAutoNum.exists()) {
    target.bulletAutoNum = buAutoNum.attr('type') || 'arabicPeriod';
    target.bulletNone = false;
  }
  const buNone = pPr.child('buNone');
  if (buNone.exists()) {
    target.bulletNone = true;
    target.bulletChar = undefined;
    target.bulletAutoNum = undefined;
  }
  const buFont = pPr.child('buFont');
  if (buFont.exists()) {
    target.bulletFont = buFont.attr('typeface');
  }
  const buSzPct = pPr.child('buSzPct');
  if (buSzPct.exists()) {
    const val = buSzPct.numAttr('val');
    if (val !== undefined) target.bulletSizePct = val / 100000;
  }
  // Explicit bullet color (a:buClr); when present overrides defRPr for bullet color
  const buClr = pPr.child('buClr');
  if (buClr.exists()) {
    target.bulletColorNode = buClr;
  }

  // Default run properties — accumulate across all inheritance levels so that
  // an empty <a:defRPr/> at a lower level doesn't discard the sz/color set by
  // a higher level (e.g. master titleStyle sz="4400").
  const defRPr = pPr.child('defRPr');
  if (defRPr.exists()) {
    if (!target.defRPrs) target.defRPrs = [];
    target.defRPrs.push(defRPr);
  }
}

// ---------------------------------------------------------------------------
// Run Style Resolution
// ---------------------------------------------------------------------------

interface MergedRunStyle {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  fontFamily?: string;
  hlinkClick?: string;
  /** Character spacing (tracking) in points — from a:spc @val (hundredths of pt). */
  letterSpacingPt?: number;
  /** Kerning: minimum font size (pt) for kerning; 0 = always kern. */
  kern?: number;
  /** Text capitalization: "all" = ALL CAPS, "small" = SMALL CAPS, "none" = normal. */
  cap?: string;
  /** Baseline shift in percentage (positive = superscript, negative = subscript). */
  baseline?: number;
  /** CSS gradient string for text fill (from rPr > gradFill). */
  textGradientCss?: string;
  /** When true, text fill is transparent (a:noFill on rPr). */
  textNoFill?: boolean;
  /** Text outline width in px (from a:ln on rPr). */
  textOutlineWidth?: number;
  /** Text outline CSS color (solid fill on ln). */
  textOutlineColor?: string;
  /** Text outline CSS gradient (gradient fill on ln) — used as mask-image for fade effect. */
  textOutlineGradientCss?: string;
}

function mergeRunProps(target: MergedRunStyle, rPr: SafeXmlNode, ctx: RenderContext): void {
  if (!rPr.exists()) return;

  const sz = rPr.numAttr('sz');
  if (sz !== undefined) target.fontSize = sz / 100; // hundredths of point -> pt

  const b = rPr.attr('b');
  if (b !== undefined) target.bold = b === '1' || b === 'true';

  const i = rPr.attr('i');
  if (i !== undefined) target.italic = i === '1' || i === 'true';

  const u = rPr.attr('u');
  if (u !== undefined && u !== 'none') target.underline = true;
  if (u === 'none') target.underline = false;

  const strike = rPr.attr('strike');
  if (strike !== undefined && strike !== 'noStrike') target.strikethrough = true;
  if (strike === 'noStrike') target.strikethrough = false;

  // Color from solidFill or gradFill child.
  // solidFill and gradFill are mutually exclusive fill types in OOXML.
  // When a more specific level sets one, it must clear the other to prevent
  // an inherited gradient from overriding an explicit solid color (or vice versa).
  const solidFill = rPr.child('solidFill');
  if (solidFill.exists()) {
    const { color, alpha } = resolveColor(solidFill, ctx);
    const hex = color.startsWith('#') ? color : `#${color}`;
    if (alpha < 1) {
      const { r, g, b: bl } = hexToRgbInternal(hex);
      target.color = `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
    } else {
      target.color = hex;
    }
    target.textGradientCss = undefined;
  }
  const gradFill = rPr.child('gradFill');
  if (gradFill.exists()) {
    const css = resolveGradientForText(gradFill, ctx);
    if (css) {
      target.textGradientCss = css;
      target.color = undefined;
    }
  }

  // Font family
  const latin = rPr.child('latin');
  if (latin.exists()) {
    const typeface = latin.attr('typeface');
    if (typeface) {
      target.fontFamily = resolveThemeFont(typeface, ctx);
    }
  }
  if (!target.fontFamily) {
    const ea = rPr.child('ea');
    if (ea.exists()) {
      const typeface = ea.attr('typeface');
      if (typeface) {
        target.fontFamily = resolveThemeFont(typeface, ctx);
      }
    }
  }
  if (!target.fontFamily) {
    const cs = rPr.child('cs');
    if (cs.exists()) {
      const typeface = cs.attr('typeface');
      if (typeface) {
        target.fontFamily = resolveThemeFont(typeface, ctx);
      }
    }
  }

  // Hyperlink
  const hlinkClick = rPr.child('hlinkClick');
  if (hlinkClick.exists()) {
    // The actual URL is in the slide rels, referenced by r:id
    const rId = hlinkClick.attr('id') ?? hlinkClick.attr('r:id');
    if (rId) {
      const rel = ctx.slide.rels.get(rId);
      if (rel && rel.targetMode === 'External' && isAllowedExternalUrl(rel.target)) {
        target.hlinkClick = rel.target;
      }
    }
  }

  // Character spacing (compact/tracking): rPr@spc in hundredths of a point
  const spc = rPr.numAttr('spc');
  if (spc !== undefined) target.letterSpacingPt = spc / 100;

  // Kerning: rPr@kern = minimum font size (hundredths of pt) to apply kerning; 0 = always
  const kern = rPr.numAttr('kern');
  if (kern !== undefined) target.kern = kern / 100;

  // Text capitalization: cap="all" (ALL CAPS) or cap="small" (SMALL CAPS)
  const cap = rPr.attr('cap');
  if (cap !== undefined) target.cap = cap;

  // Baseline shift: positive = superscript, negative = subscript (in 1000ths of percent)
  const baseline = rPr.numAttr('baseline');
  if (baseline !== undefined) target.baseline = baseline;

  // Text noFill: a:noFill on rPr makes text interior transparent
  if (rPr.child('noFill').exists()) {
    target.textNoFill = true;
  }

  // Text outline: a:ln on rPr defines text stroke/outline
  const ln = rPr.child('ln');
  if (ln.exists() && !ln.child('noFill').exists()) {
    const lnW = ln.numAttr('w');
    target.textOutlineWidth = lnW ? emuToPx(lnW) : 0.75; // default ~0.75px
    // Solid fill on outline
    const lnSolid = ln.child('solidFill');
    if (lnSolid.exists()) {
      const { color: c, alpha: a } = resolveColor(lnSolid, ctx);
      target.textOutlineColor = colorToCssLocal(c, a);
    }
    // Gradient fill on outline — build CSS gradient for mask effect
    const lnGrad = ln.child('gradFill');
    if (lnGrad.exists()) {
      target.textOutlineGradientCss = resolveGradientForText(lnGrad, ctx);
    }
  }
}

/**
 * Resolve theme font placeholder references like "+mj-lt" or "+mn-lt".
 */
function resolveThemeFont(typeface: string, ctx: RenderContext): string {
  if (typeface === '+mj-lt' || typeface === '+mj-ea' || typeface === '+mj-cs') {
    const key = typeface.slice(4) as 'lt' | 'ea' | 'cs';
    const mapping: Record<string, 'latin' | 'ea' | 'cs'> = { lt: 'latin', ea: 'ea', cs: 'cs' };
    return ctx.theme.majorFont[mapping[key] || 'latin'] || typeface;
  }
  if (typeface === '+mn-lt' || typeface === '+mn-ea' || typeface === '+mn-cs') {
    const key = typeface.slice(4) as 'lt' | 'ea' | 'cs';
    const mapping: Record<string, 'latin' | 'ea' | 'cs'> = { lt: 'latin', ea: 'ea', cs: 'cs' };
    return ctx.theme.minorFont[mapping[key] || 'latin'] || typeface;
  }
  return typeface;
}

/**
 * Minimal hex-to-rgb parser for inline use.
 */
function hexToRgbInternal(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace(/^#/, '');
  const num = parseInt(
    cleaned.length === 3
      ? cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2]
      : cleaned,
    16,
  );
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

/**
 * Convert resolved color + alpha to CSS color string.
 */
function colorToCssLocal(color: string, alpha: number): string {
  const hex = color.startsWith('#') ? color : `#${color}`;
  if (alpha >= 1) return hex;
  const { r, g, b } = hexToRgbInternal(hex);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/**
 * Resolve a gradient fill node into a CSS linear-gradient string.
 * Used for text outline gradient effects.
 */
function resolveGradientForText(gradFill: SafeXmlNode, ctx: RenderContext): string {
  const gsLst = gradFill.child('gsLst');
  const stops: { position: number; color: string }[] = [];
  for (const gs of gsLst.children('gs')) {
    const pos = gs.numAttr('pos') ?? 0;
    const posPercent = pctToDecimal(pos) * 100;
    const { color, alpha } = resolveColor(gs, ctx);
    stops.push({ position: posPercent, color: colorToCssLocal(color, alpha) });
  }
  if (stops.length === 0) return '';
  stops.sort((a, b) => a.position - b.position);
  const stopsStr = stops.map((s) => `${s.color} ${s.position.toFixed(1)}%`).join(', ');
  const lin = gradFill.child('lin');
  if (lin.exists()) {
    const angle = angleToDeg(lin.numAttr('ang') ?? 0);
    const cssAngle = (angle + 90) % 360;
    return `linear-gradient(${cssAngle.toFixed(1)}deg, ${stopsStr})`;
  }
  return `linear-gradient(180deg, ${stopsStr})`;
}

// ---------------------------------------------------------------------------
// Bullet Generation
// ---------------------------------------------------------------------------

function generateAutoNumber(type: string, index: number): string {
  const num = index + 1;
  switch (type) {
    case 'arabicPeriod':
      return `${num}.`;
    case 'arabicParenR':
      return `${num})`;
    case 'arabicParenBoth':
      return `(${num})`;
    case 'arabicPlain':
      return `${num}`;
    case 'romanUcPeriod':
      return `${toRoman(num)}.`;
    case 'romanLcPeriod':
      return `${toRoman(num).toLowerCase()}.`;
    case 'alphaUcPeriod':
      return `${String.fromCharCode(64 + (((num - 1) % 26) + 1))}.`;
    case 'alphaLcPeriod':
      return `${String.fromCharCode(96 + (((num - 1) % 26) + 1))}.`;
    case 'alphaUcParenR':
      return `${String.fromCharCode(64 + (((num - 1) % 26) + 1))})`;
    case 'alphaLcParenR':
      return `${String.fromCharCode(96 + (((num - 1) % 26) + 1))})`;
    default:
      return `${num}.`;
  }
}

function toRoman(num: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  let remaining = num;
  for (let i = 0; i < vals.length; i++) {
    while (remaining >= vals[i]) {
      result += syms[i];
      remaining -= vals[i];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTML string output (replaces DOM container in TextRenderer)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Preserve consecutive spaces (same intent as TextRenderer innerHTML / textContent handling).
 */
function formatRunTextForHtml(raw: string): string {
  if (!raw) return '';
  if (raw.includes('\t')) {
    return escapeHtml(raw);
  }
  let t = escapeHtml(raw);
  if (/ {2}/.test(raw)) {
    t = t.replace(/ {2}/g, ' \u00a0');
  }
  return t;
}

// ---------------------------------------------------------------------------
// Main Render Function
// ---------------------------------------------------------------------------

/**
 * Render a text body into the provided container element.
 *
 * Implements 7-level style inheritance:
 * 1. master.defaultTextStyle
 * 2. master.textStyles[category] (titleStyle / bodyStyle / otherStyle)
 * 3. master placeholder lstStyle
 * 4. layout placeholder lstStyle
 * 5. shape lstStyle
 * 6. paragraph pPr
 * 7. run rPr
 */
/** Optional overrides when rendering text (e.g. table cell style text properties from tcTxStyle). */
export interface RenderTextBodyOptions {
  /** When set, used as text color when the run has no explicit color (e.g. table style tcTxStyle). */
  cellTextColor?: string;
  /** When set, applies bold from table style tcTxStyle (overrides inherited, yields to explicit run rPr). */
  cellTextBold?: boolean;
  /** When set, applies italic from table style tcTxStyle (overrides inherited, yields to explicit run rPr). */
  cellTextItalic?: boolean;
  /** When set, applies font family from table style tcTxStyle (overrides inherited, yields to explicit run rPr). */
  cellTextFontFamily?: string;
  /** fontRef color from shape style (e.g. SmartArt). Overrides inherited styles but yields to explicit run rPr color. */
  fontRefColor?: string;
}

/**
 * Same contract as `TextRenderer.renderTextBody`, but returns an HTML string for `Shape.content` / `Text.content`
 * (types.ts / README) instead of mutating a DOM `container`.
 */
export function renderTextBody(
  textBody: TextBody | undefined,
  placeholder: PlaceholderInfo | undefined,
  ctx: RenderContext,
  options?: RenderTextBodyOptions,
): string {
  if (!textBody?.paragraphs?.length) return '';

  const category = getPlaceholderCategory(placeholder);
  let bulletCounter = 0;
  const noWrap = textBody.bodyProperties?.attr('wrap') === 'none';

  let html = '';

  for (const paragraph of textBody.paragraphs) {
    const level = paragraph.level;

    // ---- Build merged paragraph style (7-level inheritance) ----
    const merged: MergedParagraphStyle = {};

    // Level 1: master defaultTextStyle
    mergeParagraphProps(merged, findStyleAtLevel(ctx.master.defaultTextStyle, level));

    // Level 2: master text styles by category
    const masterTextStyle =
      category === 'title'
        ? ctx.master.textStyles.titleStyle
        : category === 'body'
          ? ctx.master.textStyles.bodyStyle
          : ctx.master.textStyles.otherStyle;
    mergeParagraphProps(merged, findStyleAtLevel(masterTextStyle, level));

    // Level 3: master placeholder lstStyle
    if (placeholder) {
      const masterPh = findPlaceholderNode(ctx.master.placeholders, placeholder);
      if (masterPh) {
        const lstStyle = getPlaceholderLstStyle(masterPh);
        mergeParagraphProps(merged, findStyleAtLevel(lstStyle, level));
      }
    }

    // Level 4: layout placeholder lstStyle
    if (placeholder) {
      const layoutPh = findPlaceholderNode(
        ctx.layout.placeholders.map((e) => e.node),
        placeholder,
      );
      if (layoutPh) {
        const lstStyle = getPlaceholderLstStyle(layoutPh);
        mergeParagraphProps(merged, findStyleAtLevel(lstStyle, level));
      }
    }

    // Level 5: shape lstStyle
    mergeParagraphProps(merged, findStyleAtLevel(textBody.listStyle, level));

    // Level 6: paragraph pPr
    if (paragraph.properties) {
      mergeParagraphProps(merged, paragraph.properties);
    }

    // ---- Apply paragraph styles (equivalent to paraDiv.style.* in TextRenderer) ----
    const paraCssParts: string[] = [];
    if (merged.align) {
      const alignMap: Record<string, string> = {
        l: 'left',
        ctr: 'center',
        r: 'right',
        just: 'justify',
        dist: 'justify',
      };
      paraCssParts.push(`text-align: ${alignMap[merged.align] || 'left'}`);
    }
    if (merged.marginLeft !== undefined) {
      paraCssParts.push(`margin-left: ${merged.marginLeft}px`);
    }
    if (merged.textIndent !== undefined) {
      paraCssParts.push(`text-indent: ${merged.textIndent}px`);
    }
    if (merged.lineHeight) {
      paraCssParts.push(`line-height: ${merged.lineHeight}`);
    }
    // Determine effective font size for percentage-based spacing
    // Use defRPr or first run's font size, fallback to 12pt
    let effectiveFontSize = 12; // default 12pt
    if (merged.defRPrs) {
      for (const drp of merged.defRPrs) {
        const sz = drp.numAttr('sz');
        if (sz !== undefined) effectiveFontSize = sz / 100;
      }
    }
    if (paragraph.runs.length > 0 && paragraph.runs[0].properties) {
      const sz = paragraph.runs[0].properties.numAttr('sz');
      if (sz !== undefined) effectiveFontSize = sz / 100;
    }

    if (merged.spaceBefore !== undefined && merged.spaceBefore !== 0) {
      paraCssParts.push(`margin-top: ${merged.spaceBefore}pt`);
    } else if (merged.spaceBeforePct !== undefined && merged.spaceBeforePct !== 0) {
      paraCssParts.push(`margin-top: ${merged.spaceBeforePct * effectiveFontSize}pt`);
    }
    if (merged.spaceAfter !== undefined && merged.spaceAfter !== 0) {
      paraCssParts.push(`margin-bottom: ${merged.spaceAfter}pt`);
    } else if (merged.spaceAfterPct !== undefined && merged.spaceAfterPct !== 0) {
      paraCssParts.push(`margin-bottom: ${merged.spaceAfterPct * effectiveFontSize}pt`);
    }

    // ---- Bullets ----
    // Suppress bullets for metadata placeholders (slide number, date, footer)
    // Also suppress for empty paragraphs (no visible runs) — PowerPoint never shows bullets for them
    const hasVisibleRuns = paragraph.runs.some((r) => r.text != null && r.text.length > 0);
    const suppressBullet =
      !hasVisibleRuns ||
      placeholder?.type === 'sldNum' ||
      placeholder?.type === 'dt' ||
      placeholder?.type === 'ftr' ||
      placeholder?.type === 'title' ||
      placeholder?.type === 'ctrTitle' ||
      placeholder?.type === 'subTitle';
    let bulletPrefix = '';
    if (!suppressBullet && merged.bulletNone !== true) {
      if (merged.bulletChar) {
        bulletPrefix = merged.bulletChar;
      } else if (merged.bulletAutoNum) {
        bulletPrefix = generateAutoNumber(merged.bulletAutoNum, bulletCounter);
        bulletCounter++;
      }
    }

    // When line spacing is absolute (spcPts), wrap each line in a block-level
    // div with explicit height. This ensures exact spacing regardless of font
    // metrics — CJK fonts (e.g. Microsoft YaHei) and bold faces often have
    // ascent+descent larger than the spcPts value, which causes the browser
    // to grow the line-box past the CSS line-height and silently overflow the
    // text frame. Using a fixed-height div with overflow: visible keeps each
    // line's layout footprint at exactly spcPts, matching PowerPoint behavior
    // even for single-line paragraphs.
    // Set tab-size when paragraph contains tab characters (default OOXML tab spacing = 914400 EMU = 96px)
    if (paragraph.runs.some((r) => r.text?.includes('\t'))) {
      const defaultTabPx = 96; // 914400 EMU at 96 dpi
      paraCssParts.push(`tab-size: ${defaultTabPx}px`);
    }
    if (noWrap) {
      paraCssParts.push('white-space: nowrap');
    }
    const useLineWrappers = !!(merged.lineHeightAbsolute && merged.lineHeight);

    const paraCss = paraCssParts.join(';');
    const openTag = useLineWrappers
      ? `<div${paraCss ? ` style="${paraCss};"` : ''}>`
      : `<p${paraCss ? ` style="${paraCss};"` : ''}>`;
    const closeTag = useLineWrappers ? '</div>' : '</p>';
    html += openTag;

    // Build bullet HTML up front. We emit it AFTER opening the line wrapper
    // (when wrappers are on) so the bullet sits inline with the first line of
    // content; emitting an inline <span> before a block-level wrapper <div>
    // would push the content onto the next line and shift the whole paragraph.
    let bulletHtml = '';
    if (bulletPrefix) {
      // Bullet color: 1) explicit buClr from list style, 2) paragraph defRPr, 3) first run's color (so bullet matches text), 4) cell/fallback
      let bulletColor: string | undefined;
      if (merged.bulletColorNode && merged.bulletColorNode.exists()) {
        bulletColor = resolveColorToCss(merged.bulletColorNode, ctx);
      }
      if (bulletColor === undefined && merged.defRPrs) {
        const bulletRunStyle: MergedRunStyle = {};
        for (const drp of merged.defRPrs) mergeRunProps(bulletRunStyle, drp, ctx);
        bulletColor = bulletRunStyle.color;
      }
      if (bulletColor === undefined && paragraph.runs.length > 0) {
        const runStyle: MergedRunStyle = {};
        if (merged.defRPrs) {
          for (const drp of merged.defRPrs) mergeRunProps(runStyle, drp, ctx);
        }
        if (paragraph.runs[0].properties)
          mergeRunProps(runStyle, paragraph.runs[0].properties, ctx);
        bulletColor = runStyle.color;
      }
      // Fallback: check shape's lstStyle defRPr for color (same as run fallback)
      if (bulletColor === undefined && textBody.listStyle) {
        const lstStyleLevel = findStyleAtLevel(textBody.listStyle, level);
        if (lstStyleLevel.exists()) {
          const lstDefRPr = lstStyleLevel.child('defRPr');
          if (lstDefRPr.exists()) {
            const fallbackStyle: MergedRunStyle = {};
            mergeRunProps(fallbackStyle, lstDefRPr, ctx);
            if (fallbackStyle.color !== undefined) {
              bulletColor = fallbackStyle.color;
            }
          }
        }
      }
      const bColor =
        bulletColor ?? options?.fontRefColor ?? options?.cellTextColor ?? '#000000';

      let displayChar = bulletPrefix;
      let bFontCss = '';
      if (merged.bulletFont && isSymbolFont(merged.bulletFont)) {
        displayChar = symbolFontCharToUnicode(bulletPrefix, merged.bulletFont);
      } else if (merged.bulletFont) {
        bFontCss = `font-family: ${merged.bulletFont};`;
      }

      let bSizeCss = '';
      if (merged.bulletSizePct !== undefined && merged.bulletSizePct !== 1) {
        const runFontSize = effectiveFontSize;
        const bulletPt = runFontSize * merged.bulletSizePct;
        bSizeCss = `font-size: ${bulletPt.toFixed(1)}pt;`;
      }

      bulletHtml = `<span style="${bFontCss}${bSizeCss}color: ${bColor};">${escapeHtml(displayChar)} </span>`;
    }

    let currentLineDivOpen = false;
    const openLineWrapper = () => {
      if (!useLineWrappers || !merged.lineHeight) return;
      html += `<div style="height: ${merged.lineHeight};overflow: visible">`;
      currentLineDivOpen = true;
    };
    const closeLineWrapper = () => {
      if (currentLineDivOpen) {
        html += '</div>';
        currentLineDivOpen = false;
      }
    };

    if (useLineWrappers) {
      // wrapper mode: open wrapper then emit bullet inside, so the inline
      // bullet shares the first line baseline with the run content. Empty
      // paragraphs need no <br/> — the wrapper <div> already has a fixed line
      // height, and an extra <br/> would double the empty paragraph's footprint.
      openLineWrapper();
      html += bulletHtml;
    } else {
      // legacy <p> path: keep the original order — bullet first, then a <br/>
      // when the paragraph is otherwise empty so it still collapses to one
      // visible line.
      html += bulletHtml;
      if (paragraph.runs.length === 0) {
        html += '<br/>';
      }
    }

    // Merge consecutive runs with identical style strings into a single <span>,
    // matching pptxtojson's compact HTML output for better pptist compatibility.
    let prevStyleStr: string | null = null;
    let prevIsLink = false;
    let accumulatedText = '';

    const flushAccumulatedRun = () => {
      if (!accumulatedText || prevStyleStr === null) return;
      html += `<span style="${prevStyleStr}">${accumulatedText}</span>`;
      accumulatedText = '';
    };

    for (const run of paragraph.runs) {
      if (run.text === '\n') {
        flushAccumulatedRun();
        prevStyleStr = null;
        if (useLineWrappers) {
          closeLineWrapper();
          openLineWrapper();
        } else {
          html += '<br/>';
        }
        continue;
      }

      // Build merged run style
      const runStyle: MergedRunStyle = {};

      // Apply default run properties from all inherited defRPr nodes
      if (merged.defRPrs) {
        for (const drp of merged.defRPrs) mergeRunProps(runStyle, drp, ctx);
      }

      // Level 7: run rPr
      if (run.properties) {
        mergeRunProps(runStyle, run.properties, ctx);
      }

      // Fallback: if no color resolved yet, check the shape's lstStyle defRPr.
      if (runStyle.color === undefined && textBody.listStyle) {
        const lstStyleLevel = findStyleAtLevel(textBody.listStyle, level);
        if (lstStyleLevel.exists()) {
          const lstDefRPr = lstStyleLevel.child('defRPr');
          if (lstDefRPr.exists()) {
            const fallbackStyle: MergedRunStyle = {};
            mergeRunProps(fallbackStyle, lstDefRPr, ctx);
            if (fallbackStyle.color !== undefined) {
              runStyle.color = fallbackStyle.color;
            }
          }
        }
      }

      let runText = run.text ?? '';
      if (run.properties) {
        const symNode = run.properties.child('sym');
        if (symNode.exists()) {
          const symTypeface = symNode.attr('typeface');
          if (isSymbolFont(symTypeface)) {
            runText = Array.from(runText)
              .map((ch) => symbolFontCharToUnicode(ch, symTypeface!))
              .join('');
          }
        }
      }
      const inner = formatRunTextForHtml(runText);
      const tabStyleSuffix = runText.includes('\t') ? ';white-space: pre' : '';

      const styleStr = runStylesToCssString(runStyle, run, options, ctx) + tabStyleSuffix;
      const isLink = !!runStyle.hlinkClick;

      if (isLink) {
        flushAccumulatedRun();
        prevStyleStr = null;
        const href = escapeHtmlAttr(runStyle.hlinkClick!);
        html += `<a href="${href}" target="_blank" rel="noopener noreferrer" style="${styleStr}">${inner}</a>`;
      } else if (prevStyleStr === styleStr && !prevIsLink) {
        accumulatedText += inner;
      } else {
        flushAccumulatedRun();
        prevStyleStr = styleStr;
        accumulatedText = inner;
      }
      prevIsLink = isLink;
    }
    flushAccumulatedRun();

    if (useLineWrappers) {
      closeLineWrapper();
    }

    // endParaRPr: when the paragraph ends with a line break (trailing \n),
    // the end-of-paragraph mark (endParaRPr) defines the font size for the
    // trailing blank line. Without this, bottom-anchored text boxes render
    // content too low because the trailing space is too small.
    if (paragraph.endParaRPr) {
      const lastRun = paragraph.runs[paragraph.runs.length - 1];
      if (lastRun?.text === '\n') {
        const epSz = paragraph.endParaRPr.numAttr('sz');
        if (epSz !== undefined) {
          html += `<span style="font-size: ${(epSz / 100).toFixed(4)}pt">&#x200B;</span>`;
        }
      }
    }

    html += closeTag;
  }

  // Apply bodyPr text insets (lIns/rIns/tIns/bIns) as a wrapping div with padding.
  // OOXML defaults: lIns=91440, tIns=45720, rIns=91440, bIns=45720 (EMU).
  // Always emit the padding wrapper so the consumer doesn't need to know defaults.
  const bp = textBody.bodyProperties;
  if (bp?.exists()) {
    const DEFAULT_H_INSET = 91440;
    const DEFAULT_V_INSET = 45720;
    const lIns = bp.numAttr('lIns') ?? DEFAULT_H_INSET;
    const rIns = bp.numAttr('rIns') ?? DEFAULT_H_INSET;
    const tIns = bp.numAttr('tIns') ?? DEFAULT_V_INSET;
    const bIns = bp.numAttr('bIns') ?? DEFAULT_V_INSET;
    const pt = (emu: number) => parseFloat((emu / 12700).toFixed(2));
    html = `<div style="padding: ${pt(tIns)}pt ${pt(rIns)}pt ${pt(bIns)}pt ${pt(lIns)}pt;">${html}</div>`;
  }

  return html;
}

/** Maps TextRenderer run loop (element.style) to a single `style=""` string. */
function runStylesToCssString(
  runStyle: MergedRunStyle,
  run: TextRun,
  options: RenderTextBodyOptions | undefined,
  ctx: RenderContext,
): string {
  const fontSize = runStyle.fontSize || 12;
  const parts: string[] = [];
  parts.push(`font-size: ${fontSize}pt`);

  // Bold: explicit run rPr > cellTextBold (table style tcTxStyle) > inherited styles
  const hasExplicitRunBold = run.properties?.attr('b') !== undefined;
  if (hasExplicitRunBold ? runStyle.bold : (options?.cellTextBold ?? runStyle.bold)) {
    parts.push('font-weight: bold');
  }
  // Italic: explicit run rPr > cellTextItalic (table style tcTxStyle) > inherited styles
  const hasExplicitRunItalic = run.properties?.attr('i') !== undefined;
  if (hasExplicitRunItalic ? runStyle.italic : (options?.cellTextItalic ?? runStyle.italic)) {
    parts.push('font-style: italic');
  }

  const decorations: string[] = [];
  if (runStyle.underline) decorations.push('underline');
  if (runStyle.strikethrough) decorations.push('line-through');
  if (decorations.length > 0) {
    parts.push(`text-decoration: ${decorations.join(' ')}`);
  }

  // Color priority: explicit run rPr > hlink theme color > cellTextColor (table style tcTxStyle) > fontRef (shape style) > inherited styles > black default
  // cellTextColor from table style overrides inherited cascade colors but yields to explicit run/paragraph solidFill/gradFill.
  // fontRefColor overrides inherited styles but yields to explicit run solidFill/gradFill.
  const hasExplicitRunColor =
    run.properties?.child('solidFill').exists() || run.properties?.child('gradFill').exists();
  let effectiveColor: string | undefined;
  if (options?.fontRefColor) {
    effectiveColor = hasExplicitRunColor ? runStyle.color : options.fontRefColor;
  } else if (options?.cellTextColor && !hasExplicitRunColor) {
    effectiveColor = options.cellTextColor;
  } else {
    effectiveColor = runStyle.color;
  }

  // Hyperlink default color: when the run is a hyperlink and has no explicit
  // solidFill on its own rPr, use the theme's hlink color.  This matches
  // PowerPoint behaviour where hyperlink text defaults to the hlink scheme color.
  if (runStyle.hlinkClick && !hasExplicitRunColor) {
    const hlinkHex = ctx.theme.colorScheme.get('hlink');
    if (hlinkHex) {
      effectiveColor = hlinkHex.startsWith('#') ? hlinkHex : `#${hlinkHex}`;
    }
  }

  if (effectiveColor) {
    parts.push(`color: ${effectiveColor}`);
  } else {
    // No explicit color from run/paragraph/style: use black so text does not inherit page CSS (e.g. body { color: #e0e0e0 })
    parts.push('color: #000000');
  }

  // Gradient text fill: use background-clip to paint text with gradient
  if (runStyle.textGradientCss) {
    parts.push(`background: ${runStyle.textGradientCss}`);
    parts.push('-webkit-background-clip: text');
    parts.push('background-clip: text');
    parts.push('color: transparent');
  }

  // Text outline (a:ln on rPr) and noFill handling
  if (runStyle.textNoFill || runStyle.textOutlineWidth) {
    const strokeW = runStyle.textOutlineWidth ?? 0.75;
    if (runStyle.textNoFill && runStyle.textOutlineGradientCss) {
      // Ghost text: no fill + gradient outline → show outline fading via mask
      const outlineColor = '#ffffff'; // base stroke color (gradient applied via mask)
      parts.push('color: transparent');
      parts.push(`-webkit-text-stroke-width: ${strokeW}px`);
      parts.push(`-webkit-text-stroke-color: ${outlineColor}`);
      parts.push('paint-order: stroke fill');
      const maskGrad = runStyle.textOutlineGradientCss;
      parts.push(`mask-image: ${maskGrad}`);
      parts.push(`-webkit-mask-image: ${maskGrad}`);
    } else if (runStyle.textNoFill && runStyle.textOutlineColor) {
      // Ghost text with solid outline
      parts.push('color: transparent');
      parts.push(`-webkit-text-stroke-width: ${strokeW}px`);
      parts.push(`-webkit-text-stroke-color: ${runStyle.textOutlineColor}`);
      parts.push('paint-order: stroke fill');
    } else if (runStyle.textNoFill) {
      // noFill with no outline — invisible text (but keep space)
      parts.push('color: transparent');
    } else if (runStyle.textOutlineColor) {
      // Outline with normal fill
      parts.push(`-webkit-text-stroke-width: ${strokeW}px`);
      parts.push(`-webkit-text-stroke-color: ${runStyle.textOutlineColor}`);
      parts.push('paint-order: stroke fill');
    }
  }

  // Font family: explicit run rPr > cellTextFontFamily (table style) > inherited > theme fallback
  const hasExplicitRunFont =
    run.properties?.child('latin').exists() ||
    run.properties?.child('ea').exists() ||
    run.properties?.child('cs').exists();
  const effectiveFont = hasExplicitRunFont
    ? runStyle.fontFamily
    : (options?.cellTextFontFamily ?? runStyle.fontFamily);
  if (effectiveFont) {
    parts.push(`font-family: ${effectiveFont}`);
  } else {
    // Fallback to theme minor font
    const fallback = ctx.theme.minorFont.latin || ctx.theme.minorFont.ea;
    if (fallback) {
      parts.push(`font-family: ${fallback}`);
    }
  }

  // Character spacing (a:spc) — compact/tracking in points
  if (runStyle.letterSpacingPt !== undefined) {
    parts.push(`letter-spacing: ${runStyle.letterSpacingPt}pt`);
  }
  // Kerning (a:kern): val = min font size (pt) to kern; 0 = always kern
  if (runStyle.kern !== undefined) {
    const effectivePt = runStyle.fontSize || 12;
    parts.push(`font-kerning: ${effectivePt >= runStyle.kern ? 'normal' : 'none'}`);
  }

  // Text capitalization (a:rPr@cap)
  if (runStyle.cap === 'all') {
    parts.push('text-transform: uppercase');
  } else if (runStyle.cap === 'small') {
    parts.push('font-variant: small-caps');
  }

  // Baseline shift (superscript/subscript)
  if (runStyle.baseline !== undefined && runStyle.baseline !== 0) {
    // OOXML baseline is in 1000ths of percent; positive = superscript, negative = subscript
    const shiftPct = runStyle.baseline / 1000;
    parts.push(`vertical-align: ${shiftPct}%`);
    // Reduce font size for super/subscript
    if (Math.abs(shiftPct) >= 20) {
      parts.push(`font-size: ${fontSize * 0.65}pt`);
    }
  }

  return parts.join(';') + (parts.length ? ';' : '');
}
