import { describe, expect, test } from 'vitest';
import { runInNewContext } from 'node:vm';
import { assertJsonValue, isLosslessJsonString } from '../src/runtime/json-value.js';

describe('assertJsonValue string guards', () => {
  test('rejects an object key containing NUL', () => {
    expect(() => assertJsonValue({ ['key\u0000suffix']: true }, 'value')).toThrow(
      /object key.*NUL code point/i,
    );
  });

  test('rejects a string value containing an unpaired UTF-16 surrogate', () => {
    expect(() => assertJsonValue({ value: '\uD800' }, 'value')).toThrow(
      /unpaired UTF-16 surrogate/i,
    );
  });

  test('rejects a string key containing an unpaired UTF-16 surrogate', () => {
    expect(() => assertJsonValue({ ['key\uD800']: true }, 'value')).toThrow(
      /object key.*unpaired UTF-16 surrogate/i,
    );
  });

  test('accepts a valid UTF-16 surrogate pair', () => {
    expect(() => assertJsonValue({ value: '𐀀' }, 'value')).not.toThrow();
  });
});

describe('assertJsonValue structural guards', () => {
  test('rejects an enumerable accessor own property', () => {
    const value = Object.defineProperty({}, 'dynamic', {
      enumerable: true,
      get: () => 'value',
    });

    expect(() => assertJsonValue(value, 'value')).toThrow(/accessor property/i);
  });

  test('rejects an Array subclass instance', () => {
    class JsonLookingArray extends Array<number> {}

    expect(() => assertJsonValue(new JsonLookingArray(1, 2), 'value')).toThrow(
      /array with a non-Array prototype/i,
    );
  });

  test('rejects a sparse array even when its prototype provides the missing index', () => {
    const sparse = new Array<string>(1);
    let thrown: unknown;
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      value: 'inherited',
      writable: true,
    });
    try {
      assertJsonValue(sparse, 'value');
    } catch (error) {
      thrown = error;
    } finally {
      delete Array.prototype[0];
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/sparse array hole/i);
  });
});

describe('cross-realm and shared-predicate behavior', () => {
  test('accepts plain arrays and objects created in another realm', () => {
    const foreign = runInNewContext('[1, { nested: true }]') as unknown;
    expect(() => assertJsonValue(foreign, 'payload')).not.toThrow();
  });

  test('rejects an Array subclass created in another realm', () => {
    const foreign = runInNewContext('new (class Sub extends Array {})()') as unknown;
    expect(() => assertJsonValue(foreign, 'payload')).toThrow(/non-Array prototype/);
  });

  test('isLosslessJsonString mirrors the string gate', () => {
    expect(isLosslessJsonString('plain text')).toBe(true);
    expect(isLosslessJsonString('a\u0000b')).toBe(false);
    expect(isLosslessJsonString('\uD800')).toBe(false);
  });
});
