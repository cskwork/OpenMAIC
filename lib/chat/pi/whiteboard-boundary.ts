import type { Stage } from '@/lib/types/stage';

const POSITION_PRECISION = 1_000;
const TOP_LEVEL_GEOMETRY_NUMBER_KEYS = new Set(['left', 'top', 'width', 'height', 'rotate']);

const TRANSIENT_ELEMENT_KEYS = new Set([
  'selected',
  'active',
  'hovered',
  'editing',
  'animationState',
  'renderState',
  'zIndex',
]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([nestedKey]) => !TRANSIENT_ELEMENT_KEYS.has(nestedKey))
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([nestedKey, nested]) => [nestedKey, normalizeValue(nested)]),
  );
}

function normalizeGeometryNumber(value: unknown): unknown {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * POSITION_PRECISION) / POSITION_PRECISION
    : normalizeValue(value);
}

function normalizeLineCoordinate(value: unknown): unknown {
  return Array.isArray(value) ? value.map(normalizeGeometryNumber) : normalizeValue(value);
}

function projectElement(element: unknown): Record<string, unknown> {
  if (!element || typeof element !== 'object') return {};
  const record = element as Record<string, unknown>;
  const isLine = record.type === 'line';
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !TRANSIENT_ELEMENT_KEYS.has(key))
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, value]) => {
        if (TOP_LEVEL_GEOMETRY_NUMBER_KEYS.has(key)) {
          return [key, normalizeGeometryNumber(value)];
        }
        if (isLine && (key === 'start' || key === 'end')) {
          return [key, normalizeLineCoordinate(value)];
        }
        return [key, normalizeValue(value)];
      }),
  );
}

function hashCanonicalString(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

export interface WhiteboardFingerprintSnapshot {
  whiteboardId: string;
  elementCount: number;
  fingerprint: string;
}

/** Fingerprint the same active whiteboard used by StageAPI (`whiteboard.at(-1)`). */
export function getActiveWhiteboardFingerprint(
  stage: Stage | null | undefined,
): WhiteboardFingerprintSnapshot | null {
  const whiteboard = stage?.whiteboard?.at(-1);
  if (!whiteboard) return null;
  const elements = [...(whiteboard.elements ?? [])].sort((left, right) =>
    compareCodeUnits(String(left.id ?? ''), String(right.id ?? '')),
  );
  const canonical = JSON.stringify({
    whiteboardId: whiteboard.id,
    elements: elements.map(projectElement),
  });
  return {
    whiteboardId: whiteboard.id,
    elementCount: elements.length,
    fingerprint: hashCanonicalString(canonical),
  };
}
