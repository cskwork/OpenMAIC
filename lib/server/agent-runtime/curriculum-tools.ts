/**
 * Multi-stage curriculum tools — the backend half of "user says '7 days of
 * python', ONE agent session runs start to finish": create stages (one class
 * per unit/day) and read cross-stage outlines for chaining.
 *
 * This slice ports ONLY `create_stage` and `read_stage_outline` from the
 * reference curriculum toolset. The folder tools (`create_folder`,
 * `move_to_folder`), `rename_stage` and `list_folder_stages` belong to the
 * folder slice and are deliberately absent here, so `create_stage` never takes
 * a `folderId` (a stage is always created ungrouped until the folder slice
 * lands).
 *
 * Every tool is scoped to the run's owner: the store handed to these tools is
 * the owner-bound `PgDocumentStore` (`documentStore.forOwner(ownerId)`), so a
 * foreign stage is indistinguishable from a missing one — fail-closed, never
 * confirming another tenant's id. Every execute takes pi's 3rd `signal`
 * argument and re-checks it at each IO boundary.
 */
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { StageLinkLifecycleData } from '@/lib/agent-runtime/lifecycle';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { CourseDocument, CourseStore } from './course-tools';
import { stageIdForCall } from './course-stage';
import { mergeStageOutline } from './course-outline-union';

export { stageIdForCall } from './course-stage';

// ── Tool deps ─────────────────────────────────────────────────────────────────

export interface CurriculumToolDeps {
  /** The owner-bound document store of the run's session owner. */
  store: CourseStore;
  /** The session owner; every stage access is scoped to it by the store. */
  ownerId: string;
  sessionId: string;
  /** Fired whenever a tool produces or returns a classroom link. */
  onStageLink?: (course: StageLinkLifecycleData) => void;
  /**
   * Fired after a successful WRITE to the owner's course library: a stage
   * created. The runner turns it into the durable `library_changed` event and
   * the workspace refetches its course list — the same refresh sink the first
   * committed page already uses.
   *
   * Fired ONLY after the persist succeeded: a refused or failed call changed
   * nothing, and asking the client to refetch a tree that did not move is a
   * request for the same bytes back.
   */
  onLibraryChanged?: (change: LibraryChange) => void;
}

/**
 * What moved in the library. The client refetches the whole list either way, so
 * this rides along for the log and for debugging rather than for a diff — see
 * `LIFECYCLE.libraryChanged`. The folder-shaped variants land with the folder
 * slice.
 */
export type LibraryChange = { change: 'stage_created'; stageId: string; title: string };

// ── Params ────────────────────────────────────────────────────────────────────

const CreateStageParams = Type.Object({
  title: Type.String({
    description:
      'Stage title (e.g. "Day 1 — Python basics"); becomes the stage name and the `/classroom/<stageId>` title.',
  }),
  brief: Type.Optional(
    Type.String({ description: 'Optional one-line brief, stored as the stage description.' }),
  ),
});

const ReadStageOutlineParams = Type.Object({
  stageId: Type.String({
    description:
      'An owner stage id. Returns the stage title and its page list (order/title/type) — the summary level, not page content.',
  }),
});

// ── Toolset ───────────────────────────────────────────────────────────────────

function toolResult(text: string, details: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The single refusal every owner-scoped tool maps a non-owned stage to. The
 * tool text never echoes whether the stage is foreign or missing — a stranger
 * probing another tenant's id must get the same answer they would have got
 * while it was alive.
 */
function notYoursResult(subject: string) {
  return toolResult(
    `${subject} was not found, or does not belong to this session user. You can only read and write stages this session created.`,
    { refused: true },
    true,
  );
}

export function buildCurriculumTools(deps: CurriculumToolDeps): AgentTool<never, never>[] {
  const createStage: AgentTool<typeof CreateStageParams, unknown> = {
    name: 'create_stage',
    label: 'Create stage',
    description:
      'Create a NEW stage document owned by this session user and return its stageId and classroom url. Pass that stageId explicitly to every later stage tool. Use for multi-stage series: one stage per unit/day.',
    parameters: CreateStageParams,
    async execute(callId, params: Static<typeof CreateStageParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const title = params.title?.trim();
      if (!title) {
        return toolResult('create_stage needs a non-empty title.', { error: 'empty-title' }, true);
      }
      // Idempotent by construction: the SAME tool call (same call id, replayed
      // after a crash between the save and the result checkpoint) derives the
      // SAME stage id, so the retry lands on the stage the original already
      // minted instead of casting a second orphan course. The store is
      // owner-bound, so `loadDocument` only ever returns a stage this owner
      // owns — a foreign document at the same id reads as absent and the
      // `saveDocument` below refuses it (the owner scope is enforced inside
      // the write transaction).
      const stageId = stageIdForCall(deps.sessionId, callId);
      const existing = await deps.store.loadDocument(stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (existing) {
        const producerRef = (existing.outline as AppDocumentOutline | undefined)?.producerRef;
        // `producerRef` is this session's id when the agent created the stage
        // (set below; absent for an empty sessionId). Only a stage this session
        // minted may be treated as a committed retry — a document this session
        // did not mint at the same id is a collision and must not be confirmed.
        const ours = deps.sessionId ? producerRef === deps.sessionId : producerRef === undefined;
        if (!ours) {
          return toolResult(
            `A stage document already exists at this id and was not created by this session; refusing to overwrite it.`,
            { refused: true },
            true,
          );
        }
        deps.onStageLink?.({
          stageId,
          title: existing.stage.name,
          url: `/classroom/${stageId}`,
        });
        return toolResult(
          `Stage "${existing.stage.name}" was already created — this create_stage call was a retry, returning the existing stage.`,
          {
            stageId,
            title: existing.stage.name,
            url: `/classroom/${stageId}`,
            reused: true,
          },
        );
      }
      const now = Date.now();
      const document: CourseDocument = {
        stage: {
          id: stageId,
          name: title,
          ...(params.brief?.trim() ? { description: params.brief.trim() } : {}),
          createdAt: now,
          updatedAt: now,
        },
        scenes: [],
        // The same outline envelope the server-side generate_outline writes,
        // with producer semantics intact: this course is owned by the agent
        // runtime job, and the browser must never generate into it. An
        // agent-minted stage has NO generation-pipeline lifecycle — planning
        // happens in the conversation and each page lands through the page
        // tools of the generation slice — so it is born complete
        // (`generationComplete: true`).
        outline: {
          outlines: [],
          requirement: title,
          generationComplete: true,
          producer: 'server-job',
          ...(deps.sessionId ? { producerRef: deps.sessionId } : {}),
          createdAt: now,
          updatedAt: now,
        } satisfies AppDocumentOutline,
      };
      if (signal?.aborted) throw new Error('aborted');
      // `saveDocument` on the owner-bound store mints the document AND claims
      // the owner scope in one transaction. A concurrent mint of the same id
      // is refused by the store's owner scope; the replay is sequential, so
      // the loadDocument pre-check above is the ordering guarantee.
      await deps.store.saveDocument(document);
      if (signal?.aborted) throw new Error('aborted');
      // The owner's library gained a course — the left rail's tree is stale
      // until it refetches. Fired exactly once per mint.
      deps.onLibraryChanged?.({ change: 'stage_created', stageId, title });
      deps.onStageLink?.({ stageId, title, url: `/classroom/${stageId}` });
      return toolResult(
        `Created stage "${title}" — open it at /classroom/${stageId}. Pass stageId=${stageId} explicitly to every stage tool for this stage.`,
        {
          stageId,
          title,
          url: `/classroom/${stageId}`,
        },
      );
    },
  };

  const readStageOutline: AgentTool<typeof ReadStageOutlineParams, unknown> = {
    name: 'read_stage_outline',
    label: 'Read stage outline',
    description:
      'Read the OUTLINE of any stage this session user owns (title + page list with order/title/type — not page content). Use to chain stages in a series: see what a previous day covered before planning the next.',
    parameters: ReadStageOutlineParams,
    async execute(_id, params: Static<typeof ReadStageOutlineParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      // The owner-bound store is the fail-closed probe: a foreign or missing
      // stage reads as absent, so the refusal below never confirms another
      // tenant's id.
      const doc = await deps.store.loadDocument(params.stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (!doc) return notYoursResult(`Stage "${params.stageId}"`);
      const snapshot = doc.outline as AppDocumentOutline | undefined;
      const planned = snapshot && Array.isArray(snapshot.outlines) ? snapshot.outlines : [];
      const scenes = doc.scenes ?? [];
      // UNION view: real scenes pair with the outline entries they were built
      // from (outlineId, then order) and planned-only pages stay visible at
      // their planned position while generation is in progress; a COMPLETED
      // snapshot is pure scenes. See course-outline-union.ts.
      const entries = mergeStageOutline({
        scenes,
        planned,
        generationComplete: snapshot?.generationComplete,
      });
      // `details.pages` keeps the historical {order,title,type} shape; the
      // planned/pending marker and the display sequence ride the
      // human-readable text only (display numbers are the merged consecutive
      // positions — entries keep their original order).
      const pages = entries.map(({ order, title, type }) => ({ order, title, type }));
      const title = doc.stage?.name ?? '';
      const text =
        pages.length === 0
          ? `Stage "${title}" has no planned pages yet.`
          : `Stage "${title}" (${pages.length} page(s)):\n${entries
              .map((p, i) => `- ${i + 1}. ${p.title} [${p.type}]${p.planned ? ' (planned)' : ''}`)
              .join('\n')}`;
      return toolResult(text, { stageId: params.stageId, title, pages, pageCount: pages.length });
    },
  };

  return [createStage, readStageOutline] as unknown as AgentTool<never, never>[];
}

export const CURRICULUM_ALLOWLIST: ReadonlySet<string> = new Set([
  'create_stage',
  'read_stage_outline',
]);

/**
 * Prompt block teaching the multi-stage workflow (appended to the system
 * prompt). Folder guidance (create_folder / move_to_folder / list_folder_stages
 * / rename_stage) lands with the folder slice.
 */
export const CURRICULUM_TOOLS_PROMPT = [
  'Multi-stage series: to build a series in one session, call `create_stage`',
  'once per unit/day. `create_stage` returns a stageId; pass that',
  'stageId explicitly to every later stage tool. There is no active/current stage.',
  'Use different stageIds to work on several stages in parallel.',
  "`read_stage_outline` reads a stage's page list (not content) so you can",
  'chain a series (e.g. day 2 builds on what day 1 covered).',
].join(' ');
