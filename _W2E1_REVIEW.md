# Security review: session materials and `fetch_url`

Scope: original commit `580094fa`, based on `9f6e905b`. Review performed adversarially against the requested SSRF, trust-boundary, persistence, content-injection, resource-bound, and neutrality properties.

## Findings

### P1 — Fixed: redirect bypassed the per-session URL trust gate

The original tool authorized only `params.url`. Its manual redirect loop applied strict network validation to each `Location`, but it did not call `isSessionUrlAllowed` for redirect targets. Consequently, an origin observed in the session could redirect to an arbitrary unobserved public origin, whose response would be returned to the model and persisted.

The reference implementation has the same initial-URL-only behavior, so the port matched the reference but inherited its vulnerability.

Fix: the tool now supplies the session gate to the fetch engine; every normalized redirect target is checked before the next request starts. The tool also rechecks `page.finalUrl` before persistence or return as defense in depth for injected transports and future engine changes. Regression tests cover both the per-hop pre-request check and a forged/untrusted reported final URL.

### P2 — Fixed: soft-deleted sessions remained material-readable and writable

The foreign key only proves that an `agent_sessions` row exists. Session deletion is normally a soft delete, so the original material queries could still create, list, and read materials for a deleted session.

Fix: create now uses `INSERT ... SELECT` constrained by `agent_sessions.deleted_at IS NULL`; list and read join the parent session and fail closed when it is deleted. A PGlite regression test covers create/list/read after soft deletion. Physical deletion continues to cascade material rows through the foreign key.

### P2 — Fixed: ambiguous commit cleanup could create a dangling material row

The original compensation deleted the asset on every material-insert exception. A database connection can fail after PostgreSQL commits but before the client receives the result. In that case unconditional cleanup deleted the asset beneath a durable row.

Fix: the metadata store is initialized before the asset write, and an insert exception triggers a read-back of the caller-minted material id. A committed row is returned; a confirmed absence permits cleanup; an inconclusive read preserves the asset, preferring a reclaimable orphan over a dangling durable row.

### P2 — Fixed: unbounded slow-drip and PDF processing paths

The body timer originally reset on every stream chunk, allowing a peer to retain a worker indefinitely by sending bytes just before each timeout. The PDF path also omitted the reference page bound and invoked the generic local extractor, which materialized raster assets even though `fetch_url` consumes text only. Extracted text and page title were not independently bounded.

Fixes:

- body reading now has an absolute deadline and cancels the reader on timeout;
- downloaded bytes remain capped by the actual stream, independent of `Content-Length`;
- PDFs are limited to 50 pages before provider extraction;
- this tool requests text-only extraction, the local parser skips raster extraction, and pathological raster dimensions are rejected;
- extracted PDF text is capped at 1,000,000 characters and marks the result truncated;
- the model-visible title is capped at 180 characters.

### P3 — Residual: crash-only cross-store orphan window

Asset storage and material metadata are separate store operations with no shared transaction or caller-selected asset id. If the process terminates after `assetStore.put` commits and before the material row commits, an unreachable asset entry can remain without a material row. The asset id has not been returned, the principal is session-specific, and this does not expose another session's data; impact is storage leakage. The compensation now handles ordinary failures and ambiguous commits safely, but eliminating process-termination orphans requires a pending-record/reconciler design or a transactional composite storage API.

Physical deletion cascades the metadata row but does not itself invoke asset-registry cleanup. The product path uses soft deletion, and the asset remains inaccessible through material reads. A future retention/reconciliation job should reclaim these entries.

## SSRF assessment

No remaining SSRF route was found.

- WHATWG URL parsing canonicalizes legacy decimal/octal IPv4 spellings before validation. Userinfo, non-HTTP(S) schemes, nonstandard ports, localhost/local suffixes, metadata hostnames, private/link-local/reserved literals, IPv6 literals, and IPv4-mapped IPv6 are rejected.
- Redirects are manual. Every hop is normalized before another request, so private literal redirects fail before connection.
- The custom lookup forces `all: true`, rejects an empty answer, and runs `assertSafeIp` over the complete DNS answer set. A mixed public/private answer therefore fails closed.
- The validated addresses are returned directly from the same lookup callback used by `net.connect`/`tls.connect`; there is no intervening resolver call. Connection reuse stays attached to the already validated socket. New connections and new redirect origins invoke lookup again.
- A DNS rebind to a private address on any later lookup is rejected. Each redirect hop also receives both the network checks and the session trust-gate check.

## Trust-gate and framing assessment

- The final URL is now checked before its request at each redirect and checked again before persistence/return.
- `registerSessionUrls` is not imported or called by `fetch_url`. Reachable registration sites are limited to user-authored session storage hooks and the runner's web-search result hook. Extracted links cannot widen the session set.
- The system prompt contains `## untrusted_content_policy` and explicitly treats fetched instructions as data.
- Tool details separate `trusted` metadata from `untrusted` URL/title/content. The text form is produced with `JSON.stringify`, so quotes, braces, newlines, and attempted field names in page content remain escaped string data and cannot alter the structural framing. Unicode direction/zero-width/private-use controls are normalized out.

## Material-store assessment

- `session-materials:${sessionId}` is an injective prefix construction. `AssetPrincipal.key` is opaque and compared as a parameterized exact string; no delimiter parsing exists, so a crafted session id cannot escape into another principal namespace.
- Material writes use parameterized SQL, and table-name overrides accept only a strict identifier pattern.
- Reads constrain both material id and session id and now require a non-deleted parent session. Foreign and nonexistent ids are indistinguishable (`null`).
- The hard-delete foreign key uses `ON DELETE CASCADE`; soft-deleted parents are explicitly hidden as described above.

## Byte-cap and decompression assessment

The cap is enforced while consuming `response.body`; `Content-Length` is only an early truncation hint. Undici's fetch implementation applies gzip/deflate/Brotli decoding before exposing that body stream, so the 5 MiB cap applies to decoded bytes rather than compressed wire bytes. This bounds gzip/Brotli expansion retained by the tool. The absolute body deadline separately bounds slow delivery.

PDF input is therefore capped after HTTP decoding, then page count, raster work, and extracted-text size receive independent bounds. Parser CPU/heap isolation would still be stronger than in-process parsing, but no unbounded page fan-out, raster extraction, or persisted text expansion remains in this path.

## Neutrality scan

The requested token scan over added diff lines returns zero matches.

## Verification

- Root TypeScript check with an 8 GiB heap: passed.
- Runtime/server/document tests with Node 22, 1 GiB heap, and at most two workers: 1,120 passed, 7 skipped.
- Complete storage package suite with the same test limits: 925 passed, 102 skipped. Skips are external PostgreSQL/environment-gated suites.
- `git diff --check`: passed.

CONVERGED: yes
