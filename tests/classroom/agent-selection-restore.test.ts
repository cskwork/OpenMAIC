/**
 * restoreAgentSelection: classroom load must honor the user's persisted
 * agent mode/selection when still valid for the loaded stage, and only fall
 * back to stage-derived defaults when the persisted choice is stale
 * (e.g. ids from another stage) — the previous behavior unconditionally
 * forced auto mode whenever generated agents existed.
 */
import { describe, it, expect } from 'vitest';
import { restoreAgentSelection } from '@/lib/orchestration/registry/agent-selection';

const PRESETS = new Set(['default-1', 'default-2', 'default-3', 'default-4']);
const isPresetAgent = (id: string) => PRESETS.has(id);

describe('restoreAgentSelection', () => {
  it('keeps a persisted preset selection even when the stage has generated agents', () => {
    const persisted = { mode: 'preset' as const, selectedAgentIds: ['default-2', 'default-3'] };
    expect(
      restoreAgentSelection({
        persisted,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual(persisted);
  });

  it("keeps a persisted auto selection that is a subset of this stage's generated agents", () => {
    const persisted = { mode: 'auto' as const, selectedAgentIds: ['gen-b'] };
    expect(
      restoreAgentSelection({
        persisted,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual(persisted);
  });

  it("resets a stale auto selection (ids from another stage) to this stage's generated agents", () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] });
  });

  it('falls back to auto defaults when a persisted preset selection contains unknown ids', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['gen-stale', 'default-2'] },
        generatedAgentIds: ['gen-a'],
        isPresetAgent,
      }),
    ).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a'] });
  });

  it('falls back to stage preset agents when nothing is generated and persisted auto is stale', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        generatedAgentIds: [],
        stageAgentIds: ['default-4', 'gen-stale'],
        isPresetAgent,
      }),
    ).toEqual({ mode: 'preset', selectedAgentIds: ['default-4'] });
  });

  it('falls back to the default preset trio when nothing else is valid', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: [] },
        generatedAgentIds: [],
        isPresetAgent,
      }),
    ).toEqual({ mode: 'preset', selectedAgentIds: ['default-1', 'default-2', 'default-3'] });
  });
});
