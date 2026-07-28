# AssetProvider HTTP contract

This contract exposes the DSL `StorageProvider` interface — `put(blob, meta?) → ref`, `resolve(ref) → url`, `remove(ref)` — over HTTP. All paths below are relative to a deployment-defined base URL. Path segments are percent-encoded UTF-8 strings and MUST NOT be exactly `.` or `..`, because URL parsers normalize those dot segments before routing. Asset bytes travel as raw request and response bodies; every other body is `application/json`, and successful operations with no return value respond with `204 No Content`.

## Endpoints

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `PUT` | `/assets/{ref}` | Store bytes under a content ref the client computed. Body is the raw bytes; `Content-Type` records the asset's media type. Idempotent. | `204` |
| `GET` | `/assets/{ref}/url` | Resolve a ref to a URL a browser can load. | `200` with `{ "url": "…" }`, or `404 ASSET_NOT_FOUND` |
| `DELETE` | `/assets/{ref}` | Remove the asset. Idempotent; removing an absent asset succeeds. | `204` |
| `GET` | `/assets/{ref}/content` | Optional. Serve the bytes. Proxying deployments implement it and point `resolve` at it; signed-URL deployments do not. | `200` with the bytes |

`resolve` maps `404 ASSET_NOT_FOUND` back to `null`, matching `StorageProvider.resolve`. The client MUST use the machine-readable error code, not the status alone: a `404 ROUTE_NOT_FOUND` is a deployment error, not an absent asset.

## Content addressing is end to end

A ref is `sha256-<64 lowercase hex>` over the asset's bytes. The client computes it before uploading, and the ref **is** the address it writes to — the same rule `BrowserAssetProvider` uses, so identical bytes produce an identical ref on every backend and a ref minted in the browser keeps resolving after a deployment moves to a server.

The server MUST re-hash the received body and reject a body that does not hash to the ref in the path with `400 ASSET_REF_MISMATCH`, and MUST reject a ref that is not of the content-addressed shape with `400 VALIDATION_FAILED`. Content addressing is therefore enforced rather than assumed: no client, proxy, or replayed request can bind chosen bytes to a ref another document already points at.

Two consequences follow from the ref being derived, not allocated:

- **Uploads are idempotent and retry-safe.** Re-uploading the same bytes is a no-op on the stored bytes. Repeating an upload after an ambiguous transport failure is always safe; no idempotency key is needed.
- **De-duplication survives the backend change.** The same bytes stored twice occupy one asset.

Metadata beyond the media type is not transported. `AssetMeta.contentType` travels as the `Content-Type` request header (`application/octet-stream` when the caller has none), and other `AssetMeta` members are dropped — exactly as `BrowserAssetProvider` drops them. A later re-upload with a corrected `Content-Type` wins, so a resolved media type never depends on which write happened first.

The read path is deliberately more permissive than the write path: `resolve` and `remove` treat a ref as an opaque lookup key and MUST NOT reject one merely for not being content-addressed. That keeps the primitive honest for documents carrying refs a future scheme issued; only writes are constrained, because only writes can create a mismatch.

## Resolved URLs

`resolve` returns a URL the browser can use directly as an `<img>` / `<audio>` / `<video>` `src`. The contract accommodates both deployment shapes without the document ever storing a raw URL — the document stores the ref, and the URL is minted per resolution:

- **Signed URL.** `url` is absolute and points wherever the bytes live (object storage, a CDN). It MAY be short-lived and single-use. The client returns it **byte-for-byte** and never re-serializes it, because normalizing a URL can invalidate its signature.
- **Proxied path.** `url` is root-relative (begins with `/`) and is served by the deployment itself, typically at `GET /assets/{ref}/content` under the same authentication as the rest of the contract. The path MUST already be correct for the deployment's mount point, since the client joins it to the base URL's **origin**, not to the base URL's path.

Any other `url` value — relative without a leading `/`, empty, or not a string — is a `MALFORMED_RESPONSE` on the client. A deployment configured with a path-only base URL (an app-mounted route such as `/api/persistence`) receives root-relative paths unchanged, because the browser resolves them against the document itself.

Because a resolved URL may expire, the HTTP client caches nothing across calls. It coalesces **concurrent** `resolve(ref)` calls onto one request so they share a single URL — matching `BrowserAssetProvider`, whose object URL must not be minted twice — and then forgets it. Handing back an expired signed URL later would be worse than asking again.

## Authentication and authorization

Every route requires an authenticated principal, and the principal is derived server-side from the authenticated session. It never appears in a path, query parameter, or body: a client-submitted principal is a lateral-authorization vulnerability, the same non-negotiable that governs `learnerKey` in the [RuntimeStore HTTP contract](./runtime-http-contract.md).

Whether the asset namespace is shared across principals or partitioned per principal is a deployment choice; refs are content-addressed and therefore identical across principals either way. A deployment that shares stored bytes between principals MUST NOT let one principal's `remove` break another principal's document: in that shape, `remove` is an unlink of the caller's claim on the asset, and reclaiming the bytes is a garbage-collection decision the host owns. From the caller's side the semantics are unchanged — after `remove(ref)`, that caller's `resolve(ref)` returns `null`.

Deployments SHOULD bound upload size and reject unsupported media types before storing. Since refs are unguessable only to the extent the bytes are, a deployment holding assets that are sensitive rather than merely large MUST NOT treat knowledge of a ref as authorization.

## Errors

Every non-2xx response has this machine-readable JSON shape:

```json
{
  "error": {
    "code": "ASSET_REF_MISMATCH",
    "message": "@openmaic/storage: asset bytes hash to ...",
    "details": []
  }
}
```

`details` is optional.

| Condition | HTTP status | Error code | Client behavior |
| --- | --- | --- | --- |
| Ref is not content-addressed on a write, or the request is otherwise invalid | `400` | `VALIDATION_FAILED` | Throw `HttpAssetProviderError` with the server message |
| Uploaded bytes do not hash to the requested ref | `400` | `ASSET_REF_MISMATCH` | Throw `HttpAssetProviderError` |
| Request body exceeds the deployment's size bound | `413` | `PAYLOAD_TOO_LARGE` | Throw `HttpAssetProviderError` |
| No asset is stored under the ref | `404` | `ASSET_NOT_FOUND` | `resolve` returns `null` |
| Route does not exist | `404` | `ROUTE_NOT_FOUND` | Throw `HttpAssetProviderError` |
| Missing or invalid credential | `401` | `UNAUTHENTICATED` | Throw `HttpAssetProviderError` |
| Principal may not perform the operation | `403` | `FORBIDDEN_ASSETS` | Throw `HttpAssetProviderError` |
| Unexpected server failure | `500` | `INTERNAL_ERROR` | Throw `HttpAssetProviderError` |

A resolve response the client cannot interpret raises `MALFORMED_RESPONSE`, a client-side code with no server counterpart.

## Retry and atomicity guarantees

Every operation in this contract is safely retryable. `PUT /assets/{ref}` is idempotent because the ref determines the content; `DELETE` is idempotent because removing an absent asset succeeds; both `GET` routes are reads. A `PUT` MUST NOT expose partially written bytes under its ref: a reader either sees the complete asset or no asset.
