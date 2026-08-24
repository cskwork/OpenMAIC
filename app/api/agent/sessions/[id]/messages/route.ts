/** Agent runtime control plane for durable follow-up messages. */
import { AgentSessionAccessError } from '@openmaic/storage';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeEnabled } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeEnabled()) {
    return new Response('Not found', { status: 404 });
  }

  const responseHeaders = new Headers();
  const ownerId = resolveRequestOwnerId(req, responseHeaders);
  const { id } = await params;
  const store = await getAgentSessionStore();
  const meta = await store.getSession(id);
  if (!meta || meta.ownerId !== ownerId) {
    return new Response('Not found', { status: 404, headers: responseHeaders });
  }

  let body: { text?: string } = {};
  try {
    body = ((await req.json()) ?? {}) as typeof body;
  } catch {
    const response = apiError('INVALID_REQUEST', 400, 'invalid JSON body');
    responseHeaders.forEach((value, name) => response.headers.append(name, value));
    return response;
  }

  const text = (body.text ?? '').toString().trim();
  if (!text) {
    const response = apiError('MISSING_REQUIRED_FIELD', 400, 'text is required');
    responseHeaders.forEach((value, name) => response.headers.append(name, value));
    return response;
  }

  try {
    const posted = await store.postUserMessage(id, { text }, { expectedOwnerId: ownerId });
    return NextResponse.json(
      { id, message: { seq: posted.seq, text, delivery: posted.delivery } },
      { status: 202, headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof AgentSessionAccessError) {
      return new Response('Forbidden', { status: 403, headers: responseHeaders });
    }
    throw error;
  }
}
