import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/generate/voice/route';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/generate/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'qwen-tts',
      voiceId: 'voice-1',
      referenceAudioBase64: 'unused-when-voice-exists',
      refText: 'Reference transcript.',
      ttsApiKey: 'client-key',
      ttsModelId: 'qwen3-tts-vc-test',
    }),
  });
}

describe('Qwen voice registration route', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the shared default Qwen base URL when the request omits one', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ output: { total_count: 1, voice_list: [{ voice: 'voice-1' }] } }),
        ),
      );
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',
    );
  });

  it('returns a readable message while retaining the typed Qwen error code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 502 }),
    );
    const response = await POST(request());
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      errorCode: 'QWEN_VC_HTTP_ERROR',
      error: 'Qwen rejected the voice cloning request.',
    });
    expect(body.error).not.toBe(body.errorCode);
  });
});
