export interface AgentSelection {
  mode: 'preset' | 'auto';
  selectedAgentIds: string[];
}

/**
 * Decide the agent mode/selection to apply when a classroom loads.
 *
 * Honors the user's persisted choice when it is still valid for this stage —
 * a preset selection of known non-generated agents, or an auto selection
 * drawn from this stage's generated agents. Otherwise falls back to the
 * stage-derived defaults (the previous unconditional behavior): auto with all
 * generated agents when the stage has them, else the stage's preset agents,
 * else the default trio.
 */
export function restoreAgentSelection(params: {
  persisted: AgentSelection;
  generatedAgentIds: string[];
  stageAgentIds?: string[];
  isPresetAgent: (id: string) => boolean;
}): AgentSelection {
  const { persisted, generatedAgentIds, stageAgentIds, isPresetAgent } = params;

  if (persisted.selectedAgentIds.length > 0) {
    if (persisted.mode === 'auto') {
      const generated = new Set(generatedAgentIds);
      if (persisted.selectedAgentIds.every((id) => generated.has(id))) {
        return persisted;
      }
    } else if (persisted.selectedAgentIds.every(isPresetAgent)) {
      return persisted;
    }
  }

  if (generatedAgentIds.length > 0) {
    return { mode: 'auto', selectedAgentIds: generatedAgentIds };
  }
  const cleanIds = stageAgentIds?.filter(isPresetAgent) ?? [];
  return {
    mode: 'preset',
    selectedAgentIds: cleanIds.length > 0 ? cleanIds : ['default-1', 'default-2', 'default-3'],
  };
}
