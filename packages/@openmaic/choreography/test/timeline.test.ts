import { describe, expect, test } from 'vitest';
import {
  resolveActionTimeline,
  estimateSpeechDurationMs,
  EFFECT_AUTO_CLEAR_MS,
  DISCUSSION_TRIGGER_DELAY_MS,
  WB_OPEN_MS,
  WB_DRAW_MS,
} from '@openmaic/choreography';
import type { Action, Scene } from '@openmaic/dsl';

const sc = (id: string, actions: Action[]): Scene =>
  ({
    id,
    stageId: 's',
    type: 'slide',
    title: id,
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  }) as unknown as Scene;

const speech = (id: string, text: string): Action => ({ id, type: 'speech', text }) as Action;
const spotlight = (id: string): Action => ({ id, type: 'spotlight', elementId: 'e' }) as Action;
const laser = (id: string): Action => ({ id, type: 'laser', elementId: 'e' }) as Action;
const wbOpen = (id: string): Action => ({ id, type: 'wb_open' }) as Action;
const wbText = (id: string): Action =>
  ({ id, type: 'wb_draw_text', content: 'c', x: 0, y: 0 }) as Action;

describe('resolveActionTimeline — index → time expansion', () => {
  test('blocking speech advances the cursor by its estimated duration', () => {
    const scenes = [sc('S0', [speech('a0', 'one two three four five six seven eight nine ten')])];
    const [seg] = resolveActionTimeline(scenes);
    const expected = estimateSpeechDurationMs('one two three four five six seven eight nine ten');
    expect(seg).toMatchObject({
      sceneId: 'S0',
      sceneIndex: 0,
      actionIndex: 0,
      startMs: 0,
      durationMs: expected,
      advancesCursorMs: expected,
      blocking: true,
    });
  });

  test('speech uses the audio-duration resolver when it returns a value', () => {
    const scenes = [sc('S0', [speech('a0', 'whatever')])];
    const segs = resolveActionTimeline(scenes, { getAudioDurationMs: () => 4321 });
    expect(segs[0]).toMatchObject({ durationMs: 4321, advancesCursorMs: 4321 });
  });

  test('speech falls back to the estimate when the resolver returns null', () => {
    const scenes = [sc('S0', [speech('a0', 'a b c')])];
    const segs = resolveActionTimeline(scenes, { getAudioDurationMs: () => null });
    expect(segs[0].durationMs).toBe(estimateSpeechDurationMs('a b c'));
  });

  test('playback speed flows into the speech estimate', () => {
    const text = 'one two three four five six seven eight nine ten';
    const scenes = [sc('S0', [speech('a0', text)])];
    const segs = resolveActionTimeline(scenes, { playbackSpeed: 2 });
    expect(segs[0].durationMs).toBe(estimateSpeechDurationMs(text, { speed: 2 }));
  });

  test('fire-and-forget effects do NOT advance the cursor (visual duration only)', () => {
    const scenes = [sc('S0', [spotlight('a0'), laser('a1'), speech('a2', 'hi there friend')])];
    const [sp, la, sp2] = resolveActionTimeline(scenes);
    // spotlight: visual EFFECT_AUTO_CLEAR_MS, but cursor does not advance
    expect(sp).toMatchObject({
      startMs: 0,
      durationMs: EFFECT_AUTO_CLEAR_MS,
      advancesCursorMs: 0,
      blocking: false,
    });
    // laser: same, and it starts at 0 too since the spotlight didn't advance the clock
    expect(la).toMatchObject({
      startMs: 0,
      durationMs: EFFECT_AUTO_CLEAR_MS,
      advancesCursorMs: 0,
      blocking: false,
    });
    // the following speech also starts at 0 (nothing before it advanced the cursor)
    expect(sp2.startMs).toBe(0);
    expect(sp2.blocking).toBe(true);
  });

  test('startMs accumulates across blocking actions and scenes', () => {
    const scenes = [sc('S0', [wbOpen('a0'), wbText('a1')]), sc('S1', [wbText('b0')])];
    const segs = resolveActionTimeline(scenes);
    expect(segs.map((s) => s.startMs)).toEqual([0, WB_OPEN_MS, WB_OPEN_MS + WB_DRAW_MS]);
    expect(segs.map((s) => s.durationMs)).toEqual([WB_OPEN_MS, WB_DRAW_MS, WB_DRAW_MS]);
  });

  test('an empty scene yields one dwell beat (empty-text speech = 2000ms floor)', () => {
    const scenes = [sc('S0', [])];
    const segs = resolveActionTimeline(scenes);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      sceneId: 'S0',
      startMs: 0,
      durationMs: 2000,
      advancesCursorMs: 2000,
      blocking: true,
    });
    expect(segs[0].action).toMatchObject({ type: 'speech', text: '' });
  });

  test('a mid-list empty scene still dwells and shifts later scenes', () => {
    const scenes = [
      sc('S0', [speech('a0', 'a b c')]),
      sc('S1', []),
      sc('S2', [speech('c0', 'x y z')]),
    ];
    const segs = resolveActionTimeline(scenes);
    const d = estimateSpeechDurationMs('a b c'); // = 2000
    expect(segs.map((s) => s.sceneId)).toEqual(['S0', 'S1', 'S2']);
    expect(segs.map((s) => s.startMs)).toEqual([0, d, d + 2000]);
  });

  test('discussion contributes a deterministic trigger-delay dwell', () => {
    const scenes = [sc('S0', [{ id: 'd0', type: 'discussion', topic: 't' } as Action])];
    const [seg] = resolveActionTimeline(scenes);
    expect(seg).toMatchObject({
      durationMs: DISCUSSION_TRIGGER_DELAY_MS,
      advancesCursorMs: DISCUSSION_TRIGGER_DELAY_MS,
      blocking: true,
    });
  });

  test('play_video uses the video-duration resolver, capped, and defaults to 0', () => {
    const scenes = [sc('S0', [{ id: 'v0', type: 'play_video', elementId: 'e' } as Action])];
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(0);
    expect(resolveActionTimeline(scenes, { getVideoDurationMs: () => 12_000 })[0].durationMs).toBe(
      12_000,
    );
    expect(
      resolveActionTimeline(scenes, { getVideoDurationMs: () => 10 * 60 * 1000 })[0].durationMs,
    ).toBe(5 * 60 * 1000); // capped at MAX_VIDEO_WAIT_MS
  });

  test('wb_draw_code duration scales with line count', () => {
    const code = 'l1\nl2\nl3\nl4\nl5'; // 5 lines
    const scenes = [
      sc('S0', [{ id: 'c0', type: 'wb_draw_code', language: 'ts', code, x: 0, y: 0 } as Action]),
    ];
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(800 + 5 * 50);
  });

  test('wb_clear duration scales with the injected element count', () => {
    const scenes = [sc('S0', [{ id: 'cl', type: 'wb_clear' } as Action])];
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(380); // default 0 elements
    expect(resolveActionTimeline(scenes, { getClearElementCount: () => 4 })[0].durationMs).toBe(
      380 + 4 * 55,
    );
  });

  test('empty scene list yields an empty timeline', () => {
    expect(resolveActionTimeline([])).toEqual([]);
  });
});
