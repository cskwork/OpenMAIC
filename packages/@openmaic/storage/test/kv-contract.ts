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
