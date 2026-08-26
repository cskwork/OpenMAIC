# G-branch merge fix: runner registration test expectations aligned

## What was wrong

The merge of `origin/integration/agent-workbench` into `feat/agent-voice-tools` unioned
tool-name lists inside the conflict hunks, but the incoming (generation/media) slice's
expectation lines that sat **outside** the hunks were lost. The assertions compare
**ordered** arrays, so both membership and order had to match what the runner actually
assembles. 5 tests failed:

- `runner-skills-registration.test.ts` (1) — allowlist literal not in sorted order
- `runner-voice-registration.test.ts` (2) — tools + allowlist missing the seven
  generation/media tools
- `runner-web-search-registration.test.ts` (2) — allowlist literal not in sorted order

## Actual registration order (from `lib/server/agent-runtime/runner.ts`)

The runner calls `assembleRunnerTools(...groups)` (runner-contract.ts) which flattens the
groups in call order. The full surface, capabilities on (all gates open), in runner order:

```
ask_user
web_search                              ← only when resolveWebSearchCapability() is non-null
create_skill
read_skill
patch_skill
read                                    ← only when installed skills exist (skillReadTool)
fetch_url                               ← always registered
generate_scene
list_scenes
generate_actions
duplicate_scene
generate_tts
edit_deck
use_material_media
render_scene_preview                    ← only when RENDER_SERVICE_URL configured
read_stage
patch_stage
grep_stage
create_stage
read_stage_outline
list_materials
read_material
search_material
list_voices
set_roster
clip_audio
register_voice                          ← only when a voice-registration backend exists
```

Why this order: the `dslTools` group (`buildDslCourseToolset`, course-tools.ts) is
assembled as generation tools → audio/deck tools → material-media tool → scene-preview
tool → generic DSL tools, and `dslTools` sits between `fetch_url` and `curriculumTools`
in the `assembleRunnerTools` call. Curriculum (`create_stage`, `read_stage_outline`),
materials, roster, and voice-clone groups follow.

The allowlist (runner.ts `allowedToolNames`) is the same set built from
`MINIMAL_AGENT_TOOL_NAMES` + `web_search?` + `create_skill` + `SKILL_EDIT_TOOL_NAMES` +
`read?` + `MATERIAL_TOOL_NAMES` + `dslTools.map(name)` + `CURRICULUM_ALLOWLIST` +
`ROSTER_TOOL_NAMES` + (`VOICE_CLONE_TOOL_NAMES` or `clip_audio`). The tests pin it as the
sorted name set.

In the test environment `RENDER_SERVICE_URL` is unset, so `render_scene_preview` is
correctly absent from both the toolset and the allowlist (no test lists it).

## Expectations changed

### `tests/agent-runtime/runner-voice-registration.test.ts` (both cases)

- **tools list**: inserted the seven generation/media tools between `fetch_url` and
  `read_stage` — `generate_scene, list_scenes, generate_actions, duplicate_scene,
  generate_tts, edit_deck, use_material_media` — in exactly the runner's order
  (generation → audio/deck → material-media inside the `dslTools` group).
- **allowlist** (sorted, `.sort()` on both sides): added the same seven names, plus
  `clip_audio` / `register_voice` in sorted positions. Case 1 (backend configured) keeps
  `register_voice`; case 2 (no adapter) keeps only `clip_audio`.

### `tests/agent-runtime/runner-skills-registration.test.ts` (1 case)

- **allowlist literal**: reordered `list_scenes` before `list_voices`. The assertion sorts
  only the actual side (`expect([...].sort()).toEqual([literal])`), so the literal must be
  pre-sorted; `'list_scenes' < 'list_voices'` alphabetically. The tools list was already
  correct.

### `tests/agent-runtime/runner-web-search-registration.test.ts` (2 cases)

- Same allowlist-literal sort fix as the skills test, in both the configured and
  unconfigured cases. Tools lists were already correct.

## Assertions argued order-insensitive — none weakened

No ordered `toEqual` was replaced with a set/subset check, and no case was deleted. The
voice-test allowlist assertions were already written as `[...].sort() === [...] .sort()`
on both sides (set-membership by construction); the skills/web-search allowlist assertions
sort only the actual and require the literal to be pre-sorted — I fixed the literal's sort
order rather than loosening the assertion. The **tools-list** assertions remain strict
ordered `toEqual`s pinning the exact registered surface.

## Findings from step 4 (gating audit)

- **`render_scene_preview`** is genuinely capability-gated (`resolveRenderServiceUrl()`
  returns an error when `RENDER_SERVICE_URL` is unset → `buildScenePreviewTools` returns
  `[]`), and the allowlist follows `dslTools.map(name)` so it disappears with the tool.
  No test mis-encodes it: tests never list it. Consistent — no change needed.
- **The seven generation/media tools are registered unconditionally**, even though
  `generate_scene`/`generate_actions` depend on an LLM backend and `generate_tts` on a TTS
  backend. They degrade at **call time** (error results such as "No enabled server TTS
  capability is available") rather than at registration, which matches the incoming
  slice's design and both sides' merged runner. Not a registration/gating mismatch to fix;
  the tests correctly pin them as always present.
- `web_search` (capability), `register_voice` (registration backend), and `read`
  (installed skills) are all capability-gated in both the toolset and the allowlist, and
  the tests exercise exactly those gates. No tool was found registered-but-should-be-gated
  or vice versa.

## Verification

```
VITEST_MAX_WORKERS=2 NODE_OPTIONS=--max-old-space-size=1024 npx vitest run tests/agent-runtime/ tests/audio/ tests/server/
  → Test Files  104 passed | 2 skipped (106)
    Tests  1191 passed | 5 skipped (1196)

NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
  → exit 0

pnpm check (prettier . --check)
  → All matched files use Prettier code style!  (exit 0)

pnpm lint
  → 0 errors, 16 pre-existing warnings (unrelated packages)
```

Merge commit amended in place (`git commit --amend --no-edit`) — both parents preserved;
no rebase, not pushed.
