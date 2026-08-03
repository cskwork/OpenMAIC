import type {
  RevisionedWhiteboardAuthenticatedTarget,
  RevisionedWhiteboardBinding,
  RevisionedWhiteboardMutationAck,
  RevisionedWhiteboardMutationToolName,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  RevisionedWhiteboardCoordinator,
  type RevisionedAckResult,
  type RevisionedWhiteboardTerminal,
} from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import {
  NativeWhiteboardObservationLedger,
  type ConsumeObservationClaimResult,
  type ObservationCoverage,
} from './native-whiteboard-observation-ledger';

export type RevisionedWhiteboardAuthorizationResult =
  | { ok: true; acknowledgementToken: string }
  | Extract<ConsumeObservationClaimResult, { ok: false }>;

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

  authorizeAndRegister(input: {
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
  }): RevisionedWhiteboardAuthorizationResult {
    const authorization = this.observationLedger.consumeWith(
      {
        token: input.observationToken,
        childInvocationId: input.childInvocationId,
        requestId: input.requestId,
        stageId: input.expectedBinding.stageId,
        whiteboardId: input.expectedBinding.whiteboardId,
        revision: input.expectedBinding.revision,
        requiredCoverage: input.requiredCoverage,
      },
      () =>
        this.coordinator.register({
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
        }),
    );
    if (!authorization.ok) return authorization;
    return {
      ok: true,
      acknowledgementToken: authorization.value.acknowledgementToken,
    };
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
}
