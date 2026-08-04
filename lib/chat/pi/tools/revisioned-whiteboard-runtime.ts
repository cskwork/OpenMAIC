import type {
  RevisionedWhiteboardAuthenticatedTarget,
  RevisionedWhiteboardBinding,
  RevisionedWhiteboardMutationAck,
  RevisionedWhiteboardMutationToolName,
  RevisionedWhiteboardExpectedDescriptor,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  RevisionedWhiteboardCoordinator,
  type RevisionedAckResult,
  type RegisteredRevisionedMutation,
  type RevisionedWhiteboardTerminal,
} from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import {
  NativeWhiteboardObservationLedger,
  type ConsumeObservationClaimResult,
  type ObservationCoverage,
} from './native-whiteboard-observation-ledger';

export type RevisionedWhiteboardAuthorizationResult =
  | { ok: true; registration: RegisteredRevisionedMutation }
  | Extract<ConsumeObservationClaimResult, { ok: false }>;

export interface RevisionedWhiteboardAuthorizationInput {
  observationToken: string;
  childInvocationId: string;
  requestId: string;
  executionId: string;
  requestDigest: string;
  toolName: RevisionedWhiteboardMutationToolName;
  expectedBinding: RevisionedWhiteboardBinding;
  sessionId: string;
  sceneId: string;
  deadlineAt: number;
  requiredCoverage: ObservationCoverage;
  intentDigest?: string;
  expectedMutation?: RevisionedWhiteboardExpectedDescriptor;
}

/**
 * Request-scoped Stage 3A seam. Authorization is consumed before a caller may
 * deliver anything to the browser. The browser Authority then performs its own
 * environment CAS; these are deliberately separate trust boundaries.
 */
export class RevisionedWhiteboardMutationRuntime {
  constructor(
    readonly observationLedger: NativeWhiteboardObservationLedger,
    readonly coordinator: RevisionedWhiteboardCoordinator = new RevisionedWhiteboardCoordinator(),
  ) {}

  findAuthorizedReplay(
    input: RevisionedWhiteboardAuthorizationInput,
  ): RegisteredRevisionedMutation | null {
    return this.coordinator.findAuthorizedReplay(this.prepareRegistration(input).coordinatorInput);
  }

  authorizeAndRegister(
    input: RevisionedWhiteboardAuthorizationInput,
  ): RevisionedWhiteboardAuthorizationResult {
    const { claimInput, coordinatorInput } = this.prepareRegistration(input);
    const replay = this.coordinator.findAuthorizedReplay(coordinatorInput);
    if (replay) return { ok: true, registration: replay };
    const authorization = this.observationLedger.consumeWith(claimInput, () =>
      this.coordinator.register(coordinatorInput),
    );
    if (!authorization.ok) return authorization;
    return {
      ok: true,
      registration: authorization.value,
    };
  }

  private prepareRegistration(input: RevisionedWhiteboardAuthorizationInput) {
    const claimInput = {
      token: input.observationToken,
      childInvocationId: input.childInvocationId,
      requestId: input.requestId,
      stageId: input.expectedBinding.stageId,
      whiteboardId: input.expectedBinding.whiteboardId,
      revision: input.expectedBinding.revision,
      requiredCoverage: input.requiredCoverage,
    } as const;
    const observationAuthorizationDigest =
      this.observationLedger.createAuthorizationDigest(claimInput);
    const coordinatorInput = {
      executionId: input.executionId,
      requestDigest: input.requestDigest,
      toolName: input.toolName,
      expectedBinding: input.expectedBinding,
      authenticatedTarget: {
        childInvocationId: input.childInvocationId,
        requestId: input.requestId,
        sessionId: input.sessionId,
        sceneId: input.sceneId,
      } satisfies RevisionedWhiteboardAuthenticatedTarget,
      deadlineAt: input.deadlineAt,
      observationAuthorizationDigest,
      ...(input.intentDigest ? { intentDigest: input.intentDigest } : {}),
      ...(input.expectedMutation ? { expectedMutation: input.expectedMutation } : {}),
    };
    return { claimInput, coordinatorInput };
  }

  applyAck(
    acknowledgementToken: string,
    ack: RevisionedWhiteboardMutationAck,
  ): RevisionedAckResult {
    return this.coordinator.applyAck(acknowledgementToken, ack);
  }

  settleDeliveryFailure(executionId: string): RevisionedWhiteboardTerminal | null {
    return this.coordinator.settleDeliveryFailure(executionId);
  }

  takeActionCharge(executionId: string): boolean {
    return this.coordinator.takeActionCharge(executionId);
  }

  mintFromVerifiedTerminal(input: {
    executionId: string;
    coverage: ObservationCoverage;
  }): string | null {
    const terminal = this.coordinator.getTerminal(input.executionId);
    if (!terminal?.authenticatedReceipt) return null;
    return this.observationLedger.mintFromMutationReceipt({
      authenticatedReceipt: terminal.authenticatedReceipt,
      coverage: input.coverage,
    });
  }

  mintDrawElementBundle(input: {
    executionId: string;
    expected: RevisionedWhiteboardExpectedDescriptor;
  }) {
    const terminal = this.coordinator.getTerminal(input.executionId);
    if (!terminal?.authenticatedReceipt) return null;
    return this.observationLedger.mintDrawElementCapabilityBundle({
      authenticatedReceipt: terminal.authenticatedReceipt,
      expected: input.expected,
    });
  }

  mintBindingOnlyBundle(input: {
    executionId: string;
    expected: RevisionedWhiteboardExpectedDescriptor;
  }) {
    const terminal = this.coordinator.getTerminal(input.executionId);
    if (!terminal?.authenticatedReceipt) return null;
    return this.observationLedger.mintBindingOnlyCapabilityBundle({
      authenticatedReceipt: terminal.authenticatedReceipt,
      expected: input.expected,
    });
  }

  mintCodeDrawBundle(input: {
    executionId: string;
    expected: RevisionedWhiteboardExpectedDescriptor;
  }) {
    const terminal = this.coordinator.getTerminal(input.executionId);
    if (!terminal?.authenticatedReceipt) return null;
    return this.observationLedger.mintCodeDrawCapabilityBundle({
      authenticatedReceipt: terminal.authenticatedReceipt,
      expected: input.expected,
    });
  }

  mintCodeEditBundle(input: {
    executionId: string;
    expected: RevisionedWhiteboardExpectedDescriptor;
  }) {
    const terminal = this.coordinator.getTerminal(input.executionId);
    if (!terminal?.authenticatedReceipt) return null;
    return this.observationLedger.mintCodeEditCapabilityBundle({
      authenticatedReceipt: terminal.authenticatedReceipt,
      expected: input.expected,
    });
  }

  mintDeleteBundle(input: {
    executionId: string;
    expected: RevisionedWhiteboardExpectedDescriptor;
  }) {
    const terminal = this.coordinator.getTerminal(input.executionId);
    if (!terminal?.authenticatedReceipt) return null;
    return this.observationLedger.mintDeleteCapabilityBundle({
      authenticatedReceipt: terminal.authenticatedReceipt,
      expected: input.expected,
    });
  }

  mintClearBundle(input: {
    executionId: string;
    expected: RevisionedWhiteboardExpectedDescriptor;
  }) {
    const terminal = this.coordinator.getTerminal(input.executionId);
    if (!terminal?.authenticatedReceipt) return null;
    return this.observationLedger.mintClearCapabilityBundle({
      authenticatedReceipt: terminal.authenticatedReceipt,
      expected: input.expected,
    });
  }
}
