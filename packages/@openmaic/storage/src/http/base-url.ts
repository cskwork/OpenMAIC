/**
 * The base-URL rule the HTTP clients share.
 *
 * They build request URLs by string concatenation (`${baseUrl}${path}`), which
 * makes the base URL's shape a correctness question rather than a style one,
 * and the two clients drifting apart on it would be a security difference
 * hiding as a duplication.
 */

/** A URL carrying an explicit scheme, i.e. one that is not a bare path. */
export const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/** Schemes a client may speak. Anything else is a mis-configuration, not a mode. */
export const RESOLVABLE_SCHEMES = new Set(['http:', 'https:']);

/** The unambiguous absolute form: scheme, `//`, then an authority. */
const SCHEME_AUTHORITY_FORM = /^https?:\/\//i;

/**
 * Validate a base URL and return it without its trailing slashes.
 *
 * A base URL is either a full `http(s)://host[/path]` or a bare path (the
 * app-mounted shape, e.g. `/api/persistence`, which the browser resolves
 * against the document). Everything else is refused at construction, where the
 * deployment can still fix it:
 *
 * - A non-http(s) scheme would put `file:` or `ftp:` one string-join away from
 *   every request the client makes.
 * - A scheme without `//` — `https:api.example/x` — parses standalone to the
 *   host `api.example`, but `fetch` on a same-scheme page reads it as a path
 *   relative to the current document. The client would then send its requests,
 *   and its credentials, somewhere other than where the operator wrote.
 * - A base carrying a query or fragment silently swallows the path appended to
 *   it: `https://host/api?v=1` + `/kv/keys` is not a route anyone intended.
 */
export function assertHttpBaseUrl(baseUrl: string, label: string): string {
  if (baseUrl === '') {
    throw new Error(`@openmaic/storage: ${label} baseUrl must be non-empty`);
  }
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (!ABSOLUTE_URL.test(trimmed)) {
    if (trimmed.includes('?') || trimmed.includes('#')) {
      throw new Error(`@openmaic/storage: ${label} baseUrl must not carry a query or fragment`);
    }
    return trimmed;
  }
  // Scheme first, so a `file:` base is reported as the wrong scheme rather than
  // as the wrong shape — the two failures have different fixes.
  const scheme = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase();
  if (!RESOLVABLE_SCHEMES.has(scheme)) {
    throw new Error(
      `@openmaic/storage: ${label} baseUrl scheme ${JSON.stringify(scheme)} is not http(s)`,
    );
  }
  if (!SCHEME_AUTHORITY_FORM.test(trimmed)) {
    throw new Error(
      `@openmaic/storage: ${label} baseUrl must be http(s) in the "scheme://host" form ` +
        `(a scheme without "//" is resolved relative to the current document)`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`@openmaic/storage: ${label} baseUrl must be a valid URL`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`@openmaic/storage: ${label} baseUrl must not carry a query or fragment`);
  }
  return trimmed;
}
