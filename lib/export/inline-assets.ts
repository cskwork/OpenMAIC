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
