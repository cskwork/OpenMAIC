import { describe, it, expect } from 'vitest';
import {
  buildVoiceDesignPrompt,
  normalizeVoiceDesign,
  normalizeRefText,
  getDeterministicVoiceId,
} from '@/lib/audio/voice-design';

const design =
  'a middle-aged male teacher with a warm low-pitched resonant voice, speaking in a calm measured encouraging way';

describe('buildVoiceDesignPrompt', () => {
  it('passes a clean description through', () => {
    expect(buildVoiceDesignPrompt(design)).toBe(design);
  });
  it('collapses whitespace and control chars', () => {
    expect(buildVoiceDesignPrompt('  male  teacher \n slow ')).toBe('male teacher slow');
  });
  it('strips parentheses so they cannot break the (prompt)text delimiter', () => {
    expect(buildVoiceDesignPrompt('male teacher (deep), 英文（带口音）, calm')).toBe(
      'male teacher deep , 英文 带口音 , calm',
    );
  });
  it('caps overly long descriptions', () => {
    expect(buildVoiceDesignPrompt('a'.repeat(500)).length).toBe(200);
  });
});

describe('normalizeVoiceDesign', () => {
  it('returns trimmed free text', () => {
    expect(normalizeVoiceDesign(`  ${design} `)).toBe(design);
  });
  it('returns undefined for empty/non-string values', () => {
    expect(normalizeVoiceDesign('')).toBeUndefined();
    expect(normalizeVoiceDesign('   ')).toBeUndefined();
    expect(normalizeVoiceDesign({})).toBeUndefined();
    expect(normalizeVoiceDesign(null)).toBeUndefined();
    expect(normalizeVoiceDesign(42)).toBeUndefined();
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
    const desc = await getDeterministicVoiceId(`${design}, slightly husky`, {
      providerId: 'voxcpm-tts',
      model: 'm',
    });
    const model = await getDeterministicVoiceId(design, { providerId: 'voxcpm-tts', model: 'm2' });
    const prov = await getDeterministicVoiceId(design, {
      providerId: 'elevenlabs-tts',
      model: 'm',
    });
    expect(desc).not.toBe(base);
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
  it('keeps the id stable when refText is absent', async () => {
    const opts = { providerId: 'voxcpm-tts', model: 'm' };
    const noRef = await getDeterministicVoiceId(design, opts);
    const explicitEmpty = await getDeterministicVoiceId(design, { ...opts, refText: undefined });
    expect(explicitEmpty).toBe(noRef);
  });
});

describe('normalizeRefText', () => {
  it('trims, collapses whitespace, and strips parentheses/control chars', () => {
    expect(
      normalizeRefText('  大家好，（笑）欢迎来到\n今天的  线性代数课程，我们马上开始。 '),
    ).toBe('大家好， 笑 欢迎来到 今天的 线性代数课程，我们马上开始。');
  });
  it('rejects non-strings and scripts too short to be a meaningful seed', () => {
    expect(normalizeRefText(undefined)).toBeUndefined();
    expect(normalizeRefText(42)).toBeUndefined();
    expect(normalizeRefText('你好，欢迎来上课。')).toBeUndefined();
  });
  it('caps overly long scripts', () => {
    const long = 'a'.repeat(500);
    expect(normalizeRefText(long)?.length).toBe(300);
  });
});
