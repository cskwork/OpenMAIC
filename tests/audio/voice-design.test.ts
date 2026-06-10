import { describe, it, expect } from 'vitest';
import {
  buildVoiceDesignPrompt,
  normalizeVoiceDesign,
  normalizeRefText,
  getDeterministicVoiceId,
  type VoiceDesign,
} from '@/lib/audio/voice-design';

const design: VoiceDesign = {
  identity: 'middle-aged male teacher',
  texture: 'warm low-pitched resonant',
  delivery: 'calm measured encouraging',
};

describe('buildVoiceDesignPrompt', () => {
  it('composes the three layers into one comma-joined prompt', () => {
    expect(buildVoiceDesignPrompt(design)).toBe(
      'middle-aged male teacher, warm low-pitched resonant, calm measured encouraging',
    );
  });
  it('drops blank layers and collapses whitespace', () => {
    expect(
      buildVoiceDesignPrompt({ identity: '  male  teacher ', texture: '', delivery: 'slow' }),
    ).toBe('male teacher, slow');
  });
  it('strips parentheses so they cannot break the (prompt)text delimiter', () => {
    expect(
      buildVoiceDesignPrompt({
        identity: 'male teacher (deep)',
        texture: '英文（带口音）',
        delivery: 'calm',
      }),
    ).toBe('male teacher deep, 英文 带口音, calm');
  });
});

describe('normalizeVoiceDesign', () => {
  it('returns a clean design from a well-formed object', () => {
    expect(normalizeVoiceDesign({ identity: 'a', texture: 'b', delivery: 'c' })).toEqual({
      identity: 'a',
      texture: 'b',
      delivery: 'c',
    });
  });
  it('returns undefined when all layers are empty/missing', () => {
    expect(normalizeVoiceDesign({})).toBeUndefined();
    expect(normalizeVoiceDesign(null)).toBeUndefined();
    expect(normalizeVoiceDesign('nope')).toBeUndefined();
  });
  it('keeps a partial design (some layers present)', () => {
    expect(normalizeVoiceDesign({ identity: 'a' })).toEqual({
      identity: 'a',
      texture: '',
      delivery: '',
    });
  });
});

describe('getDeterministicVoiceId', () => {
  it('is stable for the same descriptor+provider+model, with the neutral prefix', async () => {
    const opts = { providerId: 'voxcpm-tts', model: 'VoxCPM2' };
    const a = await getDeterministicVoiceId(design, opts);
    const b = await getDeterministicVoiceId(design, opts);
    expect(a).toBe(b);
    expect(a).toMatch(/^auto-[0-9a-f]{16}$/);
  });
  it('changes when descriptor, model, or provider changes', async () => {
    const base = await getDeterministicVoiceId(design, { providerId: 'voxcpm-tts', model: 'm' });
    const tex = await getDeterministicVoiceId(
      { ...design, texture: 'bright' },
      { providerId: 'voxcpm-tts', model: 'm' },
    );
    const model = await getDeterministicVoiceId(design, { providerId: 'voxcpm-tts', model: 'm2' });
    const prov = await getDeterministicVoiceId(design, {
      providerId: 'elevenlabs-tts',
      model: 'm',
    });
    expect(tex).not.toBe(base);
    expect(model).not.toBe(base);
    expect(prov).not.toBe(base);
  });
  it('is independent of language (descriptor already encodes it)', async () => {
    // language is not a parameter of the id — same descriptor → same id regardless
    // of which TTS path (narration directive vs discussion locale) resolves it.
    const a = await getDeterministicVoiceId(design, { providerId: 'voxcpm-tts', model: 'm' });
    const b = await getDeterministicVoiceId(design, { providerId: 'voxcpm-tts', model: 'm' });
    expect(a).toBe(b);
  });
  it('changes when refText changes (different seed script = different clip)', async () => {
    const opts = { providerId: 'voxcpm-tts', model: 'm' };
    const base = await getDeterministicVoiceId(design, opts);
    const withRef = await getDeterministicVoiceId(design, {
      ...opts,
      refText: '大家好，欢迎来到今天的课程。',
    });
    const withOtherRef = await getDeterministicVoiceId(design, {
      ...opts,
      refText: '同学们好，我们开始上课吧。',
    });
    expect(withRef).not.toBe(base);
    expect(withOtherRef).not.toBe(withRef);
  });
  it('keeps the historical id when refText is absent (backwards compatible)', async () => {
    const opts = { providerId: 'voxcpm-tts', model: 'm' };
    const legacy = await getDeterministicVoiceId(design, opts);
    const explicitEmpty = await getDeterministicVoiceId(design, { ...opts, refText: undefined });
    expect(explicitEmpty).toBe(legacy);
  });
});

describe('normalizeRefText', () => {
  it('trims, collapses whitespace, and strips parentheses/control chars', () => {
    expect(normalizeRefText('  大家好，（笑）欢迎来到\n今天的  课程。 ')).toBe(
      '大家好， 笑 欢迎来到 今天的 课程。',
    );
  });
  it('rejects non-strings and scripts too short for a stable clip', () => {
    expect(normalizeRefText(undefined)).toBeUndefined();
    expect(normalizeRefText(42)).toBeUndefined();
    expect(normalizeRefText('你好。')).toBeUndefined();
  });
  it('caps overly long scripts', () => {
    const long = 'a'.repeat(500);
    expect(normalizeRefText(long)?.length).toBe(300);
  });
});
