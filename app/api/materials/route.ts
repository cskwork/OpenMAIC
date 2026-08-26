/**
 * /api/materials — the workbench's session-material list and upload face.
 *
 * Materials are session-scoped (the store from the materials slice), so the
 * client names the session with `?sessionId=`; the session's own owner row is
 * the authorization — a foreign or missing session answers the same plain 404
 * as every other agent-runtime route. The owner itself resolves from the
 * anonymous cookie and is never a request parameter.
 *
 * Uploads reuse the exact byte path the material store uses for fetched pages
 * (`createSourceMaterial` → the hash-addressed asset registry under the
 * session's own partition + a material row recording the returned asset id);
 * no second byte path is invented. Uploaded files are `source` materials:
 * they carry no readable text by design, matching the agent tools' contract.
 *
 * The configured runtime gates the family: the workbench is agent-runtime
 * territory, and there is deliberately no separate materials flag in this
 * repo (the runtime probe route documents that). A runtime that is off OR
 * enabled without a DATABASE_URL answers the same plain 404 as the stages
 * routes — never a 500 from a store that cannot connect.
 */
import { basename } from 'node:path';

import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import {
  createSourceMaterial,
  listSessionMaterials,
  publicMaterialView,
  resolveOwnedSession,
} from '@/lib/server/agent-runtime/session-materials';
import { ownerApiError, ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

/** Upper bound for one uploaded file. */
export const MAX_MATERIAL_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The store's keyset-paging ceiling (default 50, capped at 200). */
export const MAX_MATERIAL_LIST_LIMIT = 200;

/** The `x-material-filename` header, sanitized to a bare file name. */
function materialFilename(req: NextRequest): string | null {
  const raw = req.headers.get('x-material-filename');
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Preserve a plain header value; malformed percent escapes are not paths.
  }
  const name = basename(decoded.replace(/\\/g, '/')).trim().slice(0, 512);
  return name || null;
}

/** Read the body up to a cap; `null` when empty or over the cap. */
async function readBodyBytes(
  req: NextRequest,
  limit: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  if (!req.body) return { ok: false };
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    total += buffer.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(buffer);
  }
  if (total === 0) return { ok: false };
  return { ok: true, bytes: Buffer.concat(chunks) };
}

function parseLimit(raw: string | null): { limit?: number } | { invalid: true } {
  if (raw === null || raw === '') return {};
  if (!/^\d+$/.test(raw)) return { invalid: true };
  const parsed = Number(raw);
  if (parsed < 1 || parsed > MAX_MATERIAL_LIST_LIMIT) return { invalid: true };
  return { limit: parsed };
}

// GET /api/materials?sessionId=&limit=&before= — list one owned session's
// materials, newest first, keyset-paged.
export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId is required');

  const parsedLimit = parseLimit(url.searchParams.get('limit'));
  if ('invalid' in parsedLimit) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `limit must be an integer between 1 and ${MAX_MATERIAL_LIST_LIMIT}`,
    );
  }
  const before = url.searchParams.get('before')?.trim() || undefined;

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    const materials = await listSessionMaterials(sessionId, {
      ...(parsedLimit.limit === undefined ? {} : { limit: parsedLimit.limit }),
      ...(before ? { before } : {}),
    });
    return ownerJson(
      { materials: materials.map((material) => publicMaterialView(material)) },
      200,
      responseHeaders,
    );
  });
}

// POST /api/materials?sessionId= — upload a source file into one owned
// session. The raw bytes ride the body; `content-type` is the MIME type and
// `x-material-filename` the display name.
export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const sessionId = new URL(req.url).searchParams.get('sessionId')?.trim();
  if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId is required');

  const filename = materialFilename(req);
  if (!filename) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'x-material-filename header is required');
  }
  const mimeType =
    (req.headers.get('content-type') ?? '').split(';', 1)[0].trim() || 'application/octet-stream';

  const body = await readBodyBytes(req, MAX_MATERIAL_UPLOAD_BYTES);
  if (!body.ok) {
    return apiError('INVALID_REQUEST', 413, `upload exceeds ${MAX_MATERIAL_UPLOAD_BYTES} bytes`);
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    try {
      const record = await createSourceMaterial(sessionId, {
        filename,
        mimeType,
        bytes: body.bytes,
      });
      return ownerJson({ material: publicMaterialView(record) }, 201, responseHeaders);
    } catch (error) {
      console.error(
        `[Materials] Failed to store upload [sessionId=${sessionId}, ownerId=${ownerId}]:`,
        error,
      );
      return ownerApiError('INTERNAL_ERROR', 500, 'material upload failed', responseHeaders);
    }
  });
}
