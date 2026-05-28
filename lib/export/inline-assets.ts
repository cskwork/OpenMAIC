export interface InlineReport {
  inlined: string[];
  failed: { url: string; reason: string }[];
}

export interface InlineOptions {
  fetchImpl?: typeof fetch;
  maxAssetBytes?: number;
}

export type AssetRefKind = 'link' | 'script' | 'img' | 'source' | 'css-url' | 'importmap';

export interface AssetRef {
  kind: AssetRefKind;
  url: string;
}

const HTTP_URL = /^https?:\/\//i;

/** Scan LLM-generated interactive HTML for external http(s) asset references. */
export function collectAssetRefs(html: string): AssetRef[] {
  const refs: AssetRef[] = [];
  const push = (kind: AssetRefKind, url: string) => {
    if (HTTP_URL.test(url)) refs.push({ kind, url });
  };

  for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('link', m[1]);
  }
  for (const m of html.matchAll(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const attrs = m[1].toLowerCase();
    if (attrs.includes('type="importmap"') || attrs.includes('type="application/json"')) continue;
    push('script', m[2]);
  }
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('img', m[1]);
  }
  for (const m of html.matchAll(/<source\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('source', m[1]);
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    push('css-url', m[1].trim());
  }
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const map = JSON.parse(m[1]);
      const imports = map.imports ?? {};
      for (const v of Object.values(imports)) {
        if (typeof v === 'string') push('importmap', v);
      }
    } catch {
      // malformed importmap — skip
    }
  }
  return refs;
}

const DEFAULT_MAX_ASSET_BYTES = 8 * 1024 * 1024;

export function createAssetFetcher(options?: InlineOptions) {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxBytes = options?.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  const cache = new Map<string, { bytes: Uint8Array; contentType: string } | null>();

  return async function fetchAsset(
    url: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (cache.has(url)) return cache.get(url)!;
    let result: { bytes: Uint8Array; contentType: string } | null = null;
    try {
      const res = await fetchImpl(url);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength <= maxBytes) {
          const rawCt = res.headers.get('content-type') ?? '';
          const bareCt = rawCt.split(';')[0].trim();
          const contentType = bareCt || guessMime(url);
          result = { bytes: buf, contentType };
        }
      }
    } catch {
      result = null;
    }
    cache.set(url, result);
    return result;
  };
}

/** Fallback MIME by extension when the server omits content-type. */
function guessMime(url: string): string {
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
  const table: Record<string, string> = {
    js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff',
    ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav',
  };
  return table[ext] ?? 'application/octet-stream';
}

/** Encode bytes as a data: URI. */
export function toDataUri(bytes: Uint8Array, contentType: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return `data:${contentType};base64,${b64}`;
}
