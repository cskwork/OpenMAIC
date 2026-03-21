import type { TTSProviderId } from '@/lib/audio/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

/**
 * Resolve the voice ID for an agent given the current TTS provider.
 * 1. Check agent.voiceOverrides[providerId] — if valid, use it
 * 2. Otherwise — deterministic assignment from voiceList by agentIndex
 */
export function resolveVoice(
  agent: AgentConfig,
  providerId: TTSProviderId,
  agentIndex: number,
  voiceList: string[],
): string {
  if (voiceList.length === 0) return 'default';

  const override = agent.voiceOverrides?.[providerId];
  if (override && voiceList.includes(override)) {
    return override;
  }

  return voiceList[agentIndex % voiceList.length];
}

/**
 * Get the list of voice IDs for a server-side TTS provider.
 * For browser-native-tts, caller must pass browser voices separately.
 */
export function getServerVoiceList(providerId: TTSProviderId): string[] {
  if (providerId === 'browser-native-tts') return [];
  const provider = TTS_PROVIDERS[providerId];
  if (!provider) return [];
  return provider.voices.map((v) => v.id);
}
