import { migrateRuntime, validateRuntimeSession } from '@openmaic/dsl';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
} from '@openmaic/dsl';
import type { RuntimeSessionInit, RuntimeStore } from './types.js';

export interface HttpRuntimeHeadersContext {
  method: string;
  path: string;
}

export type HttpRuntimeHeadersHook = (
  context: HttpRuntimeHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpRuntimeStoreOptions {
  /** Root URL before the contract's `/runtime/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpRuntimeHeadersHook;
}

interface ErrorResponseBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

/** A server-side RuntimeStore failure, retaining its machine-readable HTTP identity. */
export class HttpRuntimeStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpRuntimeStoreError';
    this.status = status;
    this.code = code;
  }
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function assertValidSession(session: RuntimeSession): RuntimeSession {
  const result = validateRuntimeSession(session);
  if (result.valid) return session;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw new Error(
    `@openmaic/storage: invalid stored runtime session ${JSON.stringify(session.id)}: ${detail}`,
  );
}

/**
 * RuntimeStore client for the JSON HTTP contract. Session reads migrate again
 * on the client so a server running an older schema cannot leak stale envelopes
 * into a newer application.
 */
export class HttpRuntimeStore implements RuntimeStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersHook: HttpRuntimeHeadersHook | undefined;

  constructor(options: HttpRuntimeStoreOptions) {
    if (options.baseUrl === '') {
      throw new Error('@openmaic/storage: HttpRuntimeStore baseUrl must be non-empty');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('@openmaic/storage: HttpRuntimeStore requires a fetch implementation');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.headersHook = options.headers;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = new Headers(await this.headersHook?.({ method, path }));
    let serializedBody: string | undefined;
    if (body !== undefined) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      serializedBody = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
    if (!response.ok) {
      let errorBody: ErrorResponseBody | undefined;
      try {
        errorBody = (await response.json()) as ErrorResponseBody;
      } catch {
        // A non-conforming server still becomes a useful typed HTTP error.
      }
      const code = typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'HTTP_ERROR';
      const message =
        typeof errorBody?.error?.message === 'string'
          ? errorBody.error.message
          : `@openmaic/storage: RuntimeStore HTTP request failed with status ${response.status}`;
      throw new HttpRuntimeStoreError(response.status, code, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private migrateSession(session: RuntimeSession): RuntimeSession {
    return assertValidSession(migrateRuntime(session) as RuntimeSession);
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    const session = await this.request<RuntimeSession>('POST', '/runtime/sessions', init);
    return this.migrateSession(session);
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    try {
      const session = await this.request<RuntimeSession>(
        'GET',
        `/runtime/sessions/${segment(sessionId)}`,
      );
      return this.migrateSession(session);
    } catch (error) {
      if (error instanceof HttpRuntimeStoreError && error.code === 'SESSION_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    const sessions = await this.request<RuntimeSession[]>(
      'GET',
      `/runtime/stages/${segment(stageId)}/learners/${segment(learnerKey)}/sessions`,
    );
    const migrated: RuntimeSession[] = [];
    for (const session of sessions) {
      try {
        migrated.push(this.migrateSession(session));
      } catch {
        // Match BrowserRuntimeStore: corrupt partition rows are omitted.
      }
    }
    return migrated.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
  ): Promise<void> {
    await this.request<void>('PATCH', `/runtime/sessions/${segment(sessionId)}/status`, {
      status,
      updatedAt,
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>('DELETE', `/runtime/sessions/${segment(sessionId)}`);
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    return this.request<RuntimeRecord<TPayload>>(
      'POST',
      `/runtime/sessions/${segment(init.sessionId)}/records`,
      init,
    );
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    const query = opts?.sceneId === undefined ? '' : `?sceneId=${encodeURIComponent(opts.sceneId)}`;
    return this.request<RuntimeRecord[]>(
      'GET',
      `/runtime/sessions/${segment(sessionId)}/records${query}`,
    );
  }

  async mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number> {
    const result = await this.request<{ moved: number }>('POST', '/runtime/learners/merge', {
      fromLearnerKey,
      toLearnerKey,
    });
    return result.moved;
  }

  async deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/runtime/stages/${segment(stageId)}/learners/${segment(learnerKey)}`,
    );
  }

  async deleteStageRuntime(stageId: string): Promise<void> {
    await this.request<void>('DELETE', `/runtime/stages/${segment(stageId)}`);
  }
}
