import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeVisibleTextV1,
  type WhiteboardLineSpec,
  type WhiteboardShapeSpec,
} from './client-effect-contract';

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('REVISIONED_CANONICAL_VALUE_INVALID');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('REVISIONED_CANONICAL_VALUE_CYCLIC');
    ancestors.add(value);
    const normalized = Array.from({ length: value.length }, (_, index) =>
      index in value && value[index] !== undefined ? canonicalize(value[index], ancestors) : null,
    );
    ancestors.delete(value);
    return normalized;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error('REVISIONED_CANONICAL_VALUE_INVALID');
  }
  if (ancestors.has(value)) throw new Error('REVISIONED_CANONICAL_VALUE_CYCLIC');
  ancestors.add(value);
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry, ancestors)]),
  );
  ancestors.delete(value);
  return normalized;
}

export function canonicalRevisionedJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function digestRevisionedValue(value: unknown): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalRevisionedJson(value))))}`;
}

function deepFreezeRevisioned<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeRevisioned(child);
  }
  return Object.freeze(value);
}

export function immutableRevisionedSnapshot<T>(value: T): Readonly<T> {
  return deepFreezeRevisioned(JSON.parse(canonicalRevisionedJson(value)) as T);
}

export function digestOpaqueRevisionedToken(token: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(token)))}`;
}

export function digestVisibleTextV1Sync(value: string): string {
  const normalized = normalizeVisibleTextV1(value);
  return `sha256:${bytesToHex(
    sha256(utf8ToBytes(`${CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION}\n${normalized}`)),
  )}`;
}

export function digestWhiteboardShapeV1Sync(value: WhiteboardShapeSpec): string {
  const normalized = normalizeWhiteboardShapeV1({
    shape: value.shape,
    ...value.bounds,
    fillColor: value.fillColor,
  });
  return `sha256:${bytesToHex(
    sha256(
      utf8ToBytes(`${CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION}\n${JSON.stringify(normalized)}`),
    ),
  )}`;
}

export function digestWhiteboardLineV1Sync(value: WhiteboardLineSpec): string {
  const normalized = normalizeWhiteboardLineV1({
    startX: value.start.x,
    startY: value.start.y,
    endX: value.end.x,
    endY: value.end.y,
    color: value.strokeColor,
    width: value.strokeWidth,
    style: value.strokeStyle,
    points: value.markers,
  });
  return `sha256:${bytesToHex(
    sha256(
      utf8ToBytes(`${CLIENT_EFFECT_LINE_NORMALIZATION_VERSION}\n${JSON.stringify(normalized)}`),
    ),
  )}`;
}

function executionSuffix(executionId: string): string {
  return bytesToHex(sha256(utf8ToBytes(executionId)));
}

export function deriveRevisionedWhiteboardId(executionId: string): string {
  return `whiteboard-${executionSuffix(executionId)}`;
}

export function deriveRevisionedElementId(executionId: string): string {
  return `client-effect-${executionSuffix(executionId)}`;
}
