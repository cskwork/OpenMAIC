import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { piRevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type {
  ClientEffectExecutionRequest,
  ClientQueryExecutionRequest,
} from '@/lib/agent/runtime/native-child-contract';
import type { StatelessChatRequest } from '@/lib/types/chat';
import {
  NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES,
  NATIVE_WHITEBOARD_V2_TOOL_NAMES,
  createInternalNativeWhiteboardInventory,
  type NativeWhiteboardV2ToolName,
} from '@/lib/chat/pi/tools/native-whiteboard-inventory';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import {
  buildInternalNativeWhiteboardV2Inventory,
  selectInternalNativeWhiteboardInventory,
} from '@/lib/chat/pi/tools/native-whiteboard-v2-inventory';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';

function body(): StatelessChatRequest {
  return {
    messages: [],
    config: {
      agentIds: ['teacher-1'],
      piSessionId: 'session-1',
      piRequestId: 'request-1',
    },
    storeState: {
      stage: {
        id: 'stage-1',
        name: 'Stage',
        createdAt: 1,
        updatedAt: 1,
        whiteboard: [],
      },
      scenes: [],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    apiKey: 'test-only',
  } as StatelessChatRequest;
}

function buildInventory(
  input: {
    observationLedger?: NativeWhiteboardObservationLedger;
    mutationRuntime?: RevisionedWhiteboardMutationRuntime;
  } = {},
) {
  return buildInternalNativeWhiteboardV2Inventory({
    body: body(),
    send: vi.fn(async () => undefined),
    canExecute: () => true,
    onActionDone: vi.fn(),
    ...input,
  });
}

describe('Stage 3B internal v2 inventory closure', () => {
  it('assembles the exact immutable query/effect topology from all real builders', () => {
    const inventory = buildInventory();

    expect(inventory.version).toBe('v2');
    expect(inventory.functionallyComplete).toBe(true);
    expect(inventory.canonicalToolNames).toEqual(NATIVE_WHITEBOARD_V2_TOOL_NAMES);
    expect(inventory.entries.map(({ name }) => name)).toEqual(NATIVE_WHITEBOARD_V2_TOOL_NAMES);
    expect(inventory.tools.map(({ name }) => name)).toEqual(NATIVE_WHITEBOARD_V2_TOOL_NAMES);
    expect([...inventory.clientQueryHandlers.keys()]).toEqual(['wb_read']);
    expect([...inventory.clientEffectHandlers.keys()]).toEqual(
      NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES,
    );
    expect([...inventory.toolCategories]).toEqual([
      ['wb_read', 'read'],
      ...NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES.map((name) => [name, 'mutation'] as const),
    ]);
    expect([...inventory.allowedToolNames]).toEqual(NATIVE_WHITEBOARD_V2_TOOL_NAMES);
    expect(inventory.entries.every((entry) => entry.tool.name === entry.name)).toBe(true);
    expect(
      inventory.entries.every((entry) =>
        entry.kind === 'client_query'
          ? inventory.clientQueryHandlers.get(entry.name) === entry.handler &&
            !inventory.clientEffectHandlers.has(entry.name)
          : inventory.clientEffectHandlers.get(entry.name) === entry.handler &&
            !inventory.clientQueryHandlers.has(entry.name),
      ),
    ).toBe(true);

    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.canonicalToolNames)).toBe(true);
    expect(Object.isFrozen(inventory.entries)).toBe(true);
    expect(Object.isFrozen(inventory.tools)).toBe(true);
    expect(inventory.tools.every(Object.isFrozen)).toBe(true);
    expect('set' in inventory.clientEffectHandlers).toBe(false);
    expect('delete' in inventory.clientEffectHandlers).toBe(false);
    expect('add' in inventory.allowedToolNames).toBe(false);
    const mapPrototype = Object.getPrototypeOf(inventory.clientEffectHandlers);
    const setPrototype = Object.getPrototypeOf(inventory.allowedToolNames);
    expect(Object.isFrozen(mapPrototype)).toBe(true);
    expect(Object.isFrozen(setPrototype)).toBe(true);
    expect(Reflect.set(mapPrototype, 'get', () => 'forged')).toBe(false);
    expect(Reflect.set(mapPrototype, 'has', () => false)).toBe(false);
    expect(Reflect.set(setPrototype, 'has', () => true)).toBe(false);
    expect(Reflect.set(inventory.tools[0]!, 'name', 'forged')).toBe(false);
    expect(Reflect.set(inventory.entries[0]!, 'name', 'forged')).toBe(false);
    expect(inventory.tools[0]!.name).toBe('wb_read');
  });

  it('resolves exactly one ledger/runtime around the production ACK coordinator', () => {
    const automatic = buildInventory();
    expect(automatic.mutationRuntime.observationLedger).toBe(automatic.observationLedger);
    expect(automatic.mutationRuntime.coordinator).toBe(piRevisionedWhiteboardCoordinator);

    const ledger = new NativeWhiteboardObservationLedger();
    const fromLedger = buildInventory({ observationLedger: ledger });
    expect(fromLedger.observationLedger).toBe(ledger);
    expect(fromLedger.mutationRuntime.observationLedger).toBe(ledger);
    expect(fromLedger.mutationRuntime.coordinator).toBe(piRevisionedWhiteboardCoordinator);

    const runtime = new RevisionedWhiteboardMutationRuntime(
      ledger,
      piRevisionedWhiteboardCoordinator,
    );
    const fromRuntime = buildInventory({ mutationRuntime: runtime });
    expect(fromRuntime.observationLedger).toBe(ledger);
    expect(fromRuntime.mutationRuntime).toBe(runtime);
    expect(
      buildInventory({ observationLedger: ledger, mutationRuntime: runtime }).mutationRuntime,
    ).toBe(runtime);

    expect(() =>
      buildInventory({
        observationLedger: new NativeWhiteboardObservationLedger(),
        mutationRuntime: runtime,
      }),
    ).toThrow('NATIVE_WHITEBOARD_RUNTIME_LEDGER_MISMATCH');
  });

  it('routes all thirteen real entries through their exact execution discriminant', async () => {
    const send = vi.fn(async () => undefined);
    const inventory = buildInternalNativeWhiteboardV2Inventory({
      body: body(),
      send,
      canExecute: () => true,
      onActionDone: vi.fn(),
      now: () => 10,
    });
    const commonRequest = {
      protocolVersion: 'maic.tool-execution.v1' as const,
      traceId: 'trace-1',
      runId: 'run-1',
      agentInvocationId: 'child-1',
      agentId: 'teacher-1',
      depth: 1,
      sequence: 1,
      toolCallId: 'call-1',
      executionId: 'execution-1',
      idempotencyKey: 'idempotency-1',
      args: {},
      argsDigest: 'sha256:test',
      issuedAt: 1,
      deadlineAt: 10,
      attempt: 1,
    };

    const readResult = await inventory.clientQueryHandlers.get('wb_read')!({
      request: {
        ...commonRequest,
        kind: 'client_query',
        toolName: 'wb_read',
      } satisfies ClientQueryExecutionRequest,
      params: { scope: 'summary' },
    });
    expect(readResult).toMatchObject({
      isError: true,
      details: { code: 'CLIENT_QUERY_TIMEOUT' },
    });

    for (const toolName of NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES) {
      const result = await inventory.clientEffectHandlers.get(toolName)!({
        request: {
          ...commonRequest,
          kind: 'client_effect',
          toolName: 'wrong-route',
        } satisfies ClientEffectExecutionRequest,
        params: {},
      });
      expect(result).toMatchObject({
        isError: true,
        details: { code: 'REVISIONED_WHITEBOARD_TOOL_MISMATCH' },
      });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('selects only a complete version and never promotes generic v2 handler maps', () => {
    const v1 = createInternalNativeWhiteboardInventory({
      version: 'v1',
      handlers: new Map(
        NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES.map((name) => [name, vi.fn()] as const),
      ),
    });
    const genericV2 = createInternalNativeWhiteboardInventory({
      version: 'v2',
      handlers: new Map(NATIVE_WHITEBOARD_V2_TOOL_NAMES.map((name) => [name, vi.fn()] as const)),
    });
    const concreteV2 = buildInventory();

    expect(selectInternalNativeWhiteboardInventory({ version: 'v1', v1, v2: genericV2 })).toBe(v1);
    expect(() =>
      selectInternalNativeWhiteboardInventory({ version: 'v2', v1, v2: genericV2 }),
    ).toThrow('NATIVE_WHITEBOARD_INVENTORY_INCOMPLETE');
    expect(selectInternalNativeWhiteboardInventory({ version: 'v2', v1, v2: concreteV2 })).toBe(
      concreteV2,
    );
    const forgedV2 = Object.freeze({ ...concreteV2 });
    expect(() =>
      selectInternalNativeWhiteboardInventory({ version: 'v2', v1, v2: forgedV2 }),
    ).toThrow('NATIVE_WHITEBOARD_INVENTORY_INCOMPLETE');

    const incompleteV1 = createInternalNativeWhiteboardInventory({
      version: 'v1',
      handlers: new Map<NativeWhiteboardV2ToolName, () => void>(),
    });
    expect(() =>
      selectInternalNativeWhiteboardInventory({ version: 'v1', v1: incompleteV1, v2: concreteV2 }),
    ).toThrow('NATIVE_WHITEBOARD_INVENTORY_INCOMPLETE');
  });

  it('cleans child-owned read capabilities without replacing mutation coordinator lifecycle', () => {
    let sequence = 0;
    const inventory = buildInternalNativeWhiteboardV2Inventory({
      body: body(),
      send: vi.fn(async () => undefined),
      canExecute: () => true,
      onActionDone: vi.fn(),
      createCapability: () => `capability-${++sequence}`,
    });
    inventory.observationLedger.mintFromRead({
      childInvocationId: 'child-1',
      requestId: 'request-1',
      stageId: 'stage-1',
      whiteboardId: null,
      revision: 0,
      queryId: 'query-1',
      coverage: { kind: 'binding' },
      expiresAt: Date.now() + 1_000,
    });
    expect(inventory.observationLedger.getSizeForTests()).toBe(1);
    inventory.disposeChild('child-1');
    expect(inventory.observationLedger.getSizeForTests()).toBe(0);
    expect(inventory.mutationRuntime.coordinator).toBe(piRevisionedWhiteboardCoordinator);
  });

  it('keeps the concrete assembly outside the public call_agent import graph', () => {
    const callAgentSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/pi/tools/call-agent.ts'),
      'utf8',
    );
    expect(callAgentSource).not.toContain('native-whiteboard-v2-inventory');
    expect(callAgentSource).not.toMatch(/buildInternalNativeWhiteboardV2Inventory/u);

    const inventorySource = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/pi/tools/native-whiteboard-inventory.ts'),
      'utf8',
    );
    expect(inventorySource).not.toMatch(/native-whiteboard-v2-(draw|code|lifecycle|destructive)/u);

    expect(inventorySource).not.toContain('createExecutableInternalNativeWhiteboardV2Inventory');
  });
});
