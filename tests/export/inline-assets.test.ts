import { describe, it, expect } from 'vitest';
import { collectAssetRefs, createAssetFetcher, toDataUri } from '@/lib/export/inline-assets';

describe('collectAssetRefs', () => {
  it('collects stylesheet link hrefs', () => {
    const refs = collectAssetRefs('<link rel="stylesheet" href="https://cdn.example/a.css">');
    expect(refs).toContainEqual({ kind: 'link', url: 'https://cdn.example/a.css' });
  });

  it('collects script srcs', () => {
    const refs = collectAssetRefs('<script src="https://cdn.example/b.js"></script>');
    expect(refs).toContainEqual({ kind: 'script', url: 'https://cdn.example/b.js' });
  });

  it('collects img srcs', () => {
    const refs = collectAssetRefs('<img src="https://cdn.example/c.png">');
    expect(refs).toContainEqual({ kind: 'img', url: 'https://cdn.example/c.png' });
  });

  it('collects source srcs (video/audio)', () => {
    const refs = collectAssetRefs('<video><source src="https://cdn.example/d.mp4"></video>');
    expect(refs).toContainEqual({ kind: 'source', url: 'https://cdn.example/d.mp4' });
  });

  it('collects url() refs inside <style> blocks', () => {
    const refs = collectAssetRefs('<style>.x{background:url(https://cdn.example/e.png)}</style>');
    expect(refs).toContainEqual({ kind: 'css-url', url: 'https://cdn.example/e.png' });
  });

  it('collects importmap entry URLs', () => {
    const html =
      '<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js"}}</script>';
    const refs = collectAssetRefs(html);
    expect(refs).toContainEqual({
      kind: 'importmap',
      url: 'https://unpkg.com/three@0.160.0/build/three.module.js',
    });
  });

  it('IGNORES XML namespaces in xmlns (not a fetchable resource)', () => {
    const refs = collectAssetRefs('<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>');
    expect(refs.map((r) => r.url)).not.toContain('http://www.w3.org/2000/svg');
  });

  it('IGNORES data: and relative URLs', () => {
    const html =
      '<img src="data:image/png;base64,AAAA"><link rel="stylesheet" href="/local.css"><script src="./rel.js"></script>';
    const refs = collectAssetRefs(html);
    expect(refs).toEqual([]);
  });

  it('only collects http(s) absolute URLs', () => {
    const html = '<script src="https://a/x.js"></script><script src="http://b/y.js"></script>';
    const refs = collectAssetRefs(html);
    expect(refs.map((r) => r.url).sort()).toEqual(['http://b/y.js', 'https://a/x.js']);
  });
});

describe('createAssetFetcher', () => {
  function fakeFetch(map: Record<string, { body: string; contentType: string; status?: number }>) {
    return (async (url: string) => {
      const hit = map[String(url)];
      if (!hit) return new Response('not found', { status: 404 });
      return new Response(hit.body, {
        status: hit.status ?? 200,
        headers: { 'content-type': hit.contentType },
      });
    }) as unknown as typeof fetch;
  }

  it('fetches bytes + content-type', async () => {
    const fetchAsset = createAssetFetcher({
      fetchImpl: fakeFetch({ 'https://x/a.js': { body: 'console.log(1)', contentType: 'text/javascript' } }),
    });
    const got = await fetchAsset('https://x/a.js');
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.bytes)).toBe('console.log(1)');
    expect(got!.contentType).toBe('text/javascript');
  });

  it('returns null on 404 and caches the negative result', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const fetchAsset = createAssetFetcher({ fetchImpl });
    expect(await fetchAsset('https://x/missing')).toBeNull();
    expect(await fetchAsset('https://x/missing')).toBeNull();
    expect(calls).toBe(1);
  });

  it('caches successful results (one network call per url)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('data', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    const fetchAsset = createAssetFetcher({ fetchImpl });
    await fetchAsset('https://x/a');
    await fetchAsset('https://x/a');
    expect(calls).toBe(1);
  });

  it('strips content-type parameters (charset) to the bare mime', async () => {
    const fetchAsset = createAssetFetcher({
      fetchImpl: (async () => new Response('x', { status: 200, headers: { 'content-type': 'text/css; charset=utf-8' } })) as unknown as typeof fetch,
    });
    const got = await fetchAsset('https://x/a.css');
    expect(got!.contentType).toBe('text/css');
  });

  it('falls back to extension-based mime when content-type missing', async () => {
    const fetchAsset = createAssetFetcher({
      // Use a Uint8Array body so Node does not auto-inject "text/plain;charset=UTF-8"
      fetchImpl: (async () => new Response(new Uint8Array([120]), { status: 200 })) as unknown as typeof fetch,
    });
    const got = await fetchAsset('https://x/font.woff2');
    expect(got!.contentType).toBe('font/woff2');
  });

  it('skips assets larger than maxAssetBytes', async () => {
    const big = 'x'.repeat(100);
    const fetchAsset = createAssetFetcher({
      fetchImpl: (async () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
      maxAssetBytes: 10,
    });
    expect(await fetchAsset('https://x/big')).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const fetchAsset = createAssetFetcher({
      fetchImpl: (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
    });
    expect(await fetchAsset('https://x/err')).toBeNull();
  });
});

describe('toDataUri', () => {
  it('encodes bytes as base64 data uri with content type', () => {
    const uri = toDataUri(new TextEncoder().encode('hi'), 'text/plain');
    expect(uri).toBe('data:text/plain;base64,aGk=');
  });
});
