import { describe, expect, it } from 'vitest';
import { hasEditElementsIntents } from '@/lib/agent/client/apply-edit-elements';
import type { EditIntent } from '@openmaic/renderer/editing';

describe('apply-edit-elements helpers', () => {
  it('detects applyable intents', () => {
    const intents: EditIntent[] = [{ type: 'element.update', id: 'a', props: { top: 10 } }];
    expect(hasEditElementsIntents({ sceneId: 's1', intents })).toBe(true);
    expect(hasEditElementsIntents({ sceneId: 's1', intents: null })).toBe(false);
    expect(hasEditElementsIntents({ sceneId: 's1', intents: [] })).toBe(false);
    expect(hasEditElementsIntents({ intents })).toBe(false);
  });
});
