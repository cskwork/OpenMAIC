import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const callLLM = vi.fn();

vi.mock('@/lib/ai/llm', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: async () => ({
    model: {},
    modelString: 'test-model',
    thinkingConfig: undefined,
  }),
}));

import { POST } from '@/app/api/generate/agent-profiles/route';

function makeRequest(extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/generate/agent-profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stageInfo: { name: 'Intro to Algebra' },
      languageDirective: 'Respond in English.',
      availableAvatars: ['/a.png', '/b.png'],
      ...extra,
    }),
  });
}

function llmAgents(extra: Record<string, unknown>) {
  return JSON.stringify({
    agents: [
      {
        name: 'Prof. Lin',
        role: 'teacher',
        persona: 'A patient mentor.',
        avatar: '/a.png',
        color: '#111111',
        priority: 10,
        ...extra,
      },
      {
        name: 'Sam',
        role: 'student',
        persona: 'Curious learner.',
        avatar: '/b.png',
        color: '#222222',
        priority: 5,
      },
    ],
  });
}

describe('agent-profiles route — voiceDesign', () => {
  beforeEach(() => callLLM.mockReset());

  it('attaches a normalized voiceDesign when the LLM emits one', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({
        voiceDesign: { identity: 'older male teacher', texture: 'warm low', delivery: 'calm' },
      }),
    });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.agents[0].voiceDesign).toEqual({
      identity: 'older male teacher',
      texture: 'warm low',
      delivery: 'calm',
    });
  });

  it('omits voiceDesign when the LLM does not emit one', async () => {
    callLLM.mockResolvedValue({ text: llmAgents({}) });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.agents[0]).not.toHaveProperty('voiceDesign');
  });

  it('preserves the advertised model in the generated voice binding', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::qwen3-tts-vc-test::clone-1' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-test',
      voiceId: 'clone-1',
    });
  });

  it('drops a non-string voice value without failing the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    callLLM.mockResolvedValue({ text: llmAgents({ voice: 123 }) });

    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
      }),
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.agents[0]).not.toHaveProperty('voiceConfig');
    expect(warn).toHaveBeenCalledWith(
      '[AgentProfiles] Dropped voice token not present in the advertised list:',
      123,
    );
    warn.mockRestore();
  });

  it('prefers an exact advertised token when provider and voice IDs are duplicated', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::qwen3-tts-vc-second::clone-1' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-first',
            voiceId: 'clone-1',
            voiceName: 'First clone',
          },
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-second',
            voiceId: 'clone-1',
            voiceName: 'Second clone',
          },
        ],
      }),
    );
    const body = await res.json();

    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-second',
      voiceId: 'clone-1',
    });
  });

  it('accepts a two-part clone token and derives its advertised model', async () => {
    callLLM.mockResolvedValue({ text: llmAgents({ voice: 'qwen-tts::clone-1' }) });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-test',
      voiceId: 'clone-1',
    });
  });

  it('accepts a two-part catalog voice token without persisting a model', async () => {
    callLLM.mockResolvedValue({ text: llmAgents({ voice: 'qwen-tts::Cherry' }) });
    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
  });

  it('accepts a three-part catalog token without trusting its model segment', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::qwen3-tts-vc-stale::Cherry' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
  });
});
