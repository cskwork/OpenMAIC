import { describe, it, expect } from 'vitest';
import { mergeAssistantParts } from '@/lib/agent/client/merge-assistant-parts';

describe('mergeAssistantParts', () => {
  it('keeps a tool card from an earlier turn when a later turn is empty', () => {
    const parts = mergeAssistantParts({
      text: '', error: '', toolOrder: ['t1'],
      toolCalls: new Map([['t1', { name: 'regenerate_scene_actions', args: {} }]]),
      toolResults: new Map([['t1', { result: { details: { sceneId: 's', actions: [] } }, isError: false }]]),
    });
    expect(parts.some((p) => p.type === 'tool-call' && p.toolName === 'regenerate_scene_actions')).toBe(true);
  });

  it('surfaces error as text when there is no assistant text', () => {
    expect(mergeAssistantParts({ text: '', error: 'boom', toolOrder: [], toolCalls: new Map(), toolResults: new Map() }))
      .toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('latest non-empty text wins over error', () => {
    expect(mergeAssistantParts({ text: 'done', error: 'boom', toolOrder: [], toolCalls: new Map(), toolResults: new Map() }))
      .toEqual([{ type: 'text', text: 'done' }]);
  });
});
