/**
 * `edit_elements` agent tool
 *
 * Natural-language per-element edits for SLIDE scenes. The model (agent turn)
 * supplies `sceneId` + `instruction`; this tool:
 *   1. builds a trusted element inventory from client-injected SceneContext,
 *   2. asks a generation-stage LLM for proposed `{ id, props }` updates,
 *   3. validates/coerces them through the pure EditIntent gate,
 *   4. returns `details.intents` for the client to apply via onElementsChange /
 *      the host adapter (one instruction = one intent batch = one undo).
 *
 * Trust boundary: the model never authors the inventory; unknown / locked /
 * out-of-contract props refuse the whole batch — never a partial apply.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { EditIntent } from '@openmaic/renderer/editing';
import type { PPTElement } from '@openmaic/dsl';
import type { RegenerateActionsDeps, SceneContext } from './regenerate-scene-actions';
import {
  buildElementInventory,
  mapProposalsToEditIntents,
  type ElementInventoryItem,
  type ProposedElementUpdate,
} from './edit-elements-gate';

// ── Params ───────────────────────────────────────────────────────────────────

export const EditElementsParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the SLIDE scene to edit. Use the id of the current scene shown in the system prompt.',
  }),
  instruction: Type.String({
    description:
      'Natural-language element edit, e.g. "make the title blue and move it up". ' +
      'Prefer referring to the current selection ("this title") when the user has selected elements.',
  }),
});

export type EditElementsParams = Static<typeof EditElementsParams>;

// ── Details ──────────────────────────────────────────────────────────────────

export interface EditElementsDetails {
  sceneId: string;
  /** Validated EditIntents for the client to apply; null on refusal. */
  intents: EditIntent[] | null;
  /** Number of elements touched (0 on refusal). */
  updateCount: number;
}

export type EditElementsDeps = RegenerateActionsDeps & {
  /** Active selection ids from the canvas (client-sourced, trusted). */
  getSelection?: () => readonly string[];
};

// ── Prompt / parse ───────────────────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
}

/** Parse the LLM proposal JSON into proposed updates (or throw). */
export function parseProposedUpdates(raw: string): ProposedElementUpdate[] {
  const cleaned = stripCodeFences(raw.trim());
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('model response is not a JSON object');
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    updates?: unknown;
    refuse?: unknown;
  };
  if (parsed.refuse) {
    throw new Error(typeof parsed.refuse === 'string' ? parsed.refuse : 'model refused the edit');
  }
  if (!Array.isArray(parsed.updates)) {
    throw new Error('model response missing updates array');
  }
  return parsed.updates as ProposedElementUpdate[];
}

function inventoryForPrompt(items: ElementInventoryItem[]): string {
  return items
    .map((el) => {
      const box =
        el.type === 'line'
          ? `left=${el.left} top=${el.top} width=${el.width}`
          : `left=${el.left} top=${el.top} width=${el.width} height=${el.height} rotate=${el.rotate ?? 0}`;
      const styleKeys = Object.keys(el.style);
      const style =
        styleKeys.length > 0
          ? ` style={${styleKeys.map((k) => `${k}:${JSON.stringify(el.style[k])}`).join(',')}}`
          : '';
      const lock = el.lock ? ' LOCKED' : '';
      return `- id=${el.id} type=${el.type} label=${JSON.stringify(el.label)} ${box}${style}${lock}`;
    })
    .join('\n');
}

function buildProposalPrompt(args: {
  instruction: string;
  inventory: ElementInventoryItem[];
  selectionIds: readonly string[];
}): { system: string; user: string } {
  const system = [
    'You propose per-element property updates for a slide editor.',
    'Return ONLY a JSON object: {"updates":[{"id":"...","props":{...}}]}',
    'If the instruction cannot be satisfied with allowed props, return {"refuse":"reason"}.',
    'Allowed props: left, top, width, height, rotate, fill, opacity, outline, shadow,',
    'defaultColor, defaultFontName, lineHeight, wordSpace, paragraphSpace, vertical, vAlign, textType,',
    'color, gradient, filters, radius, flipH, flipV, colorMask, fixedRatio,',
    'themeColors, textColor, lineColor, fontSize, showLineNumbers, fileName.',
    'Do NOT change: id, type, lock, groupId, content, text, src, lines, latex, html, data, path, keypoints, line endpoints.',
    'Use absolute canvas values for geometry (not deltas). Prefer editing selected elements when the user says "this" / "these".',
    'Only include props that actually change. Never invent element ids.',
  ].join(' ');

  const selection =
    args.selectionIds.length > 0
      ? `Current selection (prefer these when the user says "this"/"these"): ${args.selectionIds.join(', ')}`
      : 'Current selection: (none)';

  const user = [
    `Instruction: ${args.instruction}`,
    selection,
    'Element inventory:',
    inventoryForPrompt(args.inventory),
  ].join('\n');

  return { system, user };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeEditElementsTool(
  deps: EditElementsDeps,
): AgentTool<typeof EditElementsParams, EditElementsDetails> {
  return {
    name: 'edit_elements',
    label: 'Edit slide elements',
    description:
      'Edits specific elements on a SLIDE scene from a natural-language instruction — ' +
      'e.g. "make the title blue and move it up", "make this figure smaller". ' +
      'Uses the current canvas selection when the user says "this"/"these". ' +
      'Works on SLIDE scenes only; does not rewrite text content or regenerate the whole slide. ' +
      'Supply sceneId + instruction; element data is loaded automatically.',
    parameters: EditElementsParams,

    execute: async (_toolCallId, params, signal) => {
      const { sceneId, instruction } = params;
      const trimmed = (instruction ?? '').toString().trim();
      if (!trimmed) {
        return {
          content: [{ type: 'text', text: 'Error: instruction is empty.' }],
          details: { sceneId, intents: null, updateCount: 0 },
          isError: true,
        };
      }

      const ctxData: SceneContext | undefined = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}.`,
            },
          ],
          details: { sceneId, intents: null, updateCount: 0 },
          isError: true,
        };
      }

      const { content } = ctxData;
      if (content.type !== 'slide') {
        return {
          content: [
            {
              type: 'text',
              text:
                'Cannot edit elements on this scene: edit_elements works on SLIDE scenes only. ' +
                'For interactive pages use edit_interactive_html; otherwise suggest the canvas.',
            },
          ],
          details: { sceneId, intents: null, updateCount: 0 },
          isError: true,
        };
      }

      const elements = (content.canvas?.elements ?? []) as PPTElement[];
      if (elements.length === 0) {
        return {
          content: [{ type: 'text', text: 'This slide has no elements to edit.' }],
          details: { sceneId, intents: null, updateCount: 0 },
          isError: true,
        };
      }

      const inventory = buildElementInventory(elements);
      const selectionIds = deps.getSelection?.() ?? [];
      const { system, user } = buildProposalPrompt({
        instruction: trimmed,
        inventory,
        selectionIds,
      });

      let raw: string;
      try {
        raw = await deps.aiCall('scene-content:slide', system, user, signal);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Error proposing element edits: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { sceneId, intents: null, updateCount: 0 },
          isError: true,
        };
      }

      let proposals: ProposedElementUpdate[];
      try {
        proposals = parseProposedUpdates(raw);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Could not apply the edit: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { sceneId, intents: null, updateCount: 0 },
          isError: true,
        };
      }

      const gated = mapProposalsToEditIntents(proposals, inventory);
      if (!gated.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Could not apply the edit: ${gated.reason}. Nothing was changed.`,
            },
          ],
          details: { sceneId, intents: null, updateCount: 0 },
          isError: true,
        };
      }

      const updateCount =
        gated.intents[0]?.type === 'element.updateMany'
          ? gated.intents[0].updates.length
          : gated.intents.length;

      return {
        content: [
          {
            type: 'text',
            text: `Updated ${updateCount} element(s) on the slide.`,
          },
        ],
        details: { sceneId, intents: gated.intents, updateCount },
      };
    },
  };
}
