# RuntimeStore reference server

The `@openmaic/storage/server` subpath exports a Node-only HTTP request handler implementing the [RuntimeStore HTTP contract](./runtime-http-contract.md). It accepts any injected `RuntimeStore`; the runnable `@openmaic/storage/server/reference` composition uses `PgRuntimeStore`, initializes its schema, and demonstrates the required node-postgres checkout/transaction/release pattern.

This module is a reference, not a production authentication service. A production host must supply its own authenticated identity and authorization policy. It must also terminate TLS, bound request sizes and timeouts, rate-limit abusive clients, keep database credentials outside the process image, and expose the service only through an appropriate application gateway.

## Deployment

Build the package and run the compiled entrypoint in a host that provides `pg`:

```sh
DATABASE_URL=postgres://user:password@host/database PORT=3000 \
  node packages/@openmaic/storage/dist/server/reference.js
```

The example binds to `127.0.0.1`. Its bearer token payload is used directly as the demo `learnerKey`, self-merge is the only allowed merge, and admin operations are denied. Replace all three hooks before exposing a deployment:

- `authenticate(req)` must validate a real credential and derive the canonical learner partition from server-controlled identity state.
- `authorizeMerge(principal, fromKey, toKey)` must explicitly establish that the principal may migrate the complete source partition into the destination identity. Default denial is intentional.
- `authorizeAdmin(principal)` must require a separately protected administrative role. Default denial is intentional.

The package has no PostgreSQL driver runtime dependency. A host injects its `Pool` (or another compatible `Queryable`) and owns driver lifecycle. Every transactional operation must check out a fresh connection, issue `BEGIN`, run all callback queries on that same connection, issue `COMMIT` or `ROLLBACK`, and release it in `finally`.

## Endpoint authorization matrix

The matrix treats learner, merge, and admin credentials as separate capabilities. An admin-only or merge-only credential does not implicitly own a learner partition; a deployment may combine capabilities, but every applicable check still has to pass.

| Method and path | No credential | Owning learner | Other learner | Merge-authorized | Admin-authorized |
| --- | --- | --- | --- | --- | --- |
| `POST /runtime/sessions` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `GET /runtime/sessions/{sessionId}` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `PATCH /runtime/sessions/{sessionId}/status` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `DELETE /runtime/sessions/{sessionId}` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `GET /runtime/stages/{stageId}/learners/{learnerKey}/sessions` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `POST /runtime/sessions/{sessionId}/records` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `GET /runtime/sessions/{sessionId}/records` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `POST /runtime/learners/merge` | Deny (`401`) | Deny by default | Deny by default | Allow | Deny |
| `DELETE /runtime/stages/{stageId}/learners/{learnerKey}` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `DELETE /runtime/stages/{stageId}` | Deny (`401`) | Deny (`403`) | Deny (`403`) | Deny (`403`) | Allow |
| `DELETE /runtime` | Deny (`401`) | Deny (`403`) | Deny (`403`) | Deny (`403`) | Allow |

## Threat model

`learnerKey` is an opaque partition key, never a credential. An attacker can alter path segments and JSON bodies, so trusting a submitted key enables lateral movement: reading another learner's sessions or records, writing records into their sessions, changing status, or deleting their data. The handler authenticates every contract operation and compares stored or submitted learner ownership before touching learner-scoped data. A mismatch returns `403 FORBIDDEN_LEARNER`; missing credentials return `401 UNAUTHENTICATED`.

Merge is a privilege-escalation boundary because it rewrites every source session across every stage. Merely owning either key is insufficient in a real identity system: the authorization hook must verify the account-linking or identity-upgrade proof for both the source and destination. The default is deny.

Stage cascade deletion and whole-runtime deletion are admin-plane capabilities. If exposed to ordinary learners they can erase every partition on one stage or across the entire runtime store, so both routes are controlled by the separate admin authorization hook and denied by default. Production systems should isolate admin credentials, audit decisions, protect against confused-deputy use, and avoid deriving admin authority from a learner-controlled claim.

Authentication failures and authorization denials should be logged without recording bearer credentials or sensitive request payloads. Operators should monitor repeated cross-learner denials, merge attempts, and admin-plane calls as possible account-enumeration or privilege-escalation signals.
