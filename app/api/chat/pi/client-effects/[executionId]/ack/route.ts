import { type NextRequest } from 'next/server';
import {
  CLIENT_EFFECT_ACK_HEADER,
  CLIENT_EFFECT_ACK_MAX_BYTES,
  isClientEffectAck,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import { isPiNativeChildWhiteboardEnabled } from '@/lib/config/feature-flags';
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
    if (totalBytes > CLIENT_EFFECT_ACK_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The size violation remains authoritative even if the source rejects cancellation.
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
  if (!isPiNativeChildWhiteboardEnabled()) {
    return invalidRequest(404, 'Native Child whiteboard effects are disabled.');
  }

  const origin = request.headers.get('origin');
  if (!origin || origin !== request.nextUrl.origin) {
    return invalidRequest(403, 'Client effect ACK must be same-origin.');
  }
  if (request.headers.get('content-type') !== 'application/json') {
    return invalidRequest(415, 'Client effect ACK requires application/json.');
  }

  const { executionId } = await context.params;
  const token = request.headers.get(CLIENT_EFFECT_ACK_HEADER);
  if (!token) return invalidRequest(401, 'Client effect capability is required.');
  const authorization = piClientEffectCoordinator.authorize(executionId, token);
  if (authorization === 'unauthorized') {
    return invalidRequest(401, 'Client effect capability is invalid.');
  }
  if (authorization === 'unknown') {
    return invalidRequest(404, 'Client effect execution was not found.');
  }
  if (authorization === 'gone') {
    return invalidRequest(410, 'Client effect execution has already been cleaned up.');
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > CLIENT_EFFECT_ACK_MAX_BYTES) {
    return invalidRequest(413, 'Client effect ACK body is too large.');
  }

  const bodyRead = await readBoundedBody(request);
  if (bodyRead.kind === 'too_large') {
    return invalidRequest(413, 'Client effect ACK body is too large.');
  }
  if (bodyRead.kind === 'invalid_utf8') {
    return invalidRequest(400, 'Client effect ACK body must be valid UTF-8.');
  }
  const rawBody = bodyRead.body;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return invalidRequest(400, 'Client effect ACK body must be valid JSON.');
  }
  if (!isClientEffectAck(body)) {
    return invalidRequest(400, 'Client effect ACK body is invalid.');
  }

  const outcome = piClientEffectCoordinator.acknowledge(executionId, token, body);
  switch (outcome.kind) {
    case 'applied':
    case 'duplicate':
    case 'late':
      return apiSuccess({
        disposition: outcome.kind,
        state: outcome.snapshot,
      });
    case 'unauthorized':
      return invalidRequest(401, 'Client effect capability is invalid.');
    case 'unknown':
      return invalidRequest(404, 'Client effect execution was not found.');
    case 'gone':
      return invalidRequest(410, 'Client effect execution has already been cleaned up.');
    case 'invalid':
      return apiError(
        'INVALID_REQUEST',
        409,
        outcome.reason,
        outcome.snapshot ? JSON.stringify(outcome.snapshot) : undefined,
      );
  }
}
