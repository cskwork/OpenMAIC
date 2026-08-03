import { type NextRequest } from 'next/server';
import {
  CLIENT_QUERY_RESPONSE_HEADER,
  CLIENT_QUERY_RESPONSE_MAX_BYTES,
  isClientQueryBrowserOutcome,
} from '@/lib/agent/runtime/client-query-contract';
import { piClientQueryCoordinator } from '@/lib/agent/runtime/client-query-coordinator';
import {
  isPiNativeChildRuntimeEnabled,
  isPiNativeChildWhiteboardEnabled,
} from '@/lib/config/feature-flags';
import { apiError, apiSuccess } from '@/lib/server/api-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function invalidRequest(status: number, message: string) {
  return apiError('INVALID_REQUEST', status, message);
}

async function readBoundedBody(
  request: NextRequest,
): Promise<{ kind: 'ok'; body: string } | { kind: 'invalid_utf8' } | { kind: 'too_large' }> {
  if (!request.body) return { kind: 'ok', body: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > CLIENT_QUERY_RESPONSE_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The size violation remains authoritative when cancellation itself fails.
      }
      return { kind: 'too_large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { kind: 'ok', body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'invalid_utf8' };
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ queryId: string }> },
) {
  if (!isPiNativeChildRuntimeEnabled() || !isPiNativeChildWhiteboardEnabled()) {
    return invalidRequest(404, 'Native Child whiteboard queries are disabled.');
  }
  const origin = request.headers.get('origin');
  if (!origin || origin !== request.nextUrl.origin) {
    return invalidRequest(403, 'Client query response must be same-origin.');
  }
  if (request.headers.get('content-type') !== 'application/json') {
    return invalidRequest(415, 'Client query response requires application/json.');
  }
  const { queryId } = await context.params;
  const token = request.headers.get(CLIENT_QUERY_RESPONSE_HEADER);
  if (!token) return invalidRequest(401, 'Client query capability is required.');
  const authorization = piClientQueryCoordinator.authorize(queryId, token);
  if (authorization === 'unauthorized') {
    return invalidRequest(401, 'Client query capability is invalid.');
  }
  if (authorization === 'unknown') {
    return invalidRequest(404, 'Client query was not found.');
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > CLIENT_QUERY_RESPONSE_MAX_BYTES) {
    return invalidRequest(413, 'Client query response is too large.');
  }
  const bodyRead = await readBoundedBody(request);
  if (bodyRead.kind === 'too_large')
    return invalidRequest(413, 'Client query response is too large.');
  if (bodyRead.kind === 'invalid_utf8')
    return invalidRequest(400, 'Client query response must be valid UTF-8.');
  let body: unknown;
  try {
    body = JSON.parse(bodyRead.body);
  } catch {
    return invalidRequest(400, 'Client query response must be valid JSON.');
  }
  if (!isClientQueryBrowserOutcome(body)) {
    return invalidRequest(400, 'Client query response body is invalid.');
  }
  const outcome = piClientQueryCoordinator.respond(queryId, token, bodyRead.body, body);
  switch (outcome.kind) {
    case 'applied':
    case 'duplicate':
    case 'late':
      return apiSuccess({ disposition: outcome.kind, state: outcome.status });
    case 'unauthorized':
      return invalidRequest(401, 'Client query capability is invalid.');
    case 'unknown':
      return invalidRequest(404, 'Client query was not found.');
    case 'invalid':
      return apiError('INVALID_REQUEST', 409, outcome.reason, outcome.status);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ queryId: string }> },
) {
  if (!isPiNativeChildRuntimeEnabled() || !isPiNativeChildWhiteboardEnabled()) {
    return invalidRequest(404, 'Native Child whiteboard queries are disabled.');
  }
  const origin = request.headers.get('origin');
  if (!origin || origin !== request.nextUrl.origin) {
    return invalidRequest(403, 'Client query failure report must be same-origin.');
  }
  const { queryId } = await context.params;
  const token = request.headers.get(CLIENT_QUERY_RESPONSE_HEADER);
  if (!token) return invalidRequest(401, 'Client query capability is required.');
  const outcome = piClientQueryCoordinator.failDelivery(queryId, token);
  switch (outcome.kind) {
    case 'applied':
    case 'late':
      return apiSuccess({ disposition: outcome.kind, state: outcome.status });
    case 'unauthorized':
      return invalidRequest(401, 'Client query capability is invalid.');
    case 'unknown':
      return invalidRequest(404, 'Client query was not found.');
    case 'duplicate':
    case 'invalid':
      return apiError('INVALID_REQUEST', 409, 'Client query failure report conflicted.');
  }
}
