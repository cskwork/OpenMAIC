/**
 * POST /api/bookmarks — bookmark a stage for "My Courses".
 *
 * Idempotent, owner-scoped (the owner resolves from the anonymous cookie via
 * `withRequestOwnerId`, exactly like the other workbench routes). The stage
 * must resolve through `resolveStageAccess`: absent and tombstoned are the
 * same 404, and a bookmark on a deleted course would resurrect it in the
 * caller's "My Courses" list.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { addStageBookmark } from '@/lib/persistence/stage-meta';
import { getStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { stageId } = (body ?? {}) as { stageId?: unknown };
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return NextResponse.json({ error: 'Missing stageId' }, { status: 400 });
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const access = await resolveStageAccess(stageId);
      if (!access) {
        return NextResponse.json(
          { error: 'Stage not found' },
          { status: 404, headers: responseHeaders },
        );
      }

      const db = await getStageAccessDb();
      await addStageBookmark(db, ownerId, stageId);
      return NextResponse.json({ ok: true }, { status: 200, headers: responseHeaders });
    } catch (error) {
      console.error('[Bookmarks] Failed to create bookmark:', error);
      return NextResponse.json(
        { error: 'Failed to create bookmark' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}
