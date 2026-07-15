/**
 * Server-side config + helpers for the isolated MP4 render service (issue #866).
 *
 * The render service is an opt-in capability: it's only reachable when
 * `RENDER_SERVICE_URL` is set. When unset, the app degrades to letting the user
 * download the project ZIP for local CLI rendering, so callers treat "not
 * configured" as a normal, expected state — not an error.
 */
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

/** The configured base URL of the render service, or null when the capability is off. */
export function getRenderServiceUrl(): string | null {
  const raw = process.env.RENDER_SERVICE_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** Whether one-click MP4 export is available (service configured). */
export function isRenderServiceConfigured(): boolean {
  return getRenderServiceUrl() !== null;
}

/**
 * Resolve the render service base URL, applying an SSRF check in production so
 * a misconfigured `RENDER_SERVICE_URL` can't be pointed at arbitrary internal
 * hosts. In development (and for the common `localhost`/compose-network case)
 * the check is skipped — mirrors `app/api/extract-document`'s gating, and a
 * localhost target additionally needs `ALLOW_LOCAL_NETWORKS=true` to pass the
 * guard when it does run. Returns `{ url }` or `{ error }`.
 */
export async function resolveRenderServiceUrl(): Promise<{ url: string } | { error: string }> {
  const url = getRenderServiceUrl();
  if (!url) return { error: 'not_configured' };

  if (process.env.NODE_ENV === 'production') {
    const ssrfError = await validateUrlForSSRF(url);
    if (ssrfError) return { error: `Invalid RENDER_SERVICE_URL: ${ssrfError}` };
  }
  return { url };
}
