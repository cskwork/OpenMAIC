/**
 * Provider-neutral voice-registration seam.
 *
 * The "auto voice" timbre-stability pattern — synthesize a voice-design once,
 * register it, then reference it by id — is not VoxCPM-specific. Any TTS
 * backend that can register/clone a voice (VoxCPM/vLLM-Omni today; ElevenLabs,
 * MiniMax, Doubao, … later) plugs in by implementing `VoiceRegistrationAdapter`
 * and registering it below. Server routes and the client orchestrator dispatch
 * by `providerId` and never name a concrete provider.
 */

import type { VoiceDesign } from '@/lib/audio/voice-design';
import { voxcpmVoiceRegistrationAdapter } from '@/lib/audio/voxcpm-registration';

/** Resolved backend connection for a registration call (server-injected for managed providers). */
export interface VoiceRegistrationConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

export interface VoiceRegistrationAdapter {
  /** Whether registration is available for this provider given its options (e.g. backend kind). */
  supportsRegistration(options?: Record<string, unknown>): boolean;
  /** Whether `voiceId` is already registered on the backend. */
  voiceExists(cfg: VoiceRegistrationConfig, voiceId: string): Promise<boolean>;
  /** Register (or idempotently re-register) a reference clip under `voiceId`; returns the id. */
  registerVoice(
    cfg: VoiceRegistrationConfig,
    params: { voiceId: string; referenceAudioBase64: string; mimeType?: string },
  ): Promise<string>;
  /**
   * Synthesize the voice design once into a reference clip. `refText` is the
   * agent's seed script (becomes the clip's exact transcript); `language` only
   * selects the fallback sample sentence when no refText is available.
   */
  bootstrapReferenceClip(
    cfg: VoiceRegistrationConfig,
    params: { design: VoiceDesign; language?: string; refText?: string },
  ): Promise<{ referenceAudioBase64: string; mimeType: string }>;
  /**
   * Canonicalize a model id for deterministic-voice-id purposes, so every
   * pipeline (server pre-registration, client lazy ensure) hashes the same
   * value for what is effectively the same model (e.g. VoxCPM treats '',
   * undefined and the display name as its single vLLM model id).
   */
  canonicalModelId?(model?: string): string | undefined;
}

/** providerId → adapter. The only seam to touch when adding a provider. */
const VOICE_REGISTRATION_ADAPTERS: Record<string, VoiceRegistrationAdapter> = {
  'voxcpm-tts': voxcpmVoiceRegistrationAdapter,
};

export function getVoiceRegistrationAdapter(
  providerId: string,
): VoiceRegistrationAdapter | undefined {
  return VOICE_REGISTRATION_ADAPTERS[providerId];
}

/** Whether this provider supports register-once/reference-by-id for the given options. */
export function supportsVoiceRegistration(
  providerId: string,
  options?: Record<string, unknown>,
): boolean {
  return getVoiceRegistrationAdapter(providerId)?.supportsRegistration(options) ?? false;
}

/**
 * The model id to hash into a deterministic voice id for `providerId`.
 * Dispatches to the adapter's canonicalization so the server (config-resolved
 * model) and the client (settings model) agree on the same id.
 */
export function canonicalVoiceModelId(providerId: string, model?: string): string | undefined {
  const adapter = getVoiceRegistrationAdapter(providerId);
  return adapter?.canonicalModelId ? adapter.canonicalModelId(model) : model;
}

/**
 * Core ensure-registered flow shared by the registration API route and the
 * generation-time server pass:
 *  - voice already on the backend → no-op;
 *  - a cached clip is supplied → (re)register it (register-on-invalid,
 *    preserving the original timbre);
 *  - else bootstrap the design once, register, and return the clip so the
 *    caller can cache it.
 * Throws on backend failure; callers decide how to degrade.
 */
export async function ensureBackendVoiceRegistered(
  adapter: VoiceRegistrationAdapter,
  cfg: VoiceRegistrationConfig,
  params: {
    voiceId: string;
    design?: VoiceDesign;
    language?: string;
    refText?: string;
    cachedClip?: { referenceAudioBase64: string; mimeType?: string };
  },
): Promise<{
  voiceId: string;
  registeredClip?: { referenceAudioBase64: string; mimeType: string };
}> {
  if (await adapter.voiceExists(cfg, params.voiceId)) {
    return { voiceId: params.voiceId };
  }

  if (params.cachedClip) {
    await adapter.registerVoice(cfg, {
      voiceId: params.voiceId,
      referenceAudioBase64: params.cachedClip.referenceAudioBase64,
      mimeType: params.cachedClip.mimeType,
    });
    return { voiceId: params.voiceId };
  }

  if (!params.design) {
    throw new Error('voice design is required to bootstrap an unregistered voice');
  }
  const clip = await adapter.bootstrapReferenceClip(cfg, {
    design: params.design,
    language: params.language,
    refText: params.refText,
  });
  await adapter.registerVoice(cfg, {
    voiceId: params.voiceId,
    referenceAudioBase64: clip.referenceAudioBase64,
    mimeType: clip.mimeType,
  });
  return { voiceId: params.voiceId, registeredClip: clip };
}
