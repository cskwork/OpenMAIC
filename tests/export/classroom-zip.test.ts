import { describe, test, expect } from 'vitest';
import {
  buildIdMap,
  rewriteAudioRefsToIds,
} from '@/lib/export/classroom-zip-utils';

describe('buildIdMap', () => {
  test('generates unique new IDs for each old key', () => {
    const oldKeys = ['audio/abc.mp3', 'audio/def.mp3', 'media/img1.png'];
    const map = buildIdMap(oldKeys);
    expect(Object.keys(map)).toHaveLength(3);
    for (const val of Object.values(map)) {
      expect(val).toBeTruthy();
      expect(typeof val).toBe('string');
    }
    const values = Object.values(map);
    expect(new Set(values).size).toBe(values.length);
  });

  test('returns empty map for empty input', () => {
    expect(buildIdMap([])).toEqual({});
  });
});

describe('rewriteAudioRefsToIds', () => {
  test('replaces audioRef with new audioId in speech actions', () => {
    const actions = [
      { type: 'speech' as const, text: 'Hello', audioRef: 'audio/abc.mp3' },
      { type: 'spotlight' as const, elementId: 'el1' },
    ];
    const audioRefMap = { 'audio/abc.mp3': 'new-audio-id-1' };
    const result = rewriteAudioRefsToIds(actions, audioRefMap);
    expect(result[0]).toEqual({
      type: 'speech',
      text: 'Hello',
      audioId: 'new-audio-id-1',
    });
    expect(result[1]).toEqual({ type: 'spotlight', elementId: 'el1' });
  });

  test('skips speech actions without audioRef', () => {
    const actions = [
      { type: 'speech' as const, text: 'Hello', audioUrl: 'https://example.com/a.mp3' },
    ];
    const result = rewriteAudioRefsToIds(actions, {});
    expect(result[0]).toEqual({
      type: 'speech',
      text: 'Hello',
      audioUrl: 'https://example.com/a.mp3',
    });
  });
});
