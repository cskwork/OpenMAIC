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
import { resolveFirstServerTTSProvider } from '@/lib/server/provider-config';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
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

/**
 * Map the course `languageDirective` (a full instruction sentence on the server
 * pipeline; the client passes a locale instead) onto something the bootstrap
 * fallback-sentence table can key on. Without this, a Chinese directive would
 * never match and a refText-less agent would bootstrap with the English sample.
 */
export function toBootstrapLanguage(language?: string): string | undefined {
  const value = language?.trim();
  if (!value) return undefined;
  if (/\p{Script=Han}/u.test(value)) return 'zh';
  // already a language/locale code → pass through
  if (/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]+)*$/.test(value)) return value;
  return undefined;
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

  const provider = resolveFirstServerTTSProvider();
  if (!provider) return resolved;
  const { providerId, apiKey, baseUrl, model } = provider;
  if (TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]?.requiresApiKey && !apiKey) {
    return resolved; // batch TTS will skip for the same reason; don't spam warns
  }

  // Server-managed providers carry no client provider-options; the adapter
  // decides support from its defaults (VoxCPM: default backend is vLLM-Omni).
  const adapter = getVoiceRegistrationAdapter(providerId);
  if (!adapter?.supportsRegistration(undefined)) return resolved;
  if (!baseUrl) return resolved;

  const cfg: VoiceRegistrationConfig = { baseUrl, apiKey, model };
  // Canonicalized so the client's lazy ensure (settings-supplied model) derives
  // the SAME deterministic id and finds the voice already registered. This
  // holds as long as the server-resolved model canonicalizes to the same value
  // as the client's; an operator-pinned custom model id namespaces separately
  // (clients unaware of the pin will register their own voice).
  const idModel = canonicalVoiceModelId(providerId, model);
  const bootstrapLanguage = toBootstrapLanguage(language);

  // Bootstrap + register concurrently (one synthesis + one upload per agent on
  // the generation critical path); each agent degrades independently. Agents
  // that resolve to the SAME deterministic id (same design + refText) share
  // one ensure call instead of racing duplicate bootstrap/register requests.
  const ensures = new Map<string, Promise<{ registeredClip?: unknown }>>();
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
        let ensure = ensures.get(voiceId);
        if (!ensure) {
          ensure = ensureBackendVoiceRegistered(adapter, cfg, {
            voiceId,
            design,
            language: bootstrapLanguage,
            refText,
          });
          ensures.set(voiceId, ensure);
        }
        const { registeredClip } = await ensure;
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
