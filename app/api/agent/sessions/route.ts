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
import { MAX_SESSION_TEXT_LENGTH } from '@/lib/server/agent-runtime/limits';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { buildRequestOrigin, isValidClassroomId } from '@/lib/server/classroom-storage';

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
  if (existingCourse && stageId && !isValidClassroomId(stageId)) {
    return apiError('INVALID_REQUEST', 400, 'existingCourse stageId has an invalid format');
  }

  const prompt =
    (body.prompt ?? '').toString().trim() || (existingCourse ? (stageId ?? 'existing-course') : '');
  if (!prompt) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'prompt is required');
  }
  if (prompt.length > MAX_SESSION_TEXT_LENGTH) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `prompt exceeds the ${MAX_SESSION_TEXT_LENGTH} character limit`,
    );
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const skillId = (body.skill ?? '').toString().trim() || undefined;

    // Upstream classrooms do not carry an owner partition, so existing-course
    // sessions validate only the identifier format here. Full existence and
    // ownership validation is deferred until a later slice consumes stageId —
    // the upstream document store has no owner partition yet.
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
  });
}

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeEnabled()) {
    return new Response('Not found', { status: 404 });
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const store = await getAgentSessionStore();
    const sessions = await store.listSessionsByOwner(ownerId);
    return NextResponse.json(sessions, { headers: responseHeaders });
  });
}
