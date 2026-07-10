/**
 * Pure intent-mapping gate for `edit_elements`.
 *
 * Takes model-proposed element updates + the trusted slide inventory and either
 * returns validated `EditIntent`s (`element.update` / `element.updateMany`) or a
 * refusal. Malformed / out-of-contract proposals never partially apply.
 *
 * No I/O, no React, no store — fixture-testable in isolation.
 */

import type { PPTElement } from '@openmaic/dsl';
import type { EditIntent } from '@openmaic/renderer/editing';
import { MIN_SIZE } from '@/configs/element';

const DEFAULT_MIN_SIZE = 20;

/** Geometry + style props the AI may mutate. Content / identity are rejected. */
export const ALLOWED_EDIT_PROPS = new Set([
  // geometry
  'left',
  'top',
  'width',
  'height',
  'rotate',
  // shared chrome
  'fill',
  'opacity',
  'outline',
  'shadow',
  // text / shape text chrome (not HTML body)
  'defaultColor',
  'defaultFontName',
  'lineHeight',
  'wordSpace',
  'paragraphSpace',
  'vertical',
  'vAlign',
  'textType',
  // line / latex / audio color
  'color',
  // shape
  'gradient',
  // image chrome
  'filters',
  'radius',
  'flipH',
  'flipV',
  'colorMask',
  'fixedRatio',
  // chart chrome
  'themeColors',
  'textColor',
  'lineColor',
  // code chrome (not `lines`)
  'fontSize',
  'showLineNumbers',
  'fileName',
]);

/** Props that must never be written by this vertical. */
export const FORBIDDEN_EDIT_PROPS = new Set([
  'id',
  'type',
  'lock',
  'groupId',
  'link',
  'content',
  'text',
  'src',
  'mediaRef',
  'lines',
  'latex',
  'html',
  'data',
  'path',
  'viewBox',
  'pathFormula',
  'keypoints',
  'start',
  'end',
  'broken',
  'broken2',
  'curve',
  'cubic',
  'colWidths',
  'rowHeights',
  'cellMinHeight',
  'animations',
]);

export interface ElementInventoryItem {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height?: number;
  rotate?: number;
  lock?: boolean;
  /** Short human-readable label for the model (stripped text / name / type). */
  label: string;
  /** Style props currently on the element that the DSL owns and AI may edit. */
  style: Record<string, unknown>;
}

export interface ProposedElementUpdate {
  id: string;
  props: Record<string, unknown>;
}

export type EditElementsGateResult =
  | { ok: true; intents: EditIntent[] }
  | { ok: false; reason: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Signed angle in (-180, 180], matching the rotate gesture core. */
export function normalizeRotate(degrees: number): number {
  let r = degrees % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

function minSizeFor(type: string): number {
  return MIN_SIZE[type] ?? DEFAULT_MIN_SIZE;
}

/**
 * Clamp geometry the same way gesture cores do: min size per type; rotate
 * normalized to (-180, 180]. Non-geometry props pass through unchanged once
 * allowed.
 */
export function clampUpdateProps(
  type: string,
  props: Record<string, unknown>,
  current: { width: number; height?: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  const min = minSizeFor(type);

  if ('width' in out) {
    if (!isFiniteNumber(out.width)) throw new Error(`width must be a finite number`);
    out.width = Math.max(min, out.width);
  }
  if ('height' in out) {
    if (!isFiniteNumber(out.height)) throw new Error(`height must be a finite number`);
    // Lines have no height — reject rather than invent one.
    if (type === 'line') throw new Error(`line elements have no height`);
    out.height = Math.max(min, out.height);
  }
  if ('left' in out && !isFiniteNumber(out.left)) {
    throw new Error(`left must be a finite number`);
  }
  if ('top' in out && !isFiniteNumber(out.top)) {
    throw new Error(`top must be a finite number`);
  }
  if ('rotate' in out) {
    if (type === 'line') throw new Error(`line elements have no rotate`);
    if (!isFiniteNumber(out.rotate)) throw new Error(`rotate must be a finite number`);
    out.rotate = normalizeRotate(out.rotate);
  }
  if ('opacity' in out) {
    if (!isFiniteNumber(out.opacity)) throw new Error(`opacity must be a finite number`);
    out.opacity = Math.min(1, Math.max(0, out.opacity));
  }

  // If only width/height change without left/top, keep current box origin —
  // nothing to clamp against current beyond min size (already done).
  void current;
  return out;
}

function validatePropsKeys(props: Record<string, unknown>): string | null {
  const keys = Object.keys(props);
  if (keys.length === 0) return 'update has empty props';
  for (const key of keys) {
    if (FORBIDDEN_EDIT_PROPS.has(key)) {
      return `prop ${JSON.stringify(key)} is not editable via edit_elements`;
    }
    if (!ALLOWED_EDIT_PROPS.has(key)) {
      return `prop ${JSON.stringify(key)} is out of contract`;
    }
  }
  return null;
}

/**
 * Validate and coerce model proposals into EditIntents.
 * All-or-nothing: any single bad update refuses the whole batch.
 */
export function mapProposalsToEditIntents(
  proposals: ProposedElementUpdate[],
  inventory: ElementInventoryItem[],
): EditElementsGateResult {
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return { ok: false, reason: 'no element updates proposed' };
  }

  const byId = new Map(inventory.map((el) => [el.id, el]));
  const seen = new Set<string>();
  const updates: Array<{ id: string; props: Partial<PPTElement> }> = [];

  for (const proposal of proposals) {
    if (!proposal || typeof proposal !== 'object') {
      return { ok: false, reason: 'malformed update entry' };
    }
    const { id, props } = proposal;
    if (typeof id !== 'string' || !id) {
      return { ok: false, reason: 'update missing element id' };
    }
    if (seen.has(id)) {
      return { ok: false, reason: `duplicate update for element ${JSON.stringify(id)}` };
    }
    seen.add(id);

    const el = byId.get(id);
    if (!el) {
      return { ok: false, reason: `unknown element id ${JSON.stringify(id)}` };
    }
    if (el.lock) {
      return { ok: false, reason: `element ${JSON.stringify(id)} is locked` };
    }
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      return { ok: false, reason: `malformed props for element ${JSON.stringify(id)}` };
    }

    const keyErr = validatePropsKeys(props);
    if (keyErr) return { ok: false, reason: keyErr };

    let clamped: Record<string, unknown>;
    try {
      clamped = clampUpdateProps(el.type, props, {
        width: el.width,
        height: el.height,
      });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : `invalid geometry for ${JSON.stringify(id)}`,
      };
    }

    updates.push({ id, props: clamped as Partial<PPTElement> });
  }

  if (updates.length === 1) {
    return {
      ok: true,
      intents: [{ type: 'element.update', id: updates[0].id, props: updates[0].props }],
    };
  }
  return {
    ok: true,
    intents: [{ type: 'element.updateMany', updates }],
  };
}

/** Build the model-visible inventory from trusted slide elements. */
export function buildElementInventory(elements: PPTElement[]): ElementInventoryItem[] {
  return elements.map((el) => {
    const style: Record<string, unknown> = {};
    for (const key of ALLOWED_EDIT_PROPS) {
      if (
        key === 'left' ||
        key === 'top' ||
        key === 'width' ||
        key === 'height' ||
        key === 'rotate'
      ) {
        continue;
      }
      const v = (el as unknown as Record<string, unknown>)[key];
      if (v !== undefined) style[key] = v;
    }
    const label = elementLabel(el);
    const base: ElementInventoryItem = {
      id: el.id,
      type: el.type,
      left: el.left,
      top: el.top,
      width: el.width,
      lock: !!el.lock,
      label,
      style,
    };
    if (el.type !== 'line') {
      base.height = (el as { height: number }).height;
      base.rotate = (el as { rotate: number }).rotate;
    }
    return base;
  });
}

function elementLabel(el: PPTElement): string {
  if (typeof el.name === 'string' && el.name.trim()) return el.name.trim().slice(0, 80);
  const e = el as {
    type: string;
    content?: unknown;
    text?: { content?: unknown };
    textType?: string;
  };
  if (e.type === 'text' && typeof e.content === 'string') {
    const plain = e.content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) return plain.slice(0, 80);
    if (e.textType) return e.textType;
  }
  if (e.type === 'shape' && typeof e.text?.content === 'string') {
    const plain = e.text.content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) return plain.slice(0, 80);
  }
  return e.type;
}
