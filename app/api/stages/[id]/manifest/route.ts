/**
 * GET /api/stages/[id]/manifest — freshness manifest for one course (the
 * reference's `stages/:id/manifest`, ported onto the owner-bound store).
 *
 * Returns `{rev, scenes: [{id, order, rev}]}` — the revision index the
 * workbench canvas diffs against before re-fetching scenes. The upstream
 * store carries no per-scene revisions and adds none (this slice reuses the
 * existing stores), so `rev` is the document's `stage.updatedAt` and every
 * scene shares it: any document-level change invalidates the whole scene set,
 * which is correct if coarser than the reference — the client's manifest diff
 * logic works unchanged and re-fetches exactly the (possibly all) scenes
 * whose rev moved. Writes through this slice's PUT/PATCH bump `updatedAt`, so
 * the UI's own saves drive the signal.
 *
 * Permission boundary is the same as every stage route: the owner-bound store
 * reads a foreign or missing stage as absent, and both answer the identical
 * 404 (the id is not an existence oracle).
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeEnabled } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeEnabled()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    const store = await getOwnerScopedDocumentStore(ownerId);
    const document = await store.loadDocument(id);
    if (!document) return ownerNotFound(responseHeaders);
    const rev = document.stage.updatedAt;
    return ownerJson(
      {
        rev,
        scenes: document.scenes.map((scene) => ({ id: scene.id, order: scene.order, rev })),
      },
      200,
      responseHeaders,
    );
  });
}
