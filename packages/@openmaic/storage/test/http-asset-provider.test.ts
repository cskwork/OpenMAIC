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
    await expect(failure).rejects.toThrow(/protocol-relative/);
  });

  test.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['blob', 'blob:https://assets.invalid/abc'],
  ])('refuses a %s: url, which would execute rather than render', async (_name, url) => {
    const failure = providerReturning(url).resolve('ref');
    await expect(failure).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(failure).rejects.toThrow(/not http\(s\)/);
  });

  test('accepts an http url as well as an https one', async () => {
    await expect(providerReturning('http://cdn.invalid/o/abc').resolve('ref')).resolves.toBe(
      'http://cdn.invalid/o/abc',
    );
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
    await expect(failure).rejects.toThrow(/not a plain JSON value/);
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
