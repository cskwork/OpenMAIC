import { describe, it, expect, vi } from 'vitest';
import {
  canonicalVoiceModelId,
  ensureBackendVoiceRegistered,
  getVoiceRegistrationAdapter,
  supportsVoiceRegistration,
  type VoiceRegistrationAdapter,
} from '@/lib/audio/voice-registration';

describe('voice-registration provider dispatch', () => {
  it('resolves an adapter for a registration-capable provider', () => {
    expect(getVoiceRegistrationAdapter('voxcpm-tts')).toBeDefined();
  });

  it('returns undefined for providers without an adapter', () => {
    expect(getVoiceRegistrationAdapter('openai-tts')).toBeUndefined();
    expect(supportsVoiceRegistration('openai-tts')).toBe(false);
  });

  it('honors per-provider capability (voxcpm only with the vllm-omni backend)', () => {
    expect(supportsVoiceRegistration('voxcpm-tts', { backend: 'vllm-omni' })).toBe(true);
    expect(supportsVoiceRegistration('voxcpm-tts', { backend: 'nano-vllm' })).toBe(false);
    // default backend (vllm-omni) when unspecified
    expect(supportsVoiceRegistration('voxcpm-tts')).toBe(true);
  });

  it('canonicalVoiceModelId converges server/client model spellings for voxcpm', () => {
    expect(canonicalVoiceModelId('voxcpm-tts', undefined)).toBe(
      canonicalVoiceModelId('voxcpm-tts', 'voxcpm2'),
    );
    // providers without canonicalization pass the model through untouched
    expect(canonicalVoiceModelId('openai-tts', 'tts-1')).toBe('tts-1');
  });
});

describe('ensureBackendVoiceRegistered', () => {
  const cfg = { baseUrl: 'https://b.test/v1' };
  const design = { identity: 'teacher', texture: 'warm', delivery: 'calm' };

  function makeAdapter(exists: boolean): VoiceRegistrationAdapter {
    return {
      supportsRegistration: () => true,
      voiceExists: vi.fn(async () => exists),
      registerVoice: vi.fn(async (_cfg, p) => p.voiceId),
      bootstrapReferenceClip: vi.fn(async () => ({
        referenceAudioBase64: 'QUJD',
        mimeType: 'audio/wav',
      })),
    };
  }

  it('no-ops when the voice is already live', async () => {
    const adapter = makeAdapter(true);
    const out = await ensureBackendVoiceRegistered(adapter, cfg, { voiceId: 'auto-1', design });
    expect(out).toEqual({ voiceId: 'auto-1' });
    expect(adapter.registerVoice).not.toHaveBeenCalled();
    expect(adapter.bootstrapReferenceClip).not.toHaveBeenCalled();
  });

  it('re-registers a supplied cached clip without re-synthesizing', async () => {
    const adapter = makeAdapter(false);
    const out = await ensureBackendVoiceRegistered(adapter, cfg, {
      voiceId: 'auto-1',
      design,
      cachedClip: { referenceAudioBase64: 'T0xE', mimeType: 'audio/wav' },
    });
    expect(out.registeredClip).toBeUndefined();
    expect(adapter.bootstrapReferenceClip).not.toHaveBeenCalled();
    expect(adapter.registerVoice).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({ referenceAudioBase64: 'T0xE' }),
    );
  });

  it('bootstraps with refText and returns the new clip on first registration', async () => {
    const adapter = makeAdapter(false);
    const out = await ensureBackendVoiceRegistered(adapter, cfg, {
      voiceId: 'auto-1',
      design,
      language: 'zh',
      refText: '大家好，欢迎来到今天的课程，我们马上开始学习。',
    });
    expect(out.registeredClip?.referenceAudioBase64).toBe('QUJD');
    expect(adapter.bootstrapReferenceClip).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({ refText: '大家好，欢迎来到今天的课程，我们马上开始学习。' }),
    );
  });

  it('throws when an unregistered voice has neither a clip nor a design', async () => {
    const adapter = makeAdapter(false);
    await expect(ensureBackendVoiceRegistered(adapter, cfg, { voiceId: 'auto-1' })).rejects.toThrow(
      /design/,
    );
  });
});
