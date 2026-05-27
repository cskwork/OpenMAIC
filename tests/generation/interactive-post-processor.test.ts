import { describe, it, expect } from 'vitest';
import {
  postProcessInteractiveHtml,
  rewriteVendoredCdnUrls,
} from '@/lib/generation/interactive-post-processor';

describe('postProcessInteractiveHtml', () => {
  describe('KaTeX injection', () => {
    it('injects KaTeX assets from local /vendor/katex/ when KaTeX is not yet present', () => {
      const html = '<html><head></head><body>$x^2$</body></html>';
      const out = postProcessInteractiveHtml(html);

      expect(out).toContain('href="/vendor/katex/katex.min.css"');
      expect(out).toContain('src="/vendor/katex/katex.min.js"');
      expect(out).toContain('src="/vendor/katex/contrib/auto-render.min.js"');
    });

    it('does not emit any cdn.jsdelivr.net or unpkg.com URLs', () => {
      const html = '<html><head></head><body>$x^2$</body></html>';
      const out = postProcessInteractiveHtml(html);

      expect(out).not.toContain('cdn.jsdelivr.net');
      expect(out).not.toContain('unpkg.com');
    });

    it('does not double-inject when KaTeX is already present', () => {
      const html =
        '<html><head><link rel="stylesheet" href="/vendor/katex/katex.min.css"></head><body></body></html>';
      const out = postProcessInteractiveHtml(html);

      const cssMatches = out.match(/katex\.min\.css/g) ?? [];
      expect(cssMatches.length).toBe(1);
    });
  });

  describe('LaTeX delimiter conversion (regression)', () => {
    it('converts $$...$$ to \\[...\\]', () => {
      const html = '<html><head></head><body>$$x^2$$</body></html>';
      const out = postProcessInteractiveHtml(html);
      expect(out).toContain('\\[x^2\\]');
    });

    it('converts $...$ to \\(...\\)', () => {
      const html = '<html><head></head><body>foo $x^2$ bar</body></html>';
      const out = postProcessInteractiveHtml(html);
      expect(out).toContain('\\(x^2\\)');
    });

    it('does not touch $ inside <script> blocks', () => {
      const html = '<html><head></head><body><script>const x = "$10";</script></body></html>';
      const out = postProcessInteractiveHtml(html);
      expect(out).toContain('const x = "$10";');
    });
  });
});

describe('rewriteVendoredCdnUrls', () => {
  it('rewrites unpkg three.module.js → /vendor/three/build/three.module.js', () => {
    const html = '<script type="module" src="https://unpkg.com/three@0.160.0/build/three.module.js"></script>';
    expect(rewriteVendoredCdnUrls(html)).toBe(
      '<script type="module" src="/vendor/three/build/three.module.js"></script>',
    );
  });

  it('rewrites jsdelivr three.module.js → /vendor/three/build/three.module.js', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"></script>';
    expect(rewriteVendoredCdnUrls(html)).toBe(
      '<script src="/vendor/three/build/three.module.js"></script>',
    );
  });

  it('rewrites unpkg three addons prefix → /vendor/three/examples/jsm/', () => {
    const html = '"three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"';
    expect(rewriteVendoredCdnUrls(html)).toBe('"three/addons/": "/vendor/three/examples/jsm/"');
  });

  it('preserves path suffix on three addons rewrite (e.g. controls/OrbitControls.js)', () => {
    const html =
      '<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js"></script>';
    expect(rewriteVendoredCdnUrls(html)).toBe(
      '<script src="/vendor/three/examples/jsm/controls/OrbitControls.js"></script>',
    );
  });

  it('rewrites jsdelivr katex CSS → /vendor/katex/katex.min.css', () => {
    const html = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">';
    expect(rewriteVendoredCdnUrls(html)).toBe(
      '<link rel="stylesheet" href="/vendor/katex/katex.min.css">',
    );
  });

  it('rewrites jsdelivr katex auto-render under dist/contrib/', () => {
    const html =
      '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>';
    expect(rewriteVendoredCdnUrls(html)).toBe(
      '<script src="/vendor/katex/contrib/auto-render.min.js"></script>',
    );
  });

  it('rewrites unpkg katex URLs the same way', () => {
    const html = '<link href="https://unpkg.com/katex@0.16.9/dist/katex.min.css">';
    expect(rewriteVendoredCdnUrls(html)).toBe('<link href="/vendor/katex/katex.min.css">');
  });

  it('handles version-agnostic refs (latest, semver range, missing @<version>)', () => {
    // @latest
    expect(rewriteVendoredCdnUrls('"https://unpkg.com/three@latest/build/three.module.js"')).toBe(
      '"/vendor/three/build/three.module.js"',
    );
    // pinned different version
    expect(rewriteVendoredCdnUrls('"https://unpkg.com/three@0.159.0/build/three.module.js"')).toBe(
      '"/vendor/three/build/three.module.js"',
    );
    // missing version (unpkg allows this)
    expect(rewriteVendoredCdnUrls('"https://unpkg.com/three/build/three.module.js"')).toBe(
      '"/vendor/three/build/three.module.js"',
    );
  });

  it('does NOT touch unrelated unpkg/jsdelivr URLs', () => {
    const html =
      '<script src="https://unpkg.com/some-other-lib@1.0/main.js"></script>' +
      '<link href="https://cdn.jsdelivr.net/npm/tailwindcss@4/dist/tailwind.css">';
    expect(rewriteVendoredCdnUrls(html)).toBe(html);
  });

  it('does NOT touch three.module.min.js or other build artifacts we did not vendor', () => {
    // We only vendor three.module.js (the ESM build). Other artifacts are out of scope.
    const html = '<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>';
    expect(rewriteVendoredCdnUrls(html)).toBe(html);
  });
});

describe('postProcessInteractiveHtml — integration with rewriter', () => {
  it('rewrites LLM-written CDN three URLs (importmap case)', () => {
    const html = [
      '<!doctype html><html><head>',
      '<script type="importmap">{"imports":{',
      '"three":"https://unpkg.com/three@0.160.0/build/three.module.js",',
      '"three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"',
      '}}</script>',
      '</head><body></body></html>',
    ].join('');
    const out = postProcessInteractiveHtml(html);
    expect(out).toContain('"three":"/vendor/three/build/three.module.js"');
    expect(out).toContain('"three/addons/":"/vendor/three/examples/jsm/"');
    expect(out).not.toContain('unpkg.com');
  });

  it('rewrites LLM-written CDN katex URLs and does not double-inject KaTeX', () => {
    const html =
      '<html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"></head><body>$x$</body></html>';
    const out = postProcessInteractiveHtml(html);
    // Rewrite happened
    expect(out).toContain('/vendor/katex/katex.min.css');
    // No CDN URL leaks
    expect(out).not.toContain('cdn.jsdelivr.net');
    // No duplicate katex.min.css (rewriter rewrote LLM's link; injector saw 'katex' substring in result and skipped its own injection)
    expect(out.match(/katex\.min\.css/g)?.length).toBe(1);
  });
});
