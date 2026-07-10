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
import sceneSchemaJson from '@openmaic/dsl/schema/scene.schema.json';
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

type JsonSchema = {
  $ref?: string;
  anyOf?: JsonSchema[];
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  minimum?: number;
  maximum?: number;
};

type SchemaDocument = {
  definitions?: Record<string, JsonSchema>;
};

const sceneSchema = sceneSchemaJson as SchemaDocument;
const schemaDefinitions = sceneSchema.definitions ?? {};

const SHAPE_TEXT_SCHEMA_ALIASES = new Map<string, string>([
  ['defaultColor', 'defaultColor'],
  ['defaultFontName', 'defaultFontName'],
  ['lineHeight', 'lineHeight'],
  ['wordSpace', 'wordSpace'],
  ['paragraphSpace', 'paragraphSpace'],
  ['textType', 'type'],
  ['vAlign', 'align'],
]);

function decodeRefName(ref: string): string | null {
  const m = ref.match(/^#\/definitions\/(.+)$/);
  return m ? m[1].replace(/~1/g, '/').replace(/~0/g, '~') : null;
}

function resolveSchema(schema: JsonSchema, seen = new Set<string>()): JsonSchema {
  if (!schema.$ref) return schema;
  const name = decodeRefName(schema.$ref);
  if (!name || seen.has(name)) return schema;
  const target = schemaDefinitions[name];
  if (!target) return schema;
  seen.add(name);
  return resolveSchema(target, seen);
}

function elementTypeFromSchema(schema: JsonSchema): string | null {
  const typeSchema = resolveSchema(schema.properties?.type ?? {});
  return typeof typeSchema.const === 'string' ? typeSchema.const : null;
}

/**
 * Lockstep with packages/@openmaic/dsl/scripts/gen-schema.mjs: the package
 * export @openmaic/dsl/schema/scene.schema.json is generated from slides.ts.
 */
function buildEditablePropSchemas(): Map<string, Map<string, JsonSchema>> {
  const out = new Map<string, Map<string, JsonSchema>>();
  const elementUnion = resolveSchema(schemaDefinitions.PPTElement ?? {});
  for (const option of elementUnion.anyOf ?? []) {
    const elementSchema = resolveSchema(option);
    const elementType = elementTypeFromSchema(elementSchema);
    if (!elementType || !elementSchema.properties) continue;
    out.set(elementType, new Map(Object.entries(elementSchema.properties)));
  }

  const shapeProps = out.get('shape');
  const shapeTextSchema = shapeProps?.get('text');
  const shapeTextProps = shapeTextSchema ? resolveSchema(shapeTextSchema).properties : undefined;
  if (shapeProps && shapeTextProps) {
    for (const [flatProp, schemaProp] of SHAPE_TEXT_SCHEMA_ALIASES) {
      const subschema = shapeTextProps[schemaProp];
      if (subschema) shapeProps.set(flatProp, subschema);
    }
  }

  return out;
}

const EDITABLE_PROP_SCHEMAS_BY_TYPE = buildEditablePropSchemas();

export function getEditablePropSchema(type: string, key: string): JsonSchema | null {
  if (!ALLOWED_EDIT_PROPS.has(key) || FORBIDDEN_EDIT_PROPS.has(key)) return null;
  return EDITABLE_PROP_SCHEMAS_BY_TYPE.get(type)?.get(key) ?? null;
}

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

function schemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return isFiniteNumber(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

function describeSchemaTypes(type: string | string[]): string {
  return Array.isArray(type) ? type.join('|') : type;
}

function validateJsonSchemaSubset(value: unknown, schema: JsonSchema, path: string): string | null {
  const s = resolveSchema(schema);
  if (s.anyOf?.length) {
    const errors = s.anyOf
      .map((option) => validateJsonSchemaSubset(value, option, path))
      .filter(Boolean);
    return errors.length === s.anyOf.length ? `${path} does not match any allowed schema` : null;
  }

  if ('const' in s && !Object.is(value, s.const)) {
    return `${path} must be ${JSON.stringify(s.const)}`;
  }
  if (s.enum && !s.enum.some((item) => Object.is(item, value))) {
    return `${path} must be one of ${s.enum.map((item) => JSON.stringify(item)).join('|')}`;
  }

  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      return types.includes('number')
        ? `${path} must be a finite number`
        : `${path} must be ${describeSchemaTypes(s.type)}`;
    }
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} must be a finite number`;
    if (typeof s.minimum === 'number' && value < s.minimum) {
      return `${path} out of bounds (${s.minimum}..${s.maximum ?? '∞'})`;
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      return `${path} out of bounds (${s.minimum ?? '-∞'}..${s.maximum})`;
    }
  }

  if (s.properties) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `${path} must be object`;
    }
    const obj = value as Record<string, unknown>;
    for (const required of s.required ?? []) {
      if (!(required in obj)) return `${path}.${required} is required`;
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!s.properties[key]) return `${path}.${key} is out of contract`;
      }
    }
    for (const [key, nested] of Object.entries(s.properties)) {
      if (key in obj) {
        const err = validateJsonSchemaSubset(obj[key], nested, `${path}.${key}`);
        if (err) return err;
      }
    }
  }

  if (s.items) {
    if (!Array.isArray(value)) return `${path} must be array`;
    if (Array.isArray(s.items)) {
      for (let i = 0; i < value.length; i++) {
        const itemSchema = s.items[Math.min(i, s.items.length - 1)];
        if (!itemSchema) continue;
        const err = validateJsonSchemaSubset(value[i], itemSchema, `${path}[${i}]`);
        if (err) return err;
      }
    } else {
      for (let i = 0; i < value.length; i++) {
        const err = validateJsonSchemaSubset(value[i], s.items, `${path}[${i}]`);
        if (err) return err;
      }
    }
  }

  return null;
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

const COLOR_STRING_PROPS = new Set([
  'fill',
  'defaultColor',
  'color',
  'textColor',
  'lineColor',
  'colorMask',
]);

function validatePolicyOverlay(key: string, value: unknown): string | null {
  if (COLOR_STRING_PROPS.has(key)) {
    return isColorString(value) ? null : `${key} must be a color string`;
  }

  switch (key) {
    case 'defaultFontName':
      return isNonEmptyString(value, 80) ? null : `${key} must be a non-empty string`;
    case 'opacity':
      if (!isFiniteNumber(value)) return 'opacity must be a finite number';
      if (value < 0 || value > 1) return 'opacity out of bounds (0..1)';
      return null;
    case 'lineHeight':
    case 'wordSpace':
    case 'paragraphSpace':
      if (!isFiniteNumber(value)) return `${key} must be a finite number`;
      if (value < 0 || value > 100) return `${key} out of bounds (0..100)`;
      return null;
    case 'radius':
      if (!isFiniteNumber(value)) return `${key} must be a finite number`;
      if (value < 0 || value > 500) return `${key} out of bounds (0..500)`;
      return null;
    case 'fontSize':
      if (!isFiniteNumber(value)) return `${key} must be a finite number`;
      if (value < 8 || value > 200) return `${key} out of bounds (8..200)`;
      return null;
    case 'outline': {
      const o = value as Record<string, unknown>;
      if ('width' in o && (!isFiniteNumber(o.width) || o.width < 0 || o.width > LINE_STROKE_MAX)) {
        return 'outline.width must be a finite number in range';
      }
      if ('color' in o && !isColorString(o.color)) return 'outline.color must be a color string';
      return null;
    }
    case 'shadow': {
      const o = value as Record<string, unknown>;
      return isColorString(o.color) ? null : 'shadow.color must be a color string';
    }
    case 'gradient': {
      const o = value as { colors?: unknown[] };
      if (!Array.isArray(o.colors) || o.colors.length === 0 || o.colors.length > 10) {
        return 'gradient.colors must contain 1..10 stops';
      }
      for (let i = 0; i < o.colors.length; i++) {
        const stop = o.colors[i] as Record<string, unknown>;
        if (!isFiniteNumber(stop.pos) || stop.pos < 0 || stop.pos > 100) {
          return `gradient.colors[${i}].pos must be a number in [0,100]`;
        }
        if (!isColorString(stop.color)) {
          return `gradient.colors[${i}].color must be a color string`;
        }
      }
      return null;
    }
    case 'filters': {
      for (const [filterKey, filterValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof filterValue !== 'string') return `filters.${filterKey} must be a string`;
        if (filterValue.length > 40) return `filters.${filterKey} must be at most 40 chars`;
      }
      return null;
    }
    case 'themeColors':
      if (!Array.isArray(value) || value.length === 0 || !value.every(isColorString)) {
        return 'themeColors must be a non-empty array of color strings';
      }
      return null;
    default:
      return null;
  }
}

/**
 * Validate non-geometry prop values. Returns an error string or null.
 * Geometry is handled by clampUpdateProps.
 */
export function validatePropValue(key: string, value: unknown, type: string): string | null {
  const schema = getEditablePropSchema(type, key);
  if (!schema) return `${key} is not valid on ${type} elements`;

  const schemaErr = validateJsonSchemaSubset(value, schema, key);
  if (schemaErr) return schemaErr;

  return validatePolicyOverlay(key, value);
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
    const width = out.width;
    if (type === 'line') {
      out.width = Math.min(LINE_STROKE_MAX, Math.max(LINE_STROKE_MIN, width));
    } else {
      const clampedWidth = Math.max(minSizeFor(type), width);
      out.width = clampCoord(clampedWidth, 'width');
    }
  }
  if ('height' in out) {
    if (!isFiniteNumber(out.height)) throw new Error(`height must be a finite number`);
    if (type === 'line') throw new Error(`line elements have no height`);
    const height = out.height;
    const clampedHeight = Math.max(minSizeFor(type), height);
    out.height = clampCoord(clampedHeight, 'height');
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
  targetElementTypes?: Record<string, string>,
): EditElementsGateResult {
  const inventory = buildElementInventory(elements);
  const ids = collectIntentTargetIds(intents);
  if (ids.length === 0) return { ok: false, reason: 'no element updates proposed' };

  const byId = new Map(inventory.map((el) => [el.id, el]));
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) return { ok: false, reason: `unknown element id ${JSON.stringify(id)}` };
    if (el.lock) return { ok: false, reason: `element ${JSON.stringify(id)} is locked` };
    const expectedType = targetElementTypes?.[id];
    if (expectedType && el.type !== expectedType) {
      return {
        ok: false,
        reason: `element ${JSON.stringify(id)} changed type from ${expectedType} to ${el.type}`,
      };
    }
  }
  const groupErr = enforceGroupCohesion(
    ids.map((id) => ({ id })),
    inventory,
  );
  if (groupErr) return { ok: false, reason: groupErr };
  return { ok: true, intents };
}
