# KVStore HTTP contract

This contract exposes the `KVStore` operations — `get` / `set` / `remove` / `keys(prefix?)` — over JSON HTTP for the **`account` scope only**. All paths below are relative to a deployment-defined base URL. Path segments and query parameter values are percent-encoded UTF-8 strings. Request and response bodies use `application/json`; successful operations with no return value respond with `204 No Content`.

The conformance server in this package is test-only. It implements no authentication or authorization model beyond what the contract's response codes require; deriving the principal from an authenticated session is the reference server's job.

## The scope is not on the wire

`KVStore` distinguishes two scopes. `account` is user data a server-backed deployment syncs across devices (provider and model configuration, profile); `device` is machine-local state (theme, locale, layout) that must never leave the machine. That is a property of the primitive, not a deployment setting.

This contract therefore has **no scope at all**: no scope path segment, no scope query parameter, no scope header, no scope body field. There is nothing to set to `device`, so there is no configuration or client bug that could ship a device value to a server — a request carrying a device value is not a request this contract can express. Servers MUST reject a request that invents a scope in any of those channels with `400 VALIDATION_FAILED` rather than ignoring it, so a client attempting to describe a scope fails loud instead of silently having its intent discarded.

The body is a channel too, and it is easy to miss on the operations that have no body of their own. `get`, `remove`, and `keys` are bodyless: a server that routes them without reading the body would let `GET /kv/keys` with `{"scope":"device"}` succeed, which is the "every channel" guarantee failing silently rather than loudly. So a bodyless method (`GET`, `DELETE`) MUST reject **any** request body outright — there is nothing legitimate for it to carry — and only `set` reads a body, where a `scope` field in it is rejected. Every one of `{get, set, remove, keys}` × `{query, header, body}` is closed, and the shared suite pins each cell.

The client half mirrors this in three layers, only the last of which actually carries the weight:

1. `HttpAccountKV` is the only object in `@openmaic/storage` that can reach this contract, and its scope parameter admits `'account'` alone — a literal `'device'` at a call site is a type error. It also **refuses one at runtime**, because the type is not enough: TypeScript compares method parameters bivariantly, so this transport stands in for the wider `KVStore` wherever one is expected, and a caller holding it that way can pass any scope. Silently dropping that argument is how a device value reaches a server, so the transport takes the scope and fails loud on anything but `account`.
2. `HttpKVStore` — the full `KVStore` — is the one place the two scopes are told apart. An unrecognized scope is refused rather than folded into the account path: guessing would send a value the caller believed was device-local to a server.
3. `HttpKVStore` requires a **`LocalKVStore`** for the `device` scope — a store branded as keeping its values on this machine. `KVStore` alone is not enough, because a networked store satisfies it structurally: `HttpAccountKV` *is* a `KVStore` with one optional parameter fewer, so a `KVStore`-typed parameter would accept the very transport this design exists to exclude. The brand makes that a type error, and a runtime check refuses a remote store that a cast smuggled past the types.

There is no default and no fallback, so a deployment cannot end up with device values that have nowhere local to go.

The same pairing rule reaches the zustand adapter, which is where a store and a scope are chosen as separate arguments and therefore the easiest place to pair them wrongly: `kvPersistStorage(store, 'device')` requires a **`DeviceSafeKVStore`** at the type level and checks the brand at runtime. `DeviceSafeKVStore` is the capability that actually matters — "a `device` write stays on this machine" — and it is broader than `LocalKVStore`: it admits both a fully-local backend and the `HttpKVStore` composite, which routes `device` to its injected local backend while sending only `account` to a server. What it excludes is the pure `HttpAccountKV` transport, which has no local device backend and would put a device value on the wire; that store declares the capability `false` and is double-rejected.

### Account settings are only as isolated as the deployment makes them

The `account` scope is where a server-backed deployment syncs a user's settings across devices, and the contract's principal derivation keeps one account from addressing another's keys over the wire. That is a routing guarantee, not a storage one. Before enabling settings sync, a deployment **MUST** provide real per-user isolation of the stored rows (the `(principal, key)` partition enforced end to end, not merely by a query filter a bug could drop) and **encryption at rest** for the values, which hold user configuration and profile data. The reference server is a reference: it demonstrates the principal derivation, not a production isolation or encryption posture, and MUST NOT be exposed with real user data as-is.

## A key is an opaque string

A key is **opaque**. Callers compose keys from unconstrained DSL identifiers — a `stageId` may legitimately be `stage/one`, and the DSL constrains ids only to be strings — so a key may contain `/`, `\`, `:`, `%`, spaces, or any other character that resembles structure, and the contract MUST NOT reject one for that. Path traversal is defended by **encoding, not by rejection**: the client percent-encodes the whole key into a single URL path segment (`stage/one` → `stage%2Fone`), so a separator can never open a new segment on the wire, and a server **MUST** store the decoded key as an opaque value — a bound query parameter or a derived, constrained storage id — **never as a path component or an unescaped fragment of a query**. `a%2F..%2F..%2Fb` is a legal request; it decodes to the single opaque key `a/../../b`, which addresses one entry and traverses nothing.

The key domain belongs to the `KVStore` primitive, not to this contract — **every** backend enforces the same rules, so a key that round-trips in the browser round-trips over HTTP too, and the shared contract suite asserts it against both. Those rules are only the ones encoding cannot cover and the transport cannot carry, and none of them can be produced by a caller composing `prefix + id`: a key MUST NOT be empty, MUST NOT be exactly `.` or `..` (which URL path normalization would eat before routing), and MUST NOT contain U+0000 or an unpaired UTF-16 surrogate (which the transports underneath cannot represent). Clients reject a violating key before sending; servers MUST reject one with `400 VALIDATION_FAILED`. A key that merely *looks* like a path is not a violation.

The key domain has **no length constraint** — a `stageId` is a string of any length, so any tight bound would eventually reject a legitimate `prefix + id` (a 500-character id under a `editor-current-scene:` prefix already crosses 512 bytes). Backends MAY apply a generous denial-of-service ceiling so a single key cannot be megabytes and blow out a URL or a server index, but it is a resource guard, not part of the key domain, and MUST sit far above any identifier a caller could realistically produce; the backends here cap at 8 KiB, orders of magnitude beyond a real id.

## Endpoints

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/kv/entries/{key}` | Read one value. | `200` with `{ "value": <json> }`, or `404 KEY_NOT_FOUND` |
| `PUT` | `/kv/entries/{key}` | Write one value from `{ "value": <json> }`. Replaces any existing value. | `204` |
| `DELETE` | `/kv/entries/{key}` | Delete one value. Idempotent; deleting an absent key succeeds. | `204` |
| `GET` | `/kv/keys` | List the principal's keys. Optional `?prefix={prefix}` returns only keys starting with it. | `200` with `string[]` |

Both read routes MUST be served with `Cache-Control: no-store`, and MUST NOT be cached by any intermediary. `account` is by definition the scope another device may have just written, and neither the client nor the server has a way to invalidate a cached copy when that happens — a cached read serves precisely the stale state this scope exists to move past. The client sends its reads with `cache: 'no-store'` for the same reason. Writes carry no such requirement, having nothing to read from a cache.

The value travels in an envelope rather than as the body itself. `KVStore.get` cannot distinguish a stored `null` from an absent key — both are `null` to a caller — but the wire still has to be unambiguous: a bare `null` body would be indistinguishable from an empty body or a stored `null`, leaving the framing to depend on `Content-Length`. The envelope makes "there is a value, and it is `null`" a statement the response can make. `get` maps `404 KEY_NOT_FOUND` back to `null`, matching `KVStore.get`; the client MUST use the machine-readable code, not the status alone, so a `404 ROUTE_NOT_FOUND` stays an error instead of masquerading as a missing key.

`GET /kv/keys` returns every matching key. The listing is not paginated, matching `GET /documents` in the [DocumentStore HTTP contract](./document-http-contract.md); the primitive is sized for small configuration values, and a deployment that outgrows an unbounded listing needs a change to `KVStore` itself, not a second listing shape here.

The prefix is a **literal, byte-for-byte** comparison, not a pattern. A prefix is as opaque as a key: it too travels in the query string rather than as a path segment, so it may be empty (that is what "list everything" means), may be `.` or `..` (legitimate prefixes of keys such as `.hidden`), and may contain any character a key may — `%`, `_`, `\`, `/`, and the rest. Only the transport-fatal characters and the DoS ceiling constrain it.

Because both the prefix and the keys it matches are opaque, a server MUST escape every metacharacter of its own query language before applying the comparison. In the obvious SQL translation, `key LIKE prefix || '%'`, that means `%` and `_`, **and the backslash** — PostgreSQL's default `LIKE` escape character. Backslash is the one an implementer is most likely to skip, precisely because it is easy to assume a key could never contain one; it can — a key is opaque — and so can a prefix, and both reach the query. Escape all three, or the literal comparison silently becomes a pattern match. The result order is unspecified, but the listing MUST NOT repeat a key.

## Value domain

Values travel through JSON, so this backend accepts only plain JSON values that survive serialization without changing meaning. It MUST fail loud before sending values such as `Map`, `Set`, `Date`, non-finite numbers, negative zero, nested `undefined`, `bigint`, sparse arrays, symbol-keyed properties, non-enumerable properties, strings containing U+0000, class instances, and circular references. U+2028 and U+2029 are valid JSON string contents and MUST be accepted. Keys are held to the same rule, because a key becomes a URL path segment.

This is intentionally narrower than `BrowserKVStore`, whose `JSON.stringify` would quietly rewrite a `Date` into a string or drop a nested `undefined`. Where the browser backend is silently lossy, the HTTP backend refuses.

Both backends agree on one deliberate exception: `set(key, value)` where `value` has no JSON representation at all (`undefined`, a function, a symbol) is a **removal**, not a write. Storing such a value would produce an entry that throws on read, so the key is deleted instead.

Every backend decides that by inspecting the value, never by trial-serializing it, and this is a rule about *all* of them rather than an HTTP detail. A `JSON.stringify` pre-flight runs caller code — `toJSON`, getters — before any validation has looked at anything, which reclassifies values as deletes (`{ toJSON: () => undefined }` stringifies to `undefined`) and lets a stateful accessor show the probe one value and the serializer another. Two backends probing and validating in different orders would disagree about whether a write was a delete, which is precisely the divergence the shared suite exists to prevent. Scope and key are validated first, then the delete case is recognized by type, and only then is anything serialized. A value that still fails to serialize is refused rather than quietly deleted.

## Principal derivation

The principal is derived server-side from the authenticated session and never appears in a path, query parameter, or body. This is the same non-negotiable that governs `learnerKey` in the [RuntimeStore HTTP contract](./runtime-http-contract.md): a client-submitted principal is not proof of identity, and trusting one turns every route here into a lateral-authorization vulnerability that lets one account read or overwrite another's configuration.

Every route requires an authenticated principal; there is no anonymous KV. Because keys are caller-chosen and this store holds user configuration, a deployment MUST scope every operation — including `GET /kv/keys` — to the derived principal, and MUST NOT expose a cross-principal listing on this contract.

## Errors

Every non-2xx response has this machine-readable JSON shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "@openmaic/storage: kv write body must carry \"value\"",
    "details": []
  }
}
```

`details` is optional.

| Condition | HTTP status | Error code | Client behavior |
| --- | --- | --- | --- |
| Malformed JSON, a key violating the identifier rules, a missing `value` member, a scope in any channel, or a non-JSON value | `400` | `VALIDATION_FAILED` | Throw `HttpKVStoreError` with the server message |
| Request body exceeds the deployment's size bound | `413` | `PAYLOAD_TOO_LARGE` | Throw `HttpKVStoreError` |
| No entry is stored under the key | `404` | `KEY_NOT_FOUND` | `get` returns `null` |
| Route does not exist | `404` | `ROUTE_NOT_FOUND` | Throw `HttpKVStoreError` |
| Missing or invalid credential | `401` | `UNAUTHENTICATED` | Throw `HttpKVStoreError` |
| Principal may not perform the operation | `403` | `FORBIDDEN_KV` | Throw `HttpKVStoreError` |
| Unexpected server failure | `500` | `INTERNAL_ERROR` | Throw `HttpKVStoreError`; the handler does not expose internal details |

Only `KEY_NOT_FOUND` becomes `null`. Status alone is not sufficient — `ROUTE_NOT_FOUND` shares its status and means a broken deployment, and a `401` or `403` must never be reported as a missing key.

A response the client cannot interpret — a body that is not JSON despite a 2xx status, a `get` body without a `value` member, a `keys` body that is not an array of strings — raises `MALFORMED_RESPONSE`, a client-side code with no server counterpart. It is a typed storage error like any other: the client never lets a native `SyntaxError` escape in its place.

## Retry and atomicity guarantees

Every operation is safely retryable. `PUT` is a whole-value replacement and therefore idempotent for the same body; `DELETE` is idempotent because deleting an absent key succeeds; both `GET` routes are reads. The contract offers no compare-and-swap: a concurrent write is last-writer-wins per key, which suits the small independent configuration values this primitive exists for. Callers needing an atomic read-modify-write should not model that state as KV.
