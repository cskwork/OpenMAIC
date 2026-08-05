import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

vi.mock('@/components/scene-renderers/pbl/v2/workspace', async () => {
  const { createElement } = await import('react');
  return {
    PBLV2Workspace: ({ project }: { project: { title: string } }) =>
      createElement('div', { 'data-testid': 'pbl-v2-workspace' }, project.title),
  };
});

vi.mock('@/components/scene-renderers/pbl/v2/hero', async () => {
  const { createElement } = await import('react');
  return {
    PBLV2Hero: ({ project }: { project: { title: string } }) =>
      createElement('div', { 'data-testid': 'pbl-v2-hero' }, project.title),
  };
});

import { PBLRenderer } from '@/components/scene-renderers/pbl-renderer';
import { validateAppScene } from '@/lib/document-store/validators';
import { upgradeLegacyPBLConfigToProjectV2 } from '@/lib/pbl/legacy/read';
import { isPBLProjectV2 } from '@/lib/pbl/v2/types';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

describe('PBL legacy read support', () => {
  it('round-trips a v1-native stored scene and upgrades it to a renderable v2 project', () => {
    const roundTripped = JSON.parse(JSON.stringify(legacyPBLSceneFixture));
    expect(validateAppScene(roundTripped)).toEqual({ valid: true });
    if (roundTripped.content.type !== 'pbl' || !roundTripped.content.projectConfig) {
      throw new Error('expected a legacy PBL projectConfig');
    }

    const project = upgradeLegacyPBLConfigToProjectV2(roundTripped.content.projectConfig);
    expect(isPBLProjectV2(project)).toBe(true);
    expect(project).toMatchObject({
      uiPhase: 'workspace',
      title: 'Community Garden Data Project',
      milestones: [{ status: 'completed' }, { status: 'active' }],
    });
    expect(project.threads[0]?.messages.map((message) => message.roleType)).toEqual([
      'instructor',
      'user',
    ]);
  });

  it('routes a v1-native stored scene through the v2 renderer', () => {
    const content = structuredClone(legacyPBLSceneFixture.content);
    if (content.type !== 'pbl') throw new Error('expected PBL fixture content');
    if (!content.projectConfig) throw new Error('expected legacy PBL projectConfig');
    content.projectConfig.selectedRole = null;
    content.projectConfig.chat.messages = [];
    content.projectConfig.issueboard.current_issue_id = 'issue-1';
    content.projectConfig.issueboard.issues.forEach((issue, index) => {
      issue.is_done = false;
      issue.is_active = index === 0;
    });
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content,
        mode: 'playback',
        sceneId: legacyPBLSceneFixture.id,
      }),
    );

    expect(markup).toContain('data-testid="pbl-v2-hero"');
    expect(markup).toContain('Community Garden Data Project');
  });
});
