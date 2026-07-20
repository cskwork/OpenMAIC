import { describe, expect, it } from 'vitest';
import { splitCue, splitCues, splitCueText, textUnits } from '@/lib/video-export';
import type { SubtitleCue } from '@/lib/video-export';

/**
 * Cue splitting is the fix for burned-in subtitles that covered the slide: a
 * whole-paragraph cue is split into short line-sized cues whose spans tile the
 * parent's time window (by character weight), so both the burned-in overlay and
 * the sidecar SRT/VTT read line-by-line and stay in sync with the narration.
 */

const cue = (over: Partial<SubtitleCue> = {}): SubtitleCue => ({
  index: 0,
  sceneId: 's1',
  actionId: 'a1',
  startMs: 0,
  endMs: 10_000,
  text: '',
  ...over,
});

describe('splitCueText', () => {
  it('returns nothing for empty / whitespace text', () => {
    expect(splitCueText('')).toEqual([]);
    expect(splitCueText('   \n ')).toEqual([]);
  });

  it('keeps a short single sentence as one piece', () => {
    expect(splitCueText('这是一句短旁白。')).toEqual(['这是一句短旁白。']);
  });

  it('splits on sentence-ending punctuation when over budget', () => {
    // Two full-width sentences, each ~20 units → together over the 40 budget.
    const text = '第一句话讲的是概念的基本定义和背景。第二句话进一步展开它的应用场景和例子。';
    const pieces = splitCueText(text);
    expect(pieces.length).toBeGreaterThan(1);
    // Every piece is within the readability budget.
    for (const p of pieces) expect(textUnits(p)).toBeLessThanOrEqual(40);
  });

  it('hard-wraps a long run with no punctuation', () => {
    const text = '啊'.repeat(120); // 120 wide units, no punctuation
    const pieces = splitCueText(text);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) expect(textUnits(p)).toBeLessThanOrEqual(40);
  });

  it('weights Latin characters at half a CJK cell', () => {
    expect(textUnits('中文')).toBe(2);
    expect(textUnits('abcd')).toBe(2);
  });
});

describe('splitCue — time distribution', () => {
  it('leaves an already-short cue unchanged (text trimmed)', () => {
    const out = splitCue(cue({ text: '  短句。 ', startMs: 1000, endMs: 4000 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startMs: 1000, endMs: 4000, text: '短句。' });
  });

  it('tiles the parent window with no gaps or overlaps', () => {
    const text = '第一句话讲的是概念的基本定义和背景。第二句话进一步展开它的应用场景和例子。';
    const out = splitCue(cue({ startMs: 2000, endMs: 12_000, text }));
    expect(out.length).toBeGreaterThan(1);
    // Contiguous: each cue starts exactly where the previous ended.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startMs).toBe(out[i - 1].endMs);
    }
    // Spans the whole parent window.
    expect(out[0].startMs).toBe(2000);
    expect(out[out.length - 1].endMs).toBe(12_000);
  });

  it('allocates more time to the heavier (longer) piece', () => {
    // Two separate sentences of clearly different length (both > flash floor),
    // in a window large enough that neither is merged.
    const text = '这是一段非常详细的说明包含很多内容和细节需要较长的时间才能朗读完毕。这是较短第二句。';
    const out = splitCue(cue({ startMs: 0, endMs: 12_000, text }));
    expect(out.length).toBeGreaterThanOrEqual(2);
    const first = out[0].endMs - out[0].startMs;
    const last = out[out.length - 1].endMs - out[out.length - 1].startMs;
    expect(first).toBeGreaterThan(last);
  });

  it('preserves sceneId / actionId on every piece', () => {
    const text = '第一句话讲的是概念的基本定义和背景。第二句话进一步展开它的应用场景和例子。';
    const out = splitCue(cue({ sceneId: 'sceneX', actionId: 'actX', text }));
    for (const c of out) {
      expect(c.sceneId).toBe('sceneX');
      expect(c.actionId).toBe('actX');
    }
  });

  it('merges a sub-1.2s sliver into a neighbour (no flashing)', () => {
    // Two sentences but a tiny window → the shorter piece would be < MIN_CUE_MS.
    const text = '第一句话讲的是概念的基本定义和背景更详细的内容。好。';
    const out = splitCue(cue({ startMs: 0, endMs: 2000, text }));
    for (const c of out) {
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(1200);
    }
    expect(out[out.length - 1].endMs).toBe(2000);
  });

  it('returns the original (trimmed) cue when the window is non-positive', () => {
    const out = splitCue(cue({ startMs: 5000, endMs: 5000, text: 'a。b。c。' }));
    expect(out).toHaveLength(1);
    expect(out[0].startMs).toBe(5000);
    expect(out[0].endMs).toBe(5000);
  });
});

describe('splitCues — track renumbering', () => {
  it('flattens and renumbers index 0..n over the split track', () => {
    const cues = [
      cue({
        index: 0,
        startMs: 0,
        endMs: 9000,
        text: '第一句话讲的是概念的基本定义和背景说明。第二句话进一步展开它的应用场景和例子。',
      }),
      cue({ index: 1, startMs: 9000, endMs: 12_000, text: '短句。' }),
    ];
    const out = splitCues(cues);
    expect(out.length).toBeGreaterThan(cues.length);
    out.forEach((c, i) => expect(c.index).toBe(i));
    // Global timeline stays contiguous across the original cue boundary.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startMs).toBeGreaterThanOrEqual(out[i - 1].startMs);
    }
  });
});
