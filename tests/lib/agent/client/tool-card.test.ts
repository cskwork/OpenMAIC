import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Move } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ToolCard } from '@/components/edit/AgentPanel/tool-card';
import { EditElementsCard } from '@/components/edit/AgentPanel/edit-elements-tool-ui';

vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: { scenes: unknown[] }) => unknown) => selector({ scenes: [] }),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'edit.editElements.title': '编辑元素',
        'edit.editElements.editing': '编辑中',
        'edit.editElements.notApplied': '未应用',
        'edit.editElements.applied': '已应用',
        'edit.agent.stopped': '已停止',
      })[key] ?? key,
  }),
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

  it('does not render a raw English refusal reason in localized UI', () => {
    const html = renderToStaticMarkup(
      createElement(EditElementsCard, {
        running: false,
        stopped: false,
        failed: true,
        sceneId: 's1',
      }),
    );

    expect(html).toContain('未应用');
    expect(html).not.toMatch(/locked|refuseReason/);
  });
});
