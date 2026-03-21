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
  // Check agent-specific config
  if (agent.voiceConfig) {
    const list = getServerVoiceList(agent.voiceConfig.providerId);
    if (list.includes(agent.voiceConfig.voiceId)) {
      return agent.voiceConfig;
    }
  }

  // Fallback: global provider + deterministic voice
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

/**
 * Get all configured providers and their voices for the voice picker UI.
 * Returns providers that have API keys configured or are browser-native.
 */
export function getAvailableProvidersWithVoices(
  ttsProvidersConfig: Record<string, { apiKey?: string; enabled?: boolean }>,
): Array<{
  providerId: TTSProviderId;
  providerName: string;
  voices: Array<{ id: string; name: string }>;
}> {
  const result: Array<{
    providerId: TTSProviderId;
    providerName: string;
    voices: Array<{ id: string; name: string }>;
  }> = [];

  for (const [id, config] of Object.entries(TTS_PROVIDERS)) {
    const providerId = id as TTSProviderId;
    if (providerId === 'browser-native-tts') continue;

    const providerConfig = ttsProvidersConfig[providerId];
    // Show provider if it has an API key or is server-configured
    if (providerConfig?.apiKey || (providerConfig as Record<string, unknown>)?.isServerConfigured) {
      result.push({
        providerId,
        providerName: config.name,
        voices: config.voices.map((v) => ({ id: v.id, name: v.name })),
      });
    }
  }

  return result;
}
