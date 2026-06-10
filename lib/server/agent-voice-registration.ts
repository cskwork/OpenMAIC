/**
 * Server-side auto-voice registration at classroom-generation time.
 *
 * Once agent profiles are final, every agent carrying a voiceDesign gets its
 * deterministic auto voice registered against the server-managed TTS backend
 * (bootstrap the refText seed script once, upload the clip, reference by id).
 * This is what lets server-side batch TTS use VoxCPM Auto Voice, and it means
 * the first client playback already finds the voice registered.
 *
 * Best-effort by design: any failure falls back to the inline voice-design
 * prompt (and the client's lazy register-once path remains the correctness
 * net), so classroom generation never blocks on a TTS backend.
 */

import { createLogger } from '@/lib/logger';
import {
  getServerTTSProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import {
  buildVoiceDesignPrompt,
  getDeterministicVoiceId,
  normalizeRefText,
  type VoiceDesign,
} from '@/lib/audio/voice-design';
import {
  canonicalVoiceModelId,
  ensureBackendVoiceRegistered,
  getVoiceRegistrationAdapter,
  type VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';

const log = createLogger('Agent Voice Registration');

export interface AgentVoiceSeed {
  id: string;
  voiceDesign?: VoiceDesign;
  refText?: string;
}

export interface ResolvedAgentVoice {
  /** Registered deterministic voice id; absent when registration was unavailable/failed. */
  voiceId?: string;
  /** Inline voice-design prompt, always present as the fallback. */
  voicePrompt: string;
}

/** First enabled server TTS provider — same precedence as server batch TTS. */
function resolveServerTTSProviderId(): string | undefined {
  return Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id)[0];
}

/**
 * Register the auto voice of every agent that has a voiceDesign, returning a
 * map of agentId → resolved voice (registered id and/or inline prompt).
 * Returns an empty map when the server TTS provider does not support
 * registration (callers then rely on the client-side lazy path).
 */
export async function registerAgentVoicesOnServer(
  agents: AgentVoiceSeed[],
  language?: string,
): Promise<Map<string, ResolvedAgentVoice>> {
  const resolved = new Map<string, ResolvedAgentVoice>();
  const candidates = agents.filter((agent) => agent.voiceDesign);
  if (candidates.length === 0) return resolved;

  const providerId = resolveServerTTSProviderId();
  if (!providerId) return resolved;

  // Server-managed providers carry no client provider-options; the adapter
  // decides support from its defaults (VoxCPM: default backend is vLLM-Omni).
  const adapter = getVoiceRegistrationAdapter(providerId);
  if (!adapter?.supportsRegistration(undefined)) return resolved;

  const baseUrl = resolveTTSBaseUrl(providerId);
  if (!baseUrl) return resolved;
  const model = resolveTTSModel(providerId);
  const cfg: VoiceRegistrationConfig = {
    baseUrl,
    apiKey: resolveTTSApiKey(providerId) || undefined,
    model,
  };
  // Canonicalized so the client's lazy ensure (settings-supplied model) derives
  // the SAME deterministic id and finds the voice already registered.
  const idModel = canonicalVoiceModelId(providerId, model);

  // Bootstrap + register concurrently (one synthesis + one upload per agent on
  // the generation critical path); each agent degrades independently.
  await Promise.all(
    candidates.map(async (agent) => {
      const design = agent.voiceDesign!;
      const voicePrompt = buildVoiceDesignPrompt(design);
      const refText = normalizeRefText(agent.refText);
      try {
        const voiceId = await getDeterministicVoiceId(design, {
          providerId,
          model: idModel,
          refText,
        });
        const { registeredClip } = await ensureBackendVoiceRegistered(adapter, cfg, {
          voiceId,
          design,
          language,
          refText,
        });
        log.info(
          `${registeredClip ? 'Registered' : 'Reusing already-registered'} auto voice ${voiceId} for agent ${agent.id} [provider=${providerId}]`,
        );
        resolved.set(agent.id, { voiceId, voicePrompt });
      } catch (error) {
        log.warn(
          `Auto-voice registration failed for agent ${agent.id}, falling back to inline prompt:`,
          error,
        );
        resolved.set(agent.id, { voicePrompt });
      }
    }),
  );
  return resolved;
}
