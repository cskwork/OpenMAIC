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
import { isEmptyLegacyPBLConfig, upgradeLegacyPBLConfigToProjectV2 } from '@/lib/pbl/legacy/read';
import { isPBLProjectV2 } from '@/lib/pbl/v2/types';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

function legacyConfig() {
  const content = structuredClone(legacyPBLSceneFixture.content);
  if (content.type !== 'pbl' || !content.projectConfig) {
    throw new Error('expected legacy PBL projectConfig');
  }
  return content.projectConfig;
}

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
      language: 'en-US',
      milestones: [{ status: 'completed' }, { status: 'active' }],
    });
    expect(project.roles[0]).toMatchObject({ type: 'instructor', name: 'Question Agent' });
    expect(project.milestones[1].microtasks[0].status).toBe('in_progress');
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

  it('detects Chinese content when upgrading a legacy project', () => {
    const config = legacyConfig();
    config.projectInfo.title = '天气数据项目';
    config.projectInfo.description = '分析天气数据并完成展示。';
    config.issueboard.issues[0].title = '读取数据';

    const project = upgradeLegacyPBLConfigToProjectV2(config);

    expect(project.language).toBe('zh-CN');
  });

  it('uses current_issue_id when legacy is_active is missing', () => {
    const config = legacyConfig();
    config.issueboard.issues.forEach((issue) => {
      issue.is_done = false;
      issue.is_active = false;
    });
    config.issueboard.current_issue_id = 'issue-2';

    const project = upgradeLegacyPBLConfigToProjectV2(config);

    expect(project.milestones.map((milestone) => milestone.status)).toEqual(['locked', 'active']);
  });

  it('keeps structurally sound legacy configs with sloppy leaves renderable', () => {
    const config = legacyConfig();
    const issue = config.issueboard.issues[0];
    const message = config.chat.messages[0];
    Reflect.deleteProperty(issue, 'notes');
    Reflect.deleteProperty(issue, 'generated_questions');
    Reflect.deleteProperty(issue, 'question_agent_name');
    Reflect.deleteProperty(message, 'timestamp');

    expect(isEmptyLegacyPBLConfig(config)).toBe(false);

    const project = upgradeLegacyPBLConfigToProjectV2(config);
    expect(isPBLProjectV2(project)).toBe(true);
    expect(project.title).toBe('Community Garden Data Project');
    expect(project.milestones[0]).toMatchObject({
      id: 'legacy_ms_issue-1',
      title: 'Inspect the measurements',
    });
    expect(project.threads[0]?.messages[0]?.ts).toEqual(expect.any(String));
  });

  it('drops malformed legacy chat records without classifying the config as empty', () => {
    const config = legacyConfig();
    const validMessage = config.chat.messages[0];
    const missingMessage = structuredClone(config.chat.messages[1]);
    const nonStringMessage = structuredClone(config.chat.messages[1]);
    Reflect.deleteProperty(missingMessage, 'message');
    Reflect.set(nonStringMessage, 'message', 42);
    config.chat.messages = [validMessage, missingMessage, nonStringMessage];

    expect(isEmptyLegacyPBLConfig(config)).toBe(false);

    const project = upgradeLegacyPBLConfigToProjectV2(config);
    expect(project.threads[0]?.messages).toHaveLength(1);
    expect(project.threads[0]?.messages[0]?.content).toBe(validMessage.message);
  });

  it('falls back to a valid ISO timestamp for an unparseable legacy timestamp', () => {
    const config = legacyConfig();
    Reflect.set(config.chat.messages[0], 'timestamp', 'not-a-date');

    const project = upgradeLegacyPBLConfigToProjectV2(config);
    const timestamp = project.threads[0]?.messages[0]?.ts;

    expect(() => new Date(timestamp ?? '').toISOString()).not.toThrow();
    expect(timestamp).toBe(new Date(timestamp ?? '').toISOString());
  });

  it('renders emptyProject for a new empty PBL scene', () => {
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content: { type: 'pbl' },
        mode: 'playback',
        sceneId: 'new-pbl-scene',
      }),
    );

    expect(markup).toContain('pbl.emptyProject');
  });

  it('renders a placeholder for an unusable legacy projectConfig without throwing', () => {
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content: { type: 'pbl', projectConfig: {} } as never,
        mode: 'playback',
        sceneId: 'garbage-legacy-pbl-scene',
      }),
    );

    expect(markup).toContain('pbl.emptyProject');
  });
});
