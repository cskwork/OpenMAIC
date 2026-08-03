import {
  REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES,
  type RevisionedWhiteboardMutationToolName,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';

export const NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES = REVISIONED_WHITEBOARD_MUTATION_TOOL_NAMES;

export const NATIVE_WHITEBOARD_V2_TOOL_NAMES = [
  'wb_read',
  ...NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES,
] as const;

export type NativeWhiteboardMutationToolName = RevisionedWhiteboardMutationToolName;
export type NativeWhiteboardV2ToolName = (typeof NATIVE_WHITEBOARD_V2_TOOL_NAMES)[number];
export type NativeWhiteboardInventoryVersion = 'v1' | 'v2';

export interface InternalNativeWhiteboardInventory<Handler> {
  version: NativeWhiteboardInventoryVersion;
  canonicalToolNames: readonly NativeWhiteboardV2ToolName[];
  handlers: ReadonlyMap<NativeWhiteboardV2ToolName, Handler>;
  functionallyComplete: boolean;
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
  const canonicalToolNames: readonly NativeWhiteboardV2ToolName[] =
    opts.version === 'v2' ? NATIVE_WHITEBOARD_V2_TOOL_NAMES : NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES;
  const handlers = new Map(opts.handlers ?? []);
  const allowed = new Set<NativeWhiteboardV2ToolName>(canonicalToolNames);
  for (const name of handlers.keys()) {
    if (!allowed.has(name)) throw new Error('NATIVE_WHITEBOARD_INVENTORY_VERSION_MISMATCH');
  }
  return Object.freeze({
    version: opts.version,
    canonicalToolNames,
    handlers,
    functionallyComplete:
      handlers.size === canonicalToolNames.length &&
      canonicalToolNames.every((name) => handlers.has(name)),
  });
}

/** Selects one whole inventory. Per-tool v1/v2 composition is intentionally absent. */
export function selectInternalNativeWhiteboardInventory<Handler>(opts: {
  version: NativeWhiteboardInventoryVersion;
  v1: InternalNativeWhiteboardInventory<Handler>;
  v2: InternalNativeWhiteboardInventory<Handler>;
}): InternalNativeWhiteboardInventory<Handler> {
  if (opts.v1.version !== 'v1' || opts.v2.version !== 'v2') {
    throw new Error('NATIVE_WHITEBOARD_INVENTORY_SELECTOR_INVALID');
  }
  return opts.version === 'v1' ? opts.v1 : opts.v2;
}
