import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';
import {
  deleteQwenVoice,
  downloadAudio,
  preferredVoiceName,
  qwenVoiceExists,
  registerQwenVoice,
  synthesizeQwenVoiceClone,
} from '@/lib/audio/qwen-voice-clone';
import { clearQwenVoiceRegistrationMemoForTests } from '@/lib/audio/qwen-voice-clone-registration';
import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import { getEnabledProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { validateReferenceAudio } from '@/lib/audio/wav-validate';
import { generateTTS } from '@/lib/audio/tts-providers';

const CONFIG = {
  apiKey: 'sk-qwen',
  baseUrl: 'https://dashscope.example.com/api/v1',
  targetModel: QWEN_TTS_VOICE_CLONE_MODEL,
};

function pcmWav(seconds = 1): Uint8Array {
  const dataBytes = 24_000 * seconds * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

describe('Qwen voice cloning', () => {
  beforeEach(() => clearQwenVoiceRegistrationMemoForTests());
  afterEach(() => vi.restoreAllMocks());

  it('posts the enrollment request and uses output.voice as the authoritative id', async () => {
    const audio = pcmWav();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: { voice: 'qwen_vc_authoritative' } }), {
        status: 200,
      }),
    );

    const result = await registerQwenVoice(CONFIG, {
      name: 'Sample Teacher',
      audio,
      text: 'This is the verbatim reference transcript.',
    });

    expect(result).toEqual({
      voiceId: 'qwen_vc_authoritative',
      targetModel: QWEN_TTS_VOICE_CLONE_MODEL,
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://dashscope.example.com/api/v1/services/audio/tts/customization',
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-qwen');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'qwen-voice-enrollment',
      input: {
        action: 'create',
        target_model: QWEN_TTS_VOICE_CLONE_MODEL,
        preferred_name: expect.stringMatching(/^[a-z][a-z0-9_]{1,15}$/u),
        audio: { data: `data:audio/wav;base64,${Buffer.from(audio).toString('base64')}` },
        text: 'This is the verbatim reference transcript.',
      },
    });
  });

  it.each([
    'https://dashscope.example.com',
    'https://dashscope.example.com/',
    'https://dashscope.example.com/api/v1',
    'https://dashscope.example.com/api/v1/',
  ])('normalizes base URL %s without duplicating api/v1', async (baseUrl) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ output: { voice: 'voice_1' } })));
    await registerQwenVoice(
      { ...CONFIG, baseUrl },
      { name: 'Teacher', audio: pcmWav(), text: 'Reference.' },
    );
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://dashscope.example.com/api/v1/services/audio/tts/customization',
    );
  });

  it('creates stable constrained preferred names', () => {
    const first = preferredVoiceName('A Name With Spaces', pcmWav());
    const second = preferredVoiceName('A Name With Spaces', pcmWav());
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z][a-z0-9_]{1,15}$/u);
    expect(first.length).toBeLessThanOrEqual(16);
    expect(preferredVoiceName('!!!', pcmWav())).toMatch(/^voice_[a-f0-9]{8}$/u);
  });

  it.each([
    'http://127.0.0.1/private.wav',
    'https://example.com/result.wav',
    'ftp://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8443/result.wav',
  ])('rejects an untrusted audio URL: %s', async (url) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(downloadAudio(url)).rejects.toMatchObject({
      code: 'QWEN_VC_AUDIO_URL_INVALID',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('upgrades trusted HTTP URLs and refuses redirects', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await downloadAudio(
      'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav?signature=value',
    );
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav?signature=value',
    );
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('allows international DashScope result hosts', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    await downloadAudio('https://dashscope-result-us.oss-us-west-1.aliyuncs.com/result.wav');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('rejects an oversized declared download before reading it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-length': String(50 * 1024 * 1024 + 1) },
      }),
    );
    await expect(
      downloadAudio('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav'),
    ).rejects.toMatchObject({ code: 'QWEN_VC_AUDIO_TOO_LARGE' });
  });

  it('stops a chunked download when the streaming cap is crossed', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(30 * 1024 * 1024));
        controller.enqueue(new Uint8Array(21 * 1024 * 1024));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    await expect(
      downloadAudio('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav'),
    ).rejects.toMatchObject({ code: 'QWEN_VC_AUDIO_TOO_LARGE' });
  });

  it('posts VC synthesis without parameters and returns downloaded bytes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              audio: {
                url: 'https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/a.wav',
                format: 'wav',
              },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
      );

    const result = await synthesizeQwenVoiceClone(CONFIG, 'Hello', 'qwen_vc_1');
    expect(result).toEqual({ audio: new Uint8Array([82, 73, 70, 70]), format: 'wav' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      model: QWEN_TTS_VOICE_CLONE_MODEL,
      input: { text: 'Hello', voice: 'qwen_vc_1' },
    });
  });

  it('normalizes non-default VC speed and still synthesizes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              audio: { url: 'https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/a.wav' },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    await expect(synthesizeQwenVoiceClone(CONFIG, 'Hello', 'qwen_vc_1', 1.25)).resolves.toEqual({
      audio: new Uint8Array([1]),
      format: 'wav',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('allows a custom Qwen base URL to serve its own audio without weakening redirects', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    await downloadAudio(
      'https://proxy.example.com/storage/result.wav',
      undefined,
      'https://proxy.example.com/api/v1',
    );
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('lists and deletes provider-side Qwen voices with documented request shapes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { total_count: 1, voice_list: [{ voice: 'v1' }] } })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice: 'v1' } })));

    await expect(qwenVoiceExists(CONFIG, 'v1')).resolves.toBe(true);
    await expect(deleteQwenVoice(CONFIG, 'v1')).resolves.toBeUndefined();
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      model: 'qwen-voice-enrollment',
      input: { action: 'list', page_index: 0, page_size: 100 },
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
      model: 'qwen-voice-enrollment',
      input: { action: 'delete', voice: 'v1' },
    });
  });

  it('evicts the registration memo when synthesis reports that the voice is gone', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice: 'vendor_voice_1' } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'VoiceNotFound', message: 'voice does not exist' }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice: 'vendor_voice_2' } })));
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const params = {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    };
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    await expect(adapter.registerVoice(cfg, params)).resolves.toBe('vendor_voice_1');
    await expect(
      generateTTS(
        {
          providerId: 'qwen-tts',
          modelId: CONFIG.targetModel,
          voice: 'vendor_voice_1',
          speed: 1.25,
          apiKey: CONFIG.apiKey,
          baseUrl: CONFIG.baseUrl,
        },
        'Hello',
      ),
    ).rejects.toMatchObject({ code: 'QWEN_VC_VOICE_NOT_FOUND' });
    await expect(adapter.registerVoice(cfg, params)).resolves.toBe('vendor_voice_2');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('shares a synthesis deadline across the vendor request and download', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const pending = synthesizeQwenVoiceClone(CONFIG, 'Hello', 'qwen_vc_1');
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'QWEN_VC_TIMEOUT',
        httpStatus: 504,
      });
      await vi.advanceTimersByTimeAsync(24_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates 24 kHz mono PCM WAV reference audio', () => {
    expect(validateReferenceAudio(pcmWav(2))).toEqual({
      durationSeconds: 2,
      sampleRate: 24_000,
      channels: 1,
    });
    const invalid = pcmWav();
    new DataView(invalid.buffer).setUint32(24, 16_000, true);
    expect(() => validateReferenceAudio(invalid)).toThrowError(
      'Reference audio must be a 24 kHz mono PCM WAV file between 1 and 60 seconds long',
    );
  });

  it('memoizes identical adapter registrations and returns the vendor id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ output: { voice: 'vendor_voice_1' } })));
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const params = {
      voiceId: 'Friendly Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      mimeType: 'audio/wav',
      refText: 'Reference transcript.',
    };
    const cfg = {
      baseUrl: CONFIG.baseUrl,
      apiKey: CONFIG.apiKey,
      model: CONFIG.targetModel,
    };

    await expect(
      Promise.all([adapter.registerVoice(cfg, params), adapter.registerVoice(cfg, params)]),
    ).resolves.toEqual(['vendor_voice_1', 'vendor_voice_1']);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('injects Qwen clone profiles only into the VC model group', () => {
    const qwen = getEnabledProvidersWithVoices({ 'qwen-tts': { apiKey: 'key', enabled: true } }, [
      {
        id: 'vendor_voice_1',
        providerId: 'qwen-tts',
        kind: 'clone',
        name: 'Saved voice',
      },
    ]).find((provider) => provider.providerId === 'qwen-tts')!;

    expect(qwen.voices).toContainEqual({
      id: 'vendor_voice_1',
      name: 'Saved voice',
      language: 'auto',
    });
    expect(
      qwen.modelGroups.find((group) => group.modelId === QWEN_TTS_VOICE_CLONE_MODEL)?.voices,
    ).toEqual([{ id: 'vendor_voice_1', name: 'Saved voice', language: 'auto' }]);
    expect(
      qwen.modelGroups.find((group) => group.modelId === 'qwen3-tts-flash')?.voices,
    ).not.toContainEqual(expect.objectContaining({ id: 'vendor_voice_1' }));
  });
});
