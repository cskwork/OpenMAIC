# Stage access fidelity repair

## Verified reference contract

I verified the access decisions in the reference tag with `git show` before changing this
worktree. The deciding read/write branch is:

```ts
case 'read': {
  const meta = await readMeta(action.stageId);
  if (!meta) return 'not-found';
  return meta.deletedAt !== null ? 'not-found' : 'allow';
}
case 'write': {
  const meta = await readMeta(action.stageId);
  if (!meta) return 'not-found';
  if (meta.ownerId !== ownerId) return 'forbid';
  return meta.deletedAt !== null ? 'not-found' : 'allow';
}
```

The in-transaction store gate independently makes the same capability-read decision:

```ts
const authorized = operation.mode === 'read' || row.owner_id === options.ownerId;
```

The product access resolver folds both an absent document and a tombstone into `null`:

```ts
const access = await readStageAccessIncludingDeleted(stageId, queryable);
if (!access || access.deletedAt !== null) return null;
return access;
```

The reference stage library is not the generic document list. Its collection route resolves the
current owner and calls the owner-filtered list:

```ts
const { ownerId, newAnonId } = await getOwnerId();
const dp = await getDataProvider();
const list = await dp.stages.list(ownerId);
```

Therefore the reproduced contract is:

- A live stage id is a read capability. Ownership and publication state do not restrict a direct
  read by id.
- Writes and deletes require `stage_meta.owner_id` to equal the request owner. A foreign document
  mutation through the generic document route returns `403` with the existing
  `FORBIDDEN_DOCUMENTS` error shape.
- The generic `GET /documents` list is refused. The stage library route lists only live stages
  owned by its resolved anonymous-cookie identity.
- Delete sets `stage_meta.deleted_at` without deleting document, scene, or outline rows. A
  tombstoned id reads as absent, cannot be written or recreated, and repeated owner deletion is
  idempotent.

## Changes made

- Added the `stage_meta` schema, including ownership, visibility, tombstone indexes, and an
  idempotent backfill from the previous `document_stages.owner_id` column.
- Added the reference method/path classifier and three-way access decision (`allow`, `forbid`,
  `not-found`) for the generic persistence route.
- Added an owner-bound document-store decorator. It locks and verifies `stage_meta` in the same
  transaction as document operations, atomically claims new ids, permits reads by id, restricts
  writes to the owner, owner-filters lists, and tombstones deletes.
- Changed the PostgreSQL store's direct stage/scene reads to be capability-by-id while preserving
  owner-filtered writes, folders, and lists. Bumped `@openmaic/storage` from `0.12.0` to `0.13.0`.
- Replaced the agent runner and stage-library use of the package's invented `forOwner` read
  partition with the `stage_meta` decorator.
- Made `/api/persistence/documents*` resolve the same `anonymous_id` cookie identity as agent
  sessions. Runtime and asset authentication remain on their existing development-token path.
  Newly minted cookies are returned on success and error responses.

## Split-brain regression and mutation result

`tests/persistence/stage-access-fidelity.test.ts` uses one PostgreSQL-compatible in-memory database
for the shared provider. It saves a stage through the agent's owner-bound store, then loads it
through `/api/persistence/documents/:id` with the same anonymous cookie. The response is `200` and
contains the saved stage.

The same suite verifies that a second anonymous owner can read the stage, cannot save it, receives
`403 FORBIDDEN_DOCUMENTS` through the HTTP mutation path, and has an empty library while the owner
lists the stage. It also verifies that deletion leaves joined document and metadata rows present,
sets `deleted_at`, and refuses resurrection.

Mutation check: I temporarily changed the transaction gate from
`operation.mode !== 'read' && row.owner_id !== options.ownerId` to an unconditional owner
comparison. The capability-policy test exited `1` at the second-owner read:

```text
expected null to match object { stage: { id: "stage-capability-policy" } }
```

The correct condition was restored, and all three fidelity tests then passed.

## Verification

- Document-store and document-HTTP contracts: 125 passed.
- Agent-runtime suite: passed.
- Persistence and stage route suites: 91 passed.
- Remaining route suites: 107 passed.
- Fidelity regression suite: 3 passed.
- `@openmaic/storage` typecheck and build: passed.
- Package version bump check against `origin/integration/agent-workbench`: passed.
- Reference leak scan: passed (`LEAKSCAN_EXIT=0`).

## Reference behavior outside this upstream slice

The reference also coordinates account merges, owner-identity retirement, public discovery,
bookmarks, publication timestamps, and document-origin migration state. This upstream worktree has
only anonymous-cookie ownership and no corresponding account-merge, discovery, bookmark, or
publication subsystems, so those integrations were not invented here. The access-relevant
`is_public` field is retained in `stage_meta`, but direct reads intentionally do not consult it.

Historical rows whose previous `document_stages.owner_id` is non-null are backfilled exactly.
Rows from the older null-owner document path have no recoverable owner identity in upstream; they
remain unclaimed/reserved rather than being assigned to whichever visitor reaches them first.
