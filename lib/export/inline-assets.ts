import {
  toDataUri,
  type InlineReport,
  type InlineOptions,
  type FetchAsset,
} from './inline-assets-shared';
import { buildInlinedImportmap } from './inline-assets-importmap';

export { toDataUri } from './inline-assets-shared';
export type { InlineReport, InlineOptions } from './inline-assets-shared';

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
    const whole = m[0].toLowerCase();
    if (whole.includes('importmap') || whole.includes('application/json')) continue;
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
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };
  return table[ext] ?? 'application/octet-stream';
}

/** Inline every url(...) inside a CSS text, resolving relative URLs against cssUrl. */
export async function inlineCssUrls(
  css: string,
  cssUrl: string,
  fetchAsset: FetchAsset,
): Promise<string> {
  const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  const matches = [...css.matchAll(urlRe)];
  const replacements = new Map<string, string>(); // raw ref -> data uri
  for (const m of matches) {
    const raw = m[2].trim();
    if (/^data:/i.test(raw)) continue;
    if (replacements.has(raw)) continue;
    let abs: string;
    try {
      abs = new URL(raw, cssUrl).href;
    } catch {
      continue;
    }
    const got = await fetchAsset(abs);
    if (got) replacements.set(raw, toDataUri(got.bytes, got.contentType));
  }
  return css.replace(urlRe, (full, _q, raw) => {
    const key = String(raw).trim();
    const dataUri = replacements.get(key);
    return dataUri ? `url(${dataUri})` : full;
  });
}

// ---------------------------------------------------------------------------
// inlineHtmlAssets — Task 4
// ---------------------------------------------------------------------------

async function replaceAsync(
  input: string,
  re: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(re)];
  // Process sequentially so the fetcher cache is populated before the next
  // occurrence of the same URL is processed (dedup guarantee).
  const replaced: string[] = [];
  for (const m of matches) {
    replaced.push(await replacer(...(m as unknown as string[])));
  }
  let result = '';
  let last = 0;
  matches.forEach((m, i) => {
    result += input.slice(last, m.index!) + replaced[i];
    last = m.index! + m[0].length;
  });
  return result + input.slice(last);
}

async function inlineImportmaps(
  html: string,
  fetchAsset: FetchAsset,
  report: InlineReport,
): Promise<string> {
  // Collect inline module-script bodies (type="module", non-importmap, with a body).
  const moduleBodies: string[] = [];
  for (const m of html.matchAll(
    /<script\b([^>]*)\btype\s*=\s*["']module["']([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    if (m[3]?.trim()) moduleBodies.push(m[3]);
  }
  return await replaceAsync(
    html,
    /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi,
    async (full, json) => {
      let parsed: { imports?: Record<string, string> };
      try {
        parsed = JSON.parse(json);
      } catch {
        return full;
      }
      const orig = parsed.imports ?? {};
      const { imports: inlined, report: r } = await buildInlinedImportmap(
        orig,
        moduleBodies,
        fetchAsset,
      );
      for (const u of r.inlined) if (!report.inlined.includes(u)) report.inlined.push(u);
      for (const f of r.failed)
        if (!report.failed.some((g) => g.url === f.url)) report.failed.push(f);
      // Merge: start from originals, overlay inlined data: entries.
      const merged: Record<string, string> = { ...orig, ...inlined };
      // Drop any '/'-terminated prefix key that was expanded into explicit data: entries.
      for (const key of Object.keys(merged)) {
        if (key.endsWith('/')) {
          const expanded = Object.keys(inlined).some((k) => k.startsWith(key));
          if (expanded) delete merged[key];
        }
      }
      return `<script type="importmap">${JSON.stringify({ imports: merged })}</script>`;
    },
  );
}

export async function inlineHtmlAssets(
  html: string,
  options?: InlineOptions,
): Promise<{ html: string; report: InlineReport }> {
  const fetchAsset = createAssetFetcher(options);
  const report: InlineReport = { inlined: [], failed: [] };
  let out = html;

  const markInlined = (url: string) => {
    if (!report.inlined.includes(url)) report.inlined.push(url);
  };
  const markFailed = (url: string, reason: string) => {
    if (!report.failed.some((f) => f.url === url)) report.failed.push({ url, reason });
  };

  // 1) <link rel=stylesheet href> → <style> with nested url() inlined
  out = await replaceAsync(
    out,
    /<link\b([^>]*?)\bhref\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    async (full, pre, url, post) => {
      const isStylesheet = /rel\s*=\s*["']?stylesheet/i.test(pre + post);
      if (!isStylesheet) return full;
      const got = await fetchAsset(url);
      if (!got) {
        markFailed(url, 'fetch failed');
        return full;
      }
      let cssText = new TextDecoder().decode(got.bytes);
      cssText = await inlineCssUrls(cssText, url, fetchAsset);
      markInlined(url);
      return `<style data-inlined-from="">${cssText}</style>`;
    },
  );

  // 2) <script src> (non-importmap) → data: URI src
  out = await replaceAsync(
    out,
    /<script\b([^>]*?)\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    async (full, pre, url, post) => {
      const attrs = (pre + post).toLowerCase();
      if (attrs.includes('importmap') || attrs.includes('application/json')) return full;
      const got = await fetchAsset(url);
      if (!got) {
        markFailed(url, 'fetch failed');
        return full;
      }
      markInlined(url);
      return `<script${pre}src="${toDataUri(got.bytes, got.contentType)}"${post}>`;
    },
  );

  // 3) <img src> and <source src>
  out = await replaceAsync(
    out,
    /<(img|source)\b([^>]*?)\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    async (full, tag, pre, url, post) => {
      const got = await fetchAsset(url);
      if (!got) {
        markFailed(url, 'fetch failed');
        return full;
      }
      markInlined(url);
      return `<${tag}${pre}src="${toDataUri(got.bytes, got.contentType)}"${post}>`;
    },
  );

  // 4) url() inside authored <style> blocks (skip ones we created in step 1)
  out = await replaceAsync(
    out,
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    async (full, attrs, body) => {
      if (/data-inlined-from=/.test(attrs)) return full;
      const inlined = await inlineCssUrls(body, 'about:blank', fetchAsset);
      return `<style${attrs}>${inlined}</style>`;
    },
  );

  // 5) importmap (Task 5)
  out = await inlineImportmaps(out, fetchAsset, report);

  return { html: out, report };
}
