# KVStore HTTP contract

This contract exposes the `KVStore` operations — `get` / `set` / `remove` / `keys(prefix?)` — over JSON HTTP for the **`account` scope only**. All paths below are relative to a deployment-defined base URL. Path segments and query parameter values are percent-encoded UTF-8 strings. Request and response bodies use `application/json`; successful operations with no return value respond with `204 No Content`.

The conformance server in this package is test-only. It implements no authentication or authorization model beyond what the contract's response codes require; deriving the principal from an authenticated session is the reference server's job.

## The scope is not on the wire

`KVStore` distinguishes two scopes. `account` is user data a server-backed deployment syncs across devices (provider and model configuration, profile); `device` is machine-local state (theme, locale, layout) that must never leave the machine. That is a property of the primitive, not a deployment setting.

This contract therefore has **no scope at all**: no scope path segment, no scope query parameter, no scope header, no scope body field. There is nothing to set to `device`, so there is no configuration or client bug that could ship a device value to a server — a request carrying a device value is not a request this contract can express. Servers MUST reject a request that invents a scope in any of those channels with `400 VALIDATION_FAILED` rather than ignoring it, so a client attempting to describe a scope fails loud instead of silently having its intent discarded.

The client half mirrors this in three layers, only the last of which actually carries the weight:

1. `HttpAccountKV` is the only object in `@openmaic/storage` that can reach this contract, and its scope parameter admits `'account'` alone — a literal `'device'` at a call site is a type error. It also **refuses one at runtime**, because the type is not enough: TypeScript compares method parameters bivariantly, so this transport stands in for the wider `KVStore` wherever one is expected, and a caller holding it that way can pass any scope. Silently dropping that argument is how a device value reaches a server, so the transport takes the scope and fails loud on anything but `account`.
2. `HttpKVStore` — the full `KVStore` — is the one place the two scopes are told apart. An unrecognized scope is refused rather than folded into the account path: guessing would send a value the caller believed was device-local to a server.
3. `HttpKVStore` requires a **`LocalKVStore`** for the `device` scope — a store branded as keeping its values on this machine. `KVStore` alone is not enough, because a networked store satisfies it structurally: `HttpAccountKV` *is* a `KVStore` with one optional parameter fewer, so a `KVStore`-typed parameter would accept the very transport this design exists to exclude. The brand makes that a type error, and a runtime check refuses a remote store that a cast smuggled past the types.

There is no default and no fallback, so a deployment cannot end up with device values that have nowhere local to go.

The same pairing rule reaches the zustand adapter, which is where a store and a scope are chosen as separate arguments and therefore the easiest place to pair them wrongly: `kvPersistStorage(store, 'device')` requires a `LocalKVStore` at the type level and checks the brand at runtime.

## A key is an identifier, never structure

The key domain belongs to the `KVStore` primitive, not to this contract — **every** backend enforces it, including the browser one. A key that the browser accepted but a server could not address would become unreachable the moment a deployment moved, and the claim that one shared contract suite proves the backends equivalent would be false in the one place it matters. The shared suite therefore asserts the rules against every backend.

Keys appear as path segments and arrive at the server percent-decoded, so their shape is part of the contract. A key MUST NOT be empty, MUST NOT be exactly `.` or `..` (URL parsers normalize those before routing), MUST NOT contain `/` or `\`, MUST NOT contain U+0000 or an unpaired UTF-16 surrogate, and MUST NOT exceed 512 UTF-8 bytes — a bound in bytes rather than characters, so a multi-byte key cannot exceed it while appearing to comply. Clients reject a violating key before sending; servers MUST reject one with `400 VALIDATION_FAILED`.

A server **MUST NOT use a key directly as a path component or as an unescaped fragment of a query**. `a%2F..%2F..%2Fb` is a legal request to make and decodes to something carrying separators; the key belongs in a bound parameter or a derived, constrained identifier, never in string-built structure.

## Endpoints

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/kv/entries/{key}` | Read one value. | `200` with `{ "value": <json> }`, or `404 KEY_NOT_FOUND` |
| `PUT` | `/kv/entries/{key}` | Write one value from `{ "value": <json> }`. Replaces any existing value. | `204` |
| `DELETE` | `/kv/entries/{key}` | Delete one value. Idempotent; deleting an absent key succeeds. | `204` |
| `GET` | `/kv/keys` | List the principal's keys. Optional `?prefix={prefix}` returns only keys starting with it. | `200` with `string[]` |

The value travels in an envelope rather than as the body itself. `KVStore.get` cannot distinguish a stored `null` from an absent key — both are `null` to a caller — but the wire still has to be unambiguous: a bare `null` body would be indistinguishable from an empty body or a stored `null`, leaving the framing to depend on `Content-Length`. The envelope makes "there is a value, and it is `null`" a statement the response can make. `get` maps `404 KEY_NOT_FOUND` back to `null`, matching `KVStore.get`; the client MUST use the machine-readable code, not the status alone, so a `404 ROUTE_NOT_FOUND` stays an error instead of masquerading as a missing key.

`GET /kv/keys` returns every matching key. The listing is not paginated, matching `GET /documents` in the [DocumentStore HTTP contract](./document-http-contract.md); the primitive is sized for small configuration values, and a deployment that outgrows an unbounded listing needs a change to `KVStore` itself, not a second listing shape here.

The prefix is a **literal, byte-for-byte** comparison, not a pattern. A server MUST validate it against the key rules below, minus the non-empty and dot-segment requirements — a prefix travels in the query string rather than as a path segment, so it may be empty (that is what "list everything" means) and it may be `.` or `..`, which are legitimate prefixes of keys such as `.hidden`. It MUST also escape every metacharacter of its own query language before applying it. In the obvious SQL translation, `key LIKE prefix || '%'`, that means `%`, `_` **and the backslash** — PostgreSQL's default `LIKE` escape character. Backslash is worth naming because it is the one an implementer is most likely to skip: a legal *key* can never contain one, so it is easy to conclude the client has already excluded it. The client has not; the prefix is a separate input, and it reaches the query. The result order is unspecified, but the listing MUST NOT repeat a key.

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
