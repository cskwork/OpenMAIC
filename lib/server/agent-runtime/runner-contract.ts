import type { AgentTool } from '@earendil-works/pi-agent-core';

/** Pure runner assembly seam: tests can pin the exact registered name set. */
export function assembleRunnerTools(
  ...groups: ReadonlyArray<ReadonlyArray<AgentTool>>
): AgentTool[] {
  return groups.flat();
}

// NOTE: `buildRunnerCoursePrompt` (the DSL-compatibility prompt block) is
// intentionally not ported in this slice — it imports `courseSystemPrompt` /
// `DSL_TOOLS_PROMPT` from `./course-tools`, which belongs to a later slice of
// the agent-tool foundations wave. The runner already calls
// `assembleRunnerTools` and builds its own (capability-conditional) prompt;
// the course prompt block will layer on top once the course toolset lands.
