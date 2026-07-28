# AssetProvider HTTP contract

This contract exposes the DSL `StorageProvider` interface — `put(blob, meta?) → ref`, `resolve(ref) → url`, `remove(ref)` — over HTTP. All paths below are relative to a deployment-defined base URL. Asset bytes travel as raw request and response bodies; every other body is `application/json`, and successful operations with no return value respond with `204 No Content`.

The conformance server in this package is test-only. It implements no authentication or authorization model beyond what the contract's response codes require; deriving a principal from an authenticated session is the reference server's job.

## A ref is an identifier, never structure

Refs appear as path segments and arrive at the server percent-decoded, so the shape rules are part of the contract rather than a client convenience. A ref MUST NOT be empty, MUST NOT be exactly `.` or `..` (URL parsers normalize those before routing), MUST NOT contain `/` or `\`, MUST NOT contain U+0000 or an unpaired UTF-16 surrogate, and MUST NOT exceed 512 UTF-8 bytes. Clients reject a violating ref before sending; servers MUST reject one with `400 VALIDATION_FAILED`.

Beyond rejecting those, a server **MUST NOT use a ref directly as a path component, filename, or unescaped query fragment.** `..%2F..%2Fetc%2Fpasswd` is a legal request to make and decodes to a traversal; a backend that joined the decoded value to a storage path would inherit it. Storage keys MUST be derived — re-hash the ref, or key the row by a value constrained to `[A-Za-z0-9._-]` — and the derivation MUST reject any segment containing `/`, `\`, or `..`. This applies to every backend the contract admits, including the filesystem and object-storage shapes.

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

The read path is deliberately more permissive about *shape* than the write path: `resolve` and `remove` treat a ref as an opaque lookup key and MUST NOT reject one merely for not being content-addressed. That keeps the primitive honest for documents carrying refs a future scheme issued. The identifier rules above still apply — permissive about shape is not permissive about traversal.

Zero-byte assets are legal. They hash like anything else, to the well-known SHA-256 of the empty input, so every empty asset in a deployment shares one ref by design.

## Media type

`AssetMeta.contentType` travels as the `Content-Type` request header, or `application/octet-stream` when the caller has none. Other `AssetMeta` members are not transported and are dropped — exactly as `BrowserAssetProvider` drops them.

On an upload the header is the asset's recorded media type, not transport decoration, so the client's authentication hook MUST NOT set `Content-Type`; a client whose hook does MUST fail loud rather than choose a winner, since a silently relabelled asset renders nowhere and reports nothing.

Because the stored type is caller-influenced and a proxied asset is served from the application's own origin, a server MUST NOT serve back whatever it was given:

- The server MUST hold `Content-Type` against an allowlist of **renderable** media types — the image, audio and video types the deployment actually renders, and nothing a browser would treat as a document. `image/svg+xml` does not belong on it: it is a document format, and serving one from the application's origin is a scripting surface rather than an image.
- A type outside the allowlist MUST either be rejected at upload with `400 VALIDATION_FAILED`, or stored and served as `application/octet-stream` with `Content-Disposition: attachment`. An upload carrying no media type lands here by definition, since `application/octet-stream` is not renderable — such an asset is stored and served, but as a download rather than as something a page will render.
- Every response from `GET /assets/{ref}/content` MUST carry `X-Content-Type-Options: nosniff`, so a browser cannot sniff its way past the recorded type.

This is what bounds the promise made under [Resolved URLs](#resolved-urls): a resolved URL is usable directly as an `<img>` / `<audio>` / `<video>` `src` **for an asset stored under an allowlisted type**. For anything else `resolve` still returns a working URL, and the bytes are still served — but as an attachment, because the alternative is letting a caller choose what the application's own origin executes.

A later re-upload with a corrected `Content-Type` wins for the uploading principal, so a resolved media type never depends on which write happened first. In a deployment that shares bytes across principals, that metadata MUST be recorded per principal: without it, re-uploading identical bytes under a `text/html` type would rewrite what every other principal's document resolves to, which in the proxied shape is stored XSS in the application's origin.

## Resolved URLs

`resolve` returns a URL the browser can load — usable directly as an `<img>` / `<audio>` / `<video>` `src` when the asset was stored under a renderable media type (see [Media type](#media-type)). The contract accommodates both deployment shapes without the document ever storing a raw URL — the document stores the ref, and the URL is minted per resolution:

- **Signed URL.** `url` is absolute and points wherever the bytes live (object storage, a CDN). It MAY be short-lived, and the token MUST be validated — bound to the ref it was minted for and to its expiry — not merely checked for presence. It MUST NOT be single-use: `resolve` makes no promise about how many times its result is fetched, and a caller holding an expired URL re-resolves the ref rather than expecting the same URL to be reissued. The client returns it **byte-for-byte** and never re-serializes it, because normalizing a URL can invalidate its signature.
- **Proxied path.** `url` is root-relative (begins with `/`) and is served by the deployment itself, typically at `GET /assets/{ref}/content`. The path MUST already be correct for the deployment's mount point, since the client joins it to the base URL's **origin**, not to the base URL's path.

### Choosing a shape is an authentication decision, not a preference

A resolved URL is loaded by the browser, not by this client: it goes into a media `src`, and a media load carries ambient credentials — cookies — and nothing else. The client's headers hook does not and cannot apply to it.

So the proxied shape is only sound where the deployment authenticates with a **cookie or session** that the browser attaches by itself. Such a deployment owns the consequences: the content route is reachable by cross-site markup, so it MUST use `SameSite` cookies (or an equivalent) and MUST treat the route as a read-only, side-effect-free endpoint so that CSRF has nothing to reach.

A deployment authenticating with a bearer token or any other header MUST use the signed-URL shape, or serve `GET /assets/{ref}/content` behind its own short-lived URL token. Pointing `resolve` at a header-authenticated path is not a configuration to be tuned: the resulting URL fails to load for every browser, in every deployment.

A cookie deployment whose base URL is on **another origin** needs one more thing. `fetch` sends no cookies cross-origin unless the request asks for them, and the headers hook cannot compensate — `Cookie` is a forbidden header name, so a script cannot set it. Such a deployment passes `credentials: 'include'` to the client (both `HttpAssetProvider` and `HttpAccountKV` accept it and hand it to `fetch` untouched) and takes on the CORS obligations that follow: the server must answer with `Access-Control-Allow-Credentials: true` and a concrete origin, never `*`. Same-origin cookie deployments need none of this, which is why the option is opt-in rather than a default.

### Client-side validation

A resolved URL ends up in a media `src`, so the client validates before returning it, and every failure below is a `MALFORMED_RESPONSE`.

The checks are decided by **parsing**, not by inspecting the text, because text checks and URL parsers disagree in ways an attacker picks:

- A URL containing an ASCII tab, LF or CR is refused outright. The parser strips those *before* parsing, so `/⟨tab⟩/evil.example/x` fails a "does it start with `//`" test and then loads cross-origin anyway.
- An absolute `url` MUST be in the unambiguous `http://` or `https://` form, MUST parse, and MUST carry a host. `javascript:`, `data:`, `blob:` and anything else are refused — resolving a ref must render an asset, never execute in the application's origin. The `scheme://` requirement is separate: a bare `https:cdn.example/x` parses standalone to the host `cdn.example`, but a browser resolving it against a same-scheme page reads it as a relative path, so one string names two destinations.
- A relative `url` MUST begin with `/` and, when resolved against a probe origin, MUST still be on that origin. This is what rejects `//host/x` and `/\host/x`, and anything else that reaches for an authority, without the contract having to enumerate the spellings.
- After joining a relative `url` to the base URL, the result MUST still be on the base URL's origin.
- An empty or non-string `url` is refused as before.

A validated absolute URL is returned exactly as received. In particular the client does not adjudicate *which* http(s) host a deployment may serve assets from, so a signed URL carrying userinfo (`https://user:pass@host/…`) or a homograph host is passed through: whether that host is legitimate is knowledge only the deployment has, and re-serializing the URL to normalize it would break the signature the shape exists to carry.

A deployment configured with a path-only base URL (an app-mounted route such as `/api/persistence`) receives root-relative paths unchanged, because the browser resolves them against the document itself. Every rule above still applies to them — that shape has no base origin to fall back on, so the parse-based check is the only thing standing between it and another origin.

`GET /assets/{ref}/url` MUST be served with `Cache-Control: no-store` (and MUST NOT be cached by any intermediary). Its answer is a statement about two mutable facts — whether the calling principal holds a claim, and which URL is valid right now — so a cached one is wrong in both directions: it hands back a signed URL past its expiry, and it replays a negatively cached `404` for an asset written since. The client sends the request with `cache: 'no-store'` for the same reason, because the coalescing below lives in the client and cannot reach the HTTP cache. Asset *content* is the opposite case: bytes at a content-addressed ref never change, so `GET /assets/{ref}/content` MAY be cached aggressively.

Because a resolved URL may expire, the HTTP client caches nothing across calls. It coalesces **concurrent** `resolve(ref)` calls onto one request so they share a single URL — matching `BrowserAssetProvider`, whose object URL must not be minted twice — and then forgets it. Handing back an expired signed URL later would be worse than asking again. A successful `put` or `remove` invalidates any in-flight resolution of that ref, so a caller arriving after the write never inherits an answer computed before it.

## Authentication and authorization

Every route requires an authenticated principal, and the principal is derived server-side from the authenticated session. It never appears in a path, query parameter, or body: a client-submitted principal is a lateral-authorization vulnerability, the same non-negotiable that governs `learnerKey` in the [RuntimeStore HTTP contract](./runtime-http-contract.md).

Deployments MUST bound upload size, rejecting a body past the bound with `413 PAYLOAD_TOO_LARGE` before storing any of it. Since refs are unguessable only to the extent the bytes are, a deployment holding assets that are sensitive rather than merely large MUST NOT treat knowledge of a ref as authorization.

### The per-principal claim model

Refs are content-addressed, so identical bytes uploaded by two principals produce one ref. A deployment MAY still store those bytes once. What it MUST NOT do is let the shared bytes make the two principals share a fate. The contract settles that with a claim model, so `remove`, `resolve`, and reclamation are defined rather than left to the backend:

- A principal acquires a **claim** on a ref by `PUT`, and only by `PUT`. Nothing else creates one.
- **Acquiring a claim MUST leave the bytes present.** A server that de-duplicates will find the bytes already stored and be tempted to insert the claim alone — but a concurrent reclamation of the last previous claim can remove those bytes immediately afterwards, leaving a claim pointing at nothing and a document that resolves to a URL serving `404`. Either write the bytes unconditionally, or hold the lock reclamation takes for the duration of the claim insert. This is the one ordering hazard the model introduces, and it is invisible until a deployment runs long enough to garbage-collect.
- `resolve(ref)` for a principal holding no claim returns `null` — the same answer as an asset that does not exist. Knowing a ref is not authorization, so a principal cannot read another's asset by guessing or by copying a ref out of a shared document.
- `remove(ref)` releases the caller's claim. Afterwards that caller's `resolve(ref)` returns `null`, while every other claimholder is unaffected: one principal's delete MUST NOT break another principal's document.
- Re-uploading the same bytes after a `remove` restores the claim, at the same ref.
- Once the last claim is released the bytes MAY be reclaimed. Reclamation is a host garbage-collection decision, not a contract event; during any reclamation window `resolve` returns `null` for every principal, since none holds a claim.
- Signed URLs are not claims. An expired URL is re-obtained by resolving again; a ref whose claim has been released MUST NOT be re-signed.

A deployment that partitions storage per principal satisfies all of this trivially. A deployment that de-duplicates bytes across principals has to keep the claim set explicitly — that is the cost of the de-duplication, and it is the reason media-type metadata is per-principal too.

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
| Ref violates the identifier rules, is not content-addressed on a write, carries a disallowed media type, or the request is otherwise invalid | `400` | `VALIDATION_FAILED` | Throw `HttpAssetProviderError` with the server message |
| Uploaded bytes do not hash to the requested ref | `400` | `ASSET_REF_MISMATCH` | Throw `HttpAssetProviderError` |
| Request body exceeds the deployment's size bound | `413` | `PAYLOAD_TOO_LARGE` | Throw `HttpAssetProviderError` |
| No asset is stored under the ref, or the principal holds no claim on it | `404` | `ASSET_NOT_FOUND` | `resolve` returns `null` |
| Route does not exist | `404` | `ROUTE_NOT_FOUND` | Throw `HttpAssetProviderError` |
| Missing or invalid credential | `401` | `UNAUTHENTICATED` | Throw `HttpAssetProviderError` |
| Principal may not perform the operation, or a signed URL is invalid or expired | `403` | `FORBIDDEN_ASSETS` | Throw `HttpAssetProviderError` |
| Unexpected server failure | `500` | `INTERNAL_ERROR` | Throw `HttpAssetProviderError`; the handler does not expose internal details |

Only `ASSET_NOT_FOUND` becomes `null`. Status alone is not sufficient — `ROUTE_NOT_FOUND` shares its status and means a broken deployment, and a `403` denial must never be reported as an absent asset.

A response the client cannot interpret — a body that is not JSON despite a 2xx status, a missing or unusable `url`, or one that fails the validation above — raises `MALFORMED_RESPONSE`, a client-side code with no server counterpart. It is a typed storage error like any other: the client never lets a native `SyntaxError` or `URIError` escape in its place.

## Retry and atomicity guarantees

Every operation in this contract is safely retryable. `PUT /assets/{ref}` is idempotent because the ref determines the content; `DELETE` is idempotent because removing an absent asset succeeds; both `GET` routes are reads. A `PUT` MUST NOT expose partially written bytes under its ref: a reader either sees the complete asset or no asset.
