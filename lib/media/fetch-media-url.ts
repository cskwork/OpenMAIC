/**
 * Fetch a media URL through the same-origin media proxy when it is remote.
 * A plain browser fetch is CORS-blocked for cross-origin media exactly where
 * a media element would still play, and the proxy carries the SSRF guard and
 * its response limit. Local schemes (data:, relative) go direct. Always
 * bounded; the caller maps the response.
 */
export function fetchMediaUrl(url: string, timeoutMs: number): Promise<Response> {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}
