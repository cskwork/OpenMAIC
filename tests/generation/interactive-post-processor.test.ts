import { describe, it, expect } from 'vitest';
import { postProcessInteractiveHtml } from '@/lib/generation/interactive-post-processor';

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
