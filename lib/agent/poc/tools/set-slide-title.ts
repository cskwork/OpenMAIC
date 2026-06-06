/**
 * MAIC Agent PoC — trivial scene-mutating domain tool.
 *
 * Proves the full loop: model emits a tool call -> pi loop executes this ->
 * result (with the intended op in `details`) streams to the client -> client
 * applies it to the Dexie stage store -> canvas title changes.
 *
 * Server-side `execute` has no access to the client store, so it returns the
 * intended op as `details`; the client reads it from `tool_execution_end`.
 */
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export const SetSlideTitleParams = Type.Object({
  sceneId: Type.String({ description: 'The id of the slide scene to retitle.' }),
  title: Type.String({ description: 'The new title text for the slide.' }),
});

export type SetSlideTitleOp = Static<typeof SetSlideTitleParams>;

export const setSlideTitleTool: AgentTool<typeof SetSlideTitleParams, SetSlideTitleOp> = {
  name: 'set_slide_title',
  label: 'Set slide title',
  description:
    'Set the title of a slide scene in the current MAIC deck. Use this when the user asks to rename, retitle, or change the title of the current slide.',
  parameters: SetSlideTitleParams,
  execute: async (_toolCallId, params) => {
    return {
      content: [{ type: 'text', text: `Set the slide title to "${params.title}".` }],
      details: { sceneId: params.sceneId, title: params.title },
    };
  },
};
