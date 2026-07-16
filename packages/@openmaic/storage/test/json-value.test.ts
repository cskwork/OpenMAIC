import { describe, expect, test } from 'vitest';
import { assertJsonValue } from '../src/runtime/json-value.js';

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
