import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
// JS codegen helper — no .d.ts; vitest/esbuild resolves it at runtime.
// @ts-expect-error untyped .mjs helper
import { generateSchema } from '../scripts/gen-schema.mjs';

function validator(root: 'Stage' | 'SerializedScene' | 'Action') {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(generateSchema(root));
}

describe('generated JSON Schema — Stage', () => {
  const v = validator('Stage');
  it('accepts a well-formed stage', () => {
    expect(v({ id: 's', name: 'n', createdAt: 1, updatedAt: 2 })).toBe(true);
  });
  it('rejects a stage missing required fields', () => {
    expect(v({ id: 's' })).toBe(false);
  });
});

describe('generated JSON Schema — Action', () => {
  const v = validator('Action');
  it('accepts a spotlight action', () => {
    expect(v({ id: 'a', type: 'spotlight', elementId: 'e' })).toBe(true);
  });
  it('rejects an action missing its required discriminated fields', () => {
    expect(v({ id: 'a', type: 'spotlight' /* missing elementId */ })).toBe(false);
  });
});

describe('generated JSON Schema — SerializedScene', () => {
  const v = validator('SerializedScene');
  it('rejects a scene missing required fields', () => {
    expect(v({ id: 'sc' })).toBe(false);
  });
});
