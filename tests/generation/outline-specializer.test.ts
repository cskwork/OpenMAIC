import { describe, expect, test, vi } from 'vitest';
import {
  computeIntentHash,
  hasRequiredConfig,
  resetConfigForType,
  deriveQuizConfig,
  derivePblConfig,
  deriveWidgetConfig,
  specializeOutline,
} from '@/lib/generation/outline-specializer';
import type { SceneOutline } from '@/lib/types/generation';
import type { AICallFn } from '@/lib/generation/pipeline-types';

const base: SceneOutline = {
  id: 's1',
  type: 'slide',
  title: 'Photosynthesis',
  description: 'How plants make food',
  keyPoints: ['light', 'CO2', 'glucose'],
  order: 1,
};

const noop: AICallFn = async () => '{}';

describe('computeIntentHash', () => {
  test('is stable for identical intent', () => {
    expect(computeIntentHash(base)).toBe(computeIntentHash({ ...base }));
  });
  test('changes when type changes', () => {
    expect(computeIntentHash(base)).not.toBe(computeIntentHash({ ...base, type: 'interactive' }));
  });
  test('changes when title changes', () => {
    expect(computeIntentHash(base)).not.toBe(computeIntentHash({ ...base, title: 'Respiration' }));
  });
  test('ignores config fields', () => {
    expect(computeIntentHash(base)).toBe(
      computeIntentHash({
        ...base,
        quizConfig: { questionCount: 5, difficulty: 'hard', questionTypes: ['single'] },
      }),
    );
  });
});

describe('hasRequiredConfig', () => {
  test('slide always satisfied', () => {
    expect(hasRequiredConfig(base)).toBe(true);
  });
  test('interactive needs widgetType + widgetOutline', () => {
    expect(hasRequiredConfig({ ...base, type: 'interactive' })).toBe(false);
    expect(
      hasRequiredConfig({
        ...base,
        type: 'interactive',
        widgetType: 'diagram',
        widgetOutline: { concept: 'x' },
      }),
    ).toBe(true);
  });
  test('pbl needs pblConfig', () => {
    expect(hasRequiredConfig({ ...base, type: 'pbl' })).toBe(false);
    expect(
      hasRequiredConfig({
        ...base,
        type: 'pbl',
        pblConfig: { projectTopic: 't', projectDescription: 'd', targetSkills: [] },
      }),
    ).toBe(true);
  });
  test('quiz needs quizConfig', () => {
    expect(hasRequiredConfig({ ...base, type: 'quiz' })).toBe(false);
  });
});

describe('resetConfigForType', () => {
  test('sets type and clears all config keys', () => {
    const patch = resetConfigForType('interactive');
    expect(patch.type).toBe('interactive');
    expect(patch.quizConfig).toBeUndefined();
    expect(patch.widgetType).toBeUndefined();
    expect(patch.widgetOutline).toBeUndefined();
    expect(patch.pblConfig).toBeUndefined();
    expect(patch.interactiveConfig).toBeUndefined();
    expect(patch.specializedFor).toBeUndefined();
    expect('quizConfig' in patch).toBe(true);
  });
});

describe('deriveQuizConfig', () => {
  test('keeps existing config', () => {
    const cfg = {
      questionCount: 5,
      difficulty: 'hard' as const,
      questionTypes: ['multiple' as const],
    };
    expect(deriveQuizConfig({ ...base, type: 'quiz', quizConfig: cfg })).toEqual(cfg);
  });
  test('defaults when absent', () => {
    expect(deriveQuizConfig({ ...base, type: 'quiz' })).toEqual({
      questionCount: 3,
      difficulty: 'medium',
      questionTypes: ['single'],
    });
  });
});

describe('derivePblConfig', () => {
  test('maps common fields when absent', () => {
    expect(derivePblConfig({ ...base, type: 'pbl' })).toEqual({
      projectTopic: 'Photosynthesis',
      projectDescription: 'How plants make food',
      targetSkills: ['light', 'CO2', 'glucose'],
      issueCount: 3,
    });
  });
});

describe('deriveWidgetConfig', () => {
  test('uses LLM-classified widgetType', async () => {
    const aiCall: AICallFn = async () =>
      JSON.stringify({ widgetType: 'simulation', widgetOutline: { concept: 'photosynthesis rates' } });
    const out = await deriveWidgetConfig({ ...base, type: 'interactive' }, aiCall);
    expect(out.widgetType).toBe('simulation');
    expect(out.widgetOutline.concept).toBe('photosynthesis rates');
  });
  test('falls back to diagram on invalid widgetType', async () => {
    const aiCall: AICallFn = async () => JSON.stringify({ widgetType: 'bogus' });
    const out = await deriveWidgetConfig({ ...base, type: 'interactive' }, aiCall);
    expect(out.widgetType).toBe('diagram');
    expect(out.widgetOutline.concept).toBe('Photosynthesis');
  });
  test('falls back to diagram on aiCall throw', async () => {
    const aiCall: AICallFn = async () => {
      throw new Error('llm down');
    };
    const out = await deriveWidgetConfig({ ...base, type: 'interactive' }, aiCall);
    expect(out.widgetType).toBe('diagram');
  });
  test('keeps existing widget config without calling LLM', async () => {
    const aiCall = vi.fn(async () => '{}') as unknown as AICallFn;
    const out = await deriveWidgetConfig(
      { ...base, type: 'interactive', widgetType: 'code', widgetOutline: { concept: 'kept' } },
      aiCall,
    );
    expect(out.widgetType).toBe('code');
    expect(aiCall).not.toHaveBeenCalled();
  });
});

describe('specializeOutline', () => {
  test('cache hit: matching specializedFor + config present → unchanged, no derive', async () => {
    const interactive: SceneOutline = {
      ...base,
      type: 'interactive',
      widgetType: 'code',
      widgetOutline: { concept: 'kept' },
    };
    const tagged = { ...interactive, specializedFor: computeIntentHash(interactive) };
    const deriveWidget = vi.fn();
    const out = await specializeOutline(tagged, {
      aiCall: noop,
      hasLanguageModel: true,
      deriveWidget: deriveWidget as never,
    });
    expect(out).toBe(tagged);
    expect(deriveWidget).not.toHaveBeenCalled();
  });

  test('slide is a no-op that just tags', async () => {
    const out = await specializeOutline(base, { aiCall: noop, hasLanguageModel: true });
    expect(out.type).toBe('slide');
    expect(out.specializedFor).toBe(computeIntentHash(base));
  });

  test('slide→interactive derives widget config and tags', async () => {
    const changed: SceneOutline = { ...base, type: 'interactive' };
    const deriveWidget = vi.fn(async () => ({
      widgetType: 'diagram' as const,
      widgetOutline: { concept: 'x' },
    }));
    const out = await specializeOutline(changed, {
      aiCall: noop,
      hasLanguageModel: true,
      deriveWidget: deriveWidget as never,
    });
    expect(out.type).toBe('interactive');
    expect(out.widgetType).toBe('diagram');
    expect(out.widgetOutline).toEqual({ concept: 'x' });
    expect(out.specializedFor).toBe(computeIntentHash(changed));
    expect(deriveWidget).toHaveBeenCalledOnce();
  });

  test('quiz derives default quizConfig', async () => {
    const out = await specializeOutline({ ...base, type: 'quiz' }, { aiCall: noop, hasLanguageModel: true });
    expect(out.quizConfig).toEqual({ questionCount: 3, difficulty: 'medium', questionTypes: ['single'] });
  });

  test('pbl with language model derives pblConfig', async () => {
    const out = await specializeOutline({ ...base, type: 'pbl' }, { aiCall: noop, hasLanguageModel: true });
    expect(out.type).toBe('pbl');
    expect(out.pblConfig?.projectTopic).toBe('Photosynthesis');
  });

  test('pbl without language model degrades to slide (logged), not pbl', async () => {
    const out = await specializeOutline({ ...base, type: 'pbl' }, { aiCall: noop, hasLanguageModel: false });
    expect(out.type).toBe('slide');
  });

  test('stale tag forces re-derive even if some config present', async () => {
    const changed: SceneOutline = { ...base, type: 'interactive', specializedFor: 'stale' };
    const deriveWidget = vi.fn(async () => ({
      widgetType: 'game' as const,
      widgetOutline: { concept: 'y' },
    }));
    const out = await specializeOutline(changed, {
      aiCall: noop,
      hasLanguageModel: true,
      deriveWidget: deriveWidget as never,
    });
    expect(deriveWidget).toHaveBeenCalledOnce();
    expect(out.widgetType).toBe('game');
  });
});

describe('specializeOutline — procedural-skill gating (upstream)', () => {
  test('procedural-skill widget without allowProceduralSkill → sanitized to diagram', async () => {
    const ps: SceneOutline = {
      ...base,
      type: 'interactive',
      widgetType: 'procedural-skill',
      widgetOutline: { concept: 'fix the engine', steps: ['open', 'inspect'] },
    };
    const out = await specializeOutline(ps, {
      aiCall: noop,
      hasLanguageModel: true,
      allowProceduralSkill: false,
    });
    expect(out.type).toBe('interactive');
    expect(out.widgetType).toBe('diagram');
    expect(out.specializedFor).toBeTruthy();
  });

  test('procedural-skill widget WITH allowProceduralSkill is kept (cache miss still derives nothing new)', async () => {
    const ps: SceneOutline = {
      ...base,
      type: 'interactive',
      widgetType: 'procedural-skill',
      widgetOutline: { concept: 'fix the engine' },
    };
    const out = await specializeOutline(ps, {
      aiCall: noop,
      hasLanguageModel: true,
      allowProceduralSkill: true,
    });
    expect(out.widgetType).toBe('procedural-skill');
  });
});

describe('brief as Layer-1 (restructure)', () => {
  test('brief change invalidates the intent hash', () => {
    expect(computeIntentHash(base)).not.toBe(computeIntentHash({ ...base, brief: 'a rich brief' }));
  });
  test('derivePblConfig prefers brief for projectDescription', () => {
    const out = derivePblConfig({ ...base, type: 'pbl', brief: 'Build a greenhouse model.' });
    expect(out.projectDescription).toBe('Build a greenhouse model.');
  });
  test('derivePblConfig falls back to description when no brief', () => {
    expect(derivePblConfig({ ...base, type: 'pbl' }).projectDescription).toBe('How plants make food');
  });
});
