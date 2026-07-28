import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserKVStore } from '../src/kv/browser.js';
import type { KVStore, LocalKVStore } from '../src/kv/types.js';
import { KVScopeViolationError } from '../src/kv/types.js';
import { kvPersistStorage } from '../src/zustand/persist.js';
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
  test('a device scope is a type error at a direct call on the transport', () => {
    const account = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });

    // Never invoked — these exist to be type-checked. The scope parameter is
    // declared as `'account'` precisely so a literal `'device'` cannot be
    // written here; if that narrowing is ever widened the directives go unused
    // and `tsc` fails the build, so the guard cannot rot silently. It only
    // covers *direct* calls, which is why the runtime refusal below exists too.
    const deviceCalls = (): unknown[] => [
      // @ts-expect-error this transport serves the account scope only.
      account.set('theme', 'dark', 'device'),
      // @ts-expect-error this transport serves the account scope only.
      account.get('theme', 'device'),
      // @ts-expect-error this transport serves the account scope only.
      account.remove('theme', 'device'),
      // @ts-expect-error this transport serves the account scope only.
      account.keys('ui:', 'device'),
      // An options-shaped scope is no more expressible than a positional one:
      // the parameter is `'account'`, not an object with a scope in it.
      // @ts-expect-error there is no options form that carries a scope.
      account.set('theme', 'dark', { scope: 'device' }),
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

  // The transport's missing scope parameter only protects the *positional*
  // call. What actually keeps device values off the wire is that a networked
  // store cannot be the deviceStore at all — and that has to be checked, because
  // `HttpAccountKV` satisfies `KVStore` structurally (its methods are the same
  // methods minus an optional parameter), so before the `LocalKVStore` brand it
  // could be injected as the device backend with zero type errors.
  test('a networked store cannot be injected as the device backend', () => {
    const remote = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async () => new Response(null, { status: 204 }),
    });

    const injectTransport = (): HttpKVStore =>
      new HttpKVStore({
        baseUrl: 'https://kv.invalid',
        // @ts-expect-error a remote transport is not a LocalKVStore.
        deviceStore: remote,
      });
    // Assignability to the *bare* `KVStore` is what made this reachable, so the
    // probe goes through a `KVStore` annotation as well.
    const asPlainKvStore: KVStore = remote;
    const injectViaKVStore = (): HttpKVStore =>
      new HttpKVStore({
        baseUrl: 'https://kv.invalid',
        // @ts-expect-error `KVStore` is not `LocalKVStore` either.
        deviceStore: asPlainKvStore,
      });

    // And the cast that would erase both type errors is refused at runtime.
    expect(injectTransport).toThrow(/must be a local KVStore/);
    expect(injectViaKVStore).toThrow(/must be a local KVStore/);
    expect(
      () =>
        new HttpKVStore({
          baseUrl: 'https://kv.invalid',
          deviceStore: remote as unknown as LocalKVStore,
        }),
    ).toThrow(/must be a local KVStore/);
  });

  test('an HttpKVStore cannot be nested as its own device backend', () => {
    const outer = makeStore();

    expect(
      () =>
        new HttpKVStore({
          baseUrl: 'https://kv.invalid',
          fetch: async () => new Response(null, { status: 204 }),
          deviceStore: outer as unknown as LocalKVStore,
        }),
    ).toThrow(/must be a local KVStore/);
  });

  // The transport is publicly exported and structurally a `KVStore`, so its
  // missing scope parameter was never "inexpressible" — the extra argument was
  // accepted by the language and dropped on the floor. Both sequences below
  // compiled without a cast and put a device value on the wire.
  test('the transport refuses a device scope handed to it through a KVStore reference', async () => {
    const sent: string[] = [];
    const account = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async (input, init) => {
        sent.push(`${String(input)} ${String(init?.body ?? '')}`);
        return new Response(null, { status: 204 });
      },
    });
    // Assignable, because TypeScript compares method parameters bivariantly.
    const asKvStore: KVStore = account;

    await expect(asKvStore.set('theme', 'DEVICE-ONLY', 'device')).rejects.toBeInstanceOf(
      KVScopeViolationError,
    );
    await expect(asKvStore.get('theme', 'device')).rejects.toThrow(/account scope only/);
    await expect(asKvStore.remove('theme', 'device')).rejects.toThrow(/account scope only/);
    await expect(asKvStore.keys('ui:', 'device')).rejects.toThrow(/account scope only/);

    expect(sent).toEqual([]);
  });

  test('the transport still serves an explicitly account-scoped call', async () => {
    const paths: string[] = [];
    const account = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname);
        return new Response(null, { status: 204 });
      },
    });

    await account.set('k', 'v', 'account');
    await account.remove('k', 'account');
    expect(paths).toEqual(['/kv/entries/k', '/kv/entries/k']);
  });

  test('the persist adapter refuses to pair a device scope with a remote store', () => {
    const sent: string[] = [];
    const account = new HttpAccountKV({
      baseUrl: 'https://kv.invalid',
      fetch: async (input, init) => {
        sent.push(`${String(input)} ${String(init?.body ?? '')}`);
        return new Response(null, { status: 204 });
      },
    });

    // The documented persist wiring, and the shortest path to a device value on
    // the wire: the adapter takes the store and the scope as separate arguments,
    // so nothing else was checking that they belong together.
    const pairing = (): unknown =>
      // @ts-expect-error the `device` overload requires a LocalKVStore.
      kvPersistStorage(account, 'device');
    expect(pairing).toThrow(/requires a LocalKVStore/);

    // And the cast that erases the type error is refused at runtime.
    expect(() => kvPersistStorage(account as unknown as LocalKVStore, 'device')).toThrow(
      KVScopeViolationError,
    );
    expect(sent).toEqual([]);
  });

  test('the persist adapter still accepts the legitimate pairings', async () => {
    const local = new BrowserKVStore({ storage: new MemoryStorage() });
    const deviceStorage = kvPersistStorage<{ theme: string }>(local, 'device');
    await deviceStorage.setItem('settings-storage', { state: { theme: 'dark' } });
    expect(await deviceStorage.getItem('settings-storage')).toEqual({ state: { theme: 'dark' } });

    // A remote store with the account scope is exactly what the adapter is for.
    expect(() => kvPersistStorage(makeStore(), 'account')).not.toThrow();
    expect(() => kvPersistStorage(makeStore())).not.toThrow();
  });

  test('a hand-rolled store lying about being local is the only way through', async () => {
    // Documented, not endorsed: the brand stops accidents and casts, not an
    // author who writes the lie out. The point of the assertion is that the lie
    // has to be *authored* — nothing in the package hands it to you.
    const sent: string[] = [];
    const liar = {
      isLocalKVStore: true as const,
      get: async () => null,
      set: async (key: string, value: unknown) => {
        sent.push(`${key}=${JSON.stringify(value)}`);
      },
      remove: async () => undefined,
      keys: async () => [],
    } satisfies LocalKVStore;

    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
      deviceStore: liar,
    });
    await store.set('theme', 'dark', 'device');

    expect(sent).toEqual(['theme="dark"']);
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

  test.each([
    ['a query parameter', '/kv/entries/k?scope=device', {}],
    ['a header', '/kv/entries/k', { 'x-scope': 'device' }],
  ])('the server refuses a scope smuggled in %s', async (_name, path, extraHeaders) => {
    // The body is not the only channel a scope could hide in, and a server that
    // ignored the others would silently discard a caller's stated intent.
    const response = await server.fetch(`${server.baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-storage-namespace': `scope-channel-${namespace++}`,
        ...extraHeaders,
      },
      body: JSON.stringify({ value: 'v' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('scope') },
    });
  });
});

describe('HttpKVStore key constraints', () => {
  const store = (): HttpKVStore =>
    new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

  test('refuses an empty key', async () => {
    await expect(store().get('')).rejects.toThrow(/must not be empty/);
    await expect(store().set('', 'v')).rejects.toThrow(/must not be empty/);
  });

  test.each([
    ['forward slash', 'a/../../b'],
    ['backslash', 'a\\..\\b'],
    ['bare separator', 'a/b'],
  ])('refuses a key containing a %s', async (_name, key) => {
    await expect(store().get(key)).rejects.toThrow(/must not contain/);
    await expect(store().set(key, 'v')).rejects.toThrow(/must not contain/);
    await expect(store().remove(key)).rejects.toThrow(/must not contain/);
  });

  test('refuses an over-long key', async () => {
    await expect(store().set('k'.repeat(513), 'v')).rejects.toThrow(/exceeds 512 UTF-8 bytes/);
  });

  test('bounds the key by bytes, not characters', async () => {
    // 256 three-byte characters (U+20AC) is 768 bytes: a character-counting bound would
    // wave it through and hand the server a key half again its stated limit.
    await expect(store().set('\u20AC'.repeat(256), 'v')).rejects.toThrow(/exceeds 512 UTF-8 bytes/);
  });

  test.each([
    ['%2e', '/kv/entries/%2e'],
    ['%2e%2e', '/kv/entries/%2e%2e'],
  ])('the server refuses the encoded dot segment %s', async (_name, path) => {
    const response = await server.fetch(`${server.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { 'x-storage-namespace': `kv-dot-${namespace++}` },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  test('the server validates the keys() prefix, not just the key', async () => {
    // The prefix is a separate caller-controlled input that reaches the same
    // query a key does; a server trusting the client to have checked it is
    // trusting a client it does not control.
    const response = await server.fetch(
      `${server.baseUrl}/kv/keys?prefix=${encodeURIComponent('a/b')}`,
      { headers: { 'x-storage-namespace': `kv-prefix-${namespace++}` } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('must not contain') },
    });
  });

  test('the server refuses a percent-encoded traversal in a key', async () => {
    const response = await server.fetch(
      `${server.baseUrl}/kv/entries/${encodeURIComponent('../../etc/passwd')}`,
      { method: 'DELETE', headers: { 'x-storage-namespace': `kv-traversal-${namespace++}` } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('must not contain') },
    });
  });
});

describe('HttpKVStore error-table coverage', () => {
  function respondWith(status: number, code: string): HttpKVStore {
    return new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code, message: `${code} from server` } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });
  }

  test('a 404 ROUTE_NOT_FOUND throws instead of masquerading as a missing key', async () => {
    // The MUST a status-only client would break: both rows are 404, and only
    // KEY_NOT_FOUND means "no such entry".
    const failure = respondWith(404, 'ROUTE_NOT_FOUND').get('k');
    await expect(failure).rejects.toBeInstanceOf(HttpKVStoreError);
    await expect(failure).rejects.toMatchObject({ status: 404, code: 'ROUTE_NOT_FOUND' });
  });

  test.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN_KV'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [500, 'INTERNAL_ERROR'],
  ])('maps %i %s to a typed error', async (status, code) => {
    await expect(respondWith(status, code).get('k')).rejects.toMatchObject({ status, code });
  });

  test('an unauthenticated deployment answers 401 on the contract routes', async () => {
    const guarded = await startKvAssetConformanceServer({
      listen: false,
      authenticate: (req) => req.headers.authorization !== undefined,
    });
    try {
      const store = new HttpKVStore({
        baseUrl: guarded.baseUrl,
        fetch: guarded.fetch,
        deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
      });
      // Not null: an authentication failure must never look like a missing key.
      await expect(store.get('k')).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    } finally {
      await guarded.close();
    }
  });

  test('a denied principal receives 403 rather than a missing key', async () => {
    const guarded = await startKvAssetConformanceServer({
      listen: false,
      authorize: (_req, area) => area !== 'kv',
    });
    try {
      const store = new HttpKVStore({
        baseUrl: guarded.baseUrl,
        fetch: guarded.fetch,
        deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
      });
      await expect(store.get('k')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN_KV' });
    } finally {
      await guarded.close();
    }
  });

  test('a write past the body ceiling is rejected with 413', async () => {
    const bounded = await startKvAssetConformanceServer({ listen: false, maxBodyBytes: 8 });
    try {
      const store = new HttpKVStore({
        baseUrl: bounded.baseUrl,
        fetch: bounded.fetch,
        deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
      });
      await expect(store.set('k', 'a value well past eight bytes')).rejects.toMatchObject({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    } finally {
      await bounded.close();
    }
  });

  test('a 2xx with an unparseable body becomes a typed malformed response', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () =>
        new Response('<html>a proxy error page</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    const failure = store.get('k');
    await expect(failure).rejects.not.toBeInstanceOf(SyntaxError);
    await expect(failure).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
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
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rejected: [string, unknown][] = [
      ['Map', new Map([['k', 'v']])],
      ['Set', new Set(['v'])],
      ['Date', new Date('2026-01-01T00:00:00.000Z')],
      ['NaN', Number.NaN],
      ['negative zero', -0],
      ['nested undefined', { nested: undefined }],
      ['NUL string', 'before\u0000after'],
      ['unpaired surrogate', '\uD800'],
      // The three a `JSON.stringify` pre-flight would mishandle: two throw a
      // native TypeError before the gate can produce its message, and the third
      // stringifies to `undefined` and would be reclassified as a delete.
      ['bigint', BigInt(1)],
      ['circular reference', circular],
      ['toJSON returning undefined', { toJSON: () => undefined }],
    ];

    for (const [name, value] of rejected) {
      const failure = store.set('k', value);
      await expect(failure, name).rejects.toThrow(/not a plain JSON value/);
      await expect(failure, name).rejects.not.toBeInstanceOf(TypeError);
    }
  });

  test('the JSON gate runs before anything reads the value', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    // A pre-flight `JSON.stringify` would invoke this before the gate looked,
    // letting caller code run — and change its mind — between the check and the
    // serialization the check was supposed to cover.
    let reads = 0;
    const spy = {
      get value() {
        reads += 1;
        return reads;
      },
    };

    await expect(store.set('k', spy)).rejects.toThrow(/not a plain JSON value/);
    expect(reads).toBe(0);
  });

  test.each([
    ['undefined', undefined],
    ['a function', () => 'x'],
    ['a symbol', Symbol('s')],
  ])('treats %s as a delete, matching the browser backend', async (_name, value) => {
    const store = makeStore();
    await store.set('k', 'present');
    await store.set('k', value);

    expect(await store.get('k')).toBeNull();
    expect(await store.keys()).not.toContain('k');
  });

  test('rejects keys JSON cannot carry faithfully', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await expect(store.set('bad\u0000key', 'v')).rejects.toThrow(/must not contain the NUL/);
    await expect(store.get('\uD800')).rejects.toThrow(/unpaired UTF-16 surrogate/);
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

  test.each([
    ['file:', 'file:///etc'],
    ['ftp:', 'ftp://host/x'],
  ])('refuses a %s base url at construction', (_name, baseUrl) => {
    const deviceStore = new BrowserKVStore({ storage: new MemoryStorage() });
    expect(() => new HttpKVStore({ baseUrl, deviceStore })).toThrow(/is not http\(s\)/);
  });

  test('refuses a scheme-without-authority base url', () => {
    const deviceStore = new BrowserKVStore({ storage: new MemoryStorage() });
    expect(
      () => new HttpKVStore({ baseUrl: 'https:api.example/persistence', deviceStore }),
    ).toThrow(/scheme:\/\/host/);
  });

  test.each([
    ['a query', 'https://kv.invalid/api?v=1'],
    ['a fragment', 'https://kv.invalid/api#frag'],
  ])('refuses a base url carrying %s', (_name, baseUrl) => {
    const deviceStore = new BrowserKVStore({ storage: new MemoryStorage() });
    expect(() => new HttpKVStore({ baseUrl, deviceStore })).toThrow(/query or fragment/);
  });

  test('omits credentials entirely when the deployment does not ask for them', async () => {
    let hadKey = true;
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async (_input, init) => {
        hadKey = init !== undefined && 'credentials' in init;
        return new Response(null, { status: 204 });
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await store.remove('k');
    expect(hadKey).toBe(false);
  });

  test.each([
    ['protocol-relative', '//evil.example'],
    ['backslash authority', '/\\evil.example'],
  ])('refuses a %s base url posing as a path', (_name, baseUrl) => {
    const deviceStore = new BrowserKVStore({ storage: new MemoryStorage() });
    expect(() => new HttpKVStore({ baseUrl, deviceStore })).toThrow(
      /not a reference to another origin/,
    );
  });

  test.each([
    ['a tab', '/api\u0009/persistence'],
    ['a NUL', '/api\u0000/persistence'],
  ])('refuses a base url containing %s', (_name, baseUrl) => {
    const deviceStore = new BrowserKVStore({ storage: new MemoryStorage() });
    expect(() => new HttpKVStore({ baseUrl, deviceStore })).toThrow(/control characters/);
  });

  test.each([
    ['a bare query separator', 'https://kv.invalid/api?'],
    ['a bare fragment separator', '/api/persistence#'],
  ])('refuses a base url ending in %s', (_name, baseUrl) => {
    const deviceStore = new BrowserKVStore({ storage: new MemoryStorage() });
    expect(() => new HttpKVStore({ baseUrl, deviceStore })).toThrow(/query or fragment/);
  });

  test('passes credentials through to fetch for a cross-origin cookie deployment', async () => {
    let seen: RequestCredentials | undefined;
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      credentials: 'include',
      fetch: async (_input, init) => {
        seen = init?.credentials;
        return new Response(null, { status: 204 });
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await store.remove('k');
    expect(seen).toBe('include');
  });

  test('a headers hook cannot describe the request body', async () => {
    // Same rule as HttpAssetProvider, so the two clients do not disagree about
    // whether a hook may set Content-Type.
    let called = false;
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () => {
        called = true;
        return new Response(null, { status: 204 });
      },
      headers: () => ({ 'Content-Type': 'text/plain' }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await expect(store.set('k', 'v')).rejects.toThrow(/must not set Content-Type/);
    expect(called).toBe(false);
    // Reads carry no body, so there is nothing for a hook to misdescribe.
    await expect(store.remove('k')).resolves.toBeUndefined();
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

describe('HttpKVStore cache and not-found identity', () => {
  test.each([
    ['a read of one entry', (kv: HttpKVStore) => kv.get('k')],
    ['a key listing', (kv: HttpKVStore) => kv.keys()],
  ])('%s is never served from a cache', async (_name, operation) => {
    // `account` values are precisely the ones another device may have changed a
    // moment ago, and this client cannot invalidate a cache entry when it does.
    let seen: RequestCache | undefined;
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async (input, init) => {
        seen = init?.cache;
        const body = String(input).includes('/kv/keys') ? [] : { value: 'v' };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await operation(store);
    expect(seen).toBe('no-store');
  });

  test('a write is not marked no-store, having nothing to read from a cache', async () => {
    let seen: RequestCache | undefined = 'no-store';
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async (_input, init) => {
        seen = init?.cache;
        return new Response(null, { status: 204 });
      },
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await store.set('k', 'v');
    expect(seen).toBeUndefined();
  });

  test.each([
    [401, 'the credential expired'],
    [403, 'a gateway denied the request'],
    [500, 'the origin fell over'],
  ])('throws when a %i answer carries the not-found code', async (status, why) => {
    // `null` here is indistinguishable from a legitimate miss, so reading an
    // outage as one would present it to the caller as data loss.
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'KEY_NOT_FOUND', message: why } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    const failure = store.get('k');
    await expect(failure).rejects.toBeInstanceOf(HttpKVStoreError);
    await expect(failure).rejects.toMatchObject({ status, code: 'KEY_NOT_FOUND' });
  });

  test('still maps a genuine 404 KEY_NOT_FOUND to null', async () => {
    const store = new HttpKVStore({
      baseUrl: 'https://kv.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'KEY_NOT_FOUND', message: 'absent' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    });

    await expect(store.get('k')).resolves.toBeNull();
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
