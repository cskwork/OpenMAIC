/**
 * Math serializer — converts MathNodeData into a Math element with LaTeX.
 *
 * Pipeline: OMML XML → normalizeOmmlXml (surrogate-safe Unicode normalization)
 *         → omml2mathml (MathML DOM) → mathml-to-latex (LaTeX string)
 *         → postProcessLatex (clean up remaining Unicode / HTML entities)
 */

import type { MathNodeData } from '../model/nodes/MathNode';
import type { RenderContext } from './RenderContext';
import type { Math as MathElement } from '../adapter/types';
import { resolveMediaToUrl } from '../utils/mediaWebConvert';
import { resolveMediaPath } from '../utils/media';
import { DOMParser } from '@xmldom/xmldom';
import { parseDocxMathContent } from '../utils/eqFieldParser';
import JSZip from 'jszip';

// @ts-expect-error — omml2mathml has no type declarations
import omml2mathml from 'omml2mathml';
import mathmlToLatex from 'mathml-to-latex';
const MathMLToLaTeX = mathmlToLatex.MathMLToLaTeX ?? mathmlToLatex;

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return Number((px * PX_TO_PT).toFixed(4));
}

// ---------------------------------------------------------------------------
// Unicode Mathematical Alphanumeric Symbols normalization
// ---------------------------------------------------------------------------
// PPTX stores math variables using Unicode Mathematical Italic/Bold codepoints
// (e.g. U+1D465 "𝑥" instead of "x", U+1D6FC "𝛼" instead of "α").
//
// Two-stage normalization:
//   1. normalizeOmmlXml (pre-omml2mathml): converts to plain Unicode only
//      (ASCII for Latin, basic Greek for Greek). No LaTeX commands — those
//      would corrupt the XML structure and get split into separate elements.
//   2. postProcessLatex (post-mathml-to-latex): converts remaining basic
//      Greek Unicode to LaTeX commands (\alpha, \beta, etc.) and cleans up
//      HTML entities / invisible operators.

// --- Greek LaTeX command tables (used in stage 2) ---

const GREEK_LOWER_LATEX: Record<number, string> = {
  0x03B1: '\\alpha', 0x03B2: '\\beta', 0x03B3: '\\gamma', 0x03B4: '\\delta',
  0x03B5: '\\epsilon', 0x03B6: '\\zeta', 0x03B7: '\\eta', 0x03B8: '\\theta',
  0x03B9: '\\iota', 0x03BA: '\\kappa', 0x03BB: '\\lambda', 0x03BC: '\\mu',
  0x03BD: '\\nu', 0x03BE: '\\xi', 0x03C0: '\\pi', 0x03C1: '\\rho',
  0x03C2: '\\varsigma', 0x03C3: '\\sigma', 0x03C4: '\\tau', 0x03C5: '\\upsilon',
  0x03C6: '\\varphi', 0x03C7: '\\chi', 0x03C8: '\\psi', 0x03C9: '\\omega',
};
const GREEK_UPPER_LATEX: Record<number, string> = {
  0x0391: 'A', 0x0392: 'B', 0x0393: '\\Gamma', 0x0394: '\\Delta',
  0x0395: 'E', 0x0396: 'Z', 0x0397: 'H', 0x0398: '\\Theta',
  0x0399: 'I', 0x039A: 'K', 0x039B: '\\Lambda', 0x039C: 'M',
  0x039D: 'N', 0x039E: '\\Xi', 0x039F: 'O', 0x03A0: '\\Pi',
  0x03A1: 'P', 0x03A3: '\\Sigma', 0x03A4: 'T', 0x03A5: '\\Upsilon',
  0x03A6: '\\Phi', 0x03A7: 'X', 0x03A8: '\\Psi', 0x03A9: '\\Omega',
};

// ---------------------------------------------------------------------------
// Stage 1: Unicode → plain Unicode (for XML pre-processing)
// ---------------------------------------------------------------------------
// Maps Mathematical Alphanumeric variants to BMP equivalents.
// This avoids surrogate-pair splitting in jsdom AND keeps the output
// as single Unicode characters (no multi-char LaTeX commands in XML).

function normalizeMathCharToUnicode(cp: number): string | undefined {
  // Mathematical Bold A-Z / a-z
  if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCharCode(cp - 0x1D400 + 0x41);
  if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCharCode(cp - 0x1D41A + 0x61);
  // Mathematical Italic A-Z / a-z (h = U+210E is a gap)
  if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCharCode(cp - 0x1D434 + 0x41);
  if (cp === 0x210E) return 'h';
  if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCharCode(cp - 0x1D44E + 0x61);
  // Mathematical Bold Italic A-Z / a-z
  if (cp >= 0x1D468 && cp <= 0x1D481) return String.fromCharCode(cp - 0x1D468 + 0x41);
  if (cp >= 0x1D482 && cp <= 0x1D49B) return String.fromCharCode(cp - 0x1D482 + 0x61);
  // Mathematical Sans-Serif / Bold Sans-Serif / Monospace (0x1D5A0–0x1D6A3)
  if (cp >= 0x1D5A0 && cp <= 0x1D5B9) return String.fromCharCode(cp - 0x1D5A0 + 0x41);
  if (cp >= 0x1D5BA && cp <= 0x1D5D3) return String.fromCharCode(cp - 0x1D5BA + 0x61);
  if (cp >= 0x1D5D4 && cp <= 0x1D5ED) return String.fromCharCode(cp - 0x1D5D4 + 0x41);
  if (cp >= 0x1D5EE && cp <= 0x1D607) return String.fromCharCode(cp - 0x1D5EE + 0x61);
  if (cp >= 0x1D670 && cp <= 0x1D689) return String.fromCharCode(cp - 0x1D670 + 0x41);
  if (cp >= 0x1D68A && cp <= 0x1D6A3) return String.fromCharCode(cp - 0x1D68A + 0x61);

  // Mathematical Bold / Italic / Bold-Italic Greek → basic Greek Unicode
  // Bold Greek Capitals (Α-Ω): U+1D6A8–U+1D6C0 → U+0391+
  if (cp >= 0x1D6A8 && cp <= 0x1D6C0) return String.fromCodePoint(cp - 0x1D6A8 + 0x0391);
  // Bold Greek Small (α-ω): U+1D6C2–U+1D6DA → U+03B1+
  if (cp >= 0x1D6C2 && cp <= 0x1D6DA) return String.fromCodePoint(cp - 0x1D6C2 + 0x03B1);
  // Italic Greek Capitals: U+1D6E2–U+1D6FA → U+0391+
  if (cp >= 0x1D6E2 && cp <= 0x1D6FA) return String.fromCodePoint(cp - 0x1D6E2 + 0x0391);
  // Italic Greek Small: U+1D6FC–U+1D714 → U+03B1+
  if (cp >= 0x1D6FC && cp <= 0x1D714) return String.fromCodePoint(cp - 0x1D6FC + 0x03B1);
  // Bold Italic Greek Capitals: U+1D71C–U+1D734 → U+0391+
  if (cp >= 0x1D71C && cp <= 0x1D734) return String.fromCodePoint(cp - 0x1D71C + 0x0391);
  // Bold Italic Greek Small: U+1D736–U+1D74E → U+03B1+
  if (cp >= 0x1D736 && cp <= 0x1D74E) return String.fromCodePoint(cp - 0x1D736 + 0x03B1);

  // Mathematical Bold Digits 0-9: U+1D7CE–U+1D7D7
  if (cp >= 0x1D7CE && cp <= 0x1D7D7) return String.fromCharCode(cp - 0x1D7CE + 0x30);

  return undefined;
}

/**
 * Pre-process OMML XML: normalize Unicode Mathematical Alphanumeric chars
 * to BMP equivalents BEFORE passing to omml2mathml.
 * This avoids surrogate-pair splitting in jsdom (used by omml2mathml in Node).
 * Only produces single Unicode characters — never multi-char LaTeX commands.
 */
function normalizeOmmlXml(xml: string): string {
  return Array.from(xml).map(ch => {
    const cp = ch.codePointAt(0)!;
    return normalizeMathCharToUnicode(cp) ?? ch;
  }).join('');
}

// ---------------------------------------------------------------------------
// Stage 2: LaTeX post-processing
// ---------------------------------------------------------------------------
// After mathml-to-latex, the output may still contain:
//   - Basic Greek Unicode (α, β, π…) that should be \alpha, \beta, \pi…
//   - HTML entities (&nbsp;) from MathML serialization
//   - Invisible Unicode operators (U+2061 Function Application, etc.)
//   - Mathematical Bold Digits or other leftover Unicode

function postProcessLatex(latex: string): string {
  // Replace HTML entities and known wrong ASCII expansions from mathml-to-latex
  let result = latex
    .replace(/&nbsp;/g, '\\,')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\+-/g, '\\mp ');

  // Replace Unicode characters
  const chars = Array.from(result);
  const out: string[] = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;

    // Invisible operators — remove
    if (cp === 0x2061 || cp === 0x2062 || cp === 0x2063 || cp === 0x2064) continue;
    // Non-breaking space → LaTeX thin space
    if (cp === 0x00A0) { out.push('\\,'); continue; }

    // Basic Greek → LaTeX commands
    const greekLower = GREEK_LOWER_LATEX[cp];
    if (greekLower) {
      if (out.length > 0) out.push(' ');
      out.push(greekLower);
      out.push(' ');
      continue;
    }
    const greekUpper = GREEK_UPPER_LATEX[cp];
    if (greekUpper) {
      if (greekUpper.startsWith('\\')) {
        if (out.length > 0) out.push(' ');
        out.push(greekUpper);
        out.push(' ');
      } else {
        out.push(greekUpper);
      }
      continue;
    }

    // Mathematical variant Latin/digits that survived (shouldn't happen often)
    const mapped = normalizeMathCharToUnicode(cp);
    if (mapped !== undefined) { out.push(mapped); continue; }

    // Common math Unicode → LaTeX
    if (cp === 0x2212) { out.push('-'); continue; }       // minus sign
    if (cp === 0x00B1) { out.push('\\pm '); continue; }   // ±
    if (cp === 0x2213) { out.push('\\mp '); continue; }    // ∓
    if (cp === 0x00D7) { out.push('\\times '); continue; } // ×
    if (cp === 0x2026) { out.push('\\ldots '); continue; } // …
    if (cp === 0x221E) { out.push('\\infty '); continue; } // ∞

    out.push(ch);
  }

  return out.join('').replace(/ {2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------

/**
 * Convert OMML XML string to LaTeX via omml2mathml + mathml-to-latex.
 */
function ommlToLatex(ommlXml: string): string {
  try {
    const normalized = normalizeOmmlXml(ommlXml);
    const parser = new DOMParser();
    const doc = parser.parseFromString(normalized, 'application/xml');
    const mathmlNode = omml2mathml(doc);
    if (!mathmlNode) return '';
    const mathmlStr: string = mathmlNode.outerHTML ?? mathmlNode.toString();
    const rawLatex = MathMLToLaTeX.convert(mathmlStr);
    return postProcessLatex(rawLatex);
  } catch (err) {
    console.warn('[mathSerializer] OMML→LaTeX conversion failed:', err);
    return '';
  }
}

/**
 * Resolve fallback image from the mc:Fallback branch blipFill embed.
 */
async function resolveFallbackImage(
  embed: string | undefined,
  ctx: RenderContext,
): Promise<string> {
  if (!embed) return '';
  const rel = ctx.slide.rels.get(embed);
  if (!rel) return '';
  const mediaPath = resolveMediaPath(rel.target);
  const data = ctx.presentation.media.get(mediaPath);
  if (!data) return '';
  return resolveMediaToUrl(mediaPath, data, ctx.mediaMode, ctx.mediaUrlCache);
}

/**
 * Resolve an embedded .docx package from the slide's rels + presentation embeddings.
 * Returns the word/document.xml content string, or null.
 */
async function resolveOleDocxContent(
  rId: string,
  ctx: RenderContext,
): Promise<string | null> {
  const rel = ctx.slide.rels.get(rId);
  if (!rel) return null;

  const fileName = rel.target.split('/').pop() || '';
  const embeddingPath = `ppt/embeddings/${fileName}`;
  const data = ctx.presentation.embeddings.get(embeddingPath);
  if (!data) return null;

  try {
    const zip = await JSZip.loadAsync(data);
    const docXml = await zip.file('word/document.xml')?.async('string');
    return docXml ?? null;
  } catch {
    return null;
  }
}

/**
 * Serialize a math node to a Math element.
 */
export async function mathToElement(
  node: MathNodeData,
  ctx: RenderContext,
  _order: number,
): Promise<MathElement> {
  const order = node.xmlOrder;
  const left = pxToPt(node.position.x);
  const top = pxToPt(node.position.y);
  const width = pxToPt(node.size.w);
  const height = pxToPt(node.size.h);

  let latex = '';
  let plainText = node.plainText || '';

  if (node.oleDocxRId) {
    // OLE Word.Document with EQ field math
    const docXml = await resolveOleDocxContent(node.oleDocxRId, ctx);
    if (docXml) {
      const content = parseDocxMathContent(docXml);
      latex = content.latex;
      plainText = content.plainText || plainText;
    }
  } else if (node.ommlXml) {
    latex = ommlToLatex(node.ommlXml);
  }

  const picBase64 = await resolveFallbackImage(node.fallbackBlipEmbed, ctx);

  return {
    type: 'math',
    left,
    top,
    width,
    height,
    latex,
    picBase64,
    order,
    text: plainText || undefined,
  };
}
