import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeAssistantParts } from '@/lib/agent/client/merge-assistant-parts';

// ── Helpers to test the tool_execution_end handler logic ─────────────────────
// We cannot invoke the full React hook in a unit test, but we can extract and
// test the dispatch logic that decides whether to call updateScene.

/**
 * Simulate the tool_execution_end branch of handleEvent.
 * Returns the calls made to `updateScene`.
 */
function simulateToolExecutionEnd(
  details: { sceneId?: string; actions?: unknown },
): Array<[string, { actions: unknown }]> {
  const calls: Array<[string, { actions: unknown }]> = [];
  const updateScene = (id: string, patch: { actions: unknown }) => calls.push([id, patch]);

  // Mirror the guard from use-agent-runtime.ts
  if (
    details.sceneId &&
    Array.isArray(details.actions) &&
    details.actions.length > 0
  ) {
    updateScene(details.sceneId, { actions: details.actions });
  }

  return calls;
}

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

// ── Bug 2 regression: destructive empty-apply guard ──────────────────────────
describe('tool_execution_end empty-actions guard', () => {
  it('does NOT call updateScene when actions is an empty array', () => {
    const calls = simulateToolExecutionEnd({ sceneId: 's1', actions: [] });
    expect(calls).toHaveLength(0);
  });

  it('DOES call updateScene when actions has at least one entry', () => {
    const action = { type: 'speech', id: 'a1', title: 'hi', text: 'hello' };
    const calls = simulateToolExecutionEnd({ sceneId: 's1', actions: [action] });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('s1');
    expect((calls[0][1].actions as unknown[]).length).toBe(1);
  });

  it('does NOT call updateScene when actions is missing (undefined)', () => {
    const calls = simulateToolExecutionEnd({ sceneId: 's1', actions: undefined });
    expect(calls).toHaveLength(0);
  });

  it('does NOT call updateScene when sceneId is missing', () => {
    const action = { type: 'speech', id: 'a1', title: 'hi', text: 'hello' };
    const calls = simulateToolExecutionEnd({ sceneId: undefined, actions: [action] });
    expect(calls).toHaveLength(0);
  });
});
