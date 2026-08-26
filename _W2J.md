# W2-J material extraction lifecycle

## State machine

Source uploads start in `idle`. `extract_material` performs the explicit and idempotent `idle -> pending` enqueue. A failed source may also be explicitly requeued with `failed -> pending`; that transition clears terminal output and error metadata and resets the automatic retry counter.

The extraction runner claims `pending -> running`. It may also reclaim `running -> running` after the prior lease heartbeat expires. A lease-fenced completion atomically replaces the source's existing one-hop derivative, inserts the new readable derivative, and moves the source `running -> done`. A permanent failure moves `running -> failed`. A retryable failure moves `running -> pending` at most twice; the third retryable failure moves to `failed`.

`done` and `failed` are terminal worker states: the runner never claims them. `done` cannot be re-entered or explicitly requeued. `failed` is retryable only through the explicit tool enqueue described above. Every heartbeat, completion, and failure settlement is fenced by material id plus worker id, so a reclaimed worker cannot write after losing its lease.

## Lease parameters

The extraction runner uses the sibling agent-session runner's existing configuration values: a 1,000 ms scan interval, 2,000 ms heartbeat interval, 10,000 ms lease TTL, and two concurrent jobs by default. These values preserve the package's established heartbeat/TTL ratio and deployment tuning environment variables rather than introducing a second concurrency model. Graceful shutdown stops scans and waits up to 15 seconds for active work; work still active after that keeps its lease until heartbeat expiry, preventing overlapping execution during restart.

## Portable execution and stripped behavior

Raw upload and extracted markdown bytes use the session-scoped asset registry. The runner selects candidates from `lib/document/extractors`, prioritizing ids present in server PDF configuration and using the registry order for the remaining supported extractors. The storage lifecycle contains no provider ids or provider-specific branches.

The port excludes per-owner quotas, object-storage byte paths, billing/credit accounting, and deployment-specific wrappers. It persists only session-scoped asset references, lifecycle state, extraction statistics, and the lease fence.

## End-to-end evidence

`tests/agent-runtime/material-extraction.test.ts` creates a real PostgreSQL-compatible session/material store, persists an uploaded `text/plain` source record, enqueues and claims it, runs the existing registry extractor, completes the durable derivative transition, and invokes the existing `read_material` tool. The assertion reads `The uploaded lesson text.` back from the extracted derivative. The same suite asserts that a rejected extractor becomes `failed` with `extractor rejected input` as its reason, while a connection-reset signal returns to `pending` and consumes one of the two automatic retries.

## Verification

- `NODE_OPTIONS=--max-old-space-size=1024 VITEST_MAX_WORKERS=2 pnpm exec vitest run tests/agent-runtime` — 55 files passed, 2 skipped; 698 tests passed, 5 skipped.
- `NODE_OPTIONS=--max-old-space-size=1024 VITEST_MAX_WORKERS=2 pnpm --filter @openmaic/storage exec vitest run test/pg-agent-session-material.test.ts test/pg-schema-contract.test.ts` — 2 files passed; 35 tests passed.
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit` — passed.
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @openmaic/storage typecheck` — passed.
- `node scripts/check-package-version-bumps.mjs origin/integration/agent-workbench` — passed (`@openmaic/storage` 0.12.0 -> 0.13.0).
- Full `@openmaic/storage` run: 24 files passed and 6 skipped; 968 tests passed and 104 skipped. One pre-existing unrelated multipart parser assertion failed in `http-asset-store.test.ts` (`malformed multipart body` expected, `the meta part must be sent as a file` received). The focused material/schema suites above pass.
