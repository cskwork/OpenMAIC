export interface InlineReport {
  inlined: string[];
  failed: { url: string; reason: string }[];
}

export interface InlineOptions {
  fetchImpl?: typeof fetch;
  maxAssetBytes?: number;
}

export type FetchAsset = (
  url: string,
) => Promise<{ bytes: Uint8Array; contentType: string } | null>;

/** Encode bytes as a data: URI. */
export function toDataUri(bytes: Uint8Array, contentType: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return `data:${contentType};base64,${b64}`;
}
