import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/generation/generation-pipeline', () => ({
  generateSceneActions: vi.fn(async () => [{ type: 'speech', id: 'a1', title: 'hi', text: 'hi' }]),
}));

import { makeRegenerateSceneActionsTool, type SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';
import type { SlideContent } from '@/lib/types/stage';

/** Minimal SceneOutline stub */
const stubOutline = (id: string, title: string, order = 1) => ({
  id,
  type: 'slide' as const,
  title,
  description: '',
  keyPoints: [],
  order,
});

/** Minimal SlideContent stub */
const stubContent: SlideContent = { type: 'slide', canvas: {} as never };

/** Build a deps object with a single scene context entry */
function makeDeps(sceneId: string, extra?: Partial<SceneContext>) {
  const ctx: SceneContext = {
    outline: stubOutline(sceneId, 'T'),
    allOutlines: [stubOutline(sceneId, 'T')],
    content: stubContent,
    stageId: 'stage1',
    ...extra,
  };
  return {
    aiCall: async () => '',
    getSceneContext: (id: string) => (id === sceneId ? ctx : undefined),
  };
}

describe('regenerate_scene_actions', () => {
  it('returns regenerated actions for the scene in details', async () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    const res = await tool.execute('tc1', { sceneId: 's1' });
    expect(res.details).toMatchObject({ sceneId: 's1' });
    expect(Array.isArray((res.details as { actions: unknown[] }).actions)).toBe(true);
  });

  it('includes the action count in the content text', async () => {
    const multiCtx: SceneContext = {
      outline: stubOutline('s2', 'Quiz', 2),
      allOutlines: [stubOutline('s1', 'T', 1), stubOutline('s2', 'Quiz', 2)],
      content: { type: 'quiz', questions: [] },
      stageId: 'stage1',
    };
    const deps = {
      aiCall: async () => '',
      getSceneContext: (id: string) => (id === 's2' ? multiCtx : undefined),
    };
    const tool = makeRegenerateSceneActionsTool(deps);
    const res = await tool.execute('tc2', { sceneId: 's2' });
    expect(res.content[0].type).toBe('text');
    expect((res.content[0] as { type: string; text: string }).text).toContain('1');
  });

  it('passes previousSpeeches to the generator', async () => {
    const { generateSceneActions } = await import('@/lib/generation/generation-pipeline');
    const mockGen = vi.mocked(generateSceneActions);
    mockGen.mockClear();

    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    await tool.execute('tc3', { sceneId: 's1', previousSpeeches: ['hello'] });

    expect(mockGen).toHaveBeenCalledOnce();
    // Verify via the last call's options arg (4th positional param)
    const [, , , options] = mockGen.mock.lastCall ?? [];
    expect(options?.ctx?.previousSpeeches).toEqual(['hello']);
  });

  it('returns an error result when sceneId is not in the context map', async () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    const res = await tool.execute('tc4', { sceneId: 'unknown' });
    // Should return isError and empty actions, not throw
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.details as { actions: unknown[] }).actions).toHaveLength(0);
  });

  it('tool has expected metadata', () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    expect(tool.name).toBe('regenerate_scene_actions');
    expect(typeof tool.label).toBe('string');
    expect(typeof tool.description).toBe('string');
  });
});
