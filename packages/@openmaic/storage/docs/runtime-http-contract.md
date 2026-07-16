# RuntimeStore HTTP contract

This contract exposes the complete `RuntimeStore` interface over JSON HTTP. All paths below are relative to a deployment-defined base URL. Path segments and query parameter values are percent-encoded UTF-8 strings. Request and response bodies use `application/json`; successful operations with no return value respond with `204 No Content`.

## Endpoints

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `POST` | `/runtime/sessions` | Create a session from a `RuntimeSessionInit`. The server stamps `runtimeDslVersion`; a client-submitted value is ignored. | `201` with the full `RuntimeSession` |
| `GET` | `/runtime/sessions/{sessionId}` | Get one session. | `200` with the `RuntimeSession`, or `404` if absent |
| `PATCH` | `/runtime/sessions/{sessionId}/status` | Set status from `{ "status", "updatedAt" }`. | `204` |
| `DELETE` | `/runtime/sessions/{sessionId}` | Delete a session and all of its records. | `204` |
| `GET` | `/runtime/stages/{stageId}/learners/{learnerKey}/sessions` | List a partition's sessions, ordered by the instant represented by `createdAt`, then by `id` for deterministic ties. | `200` with `RuntimeSession[]` |
| `POST` | `/runtime/sessions/{sessionId}/records` | Append a `RuntimeRecordInit`; body `sessionId` must match the path. | `201` with the full `RuntimeRecord` |
| `GET` | `/runtime/sessions/{sessionId}/records` | List records ordered by `seq`. Optional `?sceneId={sceneId}` returns only records anchored to that scene and excludes unanchored records. | `200` with `RuntimeRecord[]` |
| `POST` | `/runtime/learners/merge` | Atomically re-key all sessions across all stages from `{ "fromLearnerKey", "toLearnerKey" }`. | `200` with `{ "moved": number }` |
| `DELETE` | `/runtime/stages/{stageId}/learners/{learnerKey}` | Delete one learner's sessions and records on one stage. | `204` |
| `DELETE` | `/runtime/stages/{stageId}` | Cascade-delete every learner's sessions and records on one stage. | `204` |

`GET /runtime/sessions/{sessionId}/records` returns an empty array when the session has no records or is absent, matching `RuntimeStore.listRecords`. Deleting an absent target succeeds.

## Server-assigned sequence

`seq` is server-assigned. The append request body is a `RuntimeRecordInit`. If it includes `seq`, that value is ignored; the store's assigned value is authoritative. The server allocates the next per-session monotonic sequence number atomically with the insert, starting at `0`, and the response returns the full `RuntimeRecord`, including the assigned `seq`.

Likewise, `runtimeDslVersion` is server-assigned when a session is created. If the request body includes `runtimeDslVersion`, that value is ignored; the store's assigned value is authoritative.

## Payload domain

HTTP implementations carry record payloads through JSON and therefore MUST accept only plain JSON values that survive serialization without changing meaning. They MUST fail loud before sending values such as `Map`, `Set`, `Date`, non-finite numbers, nested `undefined`, `bigint`, sparse arrays, strings containing U+0000, U+2028, or U+2029, class instances, and circular references. This is intentionally narrower than `BrowserRuntimeStore`, whose structured-clone persistence can preserve values such as `Map`, `Set`, and `Date` that JSON cannot.

## learnerKey security model

`learnerKey` appears in paths, query parameters, and request bodies, but the server MUST derive or verify `learnerKey` from the authenticated session and MUST NOT blindly trust the client-submitted value. `learnerKey` is an opaque partition key, not proof of identity or authorization; trusting it verbatim creates a lateral-authorization vulnerability that lets one learner read, merge, or delete another learner's runtime data. The same rule applies to both keys in `mergeLearner`; authorization policy must explicitly permit the authenticated principal to migrate the source partition into the destination partition.

The conformance server in this package is test-only and does not implement an authentication or authorization model; deriving `learnerKey` from authentication is left to the reference server in #939 Part D.

## Errors

Every non-2xx response has this machine-readable JSON shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "@openmaic/storage: invalid runtime session ...",
    "details": []
  }
}
```

`details` is optional. `message` preserves the semantic wording of the backing store error so an HTTP client can reconstitute the fail-loud exceptions callers receive from `BrowserRuntimeStore`.

| Condition | HTTP status | Error code | Client behavior |
| --- | --- | --- | --- |
| Malformed JSON, an invalid envelope or payload, invalid learner keys, a body/path mismatch, or append to a non-active session | `400` | `VALIDATION_FAILED` | Throw `HttpRuntimeStoreError` (an `Error`) with the server message |
| Session does not exist | `404` | `SESSION_NOT_FOUND` | `getSession` returns `undefined`; operations that require the session throw `HttpRuntimeStoreError` with the browser store's `no session` semantics |
| Route does not exist | `404` | `ROUTE_NOT_FOUND` | Throw `HttpRuntimeStoreError` |
| A stored session has a future runtime DSL version | `409` | `FUTURE_VERSION` | Throw `HttpRuntimeStoreError` with the browser store's fail-loud `newer than this client's` semantics |
| Session id already exists | `409` | `SESSION_ALREADY_EXISTS` | Throw `HttpRuntimeStoreError` with the browser store's `already exists` semantics |
| Unexpected server failure | `500` | `INTERNAL_ERROR` | Throw `HttpRuntimeStoreError` |

The client MUST use the machine-readable code, not status alone, when an operation has special behavior. In particular, only `SESSION_NOT_FOUND` is translated to `undefined` by `getSession`. Sessions returned by reads MUST be forward-migrated through the client's `migrateRuntime` before they are returned, because the server may lag the client schema version. Corrupt sessions remain fail-loud on direct reads and are omitted from partition listings, matching `BrowserRuntimeStore`.

## Retry and atomicity guarantees

`mergeLearner`, `DELETE /runtime/sessions/{sessionId}`, `DELETE /runtime/stages/{stageId}/learners/{learnerKey}`, and `DELETE /runtime/stages/{stageId}` MUST be safely retryable. Repeating a completed merge moves `0`; repeating a delete succeeds with `204`. A merge is atomic across every matching source session and MUST NOT expose a partial move. Delete endpoints cascade atomically to the target sessions' records.

`POST /runtime/sessions` and record append are not implicitly retry-safe: clients must not retry them after an ambiguous transport failure unless a deployment adds a separate idempotency-key policy. Session ids and record ids remain caller-owned uniqueness keys, while record `seq` remains exclusively server-owned.
