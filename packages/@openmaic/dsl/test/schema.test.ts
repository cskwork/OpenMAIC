import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
// JS codegen helper — no .d.ts; vitest/esbuild resolves it at runtime.
// @ts-expect-error untyped .mjs helper
import { generateSchema } from '../scripts/gen-schema.mjs';

// Generate every root schema once (the generator parses the TS program a single
// time and is reused), then compile per case — no repeated heavy codegen.
const schemas = {
  Stage: generateSchema('Stage'),
  Action: generateSchema('Action'),
  SerializedScene: generateSchema('SerializedScene'),
} as const;

function validator(root: keyof typeof schemas) {
  return new Ajv({ allErrors: true, strict: false }).compile(schemas[root]);
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
