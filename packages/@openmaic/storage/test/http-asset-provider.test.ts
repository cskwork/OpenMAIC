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

async function readUrlFrom(
  server: KvAssetConformanceServer,
  storageNamespace: string,
  url: string,
): Promise<Uint8Array> {
  const response = await server.fetch(url, {
    headers: { 'x-storage-namespace': storageNamespace },
  });
  if (!response.ok) throw new Error(`asset url ${url} responded ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
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
  'HttpAssetProvider (proxied urls)',
  () =>
    new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => ({ 'x-storage-namespace': PROXY_NAMESPACE }),
    }),
  (url) => readUrlFrom(proxyServer, PROXY_NAMESPACE, url),
);

runStorageProviderContract(
  'HttpAssetProvider (signed urls)',
  () =>
    new HttpAssetProvider({
      baseUrl: signedServer.baseUrl,
      fetch: signedServer.fetch,
      headers: () => ({ 'x-storage-namespace': SIGNED_NAMESPACE }),
    }),
  (url) => readUrlFrom(signedServer, SIGNED_NAMESPACE, url),
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
      headers: () => ({ 'x-storage-namespace': `cross-backend-${namespace++}` }),
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
        headers: {
          'content-type': 'text/plain',
          'x-storage-namespace': storageNamespace,
        },
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
      headers: {
        'content-type': 'text/plain',
        'x-storage-namespace': `shape-${namespace++}`,
      },
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
      headers: () => ({ 'x-storage-namespace': storageNamespace }),
    });

    const first = await provider.put(new Blob(['dup me'], { type: '' }));
    const second = await provider.put(new Blob(['dup me'], { type: 'image/png' }));
    expect(second).toBe(first);

    // Same behaviour as BrowserAssetProvider: a re-put with corrected metadata
    // wins, so resolved MIME never depends on which write happened first.
    const url = await provider.resolve(first);
    const response = await proxyServer.fetch(url!, {
      headers: { 'x-storage-namespace': storageNamespace },
    });
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});

describe('HttpAssetProvider transport semantics', () => {
  test('carries the content type through to the resolved bytes', async () => {
    const storageNamespace = `content-type-${namespace++}`;
    const provider = new HttpAssetProvider({
      baseUrl: proxyServer.baseUrl,
      fetch: proxyServer.fetch,
      headers: () => ({ 'x-storage-namespace': storageNamespace }),
    });

    const ref = await provider.put(new Blob(['pixels'], { type: '' }), {
      contentType: 'image/png',
    });
    const url = await provider.resolve(ref);
    const response = await proxyServer.fetch(url!, {
      headers: { 'x-storage-namespace': storageNamespace },
    });

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
      headers: () => ({ 'x-storage-namespace': `remove-unknown-${namespace++}` }),
    });

    await expect(provider.remove(`sha256-${'a'.repeat(64)}`)).resolves.toBeUndefined();
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
      headers: () => ({ 'x-storage-namespace': 'real-network' }),
    });
    const ref = await provider.put(new Blob(['over the wire'], { type: 'text/plain' }));
    const url = await provider.resolve(ref);
    expect(url).toBe(`${networkServer.baseUrl}/assets/${ref}/content`);

    const response = await fetch(url!, { headers: { 'x-storage-namespace': 'real-network' } });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf('over the wire'));
  } finally {
    await networkServer.close();
  }
});
