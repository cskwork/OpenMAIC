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
