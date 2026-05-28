import { describe, it, expect } from 'vitest';
import { inlineSceneContent } from '@/lib/export/use-export-classroom';

const fetchImpl = (async (_url: string) => {
  if (_url === 'https://cdn.tailwindcss.com')
    return new Response('/*tw*/', { status: 200, headers: { 'content-type': 'text/javascript' } });
  return new Response('', { status: 404 });
}) as unknown as typeof fetch;

type AnyContent = Record<string, unknown>;

describe('inlineSceneContent', () => {
  it('inlines external assets in an interactive scene content.html', async () => {
    const content: AnyContent = {
      type: 'interactive',
      html: '<script src="https://cdn.tailwindcss.com"></script>',
      url: 'https://x',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { content: out, report } = await inlineSceneContent(content as any, { fetchImpl });
    expect((out as AnyContent).html).toContain('data:text/javascript;base64,');
    expect((out as AnyContent).html).not.toContain('cdn.tailwindcss.com');
    expect(report.inlined).toContain('https://cdn.tailwindcss.com');
  });

  it('passes through non-interactive scenes untouched (same reference)', async () => {
    const content: AnyContent = { type: 'slide', elements: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { content: out, report } = await inlineSceneContent(content as any, { fetchImpl });
    expect(out).toBe(content);
    expect(report.inlined).toEqual([]);
  });

  it('passes through interactive scenes with no html (url-only) untouched', async () => {
    const content: AnyContent = { type: 'interactive', url: 'https://x' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { content: out } = await inlineSceneContent(content as any, { fetchImpl });
    expect(out).toBe(content);
  });

  it('preserves other content fields while replacing html', async () => {
    const content: AnyContent = {
      type: 'interactive',
      html: '<img src="https://cdn.tailwindcss.com">',
      widgetType: 'game',
      url: 'u',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { content: out } = await inlineSceneContent(content as any, { fetchImpl });
    expect((out as AnyContent).widgetType).toBe('game');
    expect((out as AnyContent).url).toBe('u');
  });
});
