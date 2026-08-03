import { createHash, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  CLIENT_QUERY_RESPONSE_MAX_BYTES,
  isClientQueryBrowserOutcome,
  type ClientQueryBrowserOutcome,
  type ClientQueryDelivery,
  type ClientQueryRequest,
  type ClientQueryTerminalResult,
  type ClientQueryTraceEvent,
} from './client-query-contract';

const DEFAULT_MAX_LIVE_PER_CHILD = 16;
const DEFAULT_MAX_TOMBSTONES_PER_CHILD = 16;
const DEFAULT_MAX_CACHE_BYTES_PER_CHILD = 640 * 1024;
const DEFAULT_MAX_GLOBAL_LIVE = 512;
const DEFAULT_MAX_GLOBAL_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_GLOBAL_TOMBSTONES = 256;
const DEFAULT_MAX_TOMBSTONE_BYTES = 256 * 1024;
const DEFAULT_REPLAY_GRACE_MS = 30_000;
const RESERVED_FINAL_TOOL_RESULT_BYTES = 32 * 1024;

type QueryStatus = 'pending' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

interface QueryEntry {
  request: ClientQueryRequest;
  registrationIdentity: string;
  token: string;
  tokenDigest: string;
  status: QueryStatus;
  reservedCacheBytes: number;
  browserBody?: string;
  browserBodyDigest?: string;
  browserBodyBytes?: number;
  duplicateReplayCount: number;
  finalToolResultBytes?: number;
  terminal?: ClientQueryTerminalResult;
  result: Promise<ClientQueryTerminalResult>;
  resolve: (result: ClientQueryTerminalResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueryTombstone {
  queryId: string;
  childInvocationId: string;
  targetIdentity: string;
  bodyDigest?: string;
  byteLength: number;
  duplicateReplayCount: number;
  tokenDigest: string;
  disposition: QueryStatus;
  expiresAt: number;
}

export interface ClientQueryCoordinatorOptions {
  now?: () => number;
  createToken?: () => string;
  maxLivePerChild?: number;
  maxTombstonesPerChild?: number;
  maxCacheBytesPerChild?: number;
  maxGlobalLive?: number;
  maxGlobalCacheBytes?: number;
  maxGlobalTombstones?: number;
  maxTombstoneBytes?: number;
  replayGraceMs?: number;
  onTrace?: (event: ClientQueryTraceEvent) => void;
}

export type ClientQueryResponseOutcome =
  | { kind: 'applied' | 'duplicate' | 'late'; status: QueryStatus }
  | { kind: 'unauthorized' | 'unknown' }
  | { kind: 'invalid'; reason: string; status?: QueryStatus };

export interface RegisteredClientQuery {
  delivery: ClientQueryDelivery;
  result: Promise<ClientQueryTerminalResult>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualDigest = Buffer.from(digest(actual), 'hex');
  const expectedDigest = Buffer.from(digest(expected), 'hex');
  return timingSafeEqual(actualDigest, expectedDigest);
}

function tokenDigestMatches(actual: string, expectedDigest: string): boolean {
  const actualBytes = Buffer.from(digest(actual), 'hex');
  const expectedBytes = Buffer.from(expectedDigest, 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function targetIdentity(request: ClientQueryRequest): string {
  return [
    request.target.requestId,
    request.target.sessionId,
    request.target.stageId,
    request.target.sceneId,
  ].join(':');
}

function targetIdentityFromOutcome(outcome: ClientQueryBrowserOutcome): string {
  return [outcome.requestId, outcome.sessionId, outcome.stageId, outcome.sceneId].join(':');
}

function registrationIdentity(request: ClientQueryRequest): string {
  return JSON.stringify({
    queryId: request.queryId,
    executionId: request.executionId,
    childInvocationId: request.agentInvocationId,
    target: request.target,
    query: request.query,
  });
}

function tombstoneBytes(value: QueryTombstone): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class ClientQueryCoordinator {
  private readonly entries = new Map<string, QueryEntry>();
  private readonly tombstones = new Map<string, QueryTombstone>();
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly maxLivePerChild: number;
  private readonly maxTombstonesPerChild: number;
  private readonly maxCacheBytesPerChild: number;
  private readonly maxGlobalLive: number;
  private readonly maxGlobalCacheBytes: number;
  private readonly maxGlobalTombstones: number;
  private readonly maxTombstoneBytes: number;
  private readonly replayGraceMs: number;
  private readonly onTrace?: (event: ClientQueryTraceEvent) => void;
  private cleanupTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: ClientQueryCoordinatorOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.createToken = opts.createToken ?? (() => nanoid(32));
    this.maxLivePerChild = opts.maxLivePerChild ?? DEFAULT_MAX_LIVE_PER_CHILD;
    this.maxTombstonesPerChild = opts.maxTombstonesPerChild ?? DEFAULT_MAX_TOMBSTONES_PER_CHILD;
    this.maxCacheBytesPerChild = opts.maxCacheBytesPerChild ?? DEFAULT_MAX_CACHE_BYTES_PER_CHILD;
    this.maxGlobalLive = opts.maxGlobalLive ?? DEFAULT_MAX_GLOBAL_LIVE;
    this.maxGlobalCacheBytes = opts.maxGlobalCacheBytes ?? DEFAULT_MAX_GLOBAL_CACHE_BYTES;
    this.maxGlobalTombstones = opts.maxGlobalTombstones ?? DEFAULT_MAX_GLOBAL_TOMBSTONES;
    this.maxTombstoneBytes = opts.maxTombstoneBytes ?? DEFAULT_MAX_TOMBSTONE_BYTES;
    this.replayGraceMs = opts.replayGraceMs ?? DEFAULT_REPLAY_GRACE_MS;
    this.onTrace = opts.onTrace;
  }

  register(request: ClientQueryRequest): RegisteredClientQuery {
    this.cleanup();
    const identity = registrationIdentity(request);
    const existing = this.entries.get(request.queryId);
    if (existing) {
      if (existing.registrationIdentity !== identity) {
        throw new Error('CLIENT_QUERY_RESPONSE_CONFLICT');
      }
      return {
        delivery: { request, responseToken: existing.token },
        result: existing.result,
      };
    }
    if (this.tombstones.has(request.queryId)) throw new Error('CLIENT_QUERY_RESPONSE_CONFLICT');

    const childEntries = [...this.entries.values()].filter(
      (entry) => entry.request.agentInvocationId === request.agentInvocationId,
    );
    const reservedCacheBytes = CLIENT_QUERY_RESPONSE_MAX_BYTES + RESERVED_FINAL_TOOL_RESULT_BYTES;
    const childBytes = childEntries.reduce((sum, entry) => sum + entry.reservedCacheBytes, 0);
    const globalBytes = [...this.entries.values()].reduce(
      (sum, entry) => sum + entry.reservedCacheBytes,
      0,
    );
    if (
      childEntries.length >= this.maxLivePerChild ||
      childBytes + reservedCacheBytes > this.maxCacheBytesPerChild ||
      this.entries.size >= this.maxGlobalLive ||
      globalBytes + reservedCacheBytes > this.maxGlobalCacheBytes
    ) {
      throw new Error('CLIENT_QUERY_COORDINATOR_CAPACITY_EXCEEDED');
    }

    const token = this.createToken();
    let resolve!: (result: ClientQueryTerminalResult) => void;
    const result = new Promise<ClientQueryTerminalResult>((settle) => {
      resolve = settle;
    });
    const remaining = Math.max(0, request.deadlineAt - this.now());
    const timeoutMs = Math.min(request.activeQueryBudgetMs, remaining);
    if (timeoutMs <= 0) throw new Error('CLIENT_QUERY_TIMEOUT');
    const entry: QueryEntry = {
      request,
      registrationIdentity: identity,
      token,
      tokenDigest: digest(token),
      status: 'pending',
      reservedCacheBytes,
      duplicateReplayCount: 0,
      result,
      resolve,
      timer: setTimeout(() => {
        this.settle(entry, {
          status: 'timed_out',
          code: 'CLIENT_QUERY_TIMEOUT',
        });
      }, timeoutMs),
    };
    this.entries.set(request.queryId, entry);
    this.trace(entry, 'query_registered');
    return { delivery: { request, responseToken: token }, result };
  }

  authorize(queryId: string, token: string): 'authorized' | 'unauthorized' | 'unknown' {
    this.cleanup();
    const entry = this.entries.get(queryId);
    if (entry) return tokenMatches(token, entry.token) ? 'authorized' : 'unauthorized';
    const tombstone = this.tombstones.get(queryId);
    if (!tombstone) return 'unknown';
    return tokenDigestMatches(token, tombstone.tokenDigest) ? 'authorized' : 'unauthorized';
  }

  respond(
    queryId: string,
    token: string,
    rawBody: string,
    outcome: ClientQueryBrowserOutcome,
  ): ClientQueryResponseOutcome {
    this.cleanup();
    const bodyBytes = new TextEncoder().encode(rawBody).byteLength;
    if (bodyBytes > CLIENT_QUERY_RESPONSE_MAX_BYTES || !isClientQueryBrowserOutcome(outcome)) {
      return { kind: 'invalid', reason: 'CLIENT_QUERY_RESPONSE_INVALID' };
    }
    const bodyDigest = digest(rawBody);
    const entry = this.entries.get(queryId);
    if (!entry) {
      const tombstone = this.tombstones.get(queryId);
      if (!tombstone) return { kind: 'unknown' };
      if (!tokenDigestMatches(token, tombstone.tokenDigest)) return { kind: 'unauthorized' };
      if (
        outcome.queryId !== queryId ||
        targetIdentityFromOutcome(outcome) !== tombstone.targetIdentity
      ) {
        return {
          kind: 'invalid',
          reason: 'CLIENT_QUERY_RESPONSE_INVALID',
          status: tombstone.disposition,
        };
      }
      if (!tombstone.bodyDigest) {
        tombstone.bodyDigest = bodyDigest;
        tombstone.byteLength += bodyBytes;
        tombstone.duplicateReplayCount = 0;
        this.enforceTombstoneBounds();
        this.scheduleCleanupTimer();
        return { kind: 'late', status: tombstone.disposition };
      }
      if (bodyDigest !== tombstone.bodyDigest || tombstone.duplicateReplayCount >= 1) {
        return {
          kind: 'invalid',
          reason: 'CLIENT_QUERY_RESPONSE_CONFLICT',
          status: tombstone.disposition,
        };
      }
      tombstone.duplicateReplayCount += 1;
      return { kind: 'late', status: tombstone.disposition };
    }
    if (!tokenMatches(token, entry.token)) return { kind: 'unauthorized' };
    if (entry.browserBodyDigest) {
      if (
        entry.browserBodyDigest !== bodyDigest ||
        (entry.browserBody !== undefined && entry.browserBody !== rawBody) ||
        entry.duplicateReplayCount >= 1
      ) {
        return {
          kind: 'invalid',
          reason: 'CLIENT_QUERY_RESPONSE_CONFLICT',
          status: entry.status,
        };
      }
      entry.duplicateReplayCount += 1;
      return {
        kind: entry.terminal && entry.browserBody === undefined ? 'late' : 'duplicate',
        status: entry.status,
      };
    }
    if (outcome.queryId !== queryId || !this.matchesRequestIdentity(entry.request, outcome)) {
      return { kind: 'invalid', reason: 'CLIENT_QUERY_RESPONSE_INVALID', status: entry.status };
    }
    if (entry.terminal) {
      entry.browserBodyDigest = bodyDigest;
      entry.browserBodyBytes = bodyBytes;
      return { kind: 'late', status: entry.status };
    }
    entry.browserBody = rawBody;
    entry.browserBodyDigest = bodyDigest;
    entry.browserBodyBytes = bodyBytes;
    if (outcome.outcome === 'failed') {
      this.settle(entry, {
        status: 'query_failed',
        outcome,
        code: outcome.error.code,
      });
    } else {
      this.settle(entry, { status: 'query_completed', outcome });
    }
    return { kind: 'applied', status: entry.status };
  }

  failDelivery(queryId: string, token: string): ClientQueryResponseOutcome {
    this.cleanup();
    const entry = this.entries.get(queryId);
    if (!entry) {
      const tombstone = this.tombstones.get(queryId);
      if (!tombstone) return { kind: 'unknown' };
      return tokenDigestMatches(token, tombstone.tokenDigest)
        ? { kind: 'late', status: tombstone.disposition }
        : { kind: 'unauthorized' };
    }
    if (!tokenMatches(token, entry.token)) return { kind: 'unauthorized' };
    if (entry.terminal) return { kind: 'late', status: entry.status };
    this.settle(entry, {
      status: 'query_failed',
      code: 'CLIENT_QUERY_DELIVERY_FAILED',
    });
    return { kind: 'applied', status: entry.status };
  }

  recordToolResultBytes(queryId: string, bytes: number): void {
    const entry = this.entries.get(queryId);
    if (
      !entry ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > RESERVED_FINAL_TOOL_RESULT_BYTES
    ) {
      throw new Error('CLIENT_QUERY_RESPONSE_TOO_LARGE');
    }
    entry.finalToolResultBytes = bytes;
  }

  cancel(queryId: string, code = 'CLIENT_QUERY_CANCELLED'): void {
    const entry = this.entries.get(queryId);
    if (!entry) return;
    this.settle(entry, { status: 'cancelled', code });
  }

  release(queryId: string): void {
    const entry = this.entries.get(queryId);
    if (!entry || !entry.terminal) return;
    this.toTombstone(entry);
  }

  releaseChild(childInvocationId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.request.agentInvocationId !== childInvocationId) continue;
      if (!entry.terminal)
        this.settle(entry, { status: 'cancelled', code: 'CLIENT_QUERY_CANCELLED' });
      this.toTombstone(entry);
    }
  }

  clearForTests(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    this.tombstones.clear();
  }

  getCountsForTests(): { live: number; tombstones: number } {
    this.cleanup();
    return { live: this.entries.size, tombstones: this.tombstones.size };
  }

  peekCountsForTests(): { live: number; tombstones: number } {
    return { live: this.entries.size, tombstones: this.tombstones.size };
  }

  private matchesRequestIdentity(
    request: ClientQueryRequest,
    outcome: ClientQueryBrowserOutcome,
  ): boolean {
    return (
      outcome.requestId === request.target.requestId &&
      outcome.sessionId === request.target.sessionId &&
      outcome.stageId === request.target.stageId &&
      outcome.sceneId === request.target.sceneId
    );
  }

  private settle(entry: QueryEntry, terminal: ClientQueryTerminalResult): void {
    if (entry.terminal) return;
    clearTimeout(entry.timer);
    entry.terminal = terminal;
    entry.status =
      terminal.status === 'query_completed'
        ? 'completed'
        : terminal.status === 'query_failed'
          ? 'failed'
          : terminal.status === 'timed_out'
            ? 'timed_out'
            : 'cancelled';
    entry.resolve(terminal);
    this.trace(
      entry,
      entry.status === 'completed'
        ? 'query_completed'
        : entry.status === 'cancelled'
          ? 'query_cancelled'
          : 'query_failed',
      'code' in terminal ? terminal.code : undefined,
    );
  }

  private toTombstone(entry: QueryEntry): void {
    this.entries.delete(entry.request.queryId);
    const tombstone: QueryTombstone = {
      queryId: entry.request.queryId,
      childInvocationId: entry.request.agentInvocationId,
      targetIdentity: targetIdentity(entry.request),
      bodyDigest: entry.browserBodyDigest,
      byteLength: (entry.browserBodyBytes ?? 0) + (entry.finalToolResultBytes ?? 0),
      duplicateReplayCount: entry.duplicateReplayCount,
      tokenDigest: entry.tokenDigest,
      disposition: entry.status,
      expiresAt: Math.min(
        entry.request.deadlineAt + this.replayGraceMs,
        this.now() + this.replayGraceMs,
      ),
    };
    entry.browserBody = undefined;
    this.tombstones.set(tombstone.queryId, tombstone);
    this.enforceTombstoneBounds();
    this.scheduleCleanupTimer();
  }

  private cleanup(): void {
    const now = this.now();
    for (const [queryId, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(queryId);
    }
    for (const entry of [...this.entries.values()]) {
      if (entry.request.deadlineAt <= now && entry.terminal) this.toTombstone(entry);
    }
    this.enforceTombstoneBounds();
    this.scheduleCleanupTimer();
  }

  private scheduleCleanupTimer(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const tombstone of this.tombstones.values()) {
      earliestExpiry = Math.min(earliestExpiry, tombstone.expiresAt);
    }
    if (!Number.isFinite(earliestExpiry)) return;
    this.cleanupTimer = setTimeout(
      () => {
        this.cleanupTimer = undefined;
        this.cleanup();
      },
      Math.max(1, earliestExpiry - this.now()),
    );
    this.cleanupTimer.unref?.();
  }

  private enforceTombstoneBounds(): void {
    const perChild = new Map<string, QueryTombstone[]>();
    for (const value of this.tombstones.values()) {
      const entries = perChild.get(value.childInvocationId) ?? [];
      entries.push(value);
      perChild.set(value.childInvocationId, entries);
    }
    for (const entries of perChild.values()) {
      entries.sort((left, right) => left.expiresAt - right.expiresAt);
      while (entries.length > this.maxTombstonesPerChild) {
        const removed = entries.shift();
        if (removed) this.tombstones.delete(removed.queryId);
      }
    }
    const oldestFirst = () =>
      [...this.tombstones.values()].sort((left, right) => left.expiresAt - right.expiresAt);
    while (
      this.tombstones.size > this.maxGlobalTombstones ||
      [...this.tombstones.values()].reduce((sum, value) => sum + tombstoneBytes(value), 0) >
        this.maxTombstoneBytes
    ) {
      const oldest = oldestFirst()[0];
      if (!oldest) break;
      this.tombstones.delete(oldest.queryId);
    }
  }

  private trace(entry: QueryEntry, type: ClientQueryTraceEvent['type'], code?: string): void {
    this.onTrace?.({
      type,
      queryId: entry.request.queryId,
      childInvocationId: entry.request.agentInvocationId,
      code,
    });
  }
}

const processGlobal = globalThis as typeof globalThis & {
  __openmaicPiClientQueryCoordinator?: ClientQueryCoordinator;
};

export const piClientQueryCoordinator =
  processGlobal.__openmaicPiClientQueryCoordinator ??
  (processGlobal.__openmaicPiClientQueryCoordinator = new ClientQueryCoordinator());
