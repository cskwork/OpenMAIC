import { describe, it, expect } from 'vitest';
import { inlineSceneContent } from '@/lib/export/use-export-classroom';

const fetchImpl = (async (url: string) => {
  if (url === 'https://cdn.tailwindcss.com')
    return new Response('/*tw*/', { status: 200, headers: { 'content-type': 'text/javascript' } });
  return new Response('', { status: 404 });
}) as unknown as typeof fetch;

describe('inlineSceneContent', () => {
  it('inlines external assets in an interactive scene content.html', async () => {
    const content = {
      type: 'interactive',
      html: '<script src="https://cdn.tailwindcss.com"></script>',
      url: 'https://x',
    } as any;
    const { content: out, report } = await inlineSceneContent(content, { fetchImpl });
    expect(out.html).toContain('data:text/javascript;base64,');
    expect(out.html).not.toContain('cdn.tailwindcss.com');
    expect(report.inlined).toContain('https://cdn.tailwindcss.com');
  });

  it('passes through non-interactive scenes untouched (same reference)', async () => {
    const content = { type: 'slide', elements: [] } as any;
    const { content: out, report } = await inlineSceneContent(content, { fetchImpl });
    expect(out).toBe(content);
    expect(report.inlined).toEqual([]);
  });

  it('passes through interactive scenes with no html (url-only) untouched', async () => {
    const content = { type: 'interactive', url: 'https://x' } as any;
    const { content: out } = await inlineSceneContent(content, { fetchImpl });
    expect(out).toBe(content);
  });

  it('preserves other content fields while replacing html', async () => {
    const content = { type: 'interactive', html: '<img src="https://cdn.tailwindcss.com">', widgetType: 'game', url: 'u' } as any;
    const { content: out } = await inlineSceneContent(content, { fetchImpl });
    expect(out.widgetType).toBe('game');
    expect(out.url).toBe('u');
  });
});
