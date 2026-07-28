import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserAssetProvider } from '../src/asset/browser.js';
import { HttpAssetProvider, HttpAssetProviderError } from '../src/asset/http.js';
import { runStorageProviderContract } from './asset-contract.js';
import {
  startKvAssetConformanceServer,
  type KvAssetConformanceServer,
} from './kv-asset-conformance-server.js';

let proxyServer: KvAssetConformanceServer;
let signedServer: KvAssetConformanceServer;
let namespace = 0;

// The contract suite builds a fresh provider per test but reads resolved URLs
// through one shared reader, so both share one server namespace. That is safe
// precisely because assets are content-addressed: identical bytes are meant to
// be one asset, and no case in the suite removes bytes another case stores.
const PROXY_NAMESPACE = 'asset-contract-proxy';
const SIGNED_NAMESPACE = 'asset-contract-signed';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Read a resolved URL the way the *browser* would, which is the only way that
 * proves anything. A resolved URL ends up in an `<img>` / `<audio>` / `<video>`
 * `src`, and a media load carries ambient credentials only — never the client's
 * headers hook. So the proxied shape is read with nothing but a session cookie,
 * and the signed shape with no credential at all. Supplying the hook's headers
 * here would test a request no browser can make.
 */
async function readUrlFrom(
  server: KvAssetConformanceServer,
  credential: HeadersInit,
  url: string,
): Promise<Uint8Array> {
  const response = await server.fetch(url, { headers: credential });
  if (!response.ok) throw new Error(`asset url ${url} responded ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** What a browser sends by itself: a cookie, and nothing the client controls. */
function sessionCookie(storageNamespace: string): HeadersInit {
  return { cookie: `session=${storageNamespace}` };
}

beforeAll(async () => {
  proxyServer = await startKvAssetConformanceServer({ listen: false });
  signedServer = await startKvAssetConformanceServer({ listen: false, resolveMode: 'signed' });
});

afterAll(async () => {
  await proxyServer.close();
  await signedServer.close();
});

// Both deployment shapes the contract has to accommodate: a proxied path this
// server also serves, and an opaque absolute signed URL it mints per call.
runStorageProviderContract(
  'HttpAssetProvider (proxied urls, cookie-authenticated)',
  () =>
    new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      // A cookie, deliberately: the proxied shape is only sound where the same
      // credential authenticates both the contract call and the media load.
      headers: () => sessionCookie(PROXY_NAMESPACE),
    }),
  (url) => readUrlFrom(proxyServer, sessionCookie(PROXY_NAMESPACE), url),
);

runStorageProviderContract(
  'HttpAssetProvider (signed urls)',
  () =>
    new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': SIGNED_NAMESPACE }),
    }),
  // No credential at all: the token in the URL is the whole authorization,
  // which is what lets a header-authenticated deployment use this shape.
  (url) => readUrlFrom(signedServer, {}, url),
);

describe('HttpAssetProvider content addressing', () => {
  test('identical bytes yield an identical ref across the browser and HTTP backends', async () => {
    const payload = 'portable bytes';
    const browser = new BrowserAssetProvider({
      indexedDB: new IDBFactory(),
      dbName: `cross-backend-${namespace++}`,
    });
    const http = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(`cross-backend-${namespace++}`),
    });

    const browserRef = await browser.put(new Blob([payload], { type: 'text/plain' }));
    const httpRef = await http.put(new Blob([payload], { type: 'text/plain' }));

    expect(httpRef).toBe(browserRef);
    // Independently recomputed, so the two backends agreeing on a *wrong* hash
    // could not pass: the ref is the SHA-256 of the bytes, spelled out.
    expect(httpRef).toBe(`sha256-${createHash('sha256').update(payload).digest('hex')}`);
  });

  test('the server rejects bytes that do not hash to the requested ref', async () => {
    const storageNamespace = `forged-${namespace++}`;
    const response = await proxyServer.fetch(
      `${proxyServer.baseUrl}/assets/sha256-${'0'.repeat(64)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', ...sessionCookie(storageNamespace) },
        body: 'not the bytes that hash to zeroes',
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'ASSET_REF_MISMATCH' },
    });
  });

  test('the server rejects a ref that is not content-addressed', async () => {
    const response = await proxyServer.fetch(`${proxyServer.baseUrl}/assets/not-a-digest`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', ...sessionCookie(`shape-${namespace++}`) },
      body: 'anything',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  test('re-putting identical bytes keeps the ref and adopts the corrected type', async () => {
    const storageNamespace = `dedup-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(storageNamespace),
    });

    const first = await provider.put(new Blob(['dup me'], { type: '' }));
    const second = await provider.put(new Blob(['dup me'], { type: 'image/png' }));
    expect(second).toBe(first);

    // Same behaviour as BrowserAssetProvider: a re-put with corrected metadata
    // wins, so resolved MIME never depends on which write happened first.
    const url = await provider.resolve(first);
    const response = await proxyServer.fetch(url!, { headers: sessionCookie(storageNamespace) });
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});

describe('HttpAssetProvider transport semantics', () => {
  test('carries the content type through to the resolved bytes', async () => {
    const storageNamespace = `content-type-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(storageNamespace),
    });

    const ref = await provider.put(new Blob(['pixels'], { type: '' }), {
      contentType: 'image/png',
    });
    const url = await provider.resolve(ref);
    const response = await proxyServer.fetch(url!, { headers: sessionCookie(storageNamespace) });

    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf('pixels'));
  });

  test('joins a root-relative resolved url to the base origin, not the base path', async () => {
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid/api/persistence',
      fetch: async () =>
        new Response(JSON.stringify({ url: '/api/persistence/assets/ref/content' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(provider.resolve('ref')).resolves.toBe(
      'https://assets.invalid/api/persistence/assets/ref/content',
    );
  });

  test('returns an absolute signed url byte-for-byte', async () => {
    const signed = 'https://cdn.invalid/o/abc?X-Amz-Signature=deadbeef&x=a%2Fb';
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ url: signed }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    // Re-serializing a signed URL through `new URL()` can normalize it and
    // invalidate the signature, so it must pass through untouched.
    await expect(provider.resolve('ref')).resolves.toBe(signed);
  });

  test('leaves a resolved path alone when the base url is itself a path', async () => {
    const provider = new HttpAssetProvider({
      baseUrl: '/api/persistence',
      fetch: async () =>
        new Response(JSON.stringify({ url: '/api/persistence/assets/ref/content' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(provider.resolve('ref')).resolves.toBe('/api/persistence/assets/ref/content');
  });

  test.each([
    ['a missing url', {}],
    ['an empty url', { url: '' }],
    ['a non-string url', { url: 42 }],
    ['a path-relative url', { url: 'assets/ref/content' }],
  ])('maps %s in a resolve response to a malformed-response error', async (_name, body) => {
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(provider.resolve('ref')).rejects.toMatchObject({
      name: 'HttpAssetProviderError',
      code: 'MALFORMED_RESPONSE',
    });
  });

  test('surfaces a server failure as a typed error rather than a null resolve', async () => {
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const failure = provider.resolve('ref');
    await expect(failure).rejects.toBeInstanceOf(HttpAssetProviderError);
    await expect(failure).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  test('retries after a failed resolve instead of replaying the failure', async () => {
    let calls = 0;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient network failure');
        return new Response(JSON.stringify({ url: 'https://cdn.invalid/o/abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(provider.resolve('ref')).rejects.toThrow(/transient network failure/);
    await expect(provider.resolve('ref')).resolves.toBe('https://cdn.invalid/o/abc');
  });

  test('rejects dot-only refs before URL construction', async () => {
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });

    await expect(provider.resolve('.')).rejects.toThrow(/must not be ['"]\.['"]/);
    await expect(provider.remove('..')).rejects.toThrow(/must not be ['"]\.\.['"]/);
  });

  test('requires a non-empty base url and a usable fetch implementation', () => {
    expect(() => new HttpAssetProvider({ baseUrl: '' })).toThrow(/baseUrl must be non-empty/);
    expect(
      () =>
        new HttpAssetProvider({
          baseUrl: 'https://assets.invalid',
          fetch: {} as unknown as typeof globalThis.fetch,
        }),
    ).toThrow(/requires a fetch implementation/);
  });

  test('removing an unknown ref succeeds', async () => {
    const provider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(`remove-unknown-${namespace++}`),
    });

    await expect(provider.remove(`sha256-${'a'.repeat(64)}`)).resolves.toBeUndefined();
  });
});

describe('HttpAssetProvider resolved-url safety', () => {
  function providerReturning(url: unknown, baseUrl = 'https://assets.invalid'): HttpAssetProvider {
    return new HttpAssetProvider({
      baseUrl,
      fetch: async () =>
        new Response(JSON.stringify({ url }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
  }

  test.each([
    ['protocol-relative', '//evil.invalid/x'],
    // WHATWG URL parsing normalizes the backslash into the protocol-relative
    // form, so this reaches another origin while looking like a path.
    ['backslash protocol-relative', '/\\evil.invalid/x'],
  ])('refuses a %s url that would resolve to another origin', async (_name, url) => {
    const failure = providerReturning(url).resolve('ref');
    await expect(failure).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(failure).rejects.toThrow(/not a reference to another origin/);
  });

  test.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['blob', 'blob:https://assets.invalid/abc'],
  ])('refuses a %s: url, which would execute rather than render', async (_name, url) => {
    const failure = providerReturning(url).resolve('ref');
    await expect(failure).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(failure).rejects.toThrow(/must use the http\(s\) scheme/);
  });

  test('accepts an http url as well as an https one', async () => {
    await expect(providerReturning('http://cdn.invalid/o/abc').resolve('ref')).resolves.toBe(
      'http://cdn.invalid/o/abc',
    );
  });

  // The parser strips ASCII tab, LF and CR *before* parsing, so each of these
  // reads as `//evil.invalid/x` to a browser while sailing past any "does it
  // start with //" text check. The app-mounted deployment shape uses a
  // path-only base URL, where that text check was the only thing left.
  test.each([
    ['tab', '/\t/evil.invalid/x'],
    ['newline', '/\n/evil.invalid/x'],
    ['carriage return', '/\r/evil.invalid/x'],
    ['tab inside the authority', '//evil\t.invalid/x'],
  ])('refuses a url smuggling a cross-origin authority past a %s', async (_name, url) => {
    for (const base of ['https://assets.invalid', '/api/persistence']) {
      const failure = providerReturning(url, base).resolve('ref');
      await expect(failure, base).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    }
  });

  test.each([
    // Parses standalone to host `cdn.invalid`, but a browser on a same-scheme
    // page reads it as a relative path — one string, two destinations.
    ['scheme-relative', 'https:cdn.invalid/x'],
    ['empty host', 'https://'],
  ])('refuses an ambiguous or hostless absolute url (%s)', async (_name, url) => {
    const failure = providerReturning(url).resolve('ref');
    await expect(failure).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  test.each([
    ['protocol-relative', '//asset-url-probe.invalid/x'],
    // The parser normalizes these into the form above, so a `startsWith('//')`
    // spelling of the guard let them through and only the probe host failing to
    // resolve was standing in the way.
    ['backslash', '/\\asset-url-probe.invalid/x'],
    ['mixed backslash and slash', '/\\/asset-url-probe.invalid/x'],
  ])('refuses a %s url naming the probe host the check resolves against', async (_name, url) => {
    // The origin comparison asks "did this stay where I put it", and a URL
    // naming the probe host passes it by coincidence — against the real base it
    // goes somewhere else entirely. Refusing any authority-opening second
    // character is what makes the guard independent of the probe host.
    for (const base of ['https://assets.invalid', '/api/persistence']) {
      const failure = providerReturning(url, base).resolve('ref');
      await expect(failure, `${url} @ ${base}`).rejects.toMatchObject({
        code: 'MALFORMED_RESPONSE',
      });
    }
  });

  test('a signed url with userinfo or a lookalike host is still returned verbatim', async () => {
    // Documented as in-scope behaviour, not an oversight: the client validates
    // that a URL is a fetchable http(s) URL, and cannot adjudicate which hosts a
    // deployment legitimately serves assets from.
    const signed = 'https://user:pass@xn--80ak6aa92e.invalid/o/abc?sig=deadbeef';
    await expect(providerReturning(signed).resolve('ref')).resolves.toBe(signed);
  });

  test('a path-only base url still refuses a cross-origin reference', async () => {
    // The join is skipped for a path-only base, so the prefix check is the only
    // thing standing between the app and another origin.
    const failure = providerReturning('//evil.invalid/x', '/api/persistence').resolve('ref');
    await expect(failure).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});

describe('HttpAssetProvider identifier safety', () => {
  const provider = (): HttpAssetProvider =>
    new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });

  test.each([
    ['forward slash', '../../etc/passwd'],
    ['backslash', '..\\..\\windows\\system32'],
    ['bare separator', 'a/b'],
  ])('refuses a ref containing a %s before sending a request', async (_name, ref) => {
    await expect(provider().resolve(ref)).rejects.toThrow(/must not contain/);
    await expect(provider().remove(ref)).rejects.toThrow(/must not contain/);
  });

  test('refuses an empty ref', async () => {
    await expect(provider().resolve('')).rejects.toThrow(/must not be empty/);
  });

  test('refuses an over-long ref', async () => {
    await expect(provider().resolve('r'.repeat(513))).rejects.toThrow(/exceeds 512 UTF-8 bytes/);
  });

  test('reports a lone surrogate as a storage error, not a bare URIError', async () => {
    const failure = provider().resolve('\uD800');
    await expect(failure).rejects.not.toBeInstanceOf(URIError);
    await expect(failure).rejects.toThrow(/unpaired UTF-16 surrogate/);
  });

  test('the server refuses a percent-encoded traversal on every asset route', async () => {
    const traversal = `${proxyServer.baseUrl}/assets/${encodeURIComponent('../../etc/passwd')}`;
    const credential = sessionCookie(`traversal-${namespace++}`);

    for (const [method, path] of [
      ['DELETE', traversal],
      ['GET', `${traversal}/url`],
      ['PUT', traversal],
    ] as const) {
      const response = await proxyServer.fetch(path, { method, headers: credential });
      expect(response.status, `${method} ${path}`).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('must not contain') },
      });
    }
  });
});

describe('HttpAssetProvider mutation invalidates in-flight resolution', () => {
  interface Deferred {
    release: () => void;
    settled: Promise<void>;
  }

  function makeGate(): Deferred {
    let release = (): void => {};
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release, settled };
  }

  test('a resolve started before a put is not shared with callers after it', async () => {
    const gate = makeGate();
    const urls: (string | null)[] = [];
    let stored = false;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/url')) {
          // Snapshot at request time: the server answered before the write, the
          // response is merely slow in transit. Reading the flag after the gate
          // would model a server that answers from the future.
          const answered = stored;
          await gate.settled;
          return answered
            ? new Response(JSON.stringify({ url: '/assets/ref/content' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            : new Response(
                JSON.stringify({ error: { code: 'ASSET_NOT_FOUND', message: 'absent' } }),
                { status: 404, headers: { 'content-type': 'application/json' } },
              );
        }
        stored = true;
        return new Response(null, { status: 204 });
      },
    });

    // The ref the write will land on, so the invalidation is keyed on the same
    // ref the resolves ask for.
    const payload = 'now it exists';
    const ref = `sha256-${createHash('sha256').update(payload).digest('hex')}`;

    // First resolve is in flight and will answer "absent".
    const first = provider.resolve(ref);
    await provider.put(new Blob([payload], { type: 'text/plain' }));
    // A resolve issued after the write must not inherit the stale answer.
    gate.release();
    const second = provider.resolve(ref);
    urls.push(await first, await second);

    expect(urls[0]).toBeNull();
    expect(urls[1]).toBe('https://assets.invalid/assets/ref/content');
  });

  test('a resolve started before a remove is not shared with callers after it', async () => {
    const gate = makeGate();
    let present = true;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === 'DELETE') {
          present = false;
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/url')) {
          const answered = present;
          await gate.settled;
          return answered
            ? new Response(JSON.stringify({ url: '/assets/ref/content' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            : new Response(
                JSON.stringify({ error: { code: 'ASSET_NOT_FOUND', message: 'absent' } }),
                { status: 404, headers: { 'content-type': 'application/json' } },
              );
        }
        return new Response(null, { status: 204 });
      },
    });

    const first = provider.resolve('ref');
    await provider.remove('ref');
    gate.release();
    const second = provider.resolve('ref');

    // The stale URL may still be handed to the caller who asked before the
    // delete; nobody arriving afterwards may receive it.
    expect(await first).toBe('https://assets.invalid/assets/ref/content');
    expect(await second).toBeNull();
  });
});

describe('in-flight resolution is evicted by identity, not blindly', () => {
  test('a settling stale resolve does not evict the resolution that replaced it', async () => {
    // The eviction after a mutation and the eviction on settle race: a resolve
    // issued *before* a write settles *after* the write, and a blind
    // `delete(ref)` in its `finally` would throw away the resolution started
    // afterwards. Nothing breaks visibly — the next caller just silently stops
    // sharing and issues its own request — so this counts requests rather than
    // comparing URLs, which is the only way the difference is observable.
    let urlRequests = 0;
    const gates: (() => void)[] = [];
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async (input, init) => {
        if (init?.method === 'PUT') return new Response(null, { status: 204 });
        urlRequests += 1;
        await new Promise<void>((release) => gates.push(release));
        return new Response(JSON.stringify({ url: '/assets/ref/content' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const payload = 'evicted by identity';
    const ref = `sha256-${createHash('sha256').update(payload).digest('hex')}`;

    const stale = provider.resolve(ref); // request 1, in flight
    await provider.put(new Blob([payload], { type: 'image/png' })); // evicts it
    const fresh = provider.resolve(ref); // request 2, now the memoized one
    gates[0]!(); // the stale request settles, and must not evict request 2
    await stale;
    const joined = provider.resolve(ref); // must join request 2, not open a third

    gates[1]!();
    expect(await fresh).toBe('https://assets.invalid/assets/ref/content');
    expect(await joined).toBe('https://assets.invalid/assets/ref/content');
    expect(urlRequests).toBe(2);
  });
});

describe('HttpAssetProvider error-table coverage', () => {
  function respondWith(status: number, code: string): HttpAssetProvider {
    return new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code, message: `${code} from server` } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    });
  }

  test('a 404 ROUTE_NOT_FOUND throws instead of masquerading as an absent asset', async () => {
    // The one MUST in the error table that a status-only client would get
    // wrong: both rows are 404, and only ASSET_NOT_FOUND means "no such asset".
    const failure = respondWith(404, 'ROUTE_NOT_FOUND').resolve('ref');
    await expect(failure).rejects.toBeInstanceOf(HttpAssetProviderError);
    await expect(failure).rejects.toMatchObject({ status: 404, code: 'ROUTE_NOT_FOUND' });
  });

  test.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN_ASSETS'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [500, 'INTERNAL_ERROR'],
  ])('maps %i %s to a typed error', async (status, code) => {
    const failure = respondWith(status, code).resolve('ref');
    await expect(failure).rejects.toMatchObject({ status, code });
  });

  test('an unauthenticated deployment answers 401 on the contract routes', async () => {
    const guarded = await startKvAssetConformanceServer({
      listen: false,
      authenticate: (req) => req.headers.authorization !== undefined,
    });
    try {
      const provider = new HttpAssetProvider({ baseUrl: guarded.baseUrl, fetch: guarded.fetch });
      await expect(provider.resolve('ref')).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    } finally {
      await guarded.close();
    }
  });

  test('a denied principal receives 403 rather than a not-found', async () => {
    const guarded = await startKvAssetConformanceServer({
      listen: false,
      authorize: (_req, area) => area !== 'assets',
    });
    try {
      const provider = new HttpAssetProvider({ baseUrl: guarded.baseUrl, fetch: guarded.fetch });
      // Not null: an authorization denial must never look like an absent asset.
      await expect(provider.resolve('ref')).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN_ASSETS',
      });
    } finally {
      await guarded.close();
    }
  });

  test('an upload past the body ceiling is rejected with 413', async () => {
    const bounded = await startKvAssetConformanceServer({ listen: false, maxBodyBytes: 8 });
    try {
      const provider = new HttpAssetProvider({ baseUrl: bounded.baseUrl, fetch: bounded.fetch });
      await expect(
        provider.put(new Blob(['far beyond eight bytes'], { type: 'text/plain' })),
      ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    } finally {
      await bounded.close();
    }
  });

  test('a 2xx with an unparseable body becomes a typed malformed response', async () => {
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response('<html>a proxy error page</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    const failure = provider.resolve('ref');
    await expect(failure).rejects.not.toBeInstanceOf(SyntaxError);
    await expect(failure).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});

describe('HttpAssetProvider upload media type', () => {
  test('a headers hook cannot silently relabel an asset', async () => {
    let sent: HeadersInit | undefined;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async (_input, init) => {
        sent = init?.headers;
        return new Response(null, { status: 204 });
      },
      headers: () => ({ 'Content-Type': 'application/json' }),
    });

    // Silently letting the hook win would file a PNG as JSON forever, with
    // nothing to notice until the image fails to render.
    await expect(provider.put(new Blob(['pixels'], { type: 'image/png' }))).rejects.toThrow(
      /must not set Content-Type/,
    );
    expect(sent).toBeUndefined();
  });

  test('an unknown media type is uploaded as application/octet-stream', async () => {
    let contentType: string | undefined;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async (_input, init) => {
        contentType = (init?.headers as Record<string, string>)['content-type'];
        return new Response(null, { status: 204 });
      },
    });

    await provider.put(new Blob(['bytes'], { type: '' }));
    expect(contentType).toBe('application/octet-stream');
  });
});

describe('signed asset urls are validated, not merely present', () => {
  test('a tampered or unknown token is refused', async () => {
    const storageNamespace = `signed-token-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': storageNamespace }),
    });
    const ref = await provider.put(new Blob(['guarded'], { type: 'text/plain' }));
    const url = await provider.resolve(ref);

    const tampered = await signedServer.fetch(`${url!}-tampered`);
    expect(tampered.status).toBe(403);
    const missing = await signedServer.fetch(url!.replace(/\?token=.*/, ''));
    expect(missing.status).toBe(403);
  });

  test('an expired token is refused', async () => {
    const expiring = await startKvAssetConformanceServer({
      listen: false,
      resolveMode: 'signed',
      signedTtlMs: 0,
    });
    try {
      const provider = new HttpAssetProvider({ baseUrl: expiring.baseUrl, fetch: expiring.fetch });
      const ref = await provider.put(new Blob(['stale'], { type: 'text/plain' }));
      const url = await provider.resolve(ref);

      const response = await expiring.fetch(url!);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'FORBIDDEN_ASSETS' },
      });
    } finally {
      await expiring.close();
    }
  });

  test('a token minted for one ref does not open another', async () => {
    const storageNamespace = `signed-binding-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': storageNamespace }),
    });
    const first = await provider.put(new Blob(['first asset'], { type: 'text/plain' }));
    const second = await provider.put(new Blob(['second asset'], { type: 'text/plain' }));
    const url = await provider.resolve(first);

    const swapped = url!.replace(first, second);
    expect(await signedServer.fetch(swapped).then((r) => r.status)).toBe(403);
  });
});

describe('proxied asset urls are loadable by a browser', () => {
  test('the resolved path is served to a cookie-carrying media load', async () => {
    const storageNamespace = `proxy-cookie-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(storageNamespace),
    });
    const ref = await provider.put(new Blob(['renderable'], { type: 'text/plain' }));
    const url = await provider.resolve(ref);

    // Exactly what an <img> sends: the cookie, and nothing else.
    const loaded = await proxyServer.fetch(url!, { headers: sessionCookie(storageNamespace) });
    expect(loaded.status).toBe(200);
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(bytesOf('renderable'));
  });

  test('a media load with no ambient credential is refused', async () => {
    const storageNamespace = `proxy-anon-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(storageNamespace),
    });
    const ref = await provider.put(new Blob(['guarded proxy'], { type: 'text/plain' }));
    const url = await provider.resolve(ref);

    // The point of the contract's restriction: without a cookie the proxied
    // shape cannot authenticate the load, which is why a header-authenticated
    // deployment has to use the signed shape instead.
    expect(await proxyServer.fetch(url!).then((r) => r.status)).toBe(401);
  });
});

describe('asset media types are constrained on the way out', () => {
  async function serveContentType(
    uploadType: string,
    storageNamespace: string,
  ): Promise<{ type: string | null; disposition: string | null; nosniff: string | null }> {
    const provider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(storageNamespace),
    });
    const ref = await provider.put(new Blob(['payload'], { type: uploadType }));
    const url = await provider.resolve(ref);
    const response = await proxyServer.fetch(url!, { headers: sessionCookie(storageNamespace) });
    return {
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      nosniff: response.headers.get('x-content-type-options'),
    };
  }

  test.each([
    ['text/html', 'text/html'],
    ['image/svg+xml', 'image/svg+xml'],
    ['application/javascript', 'application/javascript'],
    ['a metadata-less upload', ''],
  ])('serves %s opaquely, as an attachment', async (_name, uploadType) => {
    // The stored type is caller-influenced and the proxied route is served from
    // the application's own origin, so a type outside the renderable allowlist
    // must not come back as itself — otherwise re-uploading bytes as text/html
    // is stored XSS.
    const served = await serveContentType(uploadType, `media-type-${namespace++}`);
    expect(served.type).toBe('application/octet-stream');
    expect(served.disposition).toBe('attachment');
    expect(served.nosniff).toBe('nosniff');
  });

  test.each([['image/png'], ['audio/mpeg'], ['video/mp4']])(
    'serves the renderable type %s as itself',
    async (uploadType) => {
      const served = await serveContentType(uploadType, `media-type-${namespace++}`);
      expect(served.type).toBe(uploadType);
      expect(served.disposition).toBeNull();
      expect(served.nosniff).toBe('nosniff');
    },
  );

  test('a re-upload cannot rewrite the media type another principal resolves', async () => {
    const victim = `victim-${namespace++}`;
    const attacker = `attacker-${namespace++}`;
    const bytes = new Blob(['<h1>shared bytes</h1>'], { type: 'image/png' });

    const victimProvider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(victim),
    });
    const attackerProvider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(attacker),
    });

    const ref = await victimProvider.put(bytes);
    // Same bytes, same ref, hostile media type.
    await attackerProvider.put(new Blob(['<h1>shared bytes</h1>'], { type: 'text/html' }));

    const url = await victimProvider.resolve(ref);
    const served = await proxyServer.fetch(url!, { headers: sessionCookie(victim) });
    expect(served.headers.get('content-type')).toBe('image/png');
  });
});

describe('signed urls are reusable and principal-scoped', () => {
  test('a signed url may be fetched more than once', async () => {
    // The contract says short-lived, deliberately not single-use: `resolve`
    // makes no promise about how many times its result is loaded, and a browser
    // may well re-request it (a range request, a reload, a second element).
    const storageNamespace = `signed-reuse-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': storageNamespace }),
    });
    const ref = await provider.put(new Blob(['reusable'], { type: 'image/png' }));
    const url = await provider.resolve(ref);

    for (const attempt of [1, 2, 3]) {
      const response = await signedServer.fetch(url!);
      expect(response.status, `attempt ${attempt}`).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf('reusable'));
    }
  });

  test('a signed url serves the media type its own principal filed', async () => {
    const owner = `signed-media-owner-${namespace++}`;
    const other = `signed-media-other-${namespace++}`;
    const payload = 'bytes with two filings';
    const ownerProvider = new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': owner }),
    });
    const otherProvider = new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': other }),
    });

    const ref = await ownerProvider.put(new Blob([payload], { type: 'image/png' }));
    await otherProvider.put(new Blob([payload], { type: 'text/html' }));

    const ownerUrl = await ownerProvider.resolve(ref);
    const otherUrl = await otherProvider.resolve(ref);

    // Same bytes, same ref, two filings — and the signed URL carries which one.
    const served = await signedServer.fetch(ownerUrl!);
    expect(served.headers.get('content-type')).toBe('image/png');
    const otherServed = await signedServer.fetch(otherUrl!);
    expect(otherServed.headers.get('content-type')).toBe('application/octet-stream');
    expect(otherServed.headers.get('content-disposition')).toBe('attachment');
  });
});

describe('the per-principal claim model', () => {
  function providerFor(principal: string): HttpAssetProvider {
    return new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => sessionCookie(principal),
    });
  }

  test('a claim is created by PUT and by nothing else', async () => {
    const owner = providerFor(`claim-owner-${namespace++}`);
    const stranger = providerFor(`claim-stranger-${namespace++}`);
    const ref = await owner.put(new Blob(['claimed bytes'], { type: 'image/png' }));

    expect(await owner.resolve(ref)).not.toBeNull();
    // Knowing the ref is not authorization: a stranger who read it out of a
    // shared document gets the same answer as for an asset that never existed.
    expect(await stranger.resolve(ref)).toBeNull();
  });

  test('a stranger resolving is indistinguishable from an absent asset', async () => {
    const stranger = providerFor(`claim-absent-${namespace++}`);
    const owner = providerFor(`claim-present-${namespace++}`);
    const ref = await owner.put(new Blob(['hidden'], { type: 'image/png' }));
    const neverStored = `sha256-${'b'.repeat(64)}`;

    expect(await stranger.resolve(ref)).toBeNull();
    expect(await stranger.resolve(neverStored)).toBeNull();
  });

  test("one principal's remove does not break another's document", async () => {
    const first = providerFor(`claim-first-${namespace++}`);
    const second = providerFor(`claim-second-${namespace++}`);
    const payload = 'bytes two principals share';
    const ref = await first.put(new Blob([payload], { type: 'image/png' }));
    expect(await second.put(new Blob([payload], { type: 'image/png' }))).toBe(ref);

    await first.remove(ref);

    expect(await first.resolve(ref)).toBeNull();
    // The bytes are still there for the other claimholder.
    expect(await second.resolve(ref)).not.toBeNull();
  });

  test('re-uploading after a remove restores the claim at the same ref', async () => {
    const principal = `claim-restore-${namespace++}`;
    const provider = providerFor(principal);
    const payload = 'restored bytes';

    const ref = await provider.put(new Blob([payload], { type: 'image/png' }));
    await provider.remove(ref);
    expect(await provider.resolve(ref)).toBeNull();

    expect(await provider.put(new Blob([payload], { type: 'image/png' }))).toBe(ref);
    expect(await provider.resolve(ref)).not.toBeNull();
  });

  test('bytes are reclaimable once the last claim is released', async () => {
    const first = providerFor(`claim-last-a-${namespace++}`);
    const second = providerFor(`claim-last-b-${namespace++}`);
    const payload = 'transient bytes';
    const ref = await first.put(new Blob([payload], { type: 'image/png' }));
    await second.put(new Blob([payload], { type: 'image/png' }));

    await first.remove(ref);
    await second.remove(ref);

    // No claim remains, so the ref resolves for nobody — including a third
    // principal who never held one.
    expect(await first.resolve(ref)).toBeNull();
    expect(await second.resolve(ref)).toBeNull();
    expect(await providerFor(`claim-last-c-${namespace++}`).resolve(ref)).toBeNull();
  });

  test("a signed url carries its own claim and does not leak another principal's", async () => {
    const owner = `signed-claim-${namespace++}`;
    const stranger = `signed-stranger-${namespace++}`;
    const ownerProvider = new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': owner }),
    });
    const strangerProvider = new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': stranger }),
    });

    const ref = await ownerProvider.put(new Blob(['signed bytes'], { type: 'image/png' }));
    expect(await strangerProvider.resolve(ref)).toBeNull();

    const url = await ownerProvider.resolve(ref);
    // The URL works without any credential — that is what makes it loadable —
    // but only because the token itself carries the owner's claim.
    expect(await signedServer.fetch(url!).then((r) => r.status)).toBe(200);
  });
});

describe('HttpAssetProvider base url and credentials', () => {
  test.each([
    ['file:', 'file:///etc'],
    ['ftp:', 'ftp://host/x'],
    ['javascript:', 'javascript:alert(1)'],
  ])('refuses a %s base url at construction', (_name, baseUrl) => {
    // Otherwise every request this client builds is one string-join away from a
    // scheme it should never speak.
    expect(() => new HttpAssetProvider({ baseUrl })).toThrow(/is not http\(s\)/);
  });

  test('refuses a scheme-without-authority base url', () => {
    // Parses standalone to the host `api.example`, but `fetch` on a same-scheme
    // page resolves it against the current document — so requests, and the
    // credentials on them, would go somewhere the operator never wrote.
    expect(() => new HttpAssetProvider({ baseUrl: 'https:api.example/persistence' })).toThrow(
      /scheme:\/\/host/,
    );
  });

  test.each([
    ['a query', 'https://assets.invalid/api?v=1'],
    ['a fragment', 'https://assets.invalid/api#frag'],
    ['a query on a path-only base', '/api/persistence?v=1'],
  ])('refuses a base url carrying %s', (_name, baseUrl) => {
    // Concatenating a path onto these silently swallows it.
    expect(() => new HttpAssetProvider({ baseUrl })).toThrow(/query or fragment/);
  });

  test('refuses a base url that carries a scheme but does not parse', () => {
    expect(() => new HttpAssetProvider({ baseUrl: 'https://%%' })).toThrow(/must be a valid URL/);
  });

  test.each([
    ['protocol-relative', '//evil.example'],
    ['protocol-relative with a path', '//evil.example/api'],
    ['backslash authority', '/\\evil.example'],
    ['mixed backslash and slash', '/\\/evil.example/api'],
  ])('refuses a %s base url posing as a path', (_name, baseUrl) => {
    // A browser reads these as an authority, so every request built on such a
    // base — and every credential the hook attaches to it — leaves the origin.
    expect(() => new HttpAssetProvider({ baseUrl })).toThrow(/not a reference to another origin/);
  });

  test.each([
    ['a tab', '/api\u0009/persistence'],
    ['a newline', '/api\u000A/persistence'],
    ['a carriage return', '/api\u000D/persistence'],
    ['a NUL', '/api\u0000/persistence'],
    ['a control character in an absolute base', 'https://assets.invalid/api\u0009/x'],
  ])('refuses a base url containing %s', (_name, baseUrl) => {
    // The parser strips or re-encodes these, after which the string no longer
    // means what it reads as — `/\u0009/evil.example` becomes `//evil.example`.
    expect(() => new HttpAssetProvider({ baseUrl })).toThrow(/control characters/);
  });

  test.each([
    ['a bare query separator', 'https://assets.invalid/api?'],
    ['a bare fragment separator', 'https://assets.invalid/api#'],
    ['a bare query separator on a path base', '/api/persistence?'],
    ['a bare fragment separator on a path base', '/api/persistence#'],
  ])('refuses a base url ending in %s', (_name, baseUrl) => {
    // These parse to an *empty* search and hash, so a check reading the parsed
    // URL waves them through — and the concatenated path is then swallowed into
    // the query or fragment.
    expect(() => new HttpAssetProvider({ baseUrl })).toThrow(/query or fragment/);
  });

  test('accepts a root-mounted path base', () => {
    expect(() => new HttpAssetProvider({ baseUrl: '/' })).not.toThrow();
  });

  test('still accepts a path-only base url for the app-mounted shape', () => {
    expect(() => new HttpAssetProvider({ baseUrl: '/api/persistence' })).not.toThrow();
  });

  test('passes credentials through to fetch for a cross-origin cookie deployment', async () => {
    // A cookie-authenticated deployment on another origin has no other way in:
    // fetch sends no cookies cross-origin by default, and the headers hook
    // cannot set Cookie because the browser forbids it.
    let seen: RequestCredentials | undefined;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      credentials: 'include',
      fetch: async (_input, init) => {
        seen = init?.credentials;
        return new Response(null, { status: 204 });
      },
    });

    await provider.remove(`sha256-${'c'.repeat(64)}`);
    expect(seen).toBe('include');
  });

  test('omits credentials entirely when the deployment does not ask for them', async () => {
    let hadKey = true;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async (_input, init) => {
        hadKey = init !== undefined && 'credentials' in init;
        return new Response(null, { status: 204 });
      },
    });

    await provider.remove(`sha256-${'d'.repeat(64)}`);
    expect(hadKey).toBe(false);
  });
});

describe('conformance server request hygiene', () => {
  test.each([
    ['%2e', `/assets/%2e`],
    ['%2E', `/assets/%2E`],
    ['%2e%2e', `/assets/%2e%2e`],
    ['an encoded traversal', `/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd`],
  ])('refuses the encoded dot segment %s on the raw request target', async (_name, path) => {
    // The WHATWG parser resolves dot segments — including their percent-encoded
    // spellings — before any validator can look, so a server reading the parsed
    // path would be inspecting a request nobody sent. These must be judged as
    // received.
    const response = await proxyServer.fetch(`${proxyServer.baseUrl}${path}`, {
      method: 'DELETE',
      headers: sessionCookie(`dot-segment-${namespace++}`),
    });

    expect(response.status, path).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  test('a malformed percent-escape is a 400, not a 500', async () => {
    // decodeURIComponent throws a native URIError on `%`; unmapped it would
    // surface as the contract's INTERNAL_ERROR row for an ordinary bad request.
    for (const path of ['/assets/%', '/kv/entries/%zz']) {
      const response = await proxyServer.fetch(`${proxyServer.baseUrl}${path}`, {
        headers: sessionCookie(`percent-${namespace++}`),
      });
      expect(response.status, path).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    }
  });

  test('the server refuses a percent-encoded surrogate identifier', async () => {
    // A lone surrogate has no UTF-8 encoding, so `encodeURIComponent` refuses to
    // produce one and the raw CESU-8 form below is the only way it can arrive.
    // Either way the answer is a bad request, never a 500 — and never a decoded
    // identifier the storage layer has to reason about.
    const response = await proxyServer.fetch(`${proxyServer.baseUrl}/assets/%ED%A0%80`, {
      method: 'DELETE',
      headers: sessionCookie(`surrogate-${namespace++}`),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });
});

describe('HttpAssetProvider cache and not-found identity', () => {
  test('a resolve request is never served from a cache', async () => {
    // The in-flight coalescing lives in this object; the HTTP cache does not.
    // A cached resolve returns an expired signed URL, or replays a negatively
    // cached 404 for an asset written since.
    let seen: RequestCache | undefined;
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async (_input, init) => {
        seen = init?.cache;
        return new Response(JSON.stringify({ url: 'https://cdn.invalid/o/abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await provider.resolve(`sha256-${'a'.repeat(64)}`);
    expect(seen).toBe('no-store');
  });

  test.each([
    [401, 'the credential expired'],
    [403, 'a gateway denied the request'],
    [500, 'the origin fell over'],
  ])('throws when a %i answer carries the not-found code', async (status, why) => {
    // A proxy that echoes the body's error code while answering with its own
    // status must not be read as "the asset is gone": `null` is a statement
    // about the asset, and this is a statement about the infrastructure.
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'ASSET_NOT_FOUND', message: why } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const failure = provider.resolve(`sha256-${'b'.repeat(64)}`);
    await expect(failure).rejects.toBeInstanceOf(HttpAssetProviderError);
    await expect(failure).rejects.toMatchObject({ status, code: 'ASSET_NOT_FOUND' });
  });

  test('still maps a genuine 404 ASSET_NOT_FOUND to null', async () => {
    const provider = new HttpAssetProvider({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'ASSET_NOT_FOUND', message: 'absent' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(provider.resolve(`sha256-${'c'.repeat(64)}`)).resolves.toBeNull();
  });
});

test('real fetch reaches the listening conformance server over loopback', async ({ skip }) => {
  let networkServer: KvAssetConformanceServer;
  try {
    networkServer = await startKvAssetConformanceServer();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      skip('sandbox does not permit binding a 127.0.0.1 listener');
    }
    throw error;
  }
  try {
    const provider = new HttpAssetProvider({
      baseUrl: networkServer.baseUrl,
      headers: () => sessionCookie('real-network'),
    });
    const ref = await provider.put(new Blob(['over the wire'], { type: 'text/plain' }));
    const url = await provider.resolve(ref);
    expect(url).toBe(`${networkServer.baseUrl}/assets/${ref}/content`);

    const response = await fetch(url!, { headers: sessionCookie('real-network') });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf('over the wire'));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  } finally {
    await networkServer.close();
  }
});
