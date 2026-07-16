import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideo Render API');

// Only forwards the upload to the isolated render service; the render itself
// happens there, so this route stays lightweight despite large ZIP bodies.
export const maxDuration = 60;

/** Reject uploads larger than this before forwarding (compressed ZIP bytes). */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/**
 * Derive a stable-ish client identity server-side (client IP), so the render
 * service's per-identity guard can't be bypassed by a client rotating a
 * self-supplied id. The trusted proxy forwards this as `x-openmaic-client`;
 * the service ignores any client-supplied value.
 */
function clientIdentity(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'anonymous';
  return req.headers.get('x-real-ip')?.trim() || 'anonymous';
}

/**
 * Submit an export ZIP for MP4 rendering. Forwards the multipart body to the
 * render service and relays its `202 { jobId }`. Returns 501 when the service
 * is not configured so the client can degrade to a local ZIP download.
 */
export async function POST(req: NextRequest) {
  const resolved = resolveRenderServiceUrl();
  if ('error' in resolved) {
    return apiError('PROVIDER_DISABLED', 501, 'Render service is not configured');
  }

  // Bound the upload before buffering/forwarding it (belt-and-suspenders with
  // the service's own archive limits): reject oversized bodies up front.
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > MAX_UPLOAD_BYTES) {
    return apiError('INVALID_REQUEST', 413, 'Export archive is too large');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Expected multipart/form-data');
  }
  // Never trust a client-supplied identity; the service derives it from the header.
  form.delete('userId');

  try {
    // Long enough for the upload of a multi-MB ZIP; the render is async.
    const upstream = await proxyFetch(`${resolved.url}/render`, {
      method: 'POST',
      body: form,
      headers: { 'x-openmaic-client': clientIdentity(req) },
      signal: AbortSignal.timeout(60_000),
    });

    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!upstream.ok) {
      const detail = typeof data.error === 'string' ? data.error : upstream.statusText;
      const status = upstream.status === 429 ? 429 : 502;
      return apiError(
        upstream.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
        status,
        'Render service rejected the request',
        detail,
      );
    }

    return apiSuccess({ jobId: data.jobId, pollIntervalMs: 3000 }, 202);
  } catch (error) {
    log.error('Failed to submit render job:', error);
    return apiError(
      'UPSTREAM_ERROR',
      502,
      'Failed to reach render service',
      error instanceof Error ? error.message : String(error),
    );
  }
}
