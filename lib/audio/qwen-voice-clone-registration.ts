import { createHash } from 'node:crypto';

import { QwenVoiceCloneError, registerQwenVoice } from '@/lib/audio/qwen-voice-clone';
import { isQwenVoiceCloneModel, QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';
import { validateReferenceAudio } from '@/lib/audio/wav-validate';
import type {
  VoiceRegistrationAdapter,
  VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';

const registrations = new Map<string, Promise<string>>();

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function registrationKey(
  cfg: VoiceRegistrationConfig,
  params: {
    voiceId: string;
    referenceAudioBase64: string;
    refText?: string;
  },
): string {
  return createHash('sha256')
    .update(cfg.baseUrl)
    .update('\0')
    .update(cfg.apiKey || '')
    .update('\0')
    .update(cfg.model || '')
    .update('\0')
    .update(params.voiceId)
    .update('\0')
    .update(params.refText || '')
    .update('\0')
    .update(params.referenceAudioBase64)
    .digest('hex');
}

async function registerVoice(
  cfg: VoiceRegistrationConfig,
  params: {
    voiceId: string;
    referenceAudioBase64: string;
    mimeType?: string;
    refText?: string;
  },
): Promise<string> {
  const refText = params.refText || '';
  if (!refText.trim()) throw new QwenVoiceCloneError('QWEN_VC_CONFIG_MISSING', 400);

  const key = registrationKey(cfg, params);
  const existing = registrations.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const audio = decodeBase64(params.referenceAudioBase64);
    validateReferenceAudio(audio);
    const result = await registerQwenVoice(
      {
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        targetModel: isQwenVoiceCloneModel(cfg.model) ? QWEN_TTS_VOICE_CLONE_MODEL : cfg.model,
      },
      { name: params.voiceId, audio, text: refText },
    );
    return result.voiceId;
  })();
  registrations.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    registrations.delete(key);
    throw error;
  }
}

/** Qwen does not expose a supported voice lookup endpoint, so callers re-register. */
async function voiceExists(): Promise<boolean> {
  return false;
}

/** Qwen enrollment requires a real voice sample and its verbatim transcript. */
async function bootstrapReferenceClip(): Promise<never> {
  throw new QwenVoiceCloneError('QWEN_VC_BOOTSTRAP_UNSUPPORTED', 400);
}

export const qwenVoiceCloneRegistrationAdapter: VoiceRegistrationAdapter = {
  supportsRegistration: () => true,
  supportsBootstrapReferenceClip: false,
  voiceExists,
  registerVoice,
  bootstrapReferenceClip,
};

export function clearQwenVoiceRegistrationMemoForTests(): void {
  registrations.clear();
}
