import { describe, it, expect } from 'vitest';
import { collectAssetRefs } from '@/lib/export/inline-assets';

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
