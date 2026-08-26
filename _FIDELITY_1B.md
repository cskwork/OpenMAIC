# Fidelity 1B — three-state tool access (stage-access repair, part 2)

This pass restores the reference's **tool-layer** access contract. The HTTP layer was
already faithful (capability-by-id read, owner-only mutation, generic list refused,
tombstoned delete); the agent tools still ran on a single owner-bound store and treated
"the store let me read it" as "this stage is mine". The reference resolves that by probing
each model-declared stage id through a three-state `StageAccess` (`owned` / `foreign` /
`missing` / `tombstoned`) **before** any store IO, and by branching per tool.

The reference is the authority for which tool requires ownership and which does not. The
table below is read off `origin/v1.0.0` (`lib/server/agent-runtime/`); the worktree now
mirrors it.

## Per-tool access table (reference authority)

Reference files: `curriculum-tools.ts`, `course-tools.ts` (merged course toolset +
`withOwnerStageAuthorization` wrapper), `dsl-tools.ts`, `scene-preview.ts`, `runner.ts`.

| Tool | Toolset | Required access | Refusal shape (reference) |
| --- | --- | --- | --- |
| `create_stage` | curriculum | no stage probe — mints a new stage; `folderId` must be one of the owner's folders | unknown/foreign folder: `The folder was not found, or does not belong to this session user. Create it with create_folder first, or omit folderId to create an ungrouped stage.` (`{ refused: true, error: 'unknown-folder' }`) |
| `create_folder` | curriculum | no stage probe | — |
| `move_to_folder` | curriculum | `owned` (`access.kind !== 'owned'` → refuse) | `notYoursResult`: `Stage "<id>" was not found, or does not belong to this session user. Use list_folder_stages to see the stages you can work on.` (`{ refused: true }`); foreign folder: `The folder was not found, or does not belong to this session user.` |
| `rename_stage` | curriculum | `owned` | `notYoursResult` as above; probe-passed-but-doc-gone: `Course document not found; it may have been deleted.` (`{ refused: true }`) |
| `list_folder_stages` | curriculum | folder must be the owner's; listing is owner-scoped by construction | foreign folder: `The folder was not found, or does not belong to this session user.` |
| `read_stage_outline` | curriculum | `owned` | `notYoursResult` as above; doc-gone: `Course document not found; it may have been deleted.` |
| `read_stage` | course/DSL (wrapped) | `owned` via `withOwnerStageAuthorization` (wrapper refuses before the tool runs) | `The stage was not found, or does not belong to this session user. Use list_folder_stages to see the stages you can work on.` (`{ refused: true, stageId }`); in-tool `loadCourse` fallback: `Stage "<id>" was not found or is not accessible.` / `Stage is not accessible: <error>` |
| `patch_stage` | course/DSL (wrapped) | `owned` via wrapper | same wrapper refusal |
| `grep_stage` | course/DSL (wrapped) | `owned` via wrapper | same wrapper refusal |
| `generate_scene` / `list_scenes` / `generate_actions` / `duplicate_scene` / `generate_tts` / `edit_deck` | course (wrapped) | `owned` via wrapper (each takes `stageId`) | same wrapper refusal |
| `set_roster` | roster (wrapped in the reference's merged course toolset) | `owned` via wrapper | same wrapper refusal |
| `list_voices` | roster | no `stageId` param → wrapper passes through | — |
| `render_scene_preview` | scene-preview (own probe, NOT wrapped) | `owned` | `Preview failed: course not found or not owned by this session user` (`{ sceneId }`) |
| `use_material_media` | course (session-scoped) | no `stageId` param → wrapper passes through | — |

Key structural facts from the reference:

- `runner.ts` injects one probe factory `(stageId) => probeStageAccess(meta.ownerId, stageId)`
  at three call sites: `buildScenePreviewTools`, `buildCurriculumTools`, and
  `buildCourseToolset` (which contains the DSL tools). `probeStageAccess` and the
  `StageAccess` type live in `curriculum-tools.ts` (~lines 35–65).
- The course toolset wraps **every** member in `withOwnerStageAuthorization`
  (`course-tools.ts` ~1714–1772): if the params carry a non-empty `stageId` and the probe
  is not `owned`, the call is refused before the tool's own execute runs. `read_stage`,
  `patch_stage`, and `grep_stage` therefore refuse foreign stages exactly like the writers —
  the reference does **not** give the DSL reads a capability-by-id exemption.
- `scene-preview` is deliberately outside that wrapper: it carries its own probe and its
  own refusal message.
- All refusals are fail-closed and never echo whether the stage was foreign, missing, or
  tombstoned.

## What changed

- **`lib/server/agent-runtime/curriculum-tools.ts`** — ported `StageAccess` and
  `probeStageAccess` (adapted to this tree's `stage_meta` + `document_stages` tables and
  raw-query style; defaults to the server persistence provider's pool, same seam the
  owner-bound store uses). Added the required `stageAccess` dep. `move_to_folder`,
  `rename_stage`, and `read_stage_outline` now probe first and refuse with
  `notYoursResult` on `access.kind !== 'owned'`; the probe-passed-but-doc-gone fallback
  uses the reference's `Course document not found; it may have been deleted.` message.
  `create_stage`'s folder refusals were aligned to the reference text.
- **`lib/server/agent-runtime/course-tools.ts`** — added the required `stageAccess` dep to
  `CourseToolDeps` and ported `withOwnerStageAuthorization` (exported, since the runner
  also applies it to the roster toolset). `buildDslCourseToolset` now returns
  `markDocumentWritersSequential(withOwnerStageAuthorization(tools, deps))` — every
  `stageId`-bearing course/DSL tool is owner-gated; scene preview was removed from this
  toolset so it keeps its own probe (reference structure).
- **`lib/server/agent-runtime/scene-preview.ts`** — added the required `stageAccess` +
  `ownerId` deps, the fail-closed probe, the reference refusal
  (`course not found or not owned by this session user`), and the
  `x-openmaic-client: <owner>` header on the render request.
- **`lib/server/agent-runtime/runner.ts`** — one `stageAccess` factory, injected into the
  DSL/course toolset, the curriculum toolset, and the scene-preview tool (the three call
  sites); the roster toolset is wrapped by the same `withOwnerStageAuthorization`
  (reference: `set_roster` is a member of the merged course toolset and is owner-gated).
  Scene preview is registered beside the course toolset and added to the allowlist.
- **`lib/server/agent-runtime/roster-tools.ts`** — no source change: the runner applies
  the wrapper around `buildRosterTools` (the file's header comment already claimed a
  fail-closed owner probe; that claim is now true).

## Test premise corrections

The two failing tests encoded a store-level "capability-by-id read" policy that the
reference does **not** have at the tool layer:

1. `tests/agent-runtime/dsl-tools.test.ts` — "a foreign stage is readable by id but not
   patchable through the run store" was rewritten as **"refuses a foreign stage on read,
   patch, and grep; the owner still reads it"**. The old premise (foreign `read_stage`
   succeeds) was wrong: in the reference the whole course toolset, DSL reads included, is
   owner-gated by `withOwnerStageAuthorization`. The test now builds the tools through
   `buildDslCourseToolset` with the real `probeStageAccess` over PGlite (plus
   `stage_meta` schema), and asserts Bob's read/patch/grep of Alice's stage all return the
   single not-yours refusal with `details: { refused: true, stageId }`, that Alice's own
   tools still read it, and that nothing was persisted. (The old test also happened to read
   `/scenes/1` of a freshly minted empty stage, which fails for the incidental reason that
   the stage has no scenes — another reason the premise could not stand.)
2. `tests/agent-runtime/curriculum-tools.test.ts` — "keeps create, create-with-folder,
   move, rename, and list owner-scoped" kept its assertions (they already matched the
   reference's refusals), but it failed because the unprobed tools let a foreign
   `rename_stage` reach the store and threw an uncaught ownership error. With the probes in
   place it passes unchanged. The separate unit test "refuses a stage id that does not
   resolve to a document" had its message assertion updated from the not-yours text to the
   reference's doc-gone text (`Course document not found`).

## Verification

- `VITEST_MAX_WORKERS=2 NODE_OPTIONS="--max-old-space-size=1024" npx vitest run tests/persistence tests/agent-runtime tests/server`
  → **86 passed | 2 skipped**, **1126 passed | 5 skipped** (includes the split-brain
  regression test in `tests/persistence` and the two repaired tool tests).
- The two previously failing tests, individually: `dsl-tools.test.ts` (41) and
  `curriculum-tools.test.ts` (26) all pass.
- `tests/agent-runtime/roster-tools.test.ts` → 20 passed, including two new pins for the
  roster owner gate (foreign `set_roster` refused before any store IO; `list_voices`
  passes through).
- `NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit -p tsconfig.json` — no errors
  in any touched file (the tree has pre-existing unrelated errors under `lib/pbl/v2`).
- Full-suite run: 546 of 553 files pass; the only failures are pre-existing and unrelated
  to this work — `tests/quiz/runtime.test.ts` (4) and `tests/runtime/chat-storage.test.ts`
  (40) fail identically with the changes stashed (browser-runtime/IndexedDB fixtures in a
  Node environment). Neither file imports the agent-runtime modules touched here.
- No changes under `packages/@openmaic/storage` — no package version bump required.
