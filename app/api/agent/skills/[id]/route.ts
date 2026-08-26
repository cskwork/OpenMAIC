/**
 * One user-owned Skill body, without bloating the global picker payload.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeEnabled } from '@/lib/config/feature-flags';
import { findUserSkill } from '@/lib/server/agent-runtime/user-skills';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeEnabled()) return new Response('Not found', { status: 404 });
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    const skill = await findUserSkill(id, ownerId);
    if (!skill) return new Response('Not found', { status: 404 });
    return NextResponse.json(
      { id: skill.id, content: skill.content },
      { headers: responseHeaders },
    );
  });
}
