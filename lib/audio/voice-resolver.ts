import type { TTSProviderId } from '@/lib/audio/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

export interface ResolvedVoice {
  providerId: TTSProviderId;
  voiceId: string;
}

/**
 * Resolve the TTS provider + voice for an agent.
 * 1. If agent has voiceConfig and the voice is still valid, use it
 * 2. Otherwise, use globalProviderId + deterministic assignment by agentIndex
 */
export function resolveAgentVoice(
  agent: AgentConfig,
  globalProviderId: TTSProviderId,
  agentIndex: number,
): ResolvedVoice {
  if (agent.voiceConfig) {
    const list = getServerVoiceList(agent.voiceConfig.providerId);
    if (list.includes(agent.voiceConfig.voiceId)) {
      return agent.voiceConfig;
    }
  }

  const list = getServerVoiceList(globalProviderId);
  if (list.length === 0) {
    return { providerId: globalProviderId, voiceId: 'default' };
  }
  return { providerId: globalProviderId, voiceId: list[agentIndex % list.length] };
}

/**
 * Get the list of voice IDs for a TTS provider.
 * For browser-native-tts, returns empty (browser voices are dynamic).
 */
export function getServerVoiceList(providerId: TTSProviderId): string[] {
  if (providerId === 'browser-native-tts') return [];
  const provider = TTS_PROVIDERS[providerId];
  if (!provider) return [];
  return provider.voices.map((v) => v.id);
}

export interface ProviderWithVoices {
  providerId: TTSProviderId;
  providerName: string;
  voices: Array<{ id: string; name: string }>;
}

/**
 * Get all available providers and their voices for the voice picker UI.
 * A provider is available if it has an API key or is server-configured.
 * Browser-native-tts is excluded (no static voice list).
 */
export function getAvailableProvidersWithVoices(
  ttsProvidersConfig: Record<
    string,
    { apiKey?: string; enabled?: boolean; isServerConfigured?: boolean }
  >,
): ProviderWithVoices[] {
  const result: ProviderWithVoices[] = [];

  for (const [id, config] of Object.entries(TTS_PROVIDERS)) {
    const providerId = id as TTSProviderId;
    if (providerId === 'browser-native-tts') continue;
    if (config.voices.length === 0) continue;

    const providerConfig = ttsProvidersConfig[providerId];
    const hasApiKey = providerConfig?.apiKey && providerConfig.apiKey.trim().length > 0;
    const isServerConfigured = providerConfig?.isServerConfigured === true;

    if (hasApiKey || isServerConfigured) {
      result.push({
        providerId,
        providerName: config.name,
        voices: config.voices.map((v) => ({ id: v.id, name: v.name })),
      });
    }
  }

  return result;
}

/**
 * Find a voice display name across all providers.
 */
export function findVoiceDisplayName(providerId: TTSProviderId, voiceId: string): string {
  const provider = TTS_PROVIDERS[providerId];
  if (!provider) return voiceId;
  const voice = provider.voices.find((v) => v.id === voiceId);
  return voice?.name ?? voiceId;
}
