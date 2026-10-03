import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { supportedLocales } from '@/lib/i18n/locales';
import { createWorkbenchTranslator, workbenchEn } from '@/lib/i18n/workbench';
import { skillDescription } from '@/lib/workbench/agent-skills';
import { resolveTTSProviderName, resolveTTSVoiceName } from '@/lib/audio/provider-display';

function flatten(value: unknown, prefix = '', into = new Map<string, unknown>()) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, into);
    }
  } else {
    into.set(prefix, value);
  }
  return into;
}
const read = (directory: string, code: string) =>
  flatten(JSON.parse(fs.readFileSync(path.join(directory, `${code}.json`), 'utf8')));
const mainDirectory = path.join(process.cwd(), 'lib/i18n/locales');
const overlayDirectory = path.join(process.cwd(), 'lib/i18n/workbench-locales');
const english = read(mainDirectory, 'en-US');
const placeholders = (value: unknown) =>
  typeof value === 'string' ? (value.match(/\{\{[^}]+\}\}/g) || []).sort() : [];

// Raw resources are checked before fallback merging: a missing overlay value
// otherwise looks complete while silently showing English or Simplified Chinese.
describe('multilingual UI resource contract', () => {
  it.each(supportedLocales.map(({ code }) => code))(
    '%s translates built-in skill summaries',
    (code) => {
      const t = createWorkbenchTranslator(code);
      for (const name of Object.keys(workbenchEn.skill.title)) {
        const skill = { name, description: 'raw model instructions', source: 'builtin' as const };
        const result = skillDescription(skill, t);
        expect(result, `${code}.${name}`).not.toBe(skill.description);
        expect(result, `${code}.${name}`).not.toMatch(/^workbench\./);
        expect(result.trim(), `${code}.${name}`).not.toBe('');
        expect(skill.description).toBe('raw model instructions');
      }
    },
  );

  it('preserves user-authored descriptions and unknown built-in skills', () => {
    const t = createWorkbenchTranslator('ko-KR');
    expect(
      skillDescription(
        { name: 'stage-design', description: 'My own instructions', source: 'user' },
        t,
      ),
    ).toBe('My own instructions');
    expect(
      skillDescription(
        { name: 'unknown-future-skill', description: 'New skill instructions', source: 'builtin' },
        t,
      ),
    ).toBe('New skill instructions');
  });

  it.each(supportedLocales.map(({ code }) => code))(
    '%s preserves keys and placeholders',
    (code) => {
      const target = read(mainDirectory, code);
      expect([...target.keys()].sort()).toEqual([...english.keys()].sort());
      for (const [key, source] of english) {
        expect(placeholders(target.get(key)), `${code}.${key}`).toEqual(placeholders(source));
        expect(typeof target.get(key), `${code}.${key} changed its value type`).toBe(typeof source);
      }
    },
  );

  it.each(
    supportedLocales
      .filter(({ code }) => !['en-US', 'zh-CN'].includes(code))
      .map(({ code }) => code),
  )('%s explicitly translates the whole Pro overlay', (code) => {
    const source = flatten(workbenchEn);
    const overlay = read(overlayDirectory, code);
    expect([...overlay.keys()].sort()).toEqual([...source.keys()].sort());
    for (const [key, value] of source) {
      expect(placeholders(overlay.get(key)), `${code}.${key}`).toEqual(placeholders(value));
      expect(typeof overlay.get(key), `${code}.${key}`).toBe('string');
      expect(String(overlay.get(key)).trim(), `${code}.${key}`).not.toBe('');
    }
  });

  it('Korean workspace and skill controls no longer copy English or Chinese', () => {
    const korean = read(mainDirectory, 'ko-KR');
    for (const key of [
      'workspace.untitledCourse',
      'proMode.loadSkill',
      'proMode.skillMenuTitle',
      'pbl.v2.hero.startProject',
    ]) {
      expect(korean.get(key), key).not.toBe(english.get(key));
      expect(korean.get(key), key).toMatch(/[가-힣]/);
      expect(korean.get(key), key).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it.each(['en-US', 'ko-KR'])(
    '%s displays local speech labels without changing voice identity',
    (code) => {
      const resource = read(mainDirectory, code);
      const t = (key: string) => String(resource.get(key) ?? key);
      expect(resolveTTSProviderName('local-qwen-tts', t)).toBe(
        resource.get('settings.providerLocalQwenTTS'),
      );
      expect(
        resolveTTSVoiceName(
          'local-qwen-tts',
          { id: 'announcer-female-calm-ko', name: 'Original Korean announcer' },
          t,
        ),
      ).toBe(resource.get('settings.localQwenVoice'));
      expect(resolveTTSVoiceName('openai-tts', { id: 'alloy', name: 'Alloy' }, t)).toBe('Alloy');
    },
  );
});
