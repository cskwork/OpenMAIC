import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditIntent } from '@openmaic/renderer/editing';
import type { PPTElement } from '@openmaic/dsl';
import type { SlideContent } from '@/lib/types/stage';

const commitContent = vi.fn();
const updateScene = vi.fn();

vi.mock('@/components/edit/surfaces/slide/slide-edit-session', () => ({
  useSlideEditSession: {
    getState: () => ({
      sceneId: mockSession.sceneId,
      history: mockSession.history,
      commitContent,
    }),
  },
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: {
    getState: () => ({
      getSceneById: (id: string) => mockScenes[id] ?? null,
      updateScene,
    }),
  },
}));

const mockSession: {
  sceneId: string | null;
  history: { present: SlideContent } | null;
} = { sceneId: null, history: null };

const mockScenes: Record<string, { content: SlideContent }> = {};

function slideWith(elements: PPTElement[]): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'c1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements,
    },
  } as SlideContent;
}

function textEl(id: string, overrides: Partial<PPTElement> = {}): PPTElement {
  return {
    id,
    type: 'text',
    left: 100,
    top: 80,
    width: 400,
    height: 60,
    rotate: 0,
    content: '<p>Title</p>',
    defaultColor: '#333',
    defaultFontName: 'Arial',
    ...overrides,
  } as PPTElement;
}

describe('applyEditElementsIntents', () => {
  beforeEach(() => {
    commitContent.mockReset();
    updateScene.mockReset();
    mockSession.sceneId = null;
    mockSession.history = null;
    for (const k of Object.keys(mockScenes)) delete mockScenes[k];
  });

  it('detects applyable intents', async () => {
    const { hasEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const intents: EditIntent[] = [{ type: 'element.update', id: 'a', props: { top: 10 } }];
    expect(hasEditElementsIntents({ sceneId: 's1', intents })).toBe(true);
    expect(hasEditElementsIntents({ sceneId: 's1', intents: null })).toBe(false);
    expect(hasEditElementsIntents({ sceneId: 's1', intents: [] })).toBe(false);
    expect(hasEditElementsIntents({ intents })).toBe(false);
  });

  it('refuses atomically when an id is missing at apply time (no partial)', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const present = slideWith([textEl('a')]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents('s1', [
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { top: 10 } },
          { id: 'gone', props: { top: 10 } },
        ],
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/gone|unknown|missing/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('refuses when a target is locked at apply time', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const present = slideWith([textEl('a', { lock: true })]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'a', props: { top: 10 } },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/locked/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('commits one undo entry when session is open and targets are valid', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const present = slideWith([textEl('a')]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'a', props: { top: 10, defaultColor: '#00f' } },
    ]);

    expect(result).toEqual({ ok: true });
    expect(commitContent).toHaveBeenCalledTimes(1);
    const next = commitContent.mock.calls[0][0] as SlideContent;
    expect(commitContent.mock.calls[0][1]).toBe(true);
    expect(next.canvas.elements[0]).toMatchObject({ top: 10, defaultColor: '#00f' });
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('refuses when no edit session is open (no irreversible fallback write)', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    mockScenes.s1 = { content: slideWith([textEl('a')]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'a', props: { top: 10 } },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/session/i);
    expect(updateScene).not.toHaveBeenCalled();
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('maps shape text chrome onto shape.text instead of top-level', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const shape = {
      id: 'sh1',
      type: 'shape',
      left: 10,
      top: 10,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [0, 0],
      path: 'M0,0',
      fixedRatio: false,
      fill: '#eee',
      text: {
        content: 'Label',
        defaultFontName: 'Arial',
        defaultColor: '#111',
        align: 'middle',
      },
    } as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([shape]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'sh1', props: { defaultColor: '#00f' } },
    ]);

    expect(result).toEqual({ ok: true });
    const next = commitContent.mock.calls[0][0] as SlideContent;
    const el = next.canvas.elements[0] as {
      defaultColor?: string;
      text?: { defaultColor?: string };
    };
    expect(el.defaultColor).toBeUndefined();
    expect(el.text?.defaultColor).toBe('#00f');
  });
});
