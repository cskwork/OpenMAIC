import { describe, expect, test } from 'vitest';
import {
  insertAt,
  makeAction,
  move,
  removeAt,
  setAudioId,
  setAudioIdById,
  setElementId,
  setElementIdById,
  setSpeechText,
} from '@/components/edit/ActionsBar/actions-edit';
import type { Action } from '@/lib/types/action';

const A = (id: string, type = 'speech'): Action => ({ id, type } as unknown as Action);
const ids = (xs: Action[]) => xs.map((a) => a.id);

describe('makeAction', () => {
  test('speech carries empty text; element cues carry empty elementId', () => {
    expect(makeAction('speech', 's')).toEqual({ id: 's', type: 'speech', text: '' });
    expect(makeAction('spotlight', 'p')).toEqual({ id: 'p', type: 'spotlight', elementId: '' });
    expect(makeAction('laser', 'l')).toEqual({ id: 'l', type: 'laser', elementId: '' });
  });
});

describe('insertAt / removeAt', () => {
  const base = [A('a'), A('b'), A('c')];
  test('inserts at the slot and clamps out-of-range', () => {
    expect(ids(insertAt(base, 1, A('x')))).toEqual(['a', 'x', 'b', 'c']);
    expect(ids(insertAt(base, 99, A('x')))).toEqual(['a', 'b', 'c', 'x']);
    expect(ids(insertAt(base, -5, A('x')))).toEqual(['x', 'a', 'b', 'c']);
  });
  test('does not mutate the input', () => {
    insertAt(base, 1, A('x'));
    expect(ids(base)).toEqual(['a', 'b', 'c']);
  });
  test('removeAt drops the index; no-op when out of range', () => {
    expect(ids(removeAt(base, 1))).toEqual(['a', 'c']);
    expect(ids(removeAt(base, 9))).toEqual(['a', 'b', 'c']);
  });
});

describe('move', () => {
  const base = [A('a'), A('b'), A('c'), A('d')];
  test('moves forward (slot is an original-array gap)', () => {
    expect(ids(move(base, 0, 2))).toEqual(['b', 'a', 'c', 'd']);
    expect(ids(move(base, 0, 4))).toEqual(['b', 'c', 'd', 'a']);
  });
  test('moves backward', () => {
    expect(ids(move(base, 3, 1))).toEqual(['a', 'd', 'b', 'c']);
  });
  test('no-op when dropping into its own slot', () => {
    expect(ids(move(base, 1, 1))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(move(base, 1, 2))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('setSpeechText / setElementId', () => {
  test('setSpeechText only edits speech actions', () => {
    const xs = [A('a', 'speech'), A('b', 'spotlight')];
    expect((setSpeechText(xs, 0, 'hi')[0] as { text?: string }).text).toBe('hi');
    expect(setSpeechText(xs, 1, 'no')).toBe(xs); // unchanged reference (no-op)
  });
  test('setElementId only targets element-bound cues, not speech', () => {
    const xs = [A('a', 'spotlight'), A('b', 'speech')];
    expect((setElementId(xs, 0, 'el_1')[0] as { elementId?: string }).elementId).toBe('el_1');
    expect(setElementId(xs, 1, 'el_x')).toBe(xs); // no-op: speech is not element-bound
  });
  test('setElementIdById / setAudioIdById target by id (index-stale-safe)', () => {
    const xs = [A('a', 'spotlight'), A('b', 'speech')];
    expect((setElementIdById(xs, 'a', 'el_1')[0] as { elementId?: string }).elementId).toBe('el_1');
    expect(setElementIdById(xs, 'missing', 'x')).toBe(xs);
    expect((setAudioIdById(xs, 'b', 'tts_b')[1] as { audioId?: string }).audioId).toBe('tts_b');
    expect(setAudioIdById(xs, 'a', 'tts_a')).toBe(xs); // 'a' is not speech → no-op
  });
  test('setAudioId only stamps speech actions', () => {
    const xs = [A('a', 'speech'), A('b', 'spotlight')];
    expect((setAudioId(xs, 0, 'tts_a')[0] as { audioId?: string }).audioId).toBe('tts_a');
    expect(setAudioId(xs, 1, 'tts_b')).toBe(xs); // no-op for non-speech
  });
});
