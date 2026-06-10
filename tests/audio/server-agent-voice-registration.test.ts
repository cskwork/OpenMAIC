import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDeterministicVoiceId } from '@/lib/audio/voice-design';

const providerConfig = vi.hoisted(() => ({
  getServerTTSProviders: vi.fn(),
  resolveTTSApiKey: vi.fn(() => 'test-key'),
  resolveTTSBaseUrl: vi.fn(() => 'http://voxcpm.test'),
  resolveTTSModel: vi.fn(() => 'voxcpm2'),
}));
vi.mock('@/lib/server/provider-config', () => providerConfig);

const adapter = vi.hoisted(() => ({
  supportsRegistration: vi.fn(() => true),
  voiceExists: vi.fn(async () => false),
  registerVoice: vi.fn(async (_cfg: unknown, params: { voiceId: string }) => params.voiceId),
  bootstrapReferenceClip: vi.fn(async () => ({
    referenceAudioBase64: 'QUJD',
    mimeType: 'audio/wav',
  })),
}));
vi.mock('@/lib/audio/voice-registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/voice-registration')>();
  return {
    ...actual,
    getVoiceRegistrationAdapter: (providerId: string) =>
      providerId === 'voxcpm-tts' ? adapter : undefined,
  };
});

import { registerAgentVoicesOnServer } from '@/lib/server/agent-voice-registration';

const design = { identity: '中年男教师', texture: '低沉温暖', delivery: '从容鼓励' };
const refText = '大家好，我是这门课的老师，欢迎来到课堂，我们马上开始今天的学习。';

beforeEach(() => {
  vi.clearAllMocks();
  providerConfig.getServerTTSProviders.mockReturnValue({ 'voxcpm-tts': {} });
  adapter.supportsRegistration.mockReturnValue(true);
  adapter.voiceExists.mockResolvedValue(false);
});

describe('registerAgentVoicesOnServer', () => {
  it('bootstraps with the agent refText and registers under the deterministic id', async () => {
    const result = await registerAgentVoicesOnServer(
      [{ id: 'gen-1', voiceDesign: design, refText }],
      '使用中文回答。',
    );

    const expectedId = await getDeterministicVoiceId(design, {
      providerId: 'voxcpm-tts',
      model: 'voxcpm2',
      refText,
    });
    expect(result.get('gen-1')?.voiceId).toBe(expectedId);
    expect(result.get('gen-1')?.voicePrompt).toContain('中年男教师');
    expect(adapter.bootstrapReferenceClip).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://voxcpm.test' }),
      expect.objectContaining({ refText }),
    );
    expect(adapter.registerVoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ voiceId: expectedId, referenceAudioBase64: 'QUJD' }),
    );
  });

  it('skips bootstrap when the voice already exists, still returning the id', async () => {
    adapter.voiceExists.mockResolvedValue(true);
    const result = await registerAgentVoicesOnServer([
      { id: 'gen-1', voiceDesign: design, refText },
    ]);
    expect(result.get('gen-1')?.voiceId).toBeDefined();
    expect(adapter.bootstrapReferenceClip).not.toHaveBeenCalled();
    expect(adapter.registerVoice).not.toHaveBeenCalled();
  });

  it('falls back to the inline prompt when registration fails, without throwing', async () => {
    adapter.registerVoice.mockRejectedValueOnce(new Error('backend down'));
    const result = await registerAgentVoicesOnServer([
      { id: 'gen-1', voiceDesign: design, refText },
      { id: 'gen-2', voiceDesign: design, refText: refText + '继续。' },
    ]);
    expect(result.get('gen-1')?.voiceId).toBeUndefined();
    expect(result.get('gen-1')?.voicePrompt).toContain('中年男教师');
    // The second agent is unaffected by the first one's failure
    expect(result.get('gen-2')?.voiceId).toBeDefined();
  });

  it('returns an empty map when the provider does not support registration', async () => {
    providerConfig.getServerTTSProviders.mockReturnValue({ 'qwen-tts': {} });
    const result = await registerAgentVoicesOnServer([
      { id: 'gen-1', voiceDesign: design, refText },
    ]);
    expect(result.size).toBe(0);
  });

  it('ignores agents without a voiceDesign', async () => {
    const result = await registerAgentVoicesOnServer([{ id: 'gen-1', refText }]);
    expect(result.size).toBe(0);
    expect(providerConfig.getServerTTSProviders).not.toHaveBeenCalled();
  });
});
