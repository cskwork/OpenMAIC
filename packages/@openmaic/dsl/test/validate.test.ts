import { describe, it, expect } from 'vitest';
import { validateStage, validateScene, validateAction, type ValidationResult } from '@openmaic/dsl';

function errors(r: ValidationResult): string[] {
  return r.valid ? [] : r.errors.map((e) => e.path);
}

describe('validateStage', () => {
  it('accepts a well-formed stage', () => {
    expect(validateStage({ id: 's', name: 'n', createdAt: 1, updatedAt: 2 })).toEqual({
      valid: true,
    });
  });
  it('collects every missing required field', () => {
    const r = validateStage({ id: 's' });
    expect(r.valid).toBe(false);
    expect(errors(r)).toEqual(expect.arrayContaining(['/name', '/createdAt', '/updatedAt']));
  });
  it('rejects non-objects', () => {
    expect(validateStage(null).valid).toBe(false);
    expect(validateStage('x').valid).toBe(false);
  });
});

describe('validateScene', () => {
  const ok = {
    id: 'sc1',
    stageId: 'st1',
    type: 'slide',
    title: 'Intro',
    order: 0,
    content: { type: 'slide', canvas: { id: 'c' } },
  };
  it('accepts a well-formed slide scene', () => {
    expect(validateScene(ok)).toEqual({ valid: true });
  });
  it('flags an unknown content type', () => {
    const r = validateScene({ ...ok, content: { type: 'bogus' } });
    expect(errors(r)).toContain('/content/type');
  });
  it('flags a quiz scene missing its questions array', () => {
    const r = validateScene({ ...ok, type: 'quiz', content: { type: 'quiz' } });
    expect(errors(r)).toContain('/content/questions');
  });
  it('flags a scene whose content.type disagrees with its type', () => {
    const r = validateScene({ ...ok, type: 'slide', content: { type: 'quiz', questions: [] } });
    expect(r.valid).toBe(false);
    expect(errors(r)).toContain('/content/type');
  });
  it('validates nested actions and points at the bad one', () => {
    const r = validateScene({
      ...ok,
      actions: [
        { id: 'a', type: 'speech' },
        { id: 'b', type: 'nope' },
      ],
    });
    expect(errors(r)).toContain('/actions/1/type');
  });
});

describe('validateAction', () => {
  it('accepts a known action type', () => {
    expect(validateAction({ id: 'a', type: 'spotlight' })).toEqual({ valid: true });
  });
  it('rejects an unknown action type', () => {
    const r = validateAction({ id: 'a', type: 'frobnicate' });
    expect(errors(r)).toContain('/type');
  });
  it('requires a string id', () => {
    const r = validateAction({ type: 'laser' });
    expect(errors(r)).toContain('/id');
  });
});
