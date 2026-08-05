import {
  REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES,
  type RevisionedWhiteboardMutationToolName,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';

export const NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES = Object.freeze([
  ...REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES,
]) as readonly RevisionedWhiteboardMutationToolName[];

export const NATIVE_WHITEBOARD_V2_TOOL_NAMES = Object.freeze([
  'wb_read',
  ...NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES,
]) as readonly NativeWhiteboardV2ToolName[];

export type NativeWhiteboardMutationToolName = RevisionedWhiteboardMutationToolName;
export type NativeWhiteboardV2ToolName = 'wb_read' | NativeWhiteboardMutationToolName;
export type NativeWhiteboardInventoryVersion = 'v1' | 'v2';

export interface InternalNativeWhiteboardInventory<Handler> {
  readonly version: NativeWhiteboardInventoryVersion;
  readonly canonicalToolNames: readonly NativeWhiteboardV2ToolName[];
  readonly handlers: ReadonlyMap<NativeWhiteboardV2ToolName, Handler>;
  readonly functionallyComplete: boolean;
}

class ImmutableMapSnapshot<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void): void {
    this.#map.forEach((value, key) => callbackfn(value, key, this));
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

class ImmutableSetSnapshot<T> implements ReadonlySet<T> {
  readonly #set: Set<T>;

  constructor(values: Iterable<T>) {
    this.#set = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#set.size;
  }

  has(value: T): boolean {
    return this.#set.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#set.entries();
  }

  keys(): SetIterator<T> {
    return this.#set.keys();
  }

  values(): SetIterator<T> {
    return this.#set.values();
  }

  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void): void {
    this.#set.forEach((value) => callbackfn(value, value, this));
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  union<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const result = new Set<T | U>(this);
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next()) result.add(next.value);
    return result;
  }

  intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
    return new Set([...this].filter((value): value is T & U => other.has(value as unknown as U)));
  }

  difference<U>(other: ReadonlySetLike<U>): Set<T> {
    return new Set([...this].filter((value) => !other.has(value as unknown as U)));
  }

  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const result = this.difference(other) as Set<T | U>;
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next())
      if (!this.has(next.value as unknown as T)) result.add(next.value);
    return result;
  }

  isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
    return [...this].every((value) => other.has(value));
  }

  isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next())
      if (!this.has(next.value as T)) return false;
    return true;
  }

  isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
    return [...this].every((value) => !other.has(value));
  }
}

Object.freeze(ImmutableMapSnapshot.prototype);
Object.freeze(ImmutableSetSnapshot.prototype);

export function createImmutableMapSnapshot<K, V>(
  entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  return new ImmutableMapSnapshot(entries);
}

export function createImmutableSetSnapshot<T>(values: Iterable<T>): ReadonlySet<T> {
  return new ImmutableSetSnapshot(values);
}

function canonicalNamesFor(version: NativeWhiteboardInventoryVersion) {
  return version === 'v2'
    ? Object.freeze([...NATIVE_WHITEBOARD_V2_TOOL_NAMES])
    : Object.freeze([...NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES]);
}

function handlersAreExact<Handler>(
  canonicalToolNames: readonly NativeWhiteboardV2ToolName[],
  handlers: ReadonlyMap<NativeWhiteboardV2ToolName, Handler>,
): boolean {
  return (
    handlers.size === canonicalToolNames.length &&
    canonicalToolNames.every((name) => handlers.has(name))
  );
}

/**
 * Version-level internal factory. Stage 3A may create a partial v2 descriptor
 * for tests, but the public selector is not allowed to register it until every
 * canonical handler is present. Missing handlers are represented by absence,
 * never by publicly registerable throwing stubs.
 */
export function createInternalNativeWhiteboardInventory<Handler>(opts: {
  version: NativeWhiteboardInventoryVersion;
  handlers?: ReadonlyMap<NativeWhiteboardV2ToolName, Handler>;
}): InternalNativeWhiteboardInventory<Handler> {
  const canonicalToolNames = canonicalNamesFor(opts.version);
  const handlers = createImmutableMapSnapshot(opts.handlers ?? []);
  const allowed = new Set<NativeWhiteboardV2ToolName>(canonicalToolNames);
  for (const name of handlers.keys()) {
    if (!allowed.has(name)) throw new Error('NATIVE_WHITEBOARD_INVENTORY_VERSION_MISMATCH');
  }
  return Object.freeze({
    version: opts.version,
    canonicalToolNames,
    handlers,
    functionallyComplete: opts.version === 'v1' && handlersAreExact(canonicalToolNames, handlers),
  });
}
