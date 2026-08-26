/**
 * Agent runtime control plane — the installed skills.
 *
 *   GET /api/agent/skills -> [{ id, name, title, description, hasConstraints, source }]
 *
 * Drives the `/` picker (a skill the user names there becomes the session's
 * user-locked skill at creation). `title` is the skill's display name from its
 * frontmatter; every surface shows it beside the id, which stays the English
 * contract.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { listSkills } from '@/lib/server/agent-runtime/skills';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const skills = await listSkills(ownerId);
    return NextResponse.json(
      skills.map((s) => ({
        id: s.id,
        name: s.name,
        ...(s.title ? { title: s.title } : {}),
        description: s.description,
        hasConstraints: !!s.constraints,
        source: s.source,
      })),
      { headers: responseHeaders },
    );
  });
}
