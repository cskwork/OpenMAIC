import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { StageStore } from '@/lib/api/stage-api-types';

export const WHITEBOARD_AUTHORITY_RESOURCE_BUSY = 'CLIENT_EFFECT_RESOURCE_BUSY';
export const WHITEBOARD_AUTHORITY_UNCERTAIN = 'POSTCONDITION_UNCERTAIN';
export const WHITEBOARD_AUTHORITY_BYPASS = 'WHITEBOARD_AUTHORITY_BYPASS_DETECTED';
export const WHITEBOARD_AUTHORITY_STALE_STATE = 'STALE_STATE';

export interface WhiteboardAuthoritySnapshot {
  stageId: string | null;
  activeWhiteboardId: string | null;
  revision: number;
  open: boolean;
}

interface WhiteboardDomainSnapshot extends WhiteboardAuthoritySnapshot {
  whiteboardFingerprint: string;
}

export interface WhiteboardAuthorityWriteStep {
  label: string;
  write: () => void;
}

export interface WhiteboardAuthorityTransactionOptions {
  label: string;
  writes: readonly WhiteboardAuthorityWriteStep[];
  preferredActiveWhiteboardId?: string | null;
  expected?: Pick<WhiteboardAuthoritySnapshot, 'stageId' | 'activeWhiteboardId' | 'revision'>;
}

export type WhiteboardAuthorityQueryResult<T> =
  | { ok: true; value: T; snapshot: WhiteboardAuthoritySnapshot }
  | {
      ok: false;
      code: typeof WHITEBOARD_AUTHORITY_RESOURCE_BUSY | typeof WHITEBOARD_AUTHORITY_BYPASS;
      snapshot: WhiteboardAuthoritySnapshot;
      errors: readonly string[];
    };

export type WhiteboardAuthorityTransactionResult =
  | {
      ok: true;
      changed: boolean;
      snapshot: WhiteboardAuthoritySnapshot;
    }
  | {
      ok: false;
      code:
        | typeof WHITEBOARD_AUTHORITY_RESOURCE_BUSY
        | typeof WHITEBOARD_AUTHORITY_UNCERTAIN
        | typeof WHITEBOARD_AUTHORITY_BYPASS
        | typeof WHITEBOARD_AUTHORITY_STALE_STATE;
      changed: boolean;
      mutationMayHaveCommitted: boolean;
      snapshot: WhiteboardAuthoritySnapshot;
      errors: readonly string[];
    };

interface WhiteboardAuthorityStore {
  getState(): Pick<ReturnType<StageStore['getState']>, 'stage'>;
}

function canonicalizeJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('Whiteboard state must not contain cycles');
    ancestors.add(value);
    const normalized = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value) || value[index] === undefined) return null;
      return canonicalizeJsonValue(value[index], ancestors);
    });
    ancestors.delete(value);
    return normalized;
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('Whiteboard state must not contain cycles');
    ancestors.add(value);
    const normalized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalizeJsonValue(entry, ancestors)]),
    );
    ancestors.delete(value);
    return normalized;
  }
  throw new Error(`Whiteboard state contains a non-JSON value: ${typeof value}`);
}

function fingerprintWhiteboards(whiteboards: readonly Whiteboard[] | null | undefined): string {
  const serialized = JSON.stringify(canonicalizeJsonValue(whiteboards ?? [], new Set()));
  return `sha256:${bytesToHex(sha256(utf8ToBytes(serialized)))}`;
}

function selectActiveId(
  stage: Stage | null,
  previous: WhiteboardAuthoritySnapshot | null,
  preferredActiveWhiteboardId?: string | null,
): string | null {
  const whiteboards = stage?.whiteboard ?? [];
  const previousActiveId = previous?.activeWhiteboardId ?? null;
  if (whiteboards.length === 0) return null;

  if (
    preferredActiveWhiteboardId !== undefined &&
    preferredActiveWhiteboardId !== null &&
    whiteboards.some(({ id }) => id === preferredActiveWhiteboardId)
  ) {
    return preferredActiveWhiteboardId;
  }

  if (
    previous?.stageId === stage?.id &&
    previousActiveId &&
    whiteboards.some(({ id }) => id === previousActiveId)
  ) {
    return previousActiveId;
  }

  return whiteboards[0]?.id ?? null;
}

function publicSnapshot(domain: WhiteboardDomainSnapshot): WhiteboardAuthoritySnapshot {
  return Object.freeze({
    stageId: domain.stageId,
    activeWhiteboardId: domain.activeWhiteboardId,
    revision: domain.revision,
    open: domain.open,
  });
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Browser-owned whiteboard transaction boundary.
 *
 * This class deliberately stores only binding/revision state. Whiteboard
 * elements and code remain owned by the Stage store. Only a bounded,
 * irreversible fingerprint is retained to detect unapproved writes.
 */
export class WhiteboardEnvironmentAuthority {
  private readonly store: WhiteboardAuthorityStore;
  private readOpen: () => boolean;
  private domain: WhiteboardDomainSnapshot;
  private transactionActive = false;
  private readonly listeners = new Set<() => void>();

  constructor(store: WhiteboardAuthorityStore, readOpen: () => boolean = () => false) {
    this.store = store;
    this.readOpen = readOpen;
    const stage = store.getState().stage;
    this.domain = {
      stageId: stage?.id ?? null,
      activeWhiteboardId: stage?.whiteboard?.[0]?.id ?? null,
      revision: 0,
      open: readOpen(),
      whiteboardFingerprint: fingerprintWhiteboards(stage?.whiteboard),
    };
  }

  configureOpenReader(readOpen: () => boolean): void {
    this.readOpen = readOpen;
    if (this.transactionActive) return;
    const open = readOpen();
    if (open === this.domain.open) return;
    // Configuration happens once while wiring the default stores. It is an
    // initial hydration, not a user-visible mutation.
    this.domain = { ...this.domain, open };
  }

  querySnapshot(): WhiteboardAuthorityQueryResult<WhiteboardAuthoritySnapshot> {
    const snapshot = publicSnapshot(this.domain);
    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        snapshot,
        errors: ['whiteboard query attempted while a transaction is active'],
      };
    }
    const actual = this.captureActualDomain(this.domain.revision, this.domain);
    if (!this.domainMatchesCommitted(actual)) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_BYPASS,
        snapshot,
        errors: ['whiteboard state changed outside the Authority'],
      };
    }
    return { ok: true, value: snapshot, snapshot };
  }

  queryActiveWhiteboard(): WhiteboardAuthorityQueryResult<Whiteboard | null> {
    const snapshot = publicSnapshot(this.domain);
    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        snapshot,
        errors: ['active whiteboard query attempted while a transaction is active'],
      };
    }
    const actual = this.captureActualDomain(this.domain.revision, this.domain);
    if (!this.domainMatchesCommitted(actual)) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_BYPASS,
        snapshot,
        errors: ['whiteboard state changed outside the Authority'],
      };
    }
    const stage = this.store.getState().stage;
    const value =
      stage && stage.id === this.domain.stageId && this.domain.activeWhiteboardId
        ? (stage.whiteboard?.find(({ id }) => id === this.domain.activeWhiteboardId) ?? null)
        : null;
    return { ok: true, value, snapshot };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isTransactionActive(): boolean {
    return this.transactionActive;
  }

  /**
   * Preserve the current active board on a same-stage whole-document
   * replacement by moving it to the canonical first position. A new Stage
   * hydrates its UI-visible first board as active.
   */
  canonicalizeStageReplacement(stage: Stage): Stage {
    const whiteboards = stage.whiteboard ?? [];
    if (
      stage.id !== this.domain.stageId ||
      !this.domain.activeWhiteboardId ||
      whiteboards[0]?.id === this.domain.activeWhiteboardId
    ) {
      return stage;
    }
    const activeIndex = whiteboards.findIndex(({ id }) => id === this.domain.activeWhiteboardId);
    if (activeIndex <= 0) return stage;
    return {
      ...stage,
      whiteboard: [
        whiteboards[activeIndex],
        ...whiteboards.slice(0, activeIndex),
        ...whiteboards.slice(activeIndex + 1),
      ],
    };
  }

  transact(opts: WhiteboardAuthorityTransactionOptions): WhiteboardAuthorityTransactionResult {
    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        changed: false,
        mutationMayHaveCommitted: false,
        snapshot: publicSnapshot(this.domain),
        errors: [`${opts.label}: whiteboard transaction already active`],
      };
    }

    const actualBefore = this.captureActualDomain(this.domain.revision, this.domain);
    if (!this.domainMatchesCommitted(actualBefore)) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_BYPASS,
        changed: false,
        mutationMayHaveCommitted: false,
        snapshot: publicSnapshot(this.domain),
        errors: [`${opts.label}: whiteboard state changed outside the Authority`],
      };
    }

    if (
      opts.expected &&
      (opts.expected.stageId !== this.domain.stageId ||
        opts.expected.activeWhiteboardId !== this.domain.activeWhiteboardId ||
        opts.expected.revision !== this.domain.revision)
    ) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_STALE_STATE,
        changed: false,
        mutationMayHaveCommitted: false,
        snapshot: publicSnapshot(this.domain),
        errors: [`${opts.label}: expected whiteboard revision is stale`],
      };
    }

    this.transactionActive = true;
    const errors: string[] = [];
    let changed = false;
    let nextDomain = this.domain;
    try {
      for (const step of opts.writes) {
        try {
          step.write();
        } catch (error) {
          errors.push(`${step.label}: ${stringifyError(error)}`);
        }
      }

      const stage = this.store.getState().stage;
      const open = this.readOpen();
      const activeWhiteboardId = selectActiveId(
        stage,
        this.domain,
        opts.preferredActiveWhiteboardId,
      );
      const whiteboardFingerprint = fingerprintWhiteboards(stage?.whiteboard);
      changed =
        stage?.id !== this.domain.stageId ||
        activeWhiteboardId !== this.domain.activeWhiteboardId ||
        open !== this.domain.open ||
        whiteboardFingerprint !== this.domain.whiteboardFingerprint;

      nextDomain = {
        stageId: stage?.id ?? null,
        activeWhiteboardId,
        revision: changed ? this.domain.revision + 1 : this.domain.revision,
        open,
        whiteboardFingerprint,
      };
      this.domain = nextDomain;

      for (const listener of this.listeners) {
        try {
          listener();
        } catch (error) {
          errors.push(`authority-listener: ${stringifyError(error)}`);
        }
      }
    } finally {
      this.transactionActive = false;
    }

    if (errors.length > 0) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_UNCERTAIN,
        changed,
        mutationMayHaveCommitted: true,
        snapshot: publicSnapshot(nextDomain),
        errors,
      };
    }

    return { ok: true, changed, snapshot: publicSnapshot(nextDomain) };
  }

  private captureActualDomain(
    revision: number,
    previous: WhiteboardAuthoritySnapshot,
  ): WhiteboardDomainSnapshot {
    const stage = this.store.getState().stage;
    return {
      stageId: stage?.id ?? null,
      activeWhiteboardId: selectActiveId(stage, previous),
      revision,
      open: this.readOpen(),
      whiteboardFingerprint: fingerprintWhiteboards(stage?.whiteboard),
    };
  }

  private domainMatchesCommitted(actual: WhiteboardDomainSnapshot): boolean {
    return (
      actual.stageId === this.domain.stageId &&
      actual.activeWhiteboardId === this.domain.activeWhiteboardId &&
      actual.open === this.domain.open &&
      actual.whiteboardFingerprint === this.domain.whiteboardFingerprint
    );
  }
}

const authorities = new WeakMap<object, WhiteboardEnvironmentAuthority>();
let defaultAuthority: WhiteboardEnvironmentAuthority | null = null;

export function getWhiteboardEnvironmentAuthority(
  store: WhiteboardAuthorityStore,
): WhiteboardEnvironmentAuthority {
  const key = store as object;
  const existing = authorities.get(key);
  if (existing) return existing;
  const authority = new WhiteboardEnvironmentAuthority(store);
  authorities.set(key, authority);
  return authority;
}

export function registerDefaultWhiteboardEnvironmentAuthority(
  store: WhiteboardAuthorityStore,
  readOpen: () => boolean,
): WhiteboardEnvironmentAuthority {
  const authority = getWhiteboardEnvironmentAuthority(store);
  authority.configureOpenReader(readOpen);
  defaultAuthority = authority;
  return authority;
}

export function getDefaultWhiteboardEnvironmentAuthority(): WhiteboardEnvironmentAuthority | null {
  return defaultAuthority;
}

export function getActiveWhiteboardForStore(store: WhiteboardAuthorityStore): Whiteboard | null {
  const result = getWhiteboardEnvironmentAuthority(store).queryActiveWhiteboard();
  return result.ok ? result.value : null;
}

export function canonicalActiveWhiteboard(
  stage: Pick<Stage, 'whiteboard'> | null | undefined,
): Whiteboard | null {
  return stage?.whiteboard?.[0] ?? null;
}
