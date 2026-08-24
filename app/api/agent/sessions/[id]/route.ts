/** Agent runtime control plane for reading one owned session. */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeEnabled } from '@/lib/config/feature-flags';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  return NextResponse.json(meta, { headers: responseHeaders });
}
