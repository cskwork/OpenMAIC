# U4 workbench entry report

Recorded at 2026-08-26 20:31 CST (Beijing time).

## What was wired

- Added the runtime-probed Pro badge to `/`. The client does not issue the probe when
  `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` is off, keeps the badge hidden until the probe
  returns `{ enabled: true }`, and prefetches `/workspace` only after that result.
- Changed `GET /api/agent/runtime` to expose `isAgentRuntimeConfigured()`, so an enabled
  runtime without a non-empty `DATABASE_URL` is not advertised to the client.
- Added `/workspace` and the `/workbench/new` compatibility route. Both use the same
  server-side `isWorkbenchEntryEnabled()` decision. The workspace redirects to `/` and
  the compatibility route returns not-found while disabled.
- Ported `ProLaunchPanel` against the data slice's `createWorkbenchSession()` API. It
  supports an optional installed-skill handle, optional existing-course references, and
  material attachments without issuing its own session `fetch`.
- Ported the shared-element Pro swap controller, watcher, badge, and CSS. The root layout
  owns the watcher so navigation arrival can settle a transition after the source page
  unmounts.
- Removed the reference implementation's account, credit, billing, and hosted-demo gates
  from this slice. There is no login wrapper or credit-aware send control here.
- Added the required en-US entry/composer strings.

## Sibling-slice assumptions

The data layer, chat surface, and workspace shell remain on separate unmerged branches.
This slice imports their reference exports and does not copy their implementations:

- `feat/workbench-data-layer`: `createWorkbenchSession`, `WorkbenchApiError`,
  `WorkbenchMaterial`, `CourseRef`, and `workspaceHref`.
- `feat/workbench-chat-ui`: composer transfer/key/menu helpers and the composer, skill,
  material, and course-reference UI exports used by `ProLaunchPanel`.
- `feat/workbench-workspace-shell`: `WorkspaceShell`, whose home surface consumes
  `ProLaunchPanel`, `ProBadge`, and the Pro swap controller from this slice.

`types/workbench-entry-sibling-slices.d.ts` records these compile-time contracts only. It
contains no fallback behavior and must be removed when the concrete sibling files merge.

## Flag-off and flag-on evidence

Command:

```text
VITEST_MAX_WORKERS=2 NODE_OPTIONS='--max-old-space-size=1024' pnpm vitest run \
  tests/workbench/entry-gate.test.ts \
  tests/workbench/entry-routes.test.ts \
  tests/workbench/pro-swap.test.ts \
  tests/agent-runtime/runtime-probe.test.ts
```

Observed:

```text
Test Files  4 passed (4)
Tests       14 passed (14)
```

The cases verify all of the following:

- flag off, runtime off, missing database URL, and blank database URL all close the shared
  entry gate;
- the disabled `/workspace` page invokes `redirect('/')` rather than constructing the
  shell;
- the disabled `/workbench/new` page invokes `notFound()`;
- the configured flag-on case renders both route elements;
- the runtime probe returns false/true from the configured-runtime truth; and
- the swap controller navigates directly without View Transitions, waits for route
  arrival with them, and respects reduced motion.

## End-to-end run observation (verbatim)

I attempted the required enabled-runtime build with Node 22.23.1:

```text
NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true \
OPENMAIC_AGENT_RUNTIME_ENABLED=true \
DATABASE_URL='postgres://openmaic:openmaic@127.0.0.1:5432/openmaic' \
NODE_OPTIONS='--max-old-space-size=8192' pnpm build
```

The build reached `Creating an optimized production build ...` and then stopped with:

```text
Build error occurred
Error: Turbopack build failed with 3 errors:
./components/workbench/WorkspaceEntry.tsx:1:1
Module not found: Can't resolve '@/components/workbench/workspace/WorkspaceShell'

./app/workbench/new/client.tsx:13:1
Module not found: Can't resolve '@/lib/workbench/session-store'

./app/workbench/new/client.tsx:19:1
Module not found: Can't resolve '@/lib/workbench/workspace-panes'
```

Those are the explicitly unmerged workspace-shell and data-layer APIs. Because `next
build` did not produce a runnable production bundle, I did not start `next start`, open a
browser, submit a prompt, or observe an SSE agent turn. There is no end-to-end success
claim for this isolated branch.

## What remains before an operator can use it

1. Merge the workbench data-layer, chat-surface, and workspace-shell slices.
2. Remove `types/workbench-entry-sibling-slices.d.ts` so the concrete exports are the only
   source of their types.
3. Resolve any integration conflicts in shared i18n and composer files, then repeat the
   production build with a reachable PostgreSQL URL.
4. Start the production app, open `/workspace`, create a session with a prompt, and capture
   the browser or HTTP+SSE evidence that the agent turn streams into the chat surface.

## Verification lines

- `pnpm install --prefer-offline`: pass.
- Focused Vitest suite on Node 22, 2 workers, 1024 MB heap: pass, 14/14.
- `NODE_OPTIONS='--max-old-space-size=8192' pnpm exec tsc --noEmit`: pass.
- `pnpm check`: pass.
- `pnpm lint`: pass with 0 errors and 16 warnings; the warnings are existing repository
  warnings, including the pre-existing `app/page.tsx` `loadClassrooms` dependency warning.
- `pnpm build` with runtime and database variables: blocked at the three unmerged sibling
  modules quoted above.
- `/usr/bin/python3 .../_sync-audit/leakscan.py origin/integration/agent-workbench`: `LEAK
  SCAN CLEAN` (exit 0).
