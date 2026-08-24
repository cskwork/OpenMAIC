/**
 * Agent runtime control plane for session creation and listing.
 *
 * These handlers only use the durable session store. A separately running
 * worker claims queued sessions after the request has returned.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeEnabled } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';

export const runtime = 'nodejs';

interface CreateSessionBody {
  prompt?: string;
  stageId?: string;
  skill?: string;
  /** Attach to an already-built classroom instead of starting a new course. */
  existingCourse?: boolean;
}

export async function POST(req: NextRequest) {
  if (!isAgentRuntimeEnabled()) {
    return new Response('Not found', { status: 404 });
  }

  let body: CreateSessionBody = {};
  try {
    body = ((await req.json()) ?? {}) as CreateSessionBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }

  const existingCourse = body.existingCourse === true;
  const stageId = body.stageId?.toString().trim() || undefined;
  if (existingCourse && !stageId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'existingCourse requires stageId');
  }

  const prompt =
    (body.prompt ?? '').toString().trim() || (existingCourse ? (stageId ?? 'existing-course') : '');
  if (!prompt) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'prompt is required');
  }

  const responseHeaders = new Headers();
  const ownerId = resolveRequestOwnerId(req, responseHeaders);
  const skillId = (body.skill ?? '').toString().trim() || undefined;

  // Upstream classrooms do not carry an owner partition, so existing-course
  // sessions validate the required identifier but cannot enforce ownership.
  const store = await getAgentSessionStore();
  const meta = await store.createSession({
    ownerId,
    prompt,
    ...(stageId ? { stageId } : {}),
    ...(skillId ? { skillId } : {}),
    existingCourse,
    origin: buildRequestOrigin(req),
    ...(existingCourse ? { status: 'succeeded' as const } : {}),
  });

  return NextResponse.json(meta, { status: 202, headers: responseHeaders });
}

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeEnabled()) {
    return new Response('Not found', { status: 404 });
  }

  const responseHeaders = new Headers();
  const ownerId = resolveRequestOwnerId(req, responseHeaders);
  const store = await getAgentSessionStore();
  const sessions = await store.listSessionsByOwner(ownerId);
  return NextResponse.json(sessions, { headers: responseHeaders });
}
