import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserKVStore } from '../src/kv/browser.js';
import { HttpAccountKV, HttpKVStore, HttpKVStoreError } from '../src/kv/http.js';
import { runKVStoreContract } from './kv-contract.js';
import { MemoryStorage } from './setup.js';
import {
  startKvAssetConformanceServer,
  type KvAssetConformanceServer,
} from './kv-asset-conformance-server.js';

let server: KvAssetConformanceServer;
let namespace = 0;

function makeStore(storageNamespace = `kv-${namespace++}`): HttpKVStore {
  return new HttpKVStore({
    baseUrl: server.baseUrl,
    fetch: server.fetch,
    headers: () => ({ 'x-storage-namespace': storageNamespace }),
    deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
  });
}

beforeAll(async () => {
  server = await startKvAssetConformanceServer({ listen: false });
});

afterAll(async () => {
  await server.close();
});

runKVStoreContract('HTTP (account) + local (device)', () => makeStore());

describe('HttpKVStore device-scope invariant', () => {
  test('device values are structurally unable to reach the transport', () => {
    const account = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });

    // The whole invariant in one assertion: the object that owns the network is
    // typed without a scope, so "send this device value" is not a call anyone
    // can write. These are never invoked — they exist to be type-checked. If a
    // scope parameter is ever added, the directives become unused and `tsc`
    // fails the build, so the guard cannot rot silently.
    const deviceCalls = (): unknown[] => [
      // @ts-expect-error `set` takes (key, value); there is no scope to pass.
      account.set('theme', 'dark', 'device'),
      // @ts-expect-error `get` takes (key); there is no scope to pass.
      account.get('theme', 'device'),
      // @ts-expect-error `remove` takes (key); there is no scope to pass.
      account.remove('theme', 'device'),
      // @ts-expect-error `keys` takes (prefix?); there is no scope to pass.
      account.keys('ui:', 'device'),
    ];

    expect(typeof deviceCalls).toBe('function');
  });

  test('an HttpKVStore cannot be built without somewhere local to keep device values', () => {
    const withoutDeviceStore = (): HttpKVStore =>
      // @ts-expect-error `deviceStore` is required: there is no default, and no
      // configuration in which device values fall through to the server.
      new HttpKVStore({ baseUrl: 'https://kv.invalid' });

    expect(typeof withoutDeviceStore).toBe('function');
  });

  test('device reads and writes issue no request at all', async () => {
    const requests: string[] = [];
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async (input, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(input)} ${String(init?.body ?? '')}`);
        return new Response(null, { status: 204 });
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await store.set('theme', { mode: 'dark' }, 'device');
    await store.set('layout', 'wide', 'device');
    expect(await store.get('theme', 'device')).toEqual({ mode: 'dark' });
    expect(await store.keys('', 'device')).toEqual(['theme', 'layout']);
    await store.remove('theme', 'device');
    expect(await store.get('theme', 'device')).toBeNull();

    expect(requests).toEqual([]);
  });

  test('a device value never appears in traffic, even alongside account traffic', async () => {
    const traffic: string[] = [];
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async (input, init) => {
        traffic.push(
          [
            init?.method ?? 'GET',
            String(input),
            JSON.stringify(init?.headers ?? {}),
            String(init?.body ?? ''),
          ].join(' '),
        );
        const body = String(input).includes('/kv/keys') ? [] : { value: null };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    const secret = 'device-only-secret-value';
    await store.set('shared-key', secret, 'device');
    await store.set('shared-key', 'account-value', 'account');
    await store.get('shared-key');
    await store.keys();
    await store.remove('shared-key');

    expect(traffic.length).toBeGreaterThan(0);
    for (const line of traffic) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain('device');
    }
  });

  test('the account contract exposes no scope on the wire', async () => {
    const paths: string[] = [];
    const account = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname + new URL(String(input)).search);
        return new Response(null, { status: 204 });
      },
    });

    await account.set('k', 'v');
    await account.remove('k');
    expect(paths).toEqual(['/kv/entries/k', '/kv/entries/k']);
  });

  test('the server refuses a request body that invents a scope', async () => {
    const response = await server.fetch(`${server.baseUrl}/kv/entries/k`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-storage-namespace': `scope-body-${namespace++}`,
      },
      body: JSON.stringify({ value: 'v', scope: 'device' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('scope') },
    });
  });
});

describe('HttpKVStore transport semantics', () => {
  test('maps a missing key to null rather than an error', async () => {
    const store = makeStore();
    await expect(store.get('absent')).resolves.toBeNull();
  });

  test('rejects values JSON cannot carry faithfully', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    // Narrower than BrowserKVStore on purpose: structured values that survive
    // `localStorage` round-trips only because `JSON.stringify` silently drops or
    // rewrites them must fail loud before they are sent.
    const rejected: [string, unknown][] = [
      ['Map', new Map([['k', 'v']])],
      ['Set', new Set(['v'])],
      ['Date', new Date('2026-01-01T00:00:00.000Z')],
      ['NaN', Number.NaN],
      ['negative zero', -0],
      ['nested undefined', { nested: undefined }],
      ['NUL string', 'before\u0000after'],
      ['unpaired surrogate', '\uD800'],
    ];

    for (const [name, value] of rejected) {
      await expect(store.set('k', value), name).rejects.toThrow(/not a plain JSON value/);
    }
  });

  test('rejects keys JSON cannot carry faithfully', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await expect(store.set('bad\u0000key', 'v')).rejects.toThrow(/not a plain JSON value/);
    await expect(store.get('\uD800')).rejects.toThrow(/not a plain JSON value/);
  });

  test('rejects dot-only keys before URL construction', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await expect(store.get('.')).rejects.toThrow(/must not be ['"]\.['"]/);
    await expect(store.remove('..')).rejects.toThrow(/must not be ['"]\.\.['"]/);
  });

  test('reports a malformed get response instead of inventing a value', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ notValue: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await expect(store.get('k')).rejects.toMatchObject({
      name: 'HttpKVStoreError',
      code: 'MALFORMED_RESPONSE',
    });
  });

  test.each([
    ['a non-array body', { keys: [] }],
    ['a non-string member', ['ok', 7]],
  ])('reports %s from keys() as a malformed response', async (_name, body) => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await expect(store.keys()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  test('surfaces a server failure as a typed error', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    const failure = store.get('k');
    await expect(failure).rejects.toBeInstanceOf(HttpKVStoreError);
    await expect(failure).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  test('sends a prefix query only when a prefix is given', async () => {
    const paths: string[] = [];
    const account = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname + url.search);
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await account.keys();
    await account.keys('ui:');
    expect(paths).toEqual(['/kv/keys', '/kv/keys?prefix=ui%3A']);
  });

  test('requires a non-empty base url and a usable fetch implementation', () => {
    const deviceStore = new BrowserKVStore({ storage: new MemoryStorage() });
    expect(() => new HttpKVStore({ baseUrl: '', deviceStore })).toThrow(
      /baseUrl must be non-empty/,
    );
    expect(
      () =>
        new HttpKVStore({
          baseUrl: 'https://kv.invalid',
          fetch: {} as unknown as typeof globalThis.fetch,
          deviceStore,
        }),
    ).toThrow(/requires a fetch implementation/);
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
    const store = new HttpKVStore({
      baseUrl: networkServer.baseUrl,
      headers: () => ({ 'x-storage-namespace': 'real-network' }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await store.set('provider', { name: 'demo', models: ['a', 'b'] });
    await expect(store.get('provider')).resolves.toEqual({ name: 'demo', models: ['a', 'b'] });
    await expect(store.keys()).resolves.toEqual(['provider']);
    await store.remove('provider');
    await expect(store.get('provider')).resolves.toBeNull();
  } finally {
    await networkServer.close();
  }
});
