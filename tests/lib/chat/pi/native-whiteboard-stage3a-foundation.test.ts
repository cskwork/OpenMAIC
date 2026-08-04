import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedWhiteboardAcceptedAck,
  createRevisionedWhiteboardTerminalAck,
  verifyRevisionedWhiteboardAuthorityReceipt,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { RevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import {
  NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES,
  NATIVE_WHITEBOARD_V2_TOOL_NAMES,
  createInternalNativeWhiteboardInventory,
  selectInternalNativeWhiteboardInventory,
  type NativeWhiteboardV2ToolName,
} from '@/lib/chat/pi/tools/native-whiteboard-inventory';
import { NativeWhiteboardObservationLedger } from '@/lib/chat/pi/tools/native-whiteboard-observation-ledger';
import { RevisionedWhiteboardMutationRuntime } from '@/lib/chat/pi/tools/revisioned-whiteboard-runtime';

const requestDigest = `sha256:${'a'.repeat(64)}`;

describe('Stage 3A shared observation ledger', () => {
  it('requires exact binding coverage instead of treating element coverage as hierarchical', () => {
    let sequence = 0;
    const ledger = new NativeWhiteboardObservationLedger({
      now: () => 10,
      createCapability: () => `capability-${++sequence}`,
    });
    const token = ledger.mintFromRead({
      childInvocationId: 'child-1',
      requestId: 'request-1',
      stageId: 'stage-1',
      whiteboardId: 'whiteboard-1',
      revision: 3,
      queryId: 'query-1',
      coverage: { kind: 'element', elementId: 'element-1' },
      expiresAt: 100,
    });

    expect(
      ledger.consume({
        token,
        childInvocationId: 'child-1',
        requestId: 'request-1',
        stageId: 'stage-1',
        whiteboardId: 'whiteboard-1',
        revision: 3,
        requiredCoverage: { kind: 'binding' },
      }),
    ).toEqual({ ok: false, code: 'OBSERVATION_COVERAGE_MISMATCH' });
    expect(ledger.getSizeForTests()).toBe(1);
  });

  it('does not trust a wire-shape receipt that bypassed coordinator authentication', () => {
    const ledger = new NativeWhiteboardObservationLedger();
    const receipt = verifyRevisionedWhiteboardAuthorityReceipt({
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId: 'execution-forged',
      requestDigest,
      toolName: 'wb_open',
      previousBinding: { stageId: 'stage-1', whiteboardId: null, revision: 0 },
      currentBinding: { stageId: 'stage-1', whiteboardId: 'whiteboard-1', revision: 1 },
      changed: true,
      mutationMayHaveCommitted: false,
      delta: {},
      postcondition: {},
    });
    if (!receipt) throw new Error('Expected wire-shape receipt fixture.');

    expect(
      ledger.mintFromMutationReceipt({
        authenticatedReceipt: {
          receipt,
          authenticatedTarget: {
            childInvocationId: 'child-forged',
            requestId: 'request-forged',
            sessionId: 'session-forged',
            sceneId: 'scene-forged',
          },
          deadlineAt: Date.now() + 10_000,
        } as never,
        coverage: { kind: 'binding' },
      }),
    ).toBeNull();
    expect(ledger.getSizeForTests()).toBe(0);
  });

  it('preserves the observation claim when coordinator registration fails before delivery', () => {
    const ledger = new NativeWhiteboardObservationLedger({
      createCapability: () => 'registration-capability',
    });
    const runtime = new RevisionedWhiteboardMutationRuntime(
      ledger,
      new RevisionedWhiteboardCoordinator({ maxEntries: 0 }),
    );
    const token = ledger.mintFromRead({
      childInvocationId: 'child-1',
      requestId: 'request-1',
      stageId: 'stage-1',
      whiteboardId: null,
      revision: 0,
      queryId: 'query-1',
      coverage: { kind: 'binding' },
      expiresAt: Date.now() + 1_000,
    });

    expect(() =>
      runtime.authorizeAndRegister({
        observationToken: token,
        childInvocationId: 'child-1',
        requestId: 'request-1',
        sessionId: 'session-1',
        sceneId: 'scene-1',
        executionId: 'execution-1',
        requestDigest,
        toolName: 'wb_open',
        expectedBinding: { stageId: 'stage-1', whiteboardId: null, revision: 0 },
        deadlineAt: Date.now() + 10_000,
        requiredCoverage: { kind: 'binding' },
      }),
    ).toThrow('REVISIONED_WHITEBOARD_COORDINATOR_CAPACITY_EXCEEDED');
    expect(ledger.getClaimForTests(token)).toBeDefined();
  });

  it('atomically consumes Runtime authorization before accepting browser ACKs', () => {
    let sequence = 0;
    const ledger = new NativeWhiteboardObservationLedger({
      createCapability: () => `capability-${++sequence}`,
    });
    const runtime = new RevisionedWhiteboardMutationRuntime(ledger);
    const expectedBinding = { stageId: 'stage-1', whiteboardId: null, revision: 0 };
    const deadlineAt = Date.now() + 10_000;
    const token = ledger.mintFromRead({
      childInvocationId: 'child-1',
      requestId: 'request-1',
      ...expectedBinding,
      queryId: 'query-1',
      coverage: { kind: 'binding' },
      expiresAt: Date.now() + 1_000,
    });
    const registration = runtime.authorizeAndRegister({
      observationToken: token,
      childInvocationId: 'child-1',
      requestId: 'request-1',
      sessionId: 'session-1',
      sceneId: 'scene-1',
      executionId: 'execution-1',
      requestDigest,
      toolName: 'wb_open',
      expectedBinding,
      deadlineAt,
      requiredCoverage: { kind: 'binding' },
    });
    expect(registration).toMatchObject({ ok: true });
    if (!registration.ok) throw new Error('Expected mutation authorization.');
    if (registration.registration.kind !== 'pending') {
      throw new Error('Expected a pending mutation registration.');
    }
    expect(
      runtime.authorizeAndRegister({
        observationToken: token,
        childInvocationId: 'child-1',
        requestId: 'request-1',
        sessionId: 'session-1',
        sceneId: 'scene-1',
        executionId: 'execution-retry',
        requestDigest,
        toolName: 'wb_open',
        expectedBinding,
        deadlineAt: Date.now() + 10_000,
        requiredCoverage: { kind: 'binding' },
      }),
    ).toEqual({ ok: false, code: 'OBSERVATION_CAPABILITY_INVALID' });

    const receipt = verifyRevisionedWhiteboardAuthorityReceipt({
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'committed',
      executionId: 'execution-1',
      requestDigest,
      toolName: 'wb_open',
      previousBinding: expectedBinding,
      currentBinding: { stageId: 'stage-1', whiteboardId: 'whiteboard-1', revision: 1 },
      changed: true,
      mutationMayHaveCommitted: false,
      delta: { created: true },
      postcondition: { open: true },
    });
    if (!receipt || receipt.outcome !== 'committed') throw new Error('Expected committed receipt.');
    expect(
      runtime.applyAck(
        registration.registration.acknowledgementToken,
        createRevisionedWhiteboardAcceptedAck({
          executionId: 'execution-1',
          requestDigest,
          targetBinding: {
            stageId: expectedBinding.stageId,
            whiteboardId: expectedBinding.whiteboardId,
            observedRevision: expectedBinding.revision,
          },
        }),
      ),
    ).toMatchObject({ kind: 'applied' });
    expect(
      runtime.applyAck(
        registration.registration.acknowledgementToken,
        createRevisionedWhiteboardTerminalAck(receipt),
      ),
    ).toMatchObject({ kind: 'applied' });
    const terminal = runtime.coordinator.getTerminal('execution-1');
    expect(Object.isFrozen(terminal)).toBe(true);
    const authenticatedReceipt = terminal?.authenticatedReceipt;
    expect(authenticatedReceipt).toBeDefined();
    expect(Object.isFrozen(authenticatedReceipt)).toBe(true);
    expect(Object.isFrozen(authenticatedReceipt?.authenticatedTarget)).toBe(true);
    expect(Object.isFrozen(authenticatedReceipt?.receipt)).toBe(true);
    expect(Object.isFrozen(authenticatedReceipt?.receipt.currentBinding)).toBe(true);
    expect(
      Reflect.set(authenticatedReceipt!.authenticatedTarget, 'childInvocationId', 'child-forged'),
    ).toBe(false);
    expect(Reflect.set(authenticatedReceipt!.receipt.currentBinding, 'revision', 99)).toBe(false);
    const receiptToken = runtime.mintFromVerifiedTerminal({
      executionId: 'execution-1',
      coverage: { kind: 'binding' },
    });
    expect(ledger.getClaimForTests(receiptToken!)).toMatchObject({
      source: 'mutation_receipt',
      childInvocationId: 'child-1',
      requestId: 'request-1',
      revision: 1,
      expiresAt: deadlineAt,
    });
    expect(
      runtime.mintFromVerifiedTerminal({
        executionId: 'execution-1',
        coverage: { kind: 'element', elementId: 'forged-element' },
      }),
    ).toBeNull();
  });
});

describe('Stage 3A version-level inventory selector', () => {
  it('keeps the current public call_agent inventory wholly on v1 before cutover', () => {
    const callAgentSource = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/pi/tools/call-agent.ts'),
      'utf8',
    );
    expect(callAgentSource).not.toMatch(
      /selectInternalNativeWhiteboardInventory|NATIVE_WHITEBOARD_V2_TOOL_NAMES|revisioned-whiteboard-runtime|\bwb_read\b/u,
    );
  });

  it('freezes the complete canonical names without publicly registerable stubs', () => {
    expect(NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES).toHaveLength(12);
    expect(NATIVE_WHITEBOARD_V2_TOOL_NAMES).toEqual([
      'wb_read',
      ...NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES,
    ]);
    const v2 = createInternalNativeWhiteboardInventory<() => void>({ version: 'v2' });
    expect(v2.functionallyComplete).toBe(false);
    expect(v2.handlers.size).toBe(0);
  });

  it('selects one whole inventory and rejects handlers from the other version', () => {
    const v1Handlers = new Map<NativeWhiteboardV2ToolName, () => void>(
      NATIVE_WHITEBOARD_MUTATION_TOOL_NAMES.map((name) => [name, () => undefined]),
    );
    const v2Handlers = new Map<NativeWhiteboardV2ToolName, () => void>(
      NATIVE_WHITEBOARD_V2_TOOL_NAMES.map((name) => [name, () => undefined]),
    );
    const v1 = createInternalNativeWhiteboardInventory({ version: 'v1', handlers: v1Handlers });
    const v2 = createInternalNativeWhiteboardInventory({ version: 'v2', handlers: v2Handlers });

    expect(v1.functionallyComplete).toBe(true);
    expect(v2.functionallyComplete).toBe(true);
    expect(selectInternalNativeWhiteboardInventory({ version: 'v2', v1, v2 })).toBe(v2);
    expect(() =>
      createInternalNativeWhiteboardInventory({
        version: 'v1',
        handlers: new Map<NativeWhiteboardV2ToolName, () => void>([['wb_read', () => undefined]]),
      }),
    ).toThrow('NATIVE_WHITEBOARD_INVENTORY_VERSION_MISMATCH');
  });
});
