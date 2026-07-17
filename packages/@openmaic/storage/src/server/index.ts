import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  isChatMessageSkeleton,
  isQuizAttemptSkeleton,
  needsRuntimeMigration,
  RUNTIME_DSL_VERSION,
  runtimeDslVersionOf,
  validateRuntimeRecord,
  validateRuntimeSession,
} from '@openmaic/dsl';
import type {
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
  ValidationResult,
} from '@openmaic/dsl';
import { assertJsonValue } from '../runtime/json-value.js';
import type { RuntimeSessionInit, RuntimeStore } from '../runtime/types.js';

export interface RuntimeHttpPrincipal {
  learnerKey: string;
}

export type RuntimeHttpAuthenticate = (
  req: IncomingMessage,
) => Promise<RuntimeHttpPrincipal | undefined>;

export type RuntimeHttpAuthorizeMerge = (
  principal: RuntimeHttpPrincipal,
  fromKey: string,
  toKey: string,
) => boolean | Promise<boolean>;

export type RuntimeHttpAuthorizeAdmin = (
  principal: RuntimeHttpPrincipal,
) => boolean | Promise<boolean>;

export interface RuntimeHttpHandlerOptions {
  authenticate: RuntimeHttpAuthenticate;
  authorizeMerge?: RuntimeHttpAuthorizeMerge;
  authorizeAdmin?: RuntimeHttpAuthorizeAdmin;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

class RuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    throw validationFailure('request body must be a JSON object');
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
  if (!isObject(body)) throw validationFailure('request body must be a JSON object');
  return body as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationFailure(message: string, details?: unknown): RuntimeHttpError {
  return new RuntimeHttpError(400, 'VALIDATION_FAILED', message, details);
}

function validationError(result: ValidationResult, label: string): void {
  if (result.valid) return;
  const details = result.errors;
  const detail = details.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw validationFailure(`${label}: ${detail}`, details);
}

function assertAddressableSegment(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw validationFailure('@openmaic/storage: URL path segment must be a non-empty string');
  }
  if (value === '.' || value === '..') {
    throw validationFailure(
      `@openmaic/storage: URL path segment must not be ${JSON.stringify(value)}`,
    );
  }
}

function assertJsonRequestValue(value: unknown, label: string): void {
  try {
    assertJsonValue(value, label);
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
}

function missingSessionError(sessionId: string): RuntimeHttpError {
  return new RuntimeHttpError(
    404,
    'SESSION_NOT_FOUND',
    `@openmaic/storage: no session ${JSON.stringify(sessionId)}`,
  );
}

function assertNotFutureSession(session: RuntimeSession): void {
  const version = runtimeDslVersionOf(session);
  if (!needsRuntimeMigration(session) && version !== RUNTIME_DSL_VERSION) {
    throw new RuntimeHttpError(
      409,
      'FUTURE_VERSION',
      `@openmaic/storage: session ${JSON.stringify(session.id)} was written at runtime DSL ` +
        `version ${JSON.stringify(version)}, newer than this client's ${RUNTIME_DSL_VERSION}`,
    );
  }
}

function validatePayloadForKind(session: RuntimeSession, payload: unknown): void {
  if (session.kind === 'chat' && !isChatMessageSkeleton(payload)) {
    throw validationFailure(
      '@openmaic/storage: invalid runtime record: /payload: chat payload must match ' +
        'ChatMessageSkeleton (role + content)',
    );
  }
  if (session.kind === 'quizAttempt' && !isQuizAttemptSkeleton(payload)) {
    throw validationFailure(
      '@openmaic/storage: invalid runtime record: /payload: quizAttempt payload must match ' +
        'QuizAttemptSkeleton (phase + answers)',
    );
  }
}

function forbiddenLearner(): RuntimeHttpError {
  return new RuntimeHttpError(
    403,
    'FORBIDDEN_LEARNER',
    '@openmaic/storage: authenticated learner may not access the requested learner partition',
  );
}

function requireLearner(principal: RuntimeHttpPrincipal, learnerKey: string): void {
  if (principal.learnerKey !== learnerKey) throw forbiddenLearner();
}

async function requireSession(
  store: RuntimeStore,
  sessionId: string,
): Promise<RuntimeSession> {
  const session = await store.getSession(sessionId);
  if (session === undefined) throw missingSessionError(sessionId);
  assertNotFutureSession(session);
  return session;
}

async function ownedSession(
  store: RuntimeStore,
  principal: RuntimeHttpPrincipal,
  sessionId: string,
): Promise<RuntimeSession> {
  const session = await requireSession(store, sessionId);
  requireLearner(principal, session.learnerKey);
  return session;
}

function parsePath(req: IncomingMessage): { parts: string[]; url: URL } {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://runtime.invalid');
    const parts = url.pathname
      .split('/')
      .filter((part, index) => index !== 0 || part !== '')
      .map((part) => decodeURIComponent(part));
    return { parts, url };
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
}

function mappedError(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof RuntimeHttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: RuntimeStore,
  options: RuntimeHttpHandlerOptions,
): Promise<void> {
  const { parts, url } = parsePath(req);
  const method = req.method ?? 'GET';
  if (parts[0] !== 'runtime') {
    throw new RuntimeHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
  }

  const principal = await options.authenticate(req);
  if (principal === undefined) {
    throw new RuntimeHttpError(401, 'UNAUTHENTICATED', '@openmaic/storage: authentication required');
  }
  if (typeof principal.learnerKey !== 'string' || principal.learnerKey === '') {
    throw new RuntimeHttpError(
      500,
      'INTERNAL_ERROR',
      '@openmaic/storage: authenticate returned an invalid principal',
    );
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'sessions') {
    const init = await readJson<RuntimeSessionInit & { runtimeDslVersion?: unknown }>(req);
    assertAddressableSegment(init.id);
    assertAddressableSegment(init.stageId);
    assertAddressableSegment(init.learnerKey);
    requireLearner(principal, init.learnerKey);
    validationError(
      validateRuntimeSession({ ...init, runtimeDslVersion: RUNTIME_DSL_VERSION }),
      `@openmaic/storage: invalid runtime session ${JSON.stringify(init.id)}`,
    );
    const existing = await store.getSession(init.id);
    if (existing !== undefined) {
      requireLearner(principal, existing.learnerKey);
      throw new RuntimeHttpError(
        409,
        'SESSION_ALREADY_EXISTS',
        `@openmaic/storage: session ${JSON.stringify(init.id)} already exists`,
      );
    }
    try {
      sendJson(res, 201, await store.createSession(init));
    } catch (error) {
      // A post-failure existence check classifies duplicate races without
      // depending on a database driver's message text.
      const raced = await store.getSession(init.id);
      if (raced !== undefined) {
        requireLearner(principal, raced.learnerKey);
        throw new RuntimeHttpError(
          409,
          'SESSION_ALREADY_EXISTS',
          `@openmaic/storage: session ${JSON.stringify(init.id)} already exists`,
        );
      }
      throw error;
    }
    return;
  }

  if (parts[1] === 'sessions' && parts.length >= 3) {
    const sessionId = parts[2]!;
    assertAddressableSegment(sessionId);
    if (method === 'GET' && parts.length === 3) {
      sendJson(res, 200, await ownedSession(store, principal, sessionId));
      return;
    }
    if (method === 'PATCH' && parts.length === 4 && parts[3] === 'status') {
      const body = await readJson<{ status: RuntimeSessionStatus; updatedAt: string }>(req);
      const session = await ownedSession(store, principal, sessionId);
      validationError(
        validateRuntimeSession({ ...session, status: body.status, updatedAt: body.updatedAt }),
        `@openmaic/storage: invalid runtime session ${JSON.stringify(sessionId)}`,
      );
      await store.setSessionStatus(sessionId, body.status, body.updatedAt);
      sendNoContent(res);
      return;
    }
    if (method === 'DELETE' && parts.length === 3) {
      const session = await store.getSession(sessionId);
      if (session !== undefined) {
        assertNotFutureSession(session);
        requireLearner(principal, session.learnerKey);
      }
      await store.deleteSession(sessionId);
      sendNoContent(res);
      return;
    }
    if (method === 'POST' && parts.length === 4 && parts[3] === 'records') {
      const init = await readJson<RuntimeRecordInit & { seq?: unknown }>(req);
      if (init.sessionId !== sessionId) {
        throw validationFailure('invalid runtime record: body sessionId does not match the request path');
      }
      validationError(
        validateRuntimeRecord({ ...init, seq: 0 }),
        `@openmaic/storage: invalid runtime record ${JSON.stringify(init.id)}`,
      );
      assertJsonRequestValue(init.payload, `runtime record ${JSON.stringify(init.id)} payload`);
      const session = await ownedSession(store, principal, sessionId);
      validatePayloadForKind(session, init.payload);
      if (session.status !== 'active') {
        throw validationFailure(
          `@openmaic/storage: cannot append to session ${JSON.stringify(sessionId)} with ` +
            `status '${session.status}' — records may only be appended to an active session`,
        );
      }
      sendJson(res, 201, await store.appendRecord(init));
      return;
    }
    if (method === 'GET' && parts.length === 4 && parts[3] === 'records') {
      const session = await store.getSession(sessionId);
      if (session !== undefined) {
        assertNotFutureSession(session);
        requireLearner(principal, session.learnerKey);
      }
      const sceneId = url.searchParams.get('sceneId');
      sendJson(
        res,
        200,
        await store.listRecords(sessionId, sceneId === null ? undefined : { sceneId }),
      );
      return;
    }
  }

  if (
    method === 'GET' &&
    parts.length === 6 &&
    parts[1] === 'stages' &&
    parts[3] === 'learners' &&
    parts[5] === 'sessions'
  ) {
    const stageId = parts[2]!;
    const learnerKey = parts[4]!;
    assertAddressableSegment(stageId);
    assertAddressableSegment(learnerKey);
    requireLearner(principal, learnerKey);
    const sessions = await store.listSessions(stageId, learnerKey);
    for (const session of sessions) assertNotFutureSession(session);
    sendJson(res, 200, sessions);
    return;
  }

  if (method === 'POST' && parts.length === 3 && parts[1] === 'learners' && parts[2] === 'merge') {
    const body = await readJson<{ fromLearnerKey?: unknown; toLearnerKey?: unknown }>(req);
    if (
      typeof body.fromLearnerKey !== 'string' ||
      body.fromLearnerKey === '' ||
      typeof body.toLearnerKey !== 'string' ||
      body.toLearnerKey === ''
    ) {
      throw validationFailure('@openmaic/storage: learner keys must be non-empty strings');
    }
    assertAddressableSegment(body.fromLearnerKey);
    assertAddressableSegment(body.toLearnerKey);
    assertJsonRequestValue(body.fromLearnerKey, 'runtime learner merge fromLearnerKey');
    assertJsonRequestValue(body.toLearnerKey, 'runtime learner merge toLearnerKey');
    if (!(await options.authorizeMerge?.(principal, body.fromLearnerKey, body.toLearnerKey))) {
      throw forbiddenLearner();
    }
    sendJson(res, 200, {
      moved: await store.mergeLearner(body.fromLearnerKey, body.toLearnerKey),
    });
    return;
  }

  if (
    method === 'DELETE' &&
    parts.length === 5 &&
    parts[1] === 'stages' &&
    parts[3] === 'learners'
  ) {
    const stageId = parts[2]!;
    const learnerKey = parts[4]!;
    assertAddressableSegment(stageId);
    assertAddressableSegment(learnerKey);
    requireLearner(principal, learnerKey);
    await store.deleteLearnerRuntime(stageId, learnerKey);
    sendNoContent(res);
    return;
  }

  if (method === 'DELETE' && parts.length === 3 && parts[1] === 'stages') {
    const stageId = parts[2]!;
    assertAddressableSegment(stageId);
    if (!(await options.authorizeAdmin?.(principal))) {
      throw new RuntimeHttpError(
        403,
        'FORBIDDEN_ADMIN',
        '@openmaic/storage: admin authorization required',
      );
    }
    await store.deleteStageRuntime(stageId);
    sendNoContent(res);
    return;
  }

  throw new RuntimeHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
}

/** Create a Node HTTP request handler for the complete RuntimeStore contract. */
export function createRuntimeHttpHandler(
  store: RuntimeStore,
  options: RuntimeHttpHandlerOptions,
): RequestListener {
  if (typeof options?.authenticate !== 'function') {
    throw new Error('@openmaic/storage: createRuntimeHttpHandler requires authenticate');
  }
  return (req, res) => {
    void route(req, res, store, options).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const mapped = mappedError(error);
      sendJson(res, mapped.status, mapped.body);
    });
  };
}
