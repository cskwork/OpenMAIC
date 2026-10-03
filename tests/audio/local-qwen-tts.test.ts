import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { generateTTS } from '@/lib/audio/tts-providers';
import { getProviderPreset } from '@/lib/config/provider-presets';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

describe('Local Qwen3-TTS', () => {
  it('offers the single real local voice to settings and course-generation prompts', () => {
    const provider = TTS_PROVIDERS['local-qwen-tts'];
    expect(provider.voices.map((voice) => voice.id)).toEqual(['announcer-female-calm-ko']);
    expect(DEFAULT_TTS_VOICES['local-qwen-tts']).toBe(provider.voices[0].id);
    expect(getProviderPreset('local-qwen-tts')?.capabilities.tts?.registryId).toBe(
      'local-qwen-tts',
    );
  });

  it('uses local transport, the Qwen model and the actual voice, with playable audio', async () => {
    const bytes = Uint8Array.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
      headers: { get: () => 'audio/mpeg' },
    });
    const result = await generateTTS(
      {
        providerId: 'local-qwen-tts',
        voice: DEFAULT_TTS_VOICES['local-qwen-tts'],
        apiKey: 'local-test-token',
        managed: true,
      },
      '안녕하세요',
    );
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:57441/v1/audio/speech');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      model: DEFAULT_TTS_MODELS['local-qwen-tts'],
      input: '안녕하세요',
      voice: 'announcer-female-calm-ko',
      speed: 1,
      response_format: 'mp3',
    });
    expect(result.format).toBe('mp3');
    expect(result.audio.byteLength).toBe(bytes.length);
  });
});
