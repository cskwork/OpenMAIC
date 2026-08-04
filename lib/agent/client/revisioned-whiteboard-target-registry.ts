'use client';

import {
  createRevisionedDrawTextDigests,
  isRevisionedWhiteboardEffectDelivery,
  type RevisionedWhiteboardEffectDelivery,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  digestRevisionedValue,
  immutableRevisionedSnapshot,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import type {
  RevisionedWhiteboardTargetRegistryLookup,
  RevisionedWhiteboardTargetValidation,
} from '@/lib/store/whiteboard-environment-authority';

const DEFAULT_MAX_TARGET_CLAIMS = 256;
const DEFAULT_MAX_TARGET_CLAIM_BYTES = 1024 * 1024;

type TargetClaim = Readonly<{
  deliveryDigest: string;
  executionId: string;
  requestDigest: string;
  intentDigest: string;
  childInvocationId: string;
  requestId: string;
  sessionId: string;
  sceneId: string;
  stageId: string;
  deadlineAt: number;
  byteLength: number;
}>;

export interface RevisionedWhiteboardTargetRegistryOptions {
  now?: () => number;
  maxClaims?: number;
  maxBytes?: number;
}

export type RevisionedWhiteboardTargetEnvironment = Readonly<{
  requestId: string;
  sessionId: string;
  readCurrentStageId: () => string | null | undefined;
  readCurrentSceneId: () => string | null | undefined;
}>;

function claimFromDelivery(delivery: RevisionedWhiteboardEffectDelivery): TargetClaim {
  const snapshot = immutableRevisionedSnapshot(delivery) as RevisionedWhiteboardEffectDelivery;
  const digests = createRevisionedDrawTextDigests({
    executionId: snapshot.executionId,
    expectedBinding: snapshot.expectedBinding,
    authenticatedTarget: snapshot.authenticatedTarget,
    deadlineAt: snapshot.deadlineAt,
    intent: snapshot.intent,
  });
  if (!digests || digests.requestDigest !== snapshot.requestDigest) {
    throw new Error('REVISIONED_WHITEBOARD_DELIVERY_INVALID');
  }
  const byteLength = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  return Object.freeze({
    deliveryDigest: digestRevisionedValue(snapshot),
    executionId: snapshot.executionId,
    requestDigest: snapshot.requestDigest,
    intentDigest: digests.intentDigest,
    childInvocationId: snapshot.authenticatedTarget.childInvocationId,
    requestId: snapshot.authenticatedTarget.requestId,
    sessionId: snapshot.authenticatedTarget.sessionId,
    sceneId: snapshot.authenticatedTarget.sceneId,
    stageId: snapshot.expectedBinding.stageId,
    deadlineAt: snapshot.deadlineAt,
    byteLength,
  });
}

export class RevisionedWhiteboardTargetRegistry implements RevisionedWhiteboardTargetRegistryLookup {
  private readonly claims = new Map<string, TargetClaim>();
  private readonly now: () => number;
  private readonly maxClaims: number;
  private readonly maxBytes: number;
  private readCurrentStageId: (() => string | null | undefined) | null = null;
  private readCurrentSceneId: (() => string | null | undefined) | null = null;
  private totalBytes = 0;

  constructor(opts: RevisionedWhiteboardTargetRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxClaims = opts.maxClaims ?? DEFAULT_MAX_TARGET_CLAIMS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_TARGET_CLAIM_BYTES;
  }

  register(value: unknown, environment: RevisionedWhiteboardTargetEnvironment): TargetClaim {
    this.deleteExpired();
    if (!isRevisionedWhiteboardEffectDelivery(value)) {
      throw new Error('REVISIONED_WHITEBOARD_DELIVERY_INVALID');
    }
    if (
      environment.requestId !== value.authenticatedTarget.requestId ||
      environment.sessionId !== value.authenticatedTarget.sessionId
    ) {
      throw new Error('REVISIONED_WHITEBOARD_TARGET_ENVIRONMENT_MISMATCH');
    }
    this.bindEnvironment(environment);
    const claim = claimFromDelivery(value);
    const existing = this.claims.get(claim.executionId);
    if (existing) {
      if (existing.deliveryDigest !== claim.deliveryDigest) {
        throw new Error('REVISIONED_WHITEBOARD_TARGET_REGISTRATION_CONFLICT');
      }
      return existing;
    }
    if (this.claims.size >= this.maxClaims) {
      throw new Error('REVISIONED_WHITEBOARD_TARGET_REGISTRY_CAPACITY_EXCEEDED');
    }
    if (this.totalBytes + claim.byteLength > this.maxBytes) {
      throw new Error('REVISIONED_WHITEBOARD_TARGET_REGISTRY_CAPACITY_EXCEEDED');
    }
    if (claim.deadlineAt <= this.now()) {
      throw new Error('REVISIONED_WHITEBOARD_DEADLINE_EXCEEDED');
    }
    this.claims.set(claim.executionId, claim);
    this.totalBytes += claim.byteLength;
    return claim;
  }

  validateAndConsume(input: RevisionedWhiteboardTargetValidation): boolean {
    this.deleteExpired();
    const claim = this.claims.get(input.executionId);
    if (!claim) return false;
    const identityMatches =
      claim.requestDigest === input.requestDigest &&
      claim.intentDigest === input.intentDigest &&
      claim.childInvocationId === input.authenticatedTarget.childInvocationId &&
      claim.requestId === input.authenticatedTarget.requestId &&
      claim.sessionId === input.authenticatedTarget.sessionId &&
      claim.sceneId === input.authenticatedTarget.sceneId &&
      claim.stageId === input.expectedStageId &&
      claim.deadlineAt === input.deadlineAt &&
      input.deadlineAt > this.now();
    if (!identityMatches) return false;
    let environmentIsCurrent = false;
    try {
      environmentIsCurrent =
        this.readCurrentStageId?.() === claim.stageId &&
        this.readCurrentSceneId?.() === claim.sceneId;
    } catch {
      environmentIsCurrent = false;
    }
    this.deleteClaim(input.executionId);
    return environmentIsCurrent;
  }

  release(executionId: string): void {
    this.deleteClaim(executionId);
  }

  clear(): void {
    this.claims.clear();
    this.totalBytes = 0;
  }

  getSizeForTests(): number {
    this.deleteExpired();
    return this.claims.size;
  }

  private bindEnvironment(environment: RevisionedWhiteboardTargetEnvironment): void {
    if (this.readCurrentStageId || this.readCurrentSceneId) {
      if (
        this.readCurrentStageId !== environment.readCurrentStageId ||
        this.readCurrentSceneId !== environment.readCurrentSceneId
      ) {
        throw new Error('REVISIONED_WHITEBOARD_TARGET_ENVIRONMENT_CONFLICT');
      }
      return;
    }
    this.readCurrentStageId = environment.readCurrentStageId;
    this.readCurrentSceneId = environment.readCurrentSceneId;
  }

  private deleteExpired(): void {
    const current = this.now();
    for (const [executionId, claim] of this.claims) {
      if (claim.deadlineAt <= current) this.deleteClaim(executionId);
    }
  }

  private deleteClaim(executionId: string): void {
    const claim = this.claims.get(executionId);
    if (!claim) return;
    this.claims.delete(executionId);
    this.totalBytes = Math.max(0, this.totalBytes - claim.byteLength);
  }
}

export const browserRevisionedWhiteboardTargetRegistry = new RevisionedWhiteboardTargetRegistry();
