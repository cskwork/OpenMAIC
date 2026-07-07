import { describe, expect, test } from 'vitest';
import {
  estimateSpeechDurationMs,
  EFFECT_AUTO_CLEAR_MS,
  DISCUSSION_TRIGGER_DELAY_MS,
  MAX_VIDEO_WAIT_MS,
  WB_OPEN_MS,
  WB_DRAW_MS,
  WB_EDIT_MS,
  WB_DELETE_MS,
  WB_CLOSE_MS,
  WIDGET_MS,
  wbDrawCodeMs,
  wbClearMs,
} from '@openmaic/choreography';

describe('timing constants (verbatim from the app engines)', () => {
  test('pin the effect / scene timing values', () => {
    expect(EFFECT_AUTO_CLEAR_MS).toBe(5000);
    expect(DISCUSSION_TRIGGER_DELAY_MS).toBe(3000);
    expect(MAX_VIDEO_WAIT_MS).toBe(5 * 60 * 1000);
  });

  test('pin the whiteboard / widget action durations', () => {
    expect(WB_OPEN_MS).toBe(2000);
    expect(WB_DRAW_MS).toBe(800);
    expect(WB_EDIT_MS).toBe(600);
    expect(WB_DELETE_MS).toBe(300);
    expect(WB_CLOSE_MS).toBe(700);
    expect(WIDGET_MS).toBe(300);
  });
});

describe('wbDrawCodeMs — base 800 + 50/line, capped 3000', () => {
  test('base with no/one line', () => {
    expect(wbDrawCodeMs(0)).toBe(800);
    expect(wbDrawCodeMs(1)).toBe(850);
  });
  test('scales per line', () => {
    expect(wbDrawCodeMs(10)).toBe(1300);
  });
  test('caps at 3000', () => {
    expect(wbDrawCodeMs(44)).toBe(3000); // 800 + 44*50 = 3000 exactly
    expect(wbDrawCodeMs(100)).toBe(3000);
  });
});

describe('wbClearMs — base 380 + 55/element, capped 1400', () => {
  test('base with no elements', () => {
    expect(wbClearMs(0)).toBe(380);
  });
  test('scales per element', () => {
    expect(wbClearMs(4)).toBe(600);
  });
  test('caps at 1400', () => {
    expect(wbClearMs(19)).toBe(1400); // 380 + 19*55 = 1425 → capped
    expect(wbClearMs(200)).toBe(1400);
  });
});

describe('estimateSpeechDurationMs — no-audio narration estimate', () => {
  test('empty text floors at 2000ms', () => {
    expect(estimateSpeechDurationMs('')).toBe(2000);
  });

  test('non-CJK uses 240ms/word above the floor', () => {
    // 10 words * 240 = 2400 (above the 2000 floor)
    const text = 'one two three four five six seven eight nine ten';
    expect(estimateSpeechDurationMs(text)).toBe(2400);
  });

  test('non-CJK short text floors at 2000ms', () => {
    // 3 words * 240 = 720 → floored to 2000
    expect(estimateSpeechDurationMs('a b c')).toBe(2000);
  });

  test('non-CJK collapses whitespace when counting words', () => {
    // Leading/trailing/multiple spaces must not inflate the word count.
    const a = estimateSpeechDurationMs('  one   two  three  ');
    const b = estimateSpeechDurationMs('one two three');
    expect(a).toBe(b);
  });

  test('CJK uses 150ms/char above the floor', () => {
    // 20 CJK chars * 150 = 3000 (all chars are CJK → ratio 1 > 0.3)
    const text = '一二三四五六七八九十一二三四五六七八九十';
    expect(text.length).toBe(20);
    expect(estimateSpeechDurationMs(text)).toBe(3000);
  });

  test('the 0.3 CJK ratio threshold selects the CJK branch', () => {
    // 40 chars, 16 CJK → ratio 0.4 > 0.3 → CJK branch → 40 * 150 = 6000.
    const cjk = '一二三四五六七八九十一二三四五六';
    const latin = 'abcdefghijklmnopqrstuvwx'; // 24 chars
    const text = cjk + latin;
    expect(text.length).toBe(40);
    expect(estimateSpeechDurationMs(text)).toBe(text.length * 150);
  });

  test('below the 0.3 ratio uses the word branch', () => {
    // Mostly Latin with a few CJK chars → ratio ≤ 0.3 → word branch.
    const text = 'hello world this is a test 一 二'; // 8 "words", 2 CJK of ~30 chars
    const words = text.split(/\s+/).filter(Boolean).length;
    expect(estimateSpeechDurationMs(text)).toBe(Math.max(2000, words * 240));
  });

  test('divides by playback speed', () => {
    const text = 'one two three four five six seven eight nine ten'; // 2400ms @ 1x
    expect(estimateSpeechDurationMs(text, { speed: 2 })).toBe(1200);
    expect(estimateSpeechDurationMs(text, { speed: 0.5 })).toBe(4800);
  });

  test('speed applies after the floor', () => {
    // Floored to 2000, then /2 = 1000.
    expect(estimateSpeechDurationMs('a b c', { speed: 2 })).toBe(1000);
  });
});
