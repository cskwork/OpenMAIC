/**
 * Shared payload guard for JSON-carrying backends (HTTP transport, Postgres
 * JSONB). The browser backend persists payloads via structured clone, which
 * preserves values JSON cannot represent (Map, Set, Date, NaN, nested
 * undefined, bigint). A JSON backend that accepted those would silently hand
 * back different data on the next read — appendRecord's return value and a
 * later listRecords would disagree. JSON backends therefore narrow the
 * accepted payload domain and fail loud at the write boundary.
 *
 * JSONB note: Postgres jsonb cannot store the NUL code point (U+0000) inside
 * strings (error 22P05), so strings containing it are rejected here too —
 * keeping the payload domain identical across JSON backends rather than
 * letting one accept what another must refuse.
 */

interface NonJsonValue {
  pointer: string;
  reason: string;
}

function isPlainPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function findNonJsonValue(
  value: unknown,
  pointer: string,
  seen: Set<object>,
): NonJsonValue | undefined {
  if (value === null || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return undefined;
    return { pointer, reason: `non-finite number ${String(value)}` };
  }
  if (typeof value === 'string') {
    if (!value.includes('\u0000')) return undefined;
    return { pointer, reason: 'string contains the NUL code point (\\u0000)' };
  }
  if (typeof value !== 'object') {
    return { pointer, reason: `${typeof value} is not a JSON value` };
  }
  if (seen.has(value)) return { pointer, reason: 'circular reference' };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          return { pointer: `${pointer}/${index}`, reason: 'sparse array hole' };
        }
        const nested = findNonJsonValue(value[index], `${pointer}/${index}`, seen);
        if (nested) return nested;
      }
      return undefined;
    }
    if (!isPlainPrototype(value)) {
      return {
        pointer,
        reason: 'not a plain object (Map, Set, Date, class instances do not survive JSON)',
      };
    }
    for (const [key, member] of Object.entries(value)) {
      const memberPointer = `${pointer}/${key}`;
      if (member === undefined) {
        return { pointer: memberPointer, reason: 'undefined member (dropped by JSON)' };
      }
      const nested = findNonJsonValue(member, memberPointer, seen);
      if (nested) return nested;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

/** Throw unless `value` survives JSON serialization losslessly. */
export function assertJsonValue(value: unknown, label: string): void {
  const offender = findNonJsonValue(value, '', new Set());
  if (offender) {
    throw new Error(
      `@openmaic/storage: ${label} is not a plain JSON value at ` +
        `'${offender.pointer || '/'}': ${offender.reason}`,
    );
  }
}
