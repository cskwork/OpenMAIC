import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/generation/generation-pipeline', () => ({
  generateSceneActions: vi.fn(async () => [{ type: 'speech', id: 'a1', title: 'hi', text: 'hi' }]),
}));

import { makeRegenerateSceneActionsTool } from '@/lib/agent/tools/regenerate-scene-actions';

describe('regenerate_scene_actions', () => {
  it('returns regenerated actions for the scene in details', async () => {
    const tool = makeRegenerateSceneActionsTool({ aiCall: async () => '' });
    const res = await tool.execute('tc1', {
      sceneId: 's1',
      outline: { id: 's1', title: 'T', type: 'slide' },
      allOutlines: [{ id: 's1', title: 'T', type: 'slide' }],
      content: {},
      stageId: 'stage1',
    } as never);
    expect(res.details).toMatchObject({ sceneId: 's1' });
    expect(Array.isArray((res.details as { actions: unknown[] }).actions)).toBe(true);
  });

  it('includes the action count in the content text', async () => {
    const tool = makeRegenerateSceneActionsTool({ aiCall: async () => '' });
    const res = await tool.execute('tc2', {
      sceneId: 's2',
      outline: { id: 's2', title: 'Quiz', type: 'quiz' },
      allOutlines: [
        { id: 's1', title: 'T', type: 'slide' },
        { id: 's2', title: 'Quiz', type: 'quiz' },
      ],
      content: { questions: [] },
      stageId: 'stage1',
    } as never);
    expect(res.content[0].type).toBe('text');
    expect((res.content[0] as { type: string; text: string }).text).toContain('1');
  });

  it('passes previousSpeeches to the generator', async () => {
    const { generateSceneActions } = await import('@/lib/generation/generation-pipeline');
    const mockGen = vi.mocked(generateSceneActions);
    mockGen.mockClear();

    const tool = makeRegenerateSceneActionsTool({ aiCall: async () => '' });
    await tool.execute('tc3', {
      sceneId: 's1',
      outline: { id: 's1', title: 'T', type: 'slide' },
      allOutlines: [{ id: 's1', title: 'T', type: 'slide' }],
      content: {},
      stageId: 'stage1',
      previousSpeeches: ['hello'],
    } as never);

    expect(mockGen).toHaveBeenCalledOnce();
    // Verify via the last call's options arg (4th positional param)
    const [, , , options] = mockGen.mock.lastCall ?? [];
    expect(options?.ctx?.previousSpeeches).toEqual(['hello']);
  });

  it('tool has expected metadata', () => {
    const tool = makeRegenerateSceneActionsTool({ aiCall: async () => '' });
    expect(tool.name).toBe('regenerate_scene_actions');
    expect(typeof tool.label).toBe('string');
    expect(typeof tool.description).toBe('string');
  });
});
