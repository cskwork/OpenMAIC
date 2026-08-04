import { type NextRequest } from 'next/server';
import {
  MAX_REVISIONED_WHITEBOARD_ACK_BYTES,
  REVISIONED_WHITEBOARD_ACK_HEADER,
  isRevisionedWhiteboardMutationAck,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { piRevisionedWhiteboardCoordinator } from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
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
    if (totalBytes > MAX_REVISIONED_WHITEBOARD_ACK_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The authenticated size violation remains authoritative.
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
  context: { params: Promise<{ executionId: string }> },
) {
  if (!isPiNativeChildRuntimeEnabled() || !isPiNativeChildWhiteboardEnabled()) {
    return invalidRequest(404, 'Revisioned Native Child whiteboard effects are disabled.');
  }
  const origin = request.headers.get('origin');
  if (!origin || origin !== request.nextUrl.origin) {
    return invalidRequest(403, 'Revisioned whiteboard ACK must be same-origin.');
  }
  if (request.headers.get('content-type') !== 'application/json') {
    return invalidRequest(415, 'Revisioned whiteboard ACK requires application/json.');
  }

  const { executionId } = await context.params;
  const token = request.headers.get(REVISIONED_WHITEBOARD_ACK_HEADER);
  if (!token) return invalidRequest(401, 'Revisioned whiteboard capability is required.');
  const authorization = piRevisionedWhiteboardCoordinator.authorize(executionId, token);
  if (authorization === 'unauthorized') {
    return invalidRequest(401, 'Revisioned whiteboard capability is invalid.');
  }
  if (authorization === 'unknown') {
    return invalidRequest(404, 'Revisioned whiteboard execution was not found.');
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REVISIONED_WHITEBOARD_ACK_BYTES) {
    return invalidRequest(413, 'Revisioned whiteboard ACK body is too large.');
  }
  const bodyRead = await readBoundedBody(request);
  if (bodyRead.kind === 'too_large') {
    return invalidRequest(413, 'Revisioned whiteboard ACK body is too large.');
  }
  if (bodyRead.kind === 'invalid_utf8') {
    return invalidRequest(400, 'Revisioned whiteboard ACK body must be valid UTF-8.');
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyRead.body);
  } catch {
    return invalidRequest(400, 'Revisioned whiteboard ACK body must be valid JSON.');
  }
  if (!isRevisionedWhiteboardMutationAck(body) || body.executionId !== executionId) {
    return invalidRequest(400, 'Revisioned whiteboard ACK body is invalid.');
  }
  const outcome = piRevisionedWhiteboardCoordinator.applyAck(token, body);
  switch (outcome.kind) {
    case 'applied':
    case 'duplicate':
      return apiSuccess({ disposition: outcome.kind, state: outcome.status });
    case 'unknown':
      return invalidRequest(404, 'Revisioned whiteboard execution was not found.');
    case 'invalid':
      return apiError('INVALID_REQUEST', 409, outcome.reason ?? 'Revisioned ACK conflicted.');
  }
}
