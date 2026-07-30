// Implementation-agnostic contract for `KVStore`. Every backend (browser and
// HTTP) is proven equivalent by running this same suite against it, so a new
// backend cannot silently diverge from the primitive's semantics.
import { describe, expect, test } from 'vitest';
import type { KVScope, KVStore } from '../src/index.js';

export function runKVStoreContract(name: string, makeStore: () => KVStore): void {
  describe(`KVStore contract: ${name}`, () => {
    test('round-trips a value set then get', async () => {
      const kv = makeStore();
      await kv.set('greeting', 'hello');
      expect(await kv.get<string>('greeting')).toBe('hello');
    });

    test('returns null for a missing key', async () => {
      const kv = makeStore();
      expect(await kv.get('nope')).toBeNull();
    });

    test('round-trips structured JSON values', async () => {
      const kv = makeStore();
      const value = { a: 1, b: ['x', 'y'], c: { nested: true } };
      await kv.set('obj', value);
      expect(await kv.get('obj')).toEqual(value);
    });

    test('overwrites an existing key', async () => {
      const kv = makeStore();
      await kv.set('k', 'first');
      await kv.set('k', 'second');
      expect(await kv.get<string>('k')).toBe('second');
    });

    test('remove deletes a key', async () => {
      const kv = makeStore();
      await kv.set('k', 'v');
      await kv.remove('k');
      expect(await kv.get('k')).toBeNull();
    });

    test('defaults to the account scope', async () => {
      const kv = makeStore();
      await kv.set('k', 'v'); // no scope → account
      expect(await kv.get('k', 'account')).toBe('v');
      expect(await kv.get('k', 'device')).toBeNull();
    });

    test('isolates the device and account scopes', async () => {
      const kv = makeStore();
      await kv.set('k', 'device-val', 'device');
      await kv.set('k', 'account-val', 'account');
      expect(await kv.get('k', 'device')).toBe('device-val');
      expect(await kv.get('k', 'account')).toBe('account-val');
    });

    test('keys() lists keys in a scope, filtered by prefix', async () => {
      const kv = makeStore();
      await kv.set('ui:width', 1, 'device');
      await kv.set('ui:height', 2, 'device');
      await kv.set('other', 3, 'device');
      await kv.set('ui:acct', 4, 'account');
      const uiKeys = await kv.keys('ui:', 'device');
      expect([...uiKeys].sort()).toEqual(['ui:height', 'ui:width']);
    });

    test('keys() with no prefix lists every key in the scope', async () => {
      const kv = makeStore();
      await kv.set('a', 1);
      await kv.set('b', 2);
      expect([...(await kv.keys())].sort()).toEqual(['a', 'b']);
    });

    test('set(undefined) clears the key instead of corrupting it', async () => {
      const kv = makeStore();
      await kv.set('k', 'v');
      await kv.set('k', undefined);
      // Must return null, not throw — a stored literal "undefined" would throw
      // on the JSON.parse in get().
      expect(await kv.get('k')).toBeNull();
      expect(await kv.keys()).not.toContain('k');
    });

    test('remove is scoped', async () => {
      const kv = makeStore();
      await kv.set('k', 'device-val', 'device');
      await kv.set('k', 'account-val', 'account');
      await kv.remove('k', 'device');
      expect(await kv.get('k', 'device')).toBeNull();
      expect(await kv.get('k', 'account')).toBe('account-val');
    });

    // Both backends decide "this write is a delete" by inspecting the value, not
    // by trial-serializing it: `JSON.stringify` runs caller code, so a probe
    // would reclassify `{ toJSON: () => undefined }` as a delete on one backend
    // while the other rejects it. A value that cannot be stored is refused, and
    // a refused write leaves the previous value alone.
    test('a toJSON returning undefined is refused, not silently treated as a delete', async () => {
      const kv = makeStore();
      await kv.set('k', 'present');

      await expect(kv.set('k', { toJSON: () => undefined })).rejects.toThrow();
      expect(await kv.get('k')).toBe('present');
    });

    test('the key is validated before anything reads the value', async () => {
      const kv = makeStore();
      let reads = 0;
      const spy = {
        get value() {
          reads += 1;
          return reads;
        },
      };

      // A NUL key is rejected — one of the few keys that still is — and the
      // rejection happens before the value is touched.
      await expect(kv.set('bad\u0000key', spy)).rejects.toThrow(/NUL/);
      expect(reads).toBe(0);
    });

    // Scopes arrive as ordinary values (the zustand adapter passes one through
    // verbatim), so a typo is a runtime possibility the type cannot prevent.
    // Every backend must fail closed on one, and identically: a backend that
    // guessed would either strand data in an invisible namespace or — worse for
    // a server-backed one — send a value the caller believed was device-local.
    test('an unknown scope fails closed rather than being guessed', async () => {
      const kv = makeStore();
      const unknownScope = 'Device' as KVScope;

      await expect(kv.set('k', 'v', unknownScope)).rejects.toThrow(/unknown KV scope/);
      await expect(kv.get('k', unknownScope)).rejects.toThrow(/unknown KV scope/);
      await expect(kv.remove('k', unknownScope)).rejects.toThrow(/unknown KV scope/);
      await expect(kv.keys('', unknownScope)).rejects.toThrow(/unknown KV scope/);
    });

    // The prefix is a literal, byte-for-byte comparison. Spelled out as a case
    // because the obvious SQL translation is `LIKE prefix || '%'`, where `%` and
    // `_` in a caller-supplied prefix silently become wildcards and the listing
    // starts returning keys it was never asked for.
    test('keys() treats the prefix literally, not as a pattern', async () => {
      const kv = makeStore();
      await kv.set('50%-done', 1);
      await kv.set('50x-done', 2);
      await kv.set('a_b', 3);
      await kv.set('axb', 4);

      expect(await kv.keys('50%')).toEqual(['50%-done']);
      expect(await kv.keys('a_')).toEqual(['a_b']);
    });

    // A key is opaque. Callers compose keys from unconstrained DSL identifiers —
    // a stageId may be `stage/one` — so a key containing `/`, `\\`, `:`, or `%`
    // must round-trip, not be rejected. Traversal is defended by encoding on the
    // wire (a `/` becomes one path segment) and by the server storing the key as
    // an opaque value, never a path — never by turning away a legitimate key.
    test.each([
      ['a separator', 'editor-current-scene:stage/one'],
      ['a backslash', 'document-migration:stage\\one'],
      ['a traversal shape, harmless as opaque data', 'a/../../b'],
      ['a percent sign', 'k%2Fnot-decoded'],
      ['a colon and spaces', 'ns: a b '],
    ])('round-trips a key with %s', async (_name, key) => {
      const kv = makeStore();
      await kv.set(key, { ok: true });
      expect(await kv.get(key)).toEqual({ ok: true });
      expect(await kv.keys()).toContain(key);
      await kv.remove(key);
      expect(await kv.get(key)).toBeNull();
    });

    // The few rules that remain are the ones encoding cannot cover and the
    // transport cannot carry — none of which a caller composing `prefix + id`
    // can produce. Enforced by every backend so a key that round-trips in the
    // browser round-trips over HTTP too, before either stores anything.
    test.each([
      ['an empty key', '', /must not be empty/],
      ['the dot segment "."', '.', /URL path segment/],
      ['the dot segment ".."', '..', /URL path segment/],
      ['a key containing NUL', 'bad\u0000key', /NUL/],
      ['a key containing an unpaired surrogate', '\uD800', /surrogate/],
      ['an over-long key', 'k'.repeat(513), /exceeds 512 UTF-8 bytes/],
      // Bounded in bytes, not characters: 256 three-byte characters is 768.
      ['an over-long multi-byte key', '\u20AC'.repeat(256), /exceeds 512 UTF-8 bytes/],
    ])('refuses %s', async (_name, key, message) => {
      const kv = makeStore();

      await expect(kv.set(key, 'v')).rejects.toThrow(message);
      await expect(kv.get(key)).rejects.toThrow(message);
      await expect(kv.remove(key)).rejects.toThrow(message);
      expect(await kv.keys()).not.toContain(key);
    });

    test('refuses a prefix only for what the transport cannot carry', async () => {
      const kv = makeStore();
      // A separator in a prefix is fine — it is opaque, like a key.
      await kv.set('editor-current-scene:stage/one', 1);
      expect(await kv.keys('editor-current-scene:stage/')).toEqual([
        'editor-current-scene:stage/one',
      ]);
      // But a lone surrogate still cannot be carried.
      await expect(kv.keys('\uD800')).rejects.toThrow(/surrogate/);
      // The empty prefix is what "list everything" means, so it stays legal.
      await expect(kv.keys('')).resolves.toEqual(['editor-current-scene:stage/one']);
    });

    // A prefix is not a path segment, so the dot-segment rule that governs keys
    // does not reach it: `.` is the legitimate prefix of a `.hidden`-style key.
    // Backends must agree, or a listing that works in the browser returns 400
    // against a server.
    test('keys() accepts a dot prefix, which is not a dot segment', async () => {
      const kv = makeStore();
      await kv.set('.hidden', 1);
      await kv.set('..parent', 2);
      await kv.set('visible', 3);

      expect([...(await kv.keys('.'))].sort()).toEqual(['..parent', '.hidden']);
      expect(await kv.keys('..')).toEqual(['..parent']);
    });

    test('keys() does not repeat a key', async () => {
      const kv = makeStore();
      await kv.set('one', 1);
      await kv.set('one', 2);
      await kv.set('two', 3);

      const keys = await kv.keys();
      expect([...new Set(keys)]).toHaveLength(keys.length);
      expect([...keys].sort()).toEqual(['one', 'two']);
    });
  });
}
