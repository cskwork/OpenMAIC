import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Move } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ToolCard } from '@/components/edit/AgentPanel/tool-card';

vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: { scenes: unknown[] }) => unknown) => selector({ scenes: [] }),
}));

describe('ToolCard', () => {
  it('renders children as visible card body content', () => {
    const html = renderToStaticMarkup(
      createElement(
        ToolCard,
        {
          title: 'Edit slide elements',
          icon: Move,
          status: 'failed',
          statusLabel: 'Not applied',
        },
        createElement('span', null, 'color is not valid on text elements'),
      ),
    );

    expect(html).toContain('color is not valid on text elements');
  });
});
