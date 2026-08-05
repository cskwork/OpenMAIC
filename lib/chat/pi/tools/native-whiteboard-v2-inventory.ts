import type { AgentTool } from '@earendil-works/pi-agent-core';
import { piRevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type {
  NativeClientEffectHandler,
  NativeClientQueryHandler,
  NativeToolCategory,
} from '@/lib/agent/runtime/native-child-contract';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { SendEvent } from '../types';
import {
  NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES,
  NATIVE_WHITEBOARD_V2_TOOL_NAMES,
  createImmutableMapSnapshot,
  createImmutableSetSnapshot,
  type InternalNativeWhiteboardInventory,
  type NativeWhiteboardInventoryVersion,
  type NativeWhiteboardMutationToolName,
  type NativeWhiteboardV2ToolName,
} from './native-whiteboard-inventory';
import { NativeWhiteboardObservationLedger } from './native-whiteboard-observation-ledger';
import { buildInternalNativeWhiteboardReadTool } from './native-whiteboard-read';
import {
  buildInternalRevisionedWhiteboardDrawCodeTool,
  buildInternalRevisionedWhiteboardEditCodeTool,
} from './native-whiteboard-v2-code';
import {
  buildInternalRevisionedWhiteboardClearTool,
  buildInternalRevisionedWhiteboardDeleteTool,
} from './native-whiteboard-v2-destructive';
import {
  buildInternalRevisionedWhiteboardDrawChartTool,
  buildInternalRevisionedWhiteboardDrawLatexTool,
  buildInternalRevisionedWhiteboardDrawLineTool,
  buildInternalRevisionedWhiteboardDrawShapeTool,
  buildInternalRevisionedWhiteboardDrawTableTool,
  buildInternalRevisionedWhiteboardDrawTextTool,
} from './native-whiteboard-v2-draw';
import {
  buildInternalRevisionedWhiteboardCloseTool,
  buildInternalRevisionedWhiteboardOpenTool,
} from './native-whiteboard-v2-lifecycle';
import { RevisionedWhiteboardMutationRuntime } from './revisioned-whiteboard-runtime';

export type InternalNativeWhiteboardV2Action = Readonly<{
  executionId: string;
  toolName: NativeWhiteboardMutationToolName;
  stableElementId?: string;
}>;

export type InternalNativeWhiteboardV2Entry =
  | Readonly<{
      kind: 'client_query';
      name: 'wb_read';
      category: 'read';
      tool: AgentTool;
      handler: NativeClientQueryHandler;
    }>
  | Readonly<{
      kind: 'client_effect';
      name: NativeWhiteboardMutationToolName;
      category: 'mutation';
      tool: AgentTool;
      handler: NativeClientEffectHandler;
    }>;

type InternalNativeWhiteboardV2Handler = NativeClientQueryHandler | NativeClientEffectHandler;

const executableV2Inventories = new WeakSet<object>();

export interface InternalNativeWhiteboardV2Inventory extends InternalNativeWhiteboardInventory<InternalNativeWhiteboardV2Handler> {
  readonly version: 'v2';
  readonly functionallyComplete: true;
  readonly entries: readonly InternalNativeWhiteboardV2Entry[];
  readonly tools: readonly AgentTool[];
  readonly clientQueryHandlers: ReadonlyMap<string, NativeClientQueryHandler>;
  readonly clientEffectHandlers: ReadonlyMap<string, NativeClientEffectHandler>;
  readonly toolCategories: ReadonlyMap<string, NativeToolCategory>;
  readonly allowedToolNames: ReadonlySet<string>;
  readonly observationLedger: NativeWhiteboardObservationLedger;
  readonly mutationRuntime: RevisionedWhiteboardMutationRuntime;
  readonly disposeChild: (childInvocationId: string) => void;
}

export interface InternalNativeWhiteboardV2InventoryOptions {
  body: StatelessChatRequest;
  send: SendEvent;
  canExecute: () => boolean;
  onActionDone: (details: InternalNativeWhiteboardV2Action) => void;
  observationLedger?: NativeWhiteboardObservationLedger;
  mutationRuntime?: RevisionedWhiteboardMutationRuntime;
  now?: () => number;
  createCapability?: () => string;
}

function freezeTool(tool: AgentTool): AgentTool {
  return Object.freeze({ ...tool });
}

function resolveSharedState(opts: InternalNativeWhiteboardV2InventoryOptions): {
  observationLedger: NativeWhiteboardObservationLedger;
  mutationRuntime: RevisionedWhiteboardMutationRuntime;
} {
  if (
    opts.observationLedger &&
    opts.mutationRuntime &&
    opts.mutationRuntime.observationLedger !== opts.observationLedger
  ) {
    throw new Error('NATIVE_WHITEBOARD_RUNTIME_LEDGER_MISMATCH');
  }
  const observationLedger =
    opts.observationLedger ??
    opts.mutationRuntime?.observationLedger ??
    new NativeWhiteboardObservationLedger({
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.createCapability ? { createCapability: opts.createCapability } : {}),
    });
  const mutationRuntime =
    opts.mutationRuntime ??
    new RevisionedWhiteboardMutationRuntime(observationLedger, piRevisionedWhiteboardCoordinator);
  return { observationLedger, mutationRuntime };
}

function topologyIsExact(input: {
  entries: readonly InternalNativeWhiteboardV2Entry[];
  tools: readonly AgentTool[];
  clientQueryHandlers: ReadonlyMap<string, NativeClientQueryHandler>;
  clientEffectHandlers: ReadonlyMap<string, NativeClientEffectHandler>;
  toolCategories: ReadonlyMap<string, NativeToolCategory>;
  allowedToolNames: ReadonlySet<string>;
}): boolean {
  const expectedNames = NATIVE_WHITEBOARD_V2_TOOL_NAMES;
  return (
    input.entries.length === expectedNames.length &&
    input.tools.length === expectedNames.length &&
    input.clientQueryHandlers.size === 1 &&
    input.clientQueryHandlers.has('wb_read') &&
    input.clientEffectHandlers.size === expectedNames.length - 1 &&
    NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES.every((name) => input.clientEffectHandlers.has(name)) &&
    input.toolCategories.size === expectedNames.length &&
    input.allowedToolNames.size === expectedNames.length &&
    input.entries.every(
      (entry, index) =>
        entry.name === expectedNames[index] &&
        entry.tool === input.tools[index] &&
        entry.tool.name === entry.name &&
        input.allowedToolNames.has(entry.name) &&
        input.toolCategories.get(entry.name) === entry.category &&
        (entry.kind === 'client_query'
          ? entry.name === 'wb_read' &&
            input.clientQueryHandlers.get(entry.name) === entry.handler &&
            !input.clientEffectHandlers.has(entry.name)
          : input.clientEffectHandlers.get(entry.name) === entry.handler &&
            !input.clientQueryHandlers.has(entry.name)),
    )
  );
}

function descriptorIsExact(inventory: InternalNativeWhiteboardInventory<unknown>): boolean {
  const expected =
    inventory.version === 'v2'
      ? NATIVE_WHITEBOARD_V2_TOOL_NAMES
      : NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES;
  return (
    inventory.canonicalToolNames.length === expected.length &&
    inventory.handlers.size === expected.length &&
    expected.every(
      (name, index) => inventory.canonicalToolNames[index] === name && inventory.handlers.has(name),
    )
  );
}

/** Selects one whole inventory. Per-tool v1/v2 composition is intentionally absent. */
export function selectInternalNativeWhiteboardInventory<V1Handler, V2Handler>(opts: {
  version: NativeWhiteboardInventoryVersion;
  v1: InternalNativeWhiteboardInventory<V1Handler>;
  v2: InternalNativeWhiteboardInventory<V2Handler>;
}): InternalNativeWhiteboardInventory<V1Handler> | InternalNativeWhiteboardInventory<V2Handler> {
  if (opts.v1.version !== 'v1' || opts.v2.version !== 'v2') {
    throw new Error('NATIVE_WHITEBOARD_INVENTORY_SELECTOR_INVALID');
  }
  const selected = opts.version === 'v1' ? opts.v1 : opts.v2;
  if (
    !selected.functionallyComplete ||
    !descriptorIsExact(selected) ||
    (selected.version === 'v2' &&
      (!executableV2Inventories.has(selected) ||
        !topologyIsExact(selected as unknown as InternalNativeWhiteboardV2Inventory)))
  ) {
    throw new Error('NATIVE_WHITEBOARD_INVENTORY_INCOMPLETE');
  }
  return selected;
}

/**
 * Internal/test-only Stage 3B assembly. Public call_agent must not import this
 * module before the atomic Stage 3C inventory cutover.
 */
export function buildInternalNativeWhiteboardV2Inventory(
  opts: InternalNativeWhiteboardV2InventoryOptions,
): InternalNativeWhiteboardV2Inventory {
  const { observationLedger, mutationRuntime } = resolveSharedState(opts);
  const sharedMutationOptions = {
    body: opts.body,
    send: opts.send,
    observationLedger,
    mutationRuntime,
    canExecute: opts.canExecute,
  } as const;
  const read = buildInternalNativeWhiteboardReadTool({
    body: opts.body,
    send: opts.send,
    observationLedger,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.createCapability ? { createCapability: opts.createCapability } : {}),
  });

  const mutationBundles: readonly Readonly<{
    name: NativeWhiteboardMutationToolName;
    tool: AgentTool;
    handler: NativeClientEffectHandler;
  }>[] = [
    {
      name: 'wb_open',
      ...buildInternalRevisionedWhiteboardOpenTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId }) => opts.onActionDone({ executionId, toolName: 'wb_open' }),
      }),
    },
    {
      name: 'wb_close',
      ...buildInternalRevisionedWhiteboardCloseTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId }) => opts.onActionDone({ executionId, toolName: 'wb_close' }),
      }),
    },
    {
      name: 'wb_draw_text',
      ...buildInternalRevisionedWhiteboardDrawTextTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_draw_text', stableElementId }),
      }),
    },
    {
      name: 'wb_draw_shape',
      ...buildInternalRevisionedWhiteboardDrawShapeTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_draw_shape', stableElementId }),
      }),
    },
    {
      name: 'wb_draw_line',
      ...buildInternalRevisionedWhiteboardDrawLineTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_draw_line', stableElementId }),
      }),
    },
    {
      name: 'wb_draw_latex',
      ...buildInternalRevisionedWhiteboardDrawLatexTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_draw_latex', stableElementId }),
      }),
    },
    {
      name: 'wb_draw_table',
      ...buildInternalRevisionedWhiteboardDrawTableTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_draw_table', stableElementId }),
      }),
    },
    {
      name: 'wb_draw_chart',
      ...buildInternalRevisionedWhiteboardDrawChartTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_draw_chart', stableElementId }),
      }),
    },
    {
      name: 'wb_draw_code',
      ...buildInternalRevisionedWhiteboardDrawCodeTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_draw_code', stableElementId }),
      }),
    },
    {
      name: 'wb_edit_code',
      ...buildInternalRevisionedWhiteboardEditCodeTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_edit_code', stableElementId }),
      }),
    },
    {
      name: 'wb_delete',
      ...buildInternalRevisionedWhiteboardDeleteTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId, stableElementId }) =>
          opts.onActionDone({ executionId, toolName: 'wb_delete', stableElementId }),
      }),
    },
    {
      name: 'wb_clear',
      ...buildInternalRevisionedWhiteboardClearTool({
        ...sharedMutationOptions,
        onActionDone: ({ executionId }) => opts.onActionDone({ executionId, toolName: 'wb_clear' }),
      }),
    },
  ];

  const entries = Object.freeze([
    Object.freeze({
      kind: 'client_query' as const,
      name: 'wb_read' as const,
      category: 'read' as const,
      tool: freezeTool(read.tool),
      handler: read.handler,
    }),
    ...mutationBundles.map(({ name, tool, handler }) =>
      Object.freeze({
        kind: 'client_effect' as const,
        name,
        category: 'mutation' as const,
        tool: freezeTool(tool),
        handler,
      }),
    ),
  ]) satisfies readonly InternalNativeWhiteboardV2Entry[];

  const queryEntries = entries.filter(
    (entry): entry is Extract<InternalNativeWhiteboardV2Entry, { kind: 'client_query' }> =>
      entry.kind === 'client_query',
  );
  const effectEntries = entries.filter(
    (entry): entry is Extract<InternalNativeWhiteboardV2Entry, { kind: 'client_effect' }> =>
      entry.kind === 'client_effect',
  );
  const combinedHandlers = new Map<NativeWhiteboardV2ToolName, InternalNativeWhiteboardV2Handler>(
    entries.map((entry) => [entry.name, entry.handler] as const),
  );
  const clientQueryHandlers = createImmutableMapSnapshot(
    queryEntries.map((entry) => [entry.name, entry.handler] as const),
  );
  const clientEffectHandlers = createImmutableMapSnapshot(
    effectEntries.map((entry) => [entry.name, entry.handler] as const),
  );
  const toolCategories = createImmutableMapSnapshot(
    entries.map((entry) => [entry.name, entry.category] as const),
  );
  const allowedToolNames = createImmutableSetSnapshot(entries.map((entry) => entry.name));
  const tools = Object.freeze(entries.map((entry) => entry.tool));

  const inventory = Object.freeze({
    version: 'v2' as const,
    canonicalToolNames: Object.freeze([...NATIVE_WHITEBOARD_V2_TOOL_NAMES]),
    handlers: createImmutableMapSnapshot(combinedHandlers),
    functionallyComplete: true as const,
    entries,
    tools,
    clientQueryHandlers,
    clientEffectHandlers,
    toolCategories,
    allowedToolNames,
    observationLedger,
    mutationRuntime,
    disposeChild: (childInvocationId: string) => read.dispose(childInvocationId),
  }) satisfies InternalNativeWhiteboardV2Inventory;
  if (!descriptorIsExact(inventory) || !topologyIsExact(inventory)) {
    throw new Error('NATIVE_WHITEBOARD_INVENTORY_INCOMPLETE');
  }
  executableV2Inventories.add(inventory);
  return inventory;
}
