/**
 * Image serializer — converts PicNodeData into positioned HTML image/video/audio elements.
 */

import type { PicNodeData } from '../model/nodes/PicNode';
import type { RenderContext } from './RenderContext';
import { SafeXmlNode } from '../parser/XmlParser';
import { resolveMediaToUrl } from '../utils/mediaWebConvert';
import { lineStyleToBorder } from './borderMapper';
import type { Image, Video, Audio } from '../adapter/types';
import { getMimeType, resolveMediaPath, toDataUrl } from '../utils/media';
import { isAllowedExternalUrl } from '../utils/urlSafety';
import { resolveColor } from './StyleResolver';
import { hexToRgb } from '../utils/color';

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return Number((px * PX_TO_PT).toFixed(4));
}

/**
 * Check if a file extension is an unsupported legacy format (WMF only now; EMF is handled).
 */
function isUnsupportedFormat(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return ext === 'wmf';
}

/**
 * Check if a file path is an EMF image.
 */
function isEmfFormat(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return ext === 'emf';
}

/**
 * Resolve preset geometry from spPr > prstGeom.
 * Falls back to 'rect' when no explicit preset is specified —
 * same as ImageRenderer which treats images as rectangular by default.
 */
function resolvePresetGeom(node: PicNodeData): string {
  const spPr = node.source.child('spPr');
  if (!spPr.exists()) return 'rect';
  const prstGeom = spPr.child('prstGeom');
  if (!prstGeom.exists()) return 'rect';
  return prstGeom.attr('prst') ?? 'rect';
}

/**
 * Resolve image-level hyperlink from hlinkClick on cNvPr.
 * Mirrors link resolution logic in ShapeRenderer / ImageRenderer.
 */
function resolvePicLink(node: PicNodeData, ctx: RenderContext): string | undefined {
  const h = node.hlinkClick;
  if (!h) return undefined;
  const { action, rId } = h;
  if (action === 'ppaction://hlinksldjump' && rId) {
    const rel = ctx.slide.rels.get(rId);
    if (rel) {
      const match = rel.target.match(/slide(\d+)\.xml/i);
      if (match) return `#slide-${match[1]}`;
    }
  } else if (rId) {
    const rel = ctx.slide.rels.get(rId);
    if (rel && rel.targetMode === 'External' && isAllowedExternalUrl(rel.target)) {
      return rel.target;
    }
  }
  return undefined;
}

/**
 * Resolve overall image opacity from OOXML blip alpha modifiers.
 * Same logic as ImageRenderer.resolveBlipOpacity:
 * - alphaModFix amt="N"
 * - alphaMod val="N"
 * - alphaOff val="N"
 */
function resolveBlipOpacity(blip: SafeXmlNode): number {
  let alpha = 1;

  const alphaModFix = blip.child('alphaModFix');
  if (alphaModFix.exists()) {
    alpha *= (alphaModFix.numAttr('amt') ?? 100000) / 100000;
  }

  const alphaMod = blip.child('alphaMod');
  if (alphaMod.exists()) {
    alpha *= (alphaMod.numAttr('val') ?? 100000) / 100000;
  }

  const alphaOff = blip.child('alphaOff');
  if (alphaOff.exists()) {
    alpha += (alphaOff.numAttr('val') ?? 0) / 100000;
  }

  return Math.max(0, Math.min(1, alpha));
}

/** OOXML fixed-point scale (100000 = 100%). */
const OOXML_100K = 100000;

/**
 * Build `filters` for PPTist: `sharpen`, `colorTemperature`, `saturation`, `brightness`, `contrast`.
 *
 * - **ISO / DrawingML**: `<a:lum bright contrast>` on `<a:blip>`.
 * - **Office 2010+** (same as legacy `src1/fill.js` `getPicFilters`): `a:extLst` → `ext` →
 *   `a14:imgProps` / `a14:imgLayer` / `a14:imgEffect` → `a14:saturation`, `a14:brightnessContrast`,
 *   `a14:sharpenSoften`, `a14:colorTemperature`.
 *
 * Extension effects are applied after `lum` and may override brightness/contrast when both exist.
 */
function buildImageFilters(node: PicNodeData): Image['filters'] | undefined {
  const blipFill = node.source.child('blipFill');
  if (!blipFill.exists()) return undefined;
  const blip = blipFill.child('blip');
  if (!blip.exists()) return undefined;

  const out: NonNullable<Image['filters']> = {};

  applyLumToFilters(blip, out);
  applyExtLstImageEffectsToFilters(blip, out);

  return Object.keys(out).length > 0 ? out : undefined;
}

/** `<a:lum>` — brightness / contrast (values typically −100000…100000, scale 100000 = 100%). */
function applyLumToFilters(blip: SafeXmlNode, out: NonNullable<Image['filters']>): void {
  const lum = blip.child('lum');
  if (!lum.exists()) return;
  const bright = lum.numAttr('bright');
  const contrast = lum.numAttr('contrast');
  if (bright !== undefined && bright !== 0) {
    out.brightness = bright / OOXML_100K;
  }
  if (contrast !== undefined && contrast !== 0) {
    out.contrast = contrast / OOXML_100K;
  }
}

/**
 * `a:extLst` / `a14:img*` image adjustments (namespace-agnostic `localName` from DOM).
 */
function applyExtLstImageEffectsToFilters(blip: SafeXmlNode, out: NonNullable<Image['filters']>): void {
  const extLst = blip.child('extLst');
  if (!extLst.exists()) return;

  for (const ext of extLst.children()) {
    if (ext.localName !== 'ext') continue;
    const imgProps = ext.child('imgProps');
    if (!imgProps.exists()) continue;
    const imgLayer = imgProps.child('imgLayer');
    if (!imgLayer.exists()) continue;

    for (const imgEffect of imgLayer.children()) {
      if (imgEffect.localName !== 'imgEffect') continue;
      for (const el of imgEffect.allChildren()) {
        switch (el.localName) {
          case 'saturation': {
            const sat = el.numAttr('sat');
            if (sat !== undefined) {
              out.saturation = sat / OOXML_100K;
            }
            break;
          }
          case 'brightnessContrast': {
            const bright = el.numAttr('bright');
            const contrast = el.numAttr('contrast');
            if (bright !== undefined && bright !== 0) {
              out.brightness = bright / OOXML_100K;
            }
            if (contrast !== undefined && contrast !== 0) {
              out.contrast = contrast / OOXML_100K;
            }
            break;
          }
          case 'sharpenSoften': {
            const amount = el.numAttr('amount');
            if (amount !== undefined && amount !== 0) {
              // Positive = sharpen, negative = soften (PPTist only has `sharpen`; use signed value).
              out.sharpen = amount / OOXML_100K;
            }
            break;
          }
          case 'colorTemperature': {
            const ct = el.numAttr('colorTemp');
            if (ct !== undefined) {
              out.colorTemperature = ct;
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }
}

/**
 * Resolve a media blob URL from a relationship ID.
 */
async function resolveMediaUrl(rId: string | undefined, ctx: RenderContext): Promise<string | undefined> {
  if (!rId) return undefined;

  const rel = ctx.slide.rels.get(rId);
  if (!rel) return undefined;

  // Check if target is an external URL
  if (rel.target.startsWith('http://') || rel.target.startsWith('https://')) {
    return rel.target;
  }

  // Resolve from embedded media
  const mediaPath = resolveMediaPath(rel.target);
  const data = ctx.presentation.media.get(mediaPath);
  if (!data) return undefined;

  return resolveMediaToUrl(mediaPath, data, 'blob', ctx.mediaUrlCache);
}

/**
 * Render a video element.
 */
async function renderVideo(
  node: PicNodeData,
  ctx: RenderContext,
  order: number,
  box: { left: number; top: number; width: number; height: number },
): Promise<Video> {
  // Try to get video URL from mediaRId
  const videoUrl = await resolveMediaUrl(node.mediaRId, ctx);

  // Also try to show poster image from blipEmbed
  let posterUrl: string | undefined;
  if (node.blipEmbed) {
    const rel = ctx.slide.rels.get(node.blipEmbed);
    if (rel) {
      const mediaPath = resolveMediaPath(rel.target);
      const data = ctx.presentation.media.get(mediaPath);
      if (data && !isUnsupportedFormat(mediaPath)) {
        posterUrl = await resolveMediaToUrl(mediaPath, data, ctx.mediaMode, ctx.mediaUrlCache);
      }
    }
  }

  const blob = videoUrl || undefined;
  const src = posterUrl ?? videoUrl ?? undefined;

  return {
    type: 'video',
    ...box,
    blob,
    src,
    order,
  };
}

/**
 * Render an audio element.
 */
async function renderAudio(
  node: PicNodeData,
  ctx: RenderContext,
  order: number,
  box: { left: number; top: number; width: number; height: number },
): Promise<Audio> {
  const audioUrl = await resolveMediaUrl(node.mediaRId, ctx);
  const blob = audioUrl || '';
  // TODO: optional cover image from blipEmbed

  return {
    type: 'audio',
    ...box,
    blob,
    order,
  };
}

// ---------------------------------------------------------------------------
// a:clrChange — pixel-level color replacement (chroma key)
// ---------------------------------------------------------------------------

function bytesToDataUrl(bytes: Uint8Array, mediaPath: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  let base64: string;
  if (typeof btoa !== 'undefined') {
    base64 = btoa(binary);
  } else {
    const NodeBuffer = (globalThis as unknown as { Buffer?: { from(a: Uint8Array): { toString(e: string): string } } }).Buffer;
    base64 = NodeBuffer ? NodeBuffer.from(bytes).toString('base64') : '';
  }
  return toDataUrl(base64, getMimeType(mediaPath));
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = document.createElement('img');
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Apply `a:clrChange` effect: replace pixels matching `clrFrom` with `clrTo`.
 * Falls back to the original URL if Canvas is unavailable or decoding fails.
 */
async function applyClrChange(
  mediaData: Uint8Array | ArrayBuffer,
  mediaPath: string,
  clrChange: SafeXmlNode,
  ctx: RenderContext,
): Promise<string> {
  const clrFromNode = clrChange.child('clrFrom');
  const clrToNode = clrChange.child('clrTo');
  if (!clrFromNode.exists() || !clrToNode.exists()) {
    return resolveMediaToUrl(mediaPath, mediaData, ctx.mediaMode, ctx.mediaUrlCache);
  }

  const fromColor = resolveColor(clrFromNode, ctx);
  const toColor = resolveColor(clrToNode, ctx);
  const fromRgb = hexToRgb(fromColor.color);
  const toRgb = hexToRgb(toColor.color);
  const toAlpha = Math.round(toColor.alpha * 255);

  try {
    const bytes = mediaData instanceof Uint8Array ? mediaData : new Uint8Array(mediaData);
    const dataUrl = bytesToDataUrl(bytes, mediaPath);
    const img = await loadImageElement(dataUrl);
    if (!img) {
      return resolveMediaToUrl(mediaPath, mediaData, ctx.mediaMode, ctx.mediaUrlCache);
    }

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const c2d = canvas.getContext('2d');
    if (!c2d) {
      return resolveMediaToUrl(mediaPath, mediaData, ctx.mediaMode, ctx.mediaUrlCache);
    }

    c2d.drawImage(img, 0, 0);
    const imageData = c2d.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    const COLOR_TOLERANCE = 12;
    for (let i = 0; i < pixels.length; i += 4) {
      const dist =
        Math.abs(pixels[i] - fromRgb.r) +
        Math.abs(pixels[i + 1] - fromRgb.g) +
        Math.abs(pixels[i + 2] - fromRgb.b);
      if (dist <= COLOR_TOLERANCE) {
        pixels[i] = toRgb.r;
        pixels[i + 1] = toRgb.g;
        pixels[i + 2] = toRgb.b;
        pixels[i + 3] = toAlpha;
      }
    }

    c2d.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return resolveMediaToUrl(mediaPath, mediaData, ctx.mediaMode, ctx.mediaUrlCache);
  }
}

/**
 * Render an image element.
 */
async function renderImage(
  node: PicNodeData,
  ctx: RenderContext,
  order: number,
  box: { left: number; top: number; width: number; height: number },
): Promise<Image> {
  const embedId = node.blipEmbed;
  let src = '';

  if (!embedId) {
    return buildImage(node, ctx, order, box, src, undefined);
  }

  const rel = ctx.slide.rels.get(embedId);
  if (!rel) {
    return buildImage(node, ctx, order, box, src, undefined);
  }

  const mediaPath = resolveMediaPath(rel.target);

  const data = ctx.presentation.media.get(mediaPath);
  if (!data) {
    return buildImage(node, ctx, order, box, src, undefined);
  }

  const blipFill = node.source.child('blipFill');
  const blip = blipFill.exists() ? blipFill.child('blip') : node.source.child('__none__');
  const clrChange = blip.exists() ? blip.child('clrChange') : node.source.child('__none__');

  if (clrChange.exists()) {
    src = await applyClrChange(data, mediaPath, clrChange, ctx);
  } else {
    src = await resolveMediaToUrl(mediaPath, data, ctx.mediaMode, ctx.mediaUrlCache);
  }

  return buildImage(node, ctx, order, box, src, buildImageFilters(node));
}

function buildImage(
  node: PicNodeData,
  ctx: RenderContext,
  order: number,
  box: { left: number; top: number; width: number; height: number },
  src: string,
  filters: Image['filters'] | undefined,
): Image {
  const spPr = node.source.child('spPr');
  const ln = spPr.exists() ? spPr.child('ln') : node.source.child('__none__');
  const noBorder = { border: { borderColor: '#000000', borderWidth: 0, borderType: 'solid' as const }, borderStrokeDasharray: '0' };
  let borderResult: ReturnType<typeof lineStyleToBorder>;
  if (ln.exists()) {
    const hasFill = ln.child('solidFill').exists() || ln.child('gradFill').exists() || ln.child('pattFill').exists();
    borderResult = hasFill ? lineStyleToBorder(ln, ctx) : noBorder;
  } else {
    borderResult = noBorder;
  }

  let rect: Image['rect'] | undefined;
  if (
    node.crop &&
    (node.crop.top !== 0 || node.crop.bottom !== 0 || node.crop.left !== 0 || node.crop.right !== 0)
  ) {
    rect = {
      t: node.crop.top,
      b: node.crop.bottom,
      l: node.crop.left,
      r: node.crop.right,
    };
  }

  const geom = resolvePresetGeom(node);
  const link = resolvePicLink(node, ctx);

  // Blip opacity (alphaModFix / alphaMod / alphaOff) — same as ImageRenderer.resolveBlipOpacity.
  // When opacity < 1, ImageRenderer sets wrapper.style.opacity; here we store in filters.
  const blipFillNode = node.source.child('blipFill');
  const blipNode = blipFillNode.exists() ? blipFillNode.child('blip') : node.source.child('__none__');
  const blipOpacity = blipNode.exists() ? resolveBlipOpacity(blipNode) : 1;

  const mergedFilters: Image['filters'] = { ...filters };
  if (blipOpacity < 1) {
    // Store opacity as a filter; the consumer can apply CSS opacity or equivalent.
    (mergedFilters as Record<string, number>).opacity = blipOpacity;
  }
  const hasFilters = Object.keys(mergedFilters).length > 0;

  return {
    type: 'image',
    ...box,
    src,
    rotate: node.rotation,
    isFlipH: node.flipH,
    isFlipV: node.flipV,
    order,
    rect,
    geom,
    borderColor: borderResult.border.borderColor,
    borderWidth: borderResult.border.borderWidth,
    borderType: borderResult.border.borderType,
    borderStrokeDasharray: borderResult.borderStrokeDasharray || '0',
    ...(hasFilters ? { filters: mergedFilters } : {}),
    ...(link ? { link } : {}),
  };
}

/**
 * Serialize picture node to Image, Video, or Audio element.
 *
 * Handles:
 * - Standard images (png, jpg, gif, svg, bmp)
 * - Unsupported formats (wmf) with placeholder
 * - Video elements with controls
 * - Audio elements with controls
 * - Crop via `rect` (fractions)
 * - Rotation and flip on Image
 */
export async function pictureToElement(
  node: PicNodeData,
  ctx: RenderContext,
  _order: number,
): Promise<Image | Video | Audio> {
  const order = node.xmlOrder;
  const box = {
    left: pxToPt(node.position.x),
    top: pxToPt(node.position.y),
    width: pxToPt(node.size.w),
    height: pxToPt(node.size.h),
  };

  if (node.isVideo) {
    return renderVideo(node, ctx, order, box);
  }

  if (node.isAudio) {
    return renderAudio(node, ctx, order, box);
  }

  return renderImage(node, ctx, order, box);
}
