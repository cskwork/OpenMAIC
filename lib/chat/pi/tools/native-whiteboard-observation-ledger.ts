import { nanoid } from 'nanoid';
import {
  isRevisionedDrawTextCommittedReceipt,
  type RevisionedDrawTextExpectedDescriptor,
  type RevisionedWhiteboardCommittedReceipt,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  digestOpaqueRevisionedToken,
  digestRevisionedValue,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import {
  isCoordinatorAuthenticatedRevisionedWhiteboardReceipt,
  type CoordinatorAuthenticatedRevisionedWhiteboardReceipt,
} from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';

const DEFAULT_MAX_OBSERVATION_CLAIMS = 600;
const DEFAULT_MAX_MINT_RECORDS = 256;
const DEFAULT_MAX_MINT_REJECTION_RECORDS = 64;

export type ObservationSource = 'wb_read' | 'mutation_receipt';

export type ObservationCoverage =
  | { kind: 'binding' }
  | { kind: 'element'; elementId: string }
  | { kind: 'membership'; complete: true }
  | { kind: 'code'; elementId: string; complete: true };

type ObservationClaim = {
  childInvocationId: string;
  requestId: string;
  stageId: string;
  whiteboardId: string | null;
  revision: number;
  source: ObservationSource;
  sourceId: string;
  coverage: ObservationCoverage;
  expiresAt: number;
};

export interface ConsumeObservationClaimInput {
  token: string;
  childInvocationId: string;
  requestId: string;
  stageId: string;
  whiteboardId: string | null;
  revision: number;
  requiredCoverage: ObservationCoverage;
}

export type ConsumeObservationClaimResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'OBSERVATION_CAPABILITY_INVALID'
        | 'OBSERVATION_CAPABILITY_STALE'
        | 'OBSERVATION_COVERAGE_MISMATCH';
    };

export type ConsumeObservationClaimWithResult<T> =
  | { ok: true; value: T }
  | Extract<ConsumeObservationClaimResult, { ok: false }>;

export interface MintObservationClaimInput {
  childInvocationId: string;
  requestId: string;
  stageId: string;
  whiteboardId: string | null;
  revision: number;
  source: ObservationSource;
  sourceId: string;
  coverage: ObservationCoverage;
  expiresAt: number;
}

type MintReadObservationClaimInput = Omit<MintObservationClaimInput, 'source' | 'sourceId'> & {
  queryId: string;
};

export interface NativeWhiteboardObservationLedgerOptions {
  now?: () => number;
  createCapability?: () => string;
  maxClaims?: number;
  maxMintRecords?: number;
  maxMintRejectionRecords?: number;
}

export type DrawTextCapabilityBundle = Readonly<{
  bindingObservationToken: string;
  targetObservationToken: string;
}>;

export type DrawTextCapabilityMintResult =
  | { ok: true; bundle: DrawTextCapabilityBundle; replayed: boolean }
  | { ok: false; code: 'OBSERVATION_CAPABILITY_LIMIT'; replayed: boolean };

type DrawTextMintRecord = {
  receiptDigest: string;
  childInvocationId: string;
  expiresAt: number;
  result: DrawTextCapabilityMintResult;
};

export function observationCoverageMatches(
  actual: ObservationCoverage,
  required: ObservationCoverage,
): boolean {
  if (required.kind === 'binding') return actual.kind === 'binding';
  if (required.kind === 'element') {
    return actual.kind === 'element' && actual.elementId === required.elementId;
  }
  if (required.kind === 'code') {
    return (
      actual.kind === 'code' && actual.elementId === required.elementId && actual.complete === true
    );
  }
  return actual.kind === 'membership' && actual.complete === true;
}

export class NativeWhiteboardObservationLedger {
  private readonly claims = new Map<string, ObservationClaim>();
  private readonly now: () => number;
  private readonly createCapability: () => string;
  private readonly maxClaims: number;
  private readonly maxMintRecords: number;
  private readonly maxMintRejectionRecords: number;
  private readonly drawTextMintRecords = new Map<string, DrawTextMintRecord>();
  private readonly drawTextMintRejections = new Map<string, DrawTextMintRecord>();

  constructor(opts: NativeWhiteboardObservationLedgerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.createCapability = opts.createCapability ?? (() => nanoid(32));
    this.maxClaims = opts.maxClaims ?? DEFAULT_MAX_OBSERVATION_CLAIMS;
    this.maxMintRecords = opts.maxMintRecords ?? DEFAULT_MAX_MINT_RECORDS;
    this.maxMintRejectionRecords =
      opts.maxMintRejectionRecords ?? DEFAULT_MAX_MINT_REJECTION_RECORDS;
  }

  mintFromRead(input: MintReadObservationClaimInput): string {
    const { queryId, ...claim } = input;
    return this.mint({
      ...claim,
      source: 'wb_read',
      sourceId: queryId,
    });
  }

  private mint(input: MintObservationClaimInput): string {
    this.deleteExpired();
    if (this.claims.size >= this.maxClaims) throw new Error('OBSERVATION_CAPABILITY_LIMIT');
    const token = this.nextCapability();
    if (this.claims.has(token)) throw new Error('OBSERVATION_CAPABILITY_COLLISION');
    const coverage = Object.freeze({ ...input.coverage }) as ObservationCoverage;
    this.claims.set(token, Object.freeze({ ...input, coverage }));
    return token;
  }

  mintFromMutationReceipt(input: {
    authenticatedReceipt: CoordinatorAuthenticatedRevisionedWhiteboardReceipt;
    coverage: ObservationCoverage;
  }): string | null {
    if (!isCoordinatorAuthenticatedRevisionedWhiteboardReceipt(input.authenticatedReceipt)) {
      return null;
    }
    const { receipt, authenticatedTarget, deadlineAt } = input.authenticatedReceipt;
    if (deadlineAt <= this.now()) return null;
    if (receipt.outcome !== 'committed') return null;
    const committedReceipt = receipt as RevisionedWhiteboardCommittedReceipt;
    if (committedReceipt.currentBinding.stageId === null) return null;
    if (!this.receiptAllowsCoverage(committedReceipt, input.coverage)) return null;
    return this.mint({
      childInvocationId: authenticatedTarget.childInvocationId,
      requestId: authenticatedTarget.requestId,
      stageId: committedReceipt.currentBinding.stageId,
      whiteboardId: committedReceipt.currentBinding.whiteboardId,
      revision: committedReceipt.currentBinding.revision,
      source: 'mutation_receipt',
      sourceId: committedReceipt.executionId,
      coverage: input.coverage,
      expiresAt: deadlineAt,
    });
  }

  createAuthorizationDigest(input: ConsumeObservationClaimInput): string {
    return digestRevisionedValue({
      tokenDigest: digestOpaqueRevisionedToken(input.token),
      claim: {
        childInvocationId: input.childInvocationId,
        requestId: input.requestId,
        stageId: input.stageId,
        whiteboardId: input.whiteboardId,
        revision: input.revision,
        coverage: input.requiredCoverage,
      },
    });
  }

  mintDrawTextCapabilityBundle(input: {
    authenticatedReceipt: CoordinatorAuthenticatedRevisionedWhiteboardReceipt;
    expected: RevisionedDrawTextExpectedDescriptor;
  }): DrawTextCapabilityMintResult | null {
    this.deleteExpired();
    if (!isCoordinatorAuthenticatedRevisionedWhiteboardReceipt(input.authenticatedReceipt)) {
      return null;
    }
    const { receipt, authenticatedTarget, deadlineAt } = input.authenticatedReceipt;
    if (
      deadlineAt <= this.now() ||
      receipt.currentBinding.stageId === null ||
      receipt.currentBinding.whiteboardId === null ||
      !isRevisionedDrawTextCommittedReceipt(receipt, input.expected)
    ) {
      return null;
    }
    const receiptDigest = digestRevisionedValue(receipt);
    const existing = this.drawTextMintRecords.get(receipt.executionId);
    if (existing) {
      if (existing.receiptDigest !== receiptDigest) return null;
      return existing.result.ok
        ? { ...existing.result, replayed: true }
        : { ...existing.result, replayed: true };
    }
    const existingRejection = this.drawTextMintRejections.get(receipt.executionId);
    if (existingRejection) {
      if (existingRejection.receiptDigest !== receiptDigest) return null;
      return { ok: false, code: 'OBSERVATION_CAPABILITY_LIMIT', replayed: true };
    }
    if (this.drawTextMintRecords.size >= this.maxMintRecords) {
      const result = {
        ok: false as const,
        code: 'OBSERVATION_CAPABILITY_LIMIT' as const,
        replayed: false,
      };
      this.rememberMintRejection({
        executionId: receipt.executionId,
        receiptDigest,
        childInvocationId: authenticatedTarget.childInvocationId,
        expiresAt: deadlineAt,
        result,
      });
      return result;
    }
    const base = {
      childInvocationId: authenticatedTarget.childInvocationId,
      requestId: authenticatedTarget.requestId,
      stageId: receipt.currentBinding.stageId,
      whiteboardId: receipt.currentBinding.whiteboardId,
      revision: receipt.currentBinding.revision,
      source: 'mutation_receipt' as const,
      sourceId: receipt.executionId,
      expiresAt: deadlineAt,
    };
    let result: DrawTextCapabilityMintResult;
    if (this.claims.size + 2 > this.maxClaims) {
      result = { ok: false, code: 'OBSERVATION_CAPABILITY_LIMIT', replayed: false };
    } else {
      const bindingObservationToken = this.nextCapability();
      const targetObservationToken = this.nextCapability();
      if (
        bindingObservationToken === targetObservationToken ||
        this.claims.has(bindingObservationToken) ||
        this.claims.has(targetObservationToken)
      ) {
        throw new Error('OBSERVATION_CAPABILITY_COLLISION');
      }
      const bindingClaim = Object.freeze({
        ...base,
        coverage: Object.freeze({ kind: 'binding' as const }),
      });
      const targetClaim = Object.freeze({
        ...base,
        coverage: Object.freeze({
          kind: 'element' as const,
          elementId: input.expected.stableElementId,
        }),
      });
      this.claims.set(bindingObservationToken, bindingClaim);
      this.claims.set(targetObservationToken, targetClaim);
      result = {
        ok: true,
        bundle: Object.freeze({ bindingObservationToken, targetObservationToken }),
        replayed: false,
      };
    }
    const recorded = Object.freeze({ ...result }) as DrawTextCapabilityMintResult;
    this.drawTextMintRecords.set(receipt.executionId, {
      receiptDigest,
      childInvocationId: authenticatedTarget.childInvocationId,
      expiresAt: deadlineAt,
      result: recorded,
    });
    return result;
  }

  consume(input: ConsumeObservationClaimInput): ConsumeObservationClaimResult {
    const result = this.consumeWith(input, () => undefined);
    return result.ok ? { ok: true } : result;
  }

  /**
   * Runs one synchronous registration step before irrevocably consuming the
   * claim. If registration throws, the capability remains available and no
   * browser delivery has been authorized.
   */
  consumeWith<T>(
    input: ConsumeObservationClaimInput,
    register: () => T,
  ): ConsumeObservationClaimWithResult<T> {
    const claim = this.claims.get(input.token);
    if (
      !claim ||
      claim.expiresAt <= this.now() ||
      claim.childInvocationId !== input.childInvocationId ||
      claim.requestId !== input.requestId ||
      claim.stageId !== input.stageId
    ) {
      if (claim?.expiresAt && claim.expiresAt <= this.now()) this.claims.delete(input.token);
      return { ok: false, code: 'OBSERVATION_CAPABILITY_INVALID' };
    }
    if (claim.whiteboardId !== input.whiteboardId || claim.revision !== input.revision) {
      return { ok: false, code: 'OBSERVATION_CAPABILITY_STALE' };
    }
    if (!observationCoverageMatches(claim.coverage, input.requiredCoverage)) {
      return { ok: false, code: 'OBSERVATION_COVERAGE_MISMATCH' };
    }
    const value = register();
    this.claims.delete(input.token);
    return { ok: true, value };
  }

  disposeChild(childInvocationId: string): void {
    for (const [token, claim] of this.claims) {
      if (claim.childInvocationId === childInvocationId) this.claims.delete(token);
    }
    for (const [executionId, record] of this.drawTextMintRecords) {
      if (record.childInvocationId === childInvocationId) {
        this.drawTextMintRecords.delete(executionId);
      }
    }
    for (const [executionId, record] of this.drawTextMintRejections) {
      if (record.childInvocationId === childInvocationId) {
        this.drawTextMintRejections.delete(executionId);
      }
    }
  }

  revoke(token: string): void {
    this.claims.delete(token);
  }

  getSizeForTests(): number {
    this.deleteExpired();
    return this.claims.size;
  }

  getClaimForTests(token: string): Readonly<ObservationClaim> | undefined {
    return this.claims.get(token);
  }

  getMintRecordCountForTests(): number {
    this.deleteExpired();
    return this.drawTextMintRecords.size + this.drawTextMintRejections.size;
  }

  private deleteExpired(): void {
    const current = this.now();
    for (const [token, claim] of this.claims) {
      if (claim.expiresAt <= current) this.claims.delete(token);
    }
    for (const [executionId, record] of this.drawTextMintRecords) {
      if (record.expiresAt <= current) this.drawTextMintRecords.delete(executionId);
    }
    for (const [executionId, record] of this.drawTextMintRejections) {
      if (record.expiresAt <= current) this.drawTextMintRejections.delete(executionId);
    }
  }

  private nextCapability(): string {
    const token = this.createCapability();
    if (
      typeof token !== 'string' ||
      token.length < 1 ||
      token.length > 256 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/u.test(token)
    ) {
      throw new Error('OBSERVATION_CAPABILITY_INVALID');
    }
    return token;
  }

  private rememberMintRejection(input: DrawTextMintRecord & { executionId: string }): void {
    if (this.maxMintRejectionRecords <= 0) return;
    this.drawTextMintRejections.set(input.executionId, {
      receiptDigest: input.receiptDigest,
      childInvocationId: input.childInvocationId,
      expiresAt: input.expiresAt,
      result: input.result,
    });
    while (this.drawTextMintRejections.size > this.maxMintRejectionRecords) {
      const oldest = this.drawTextMintRejections.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.drawTextMintRejections.delete(oldest);
    }
  }

  private receiptAllowsCoverage(
    _receipt: RevisionedWhiteboardCommittedReceipt,
    coverage: ObservationCoverage,
  ): boolean {
    // Every exact committed receipt proves its resulting binding. Element,
    // membership and code claims require the tool-specific postcondition
    // verifiers introduced with the corresponding Stage 3B handlers; Stage 3A
    // must not infer complete domain coverage from a tool name alone.
    if (coverage.kind === 'binding') return true;
    return false;
  }
}
