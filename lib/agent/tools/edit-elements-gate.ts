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
const LINE_STROKE_MIN = 1;
const LINE_STROKE_MAX = 100;
/** Sanity bounds so model JSON cannot park elements at 1e15. */
const COORD_MIN = -5000;
const COORD_MAX = 20000;

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
  // code chrome (not `lines` / not user-visible fileName)
  'fontSize',
  'showLineNumbers',
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
  'fileName',
]);

/** Text-chrome keys that live under `shape.text` for shape elements. */
export const SHAPE_TEXT_CHROME_PROPS = new Set([
  'defaultColor',
  'defaultFontName',
  'lineHeight',
  'wordSpace',
  'paragraphSpace',
  'textType',
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
  groupId?: string;
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

function isColorString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 64;
}

function isNonEmptyString(v: unknown, max = 200): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
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

function clampCoord(n: number, label: string): number {
  if (n < COORD_MIN || n > COORD_MAX) {
    throw new Error(`${label} out of bounds (${COORD_MIN}..${COORD_MAX})`);
  }
  return n;
}

function validateOutline(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return 'outline must be an object';
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== 'style' && k !== 'width' && k !== 'color') {
      return `outline.${k} is out of contract`;
    }
  }
  if ('style' in o && o.style !== 'solid' && o.style !== 'dashed' && o.style !== 'dotted') {
    return 'outline.style must be solid|dashed|dotted';
  }
  if ('width' in o && (!isFiniteNumber(o.width) || o.width < 0 || o.width > LINE_STROKE_MAX)) {
    return 'outline.width must be a finite number in range';
  }
  if ('color' in o && !isColorString(o.color)) return 'outline.color must be a color string';
  return null;
}

function validateShadow(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return 'shadow must be an object';
  }
  const o = v as Record<string, unknown>;
  for (const k of ['h', 'v', 'blur'] as const) {
    if (!(k in o) || !isFiniteNumber(o[k])) return `shadow.${k} must be a finite number`;
  }
  if (!isColorString(o.color)) return 'shadow.color must be a color string';
  for (const k of Object.keys(o)) {
    if (k !== 'h' && k !== 'v' && k !== 'blur' && k !== 'color') {
      return `shadow.${k} is out of contract`;
    }
  }
  return null;
}

function validateGradient(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return 'gradient must be an object';
  }
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string') return 'gradient.type must be a string';
  if (!Array.isArray(o.colors) || o.colors.length === 0) {
    return 'gradient.colors must be a non-empty array';
  }
  if (!isFiniteNumber(o.rotate)) return 'gradient.rotate must be a finite number';
  return null;
}

function validateFilters(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return 'filters must be an object';
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return `filters.${k} must be a string`;
  }
  return null;
}

/**
 * Validate non-geometry prop values. Returns an error string or null.
 * Geometry is handled by clampUpdateProps.
 */
export function validatePropValue(key: string, value: unknown, type: string): string | null {
  switch (key) {
    case 'fill':
    case 'defaultColor':
    case 'color':
    case 'textColor':
    case 'lineColor':
    case 'colorMask':
      return isColorString(value) ? null : `${key} must be a color string`;
    case 'defaultFontName':
    case 'textType':
    case 'vAlign':
      return isNonEmptyString(value, 80) ? null : `${key} must be a non-empty string`;
    case 'opacity':
      // clamped later
      return isFiniteNumber(value) ? null : 'opacity must be a finite number';
    case 'lineHeight':
    case 'wordSpace':
    case 'paragraphSpace':
    case 'radius':
    case 'fontSize':
      return isFiniteNumber(value) ? null : `${key} must be a finite number`;
    case 'vertical':
    case 'flipH':
    case 'flipV':
    case 'fixedRatio':
    case 'showLineNumbers':
      return typeof value === 'boolean' ? null : `${key} must be a boolean`;
    case 'outline':
      return validateOutline(value);
    case 'shadow':
      return validateShadow(value);
    case 'gradient':
      if (type !== 'shape') return 'gradient is only valid on shape elements';
      return validateGradient(value);
    case 'filters':
      if (type !== 'image') return 'filters is only valid on image elements';
      return validateFilters(value);
    case 'themeColors':
      if (!Array.isArray(value) || !value.every(isColorString)) {
        return 'themeColors must be an array of color strings';
      }
      return null;
    default:
      // left/top/width/height/rotate handled in clampUpdateProps
      return null;
  }
}

/**
 * Clamp geometry the same way gesture cores do: min size per type; rotate
 * normalized to (-180, 180]. Line `width` is stroke thickness (min 1), not box size.
 */
export function clampUpdateProps(
  type: string,
  props: Record<string, unknown>,
  current: { width: number; height?: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };

  if ('width' in out) {
    if (!isFiniteNumber(out.width)) throw new Error(`width must be a finite number`);
    if (type === 'line') {
      out.width = Math.min(LINE_STROKE_MAX, Math.max(LINE_STROKE_MIN, out.width));
    } else {
      out.width = Math.max(minSizeFor(type), out.width);
      out.width = clampCoord(out.width, 'width');
    }
  }
  if ('height' in out) {
    if (!isFiniteNumber(out.height)) throw new Error(`height must be a finite number`);
    if (type === 'line') throw new Error(`line elements have no height`);
    out.height = Math.max(minSizeFor(type), out.height);
    out.height = clampCoord(out.height, 'height');
  }
  if ('left' in out) {
    if (!isFiniteNumber(out.left)) throw new Error(`left must be a finite number`);
    out.left = clampCoord(out.left, 'left');
  }
  if ('top' in out) {
    if (!isFiniteNumber(out.top)) throw new Error(`top must be a finite number`);
    out.top = clampCoord(out.top, 'top');
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

function enforceGroupCohesion(
  updates: Array<{ id: string }>,
  inventory: ElementInventoryItem[],
): string | null {
  const byId = new Map(inventory.map((el) => [el.id, el]));
  const targeted = new Set(updates.map((u) => u.id));
  for (const id of targeted) {
    const el = byId.get(id);
    if (!el?.groupId) continue;
    const members = inventory.filter((x) => x.groupId === el.groupId).map((x) => x.id);
    const missing = members.filter((m) => !targeted.has(m));
    if (missing.length > 0) {
      return `group ${JSON.stringify(el.groupId)} must be edited as a unit (missing ${missing.map((m) => JSON.stringify(m)).join(', ')})`;
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

    for (const [key, value] of Object.entries(props)) {
      if (
        key === 'left' ||
        key === 'top' ||
        key === 'width' ||
        key === 'height' ||
        key === 'rotate'
      ) {
        continue;
      }
      const valueErr = validatePropValue(key, value, el.type);
      if (valueErr) return { ok: false, reason: valueErr };
    }

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

  const groupErr = enforceGroupCohesion(updates, inventory);
  if (groupErr) return { ok: false, reason: groupErr };

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
      if (el.type === 'shape' && SHAPE_TEXT_CHROME_PROPS.has(key)) {
        const text = (el as { text?: Record<string, unknown> }).text;
        const mappedKey = key === 'textType' ? 'type' : key;
        const v = text?.[mappedKey];
        if (v !== undefined) style[key] = v;
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
    if (typeof el.groupId === 'string' && el.groupId) base.groupId = el.groupId;
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

/** Collect target element ids from a batch of EditIntents. */
export function collectIntentTargetIds(intents: EditIntent[]): string[] {
  const ids: string[] = [];
  for (const intent of intents) {
    if (intent.type === 'element.update') ids.push(intent.id);
    else if (intent.type === 'element.updateMany') {
      for (const u of intent.updates) ids.push(u.id);
    }
  }
  return ids;
}

/**
 * Apply-time revalidation against the live slide content.
 * Ensures the batch is still fully applicable (ids present, unlocked, group-cohesive).
 */
export function revalidateIntentsAgainstElements(
  elements: PPTElement[],
  intents: EditIntent[],
): EditElementsGateResult {
  const inventory = buildElementInventory(elements);
  const ids = collectIntentTargetIds(intents);
  if (ids.length === 0) return { ok: false, reason: 'no element updates proposed' };

  const byId = new Map(inventory.map((el) => [el.id, el]));
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) return { ok: false, reason: `unknown element id ${JSON.stringify(id)}` };
    if (el.lock) return { ok: false, reason: `element ${JSON.stringify(id)} is locked` };
  }
  const groupErr = enforceGroupCohesion(
    ids.map((id) => ({ id })),
    inventory,
  );
  if (groupErr) return { ok: false, reason: groupErr };
  return { ok: true, intents };
}
