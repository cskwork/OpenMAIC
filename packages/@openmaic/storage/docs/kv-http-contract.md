# KVStore HTTP contract

This contract exposes the `KVStore` operations — `get` / `set` / `remove` / `keys(prefix?)` — over JSON HTTP for the **`account` scope only**. All paths below are relative to a deployment-defined base URL. Path segments and query parameter values are percent-encoded UTF-8 strings; a key used as a path segment MUST NOT be exactly `.` or `..`, because URL parsers normalize those dot segments before routing. Request and response bodies use `application/json`; successful operations with no return value respond with `204 No Content`.

## The scope is not on the wire

`KVStore` distinguishes two scopes. `account` is user data a server-backed deployment syncs across devices (provider and model configuration, profile); `device` is machine-local state (theme, locale, layout) that must never leave the machine. That is a property of the primitive, not a deployment setting.

This contract therefore has **no scope at all**: no scope path segment, no scope query parameter, no scope body field. There is nothing to set to `device`, so there is no configuration, header, or client bug that could ship a device value to a server — a request carrying a device value is not a request this contract can express. Servers MUST reject a write body that invents a scope field with `400 VALIDATION_FAILED` rather than ignoring it, so a client attempting to describe a scope fails loud instead of silently having its intent discarded.

The client half mirrors this. `HttpAccountKV` is the only object in `@openmaic/storage` that can reach this contract, and none of its methods takes a scope. `HttpKVStore` — the full `KVStore` — is the one place the two scopes are told apart: it routes `account` to that transport and `device` to a local backend, which it requires at construction. There is no default and no fallback, so a deployment cannot end up with device values that have nowhere local to go.

## Endpoints

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/kv/entries/{key}` | Read one value. | `200` with `{ "value": <json> }`, or `404 KEY_NOT_FOUND` |
| `PUT` | `/kv/entries/{key}` | Write one value from `{ "value": <json> }`. Replaces any existing value. | `204` |
| `DELETE` | `/kv/entries/{key}` | Delete one value. Idempotent; deleting an absent key succeeds. | `204` |
| `GET` | `/kv/keys` | List the principal's keys. Optional `?prefix={prefix}` returns only keys starting with it. | `200` with `string[]` |

The value is wrapped in an envelope rather than being the body itself, because a stored value may legitimately be `null` and a bare `null` body could not be told apart from an absent entry. `get` maps `404 KEY_NOT_FOUND` back to `null`, matching `KVStore.get`; the client MUST use the machine-readable code, not the status alone, so a `404 ROUTE_NOT_FOUND` stays an error instead of masquerading as a missing key.

`GET /kv/keys` returns every matching key. The listing is not paginated, matching `GET /documents` in the [DocumentStore HTTP contract](./document-http-contract.md); the primitive is sized for small configuration values, and a deployment that outgrows an unbounded listing needs a change to `KVStore` itself, not a second listing shape here.

## Value domain

Values travel through JSON, so this backend accepts only plain JSON values that survive serialization without changing meaning. It MUST fail loud before sending values such as `Map`, `Set`, `Date`, non-finite numbers, negative zero, nested `undefined`, `bigint`, sparse arrays, symbol-keyed properties, non-enumerable properties, strings containing U+0000, class instances, and circular references. U+2028 and U+2029 are valid JSON string contents and MUST be accepted. Keys are held to the same rule, because a key becomes a URL path segment.

This is intentionally narrower than `BrowserKVStore`, whose `JSON.stringify` would quietly rewrite a `Date` into a string or drop a nested `undefined`. Where the browser backend is silently lossy, the HTTP backend refuses.

Both backends agree on one deliberate exception: `set(key, value)` where `value` has no JSON representation at all (`undefined`, a function, a symbol) is a **removal**, not a write. Storing such a value would produce an entry that throws on read, so the key is deleted instead.

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
| Malformed JSON, a missing `value` member, a scope field, or a non-JSON value | `400` | `VALIDATION_FAILED` | Throw `HttpKVStoreError` with the server message |
| Request body exceeds the deployment's size bound | `413` | `PAYLOAD_TOO_LARGE` | Throw `HttpKVStoreError` |
| No entry is stored under the key | `404` | `KEY_NOT_FOUND` | `get` returns `null` |
| Route does not exist | `404` | `ROUTE_NOT_FOUND` | Throw `HttpKVStoreError` |
| Missing or invalid credential | `401` | `UNAUTHENTICATED` | Throw `HttpKVStoreError` |
| Principal may not perform the operation | `403` | `FORBIDDEN_KV` | Throw `HttpKVStoreError` |
| Unexpected server failure | `500` | `INTERNAL_ERROR` | Throw `HttpKVStoreError` |

A response the client cannot interpret — a `get` body without a `value` member, a `keys` body that is not an array of strings — raises `MALFORMED_RESPONSE`, a client-side code with no server counterpart.

## Retry and atomicity guarantees

Every operation is safely retryable. `PUT` is a whole-value replacement and therefore idempotent for the same body; `DELETE` is idempotent because deleting an absent key succeeds; both `GET` routes are reads. The contract offers no compare-and-swap: a concurrent write is last-writer-wins per key, which suits the small independent configuration values this primitive exists for. Callers needing an atomic read-modify-write should not model that state as KV.
