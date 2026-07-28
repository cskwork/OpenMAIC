import type { AssetRef, BinaryBlob } from '@openmaic/dsl';

/**
 * The content-addressing rule every `AssetProvider` backend shares:
 * `sha256-<lowercase hex>` over the blob's bytes.
 *
 * Refs have to be portable between backends — a document generated in the
 * browser and pushed to a server must keep resolving, and de-duplication only
 * survives if both sides derive the same handle from the same bytes. That is a
 * property of *one* rule, not of two implementations that happen to agree
 * today, so both backends compute their refs here.
 */

/** Matches a ref this package issued: `sha256-` plus 64 lowercase hex digits. */
const CONTENT_REF_PATTERN = /^sha256-[0-9a-f]{64}$/;

/** True when `ref` has the content-addressed shape this package issues. */
export function isContentAssetRef(ref: string): boolean {
  return CONTENT_REF_PATTERN.test(ref);
}

/**
 * Upper bound on a ref, in UTF-8 bytes. Long past any digest, and the same
 * reasoning as the KV key bound: refs become URL segments and storage keys.
 */
export const MAX_ASSET_REF_BYTES = 512;

const UTF8 = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * The ref domain, enforced by **every** backend.
 *
 * The read path deliberately accepts refs this package did not issue, so shape
 * is not enforced — but safety is, and it is enforced everywhere for the same
 * reason the KV key domain is: a ref one backend accepts and another cannot
 * address is not a portable handle. `/` and `\\` are refused because a decoded
 * ref must not be able to introduce a path segment (`..%2F..%2Fetc%2Fpasswd`
 * decodes to a traversal), and NUL or an unpaired surrogate does not survive
 * the transports underneath — the latter cannot even be percent-encoded.
 */
export function assertAssetRef(ref: string): void {
  if (ref === '') {
    throw new Error('@openmaic/storage: asset ref must not be empty');
  }
  if (ref === '.' || ref === '..') {
    throw new Error(`@openmaic/storage: URL path segment must not be ${JSON.stringify(ref)}`);
  }
  if (ref.includes('/') || ref.includes('\\')) {
    throw new Error(
      `@openmaic/storage: asset ref ${JSON.stringify(ref)} must not contain '/' or '\\'`,
    );
  }
  if (ref.includes('\u0000')) {
    throw new Error('@openmaic/storage: asset ref must not contain the NUL code point (\\u0000)');
  }
  if (LONE_SURROGATE.test(ref)) {
    throw new Error('@openmaic/storage: asset ref must not contain an unpaired UTF-16 surrogate');
  }
  const bytes = UTF8.encode(ref).length;
  if (bytes > MAX_ASSET_REF_BYTES) {
    throw new Error(
      `@openmaic/storage: asset ref exceeds ${MAX_ASSET_REF_BYTES} UTF-8 bytes (got ${bytes})`,
    );
  }
}

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, '0');
  return hex;
}

/** Hash raw bytes into the canonical ref. */
export async function assetRefForBytes(bytes: ArrayBuffer): Promise<AssetRef> {
  return `sha256-${toHex(await crypto.subtle.digest('SHA-256', bytes))}`;
}

/**
 * Read a blob once and return both its bytes and its ref. Backends need both,
 * and `arrayBuffer()` is not guaranteed to be cheap or repeatable.
 */
export async function computeAssetRef(
  data: BinaryBlob,
): Promise<{ ref: AssetRef; bytes: ArrayBuffer }> {
  const bytes = await data.arrayBuffer();
  return { ref: await assetRefForBytes(bytes), bytes };
}
