import { describe, expect, it } from 'vitest';
import { getAvailableProvidersWithVoices } from '@/lib/audio/voice-resolver';

describe('getAvailableProvidersWithVoices', () => {
  it('does not treat built-in localhost defaults as available local TTS providers', () => {
    const providers = getAvailableProvidersWithVoices({
      'browser-native-tts': { enabled: true },
      'voxcpm-tts': {
        apiKey: '',
        baseUrl: '',
        enabled: false,
        modelId: 'VoxCPM2',
        providerOptions: { backend: 'vllm' },
      },
      'lemonade-tts': {
        apiKey: '',
        baseUrl: '',
        enabled: false,
        modelId: 'kokoro-v1',
        isServerConfigured: true,
        serverBaseUrl: 'http://localhost:13305/v1',
      },
    });

    expect(providers.map((provider) => provider.providerId)).toEqual(['lemonade-tts']);
  });

  it('includes a keyless local provider when the user explicitly configured a base URL', () => {
    const providers = getAvailableProvidersWithVoices({
      'browser-native-tts': { enabled: true },
      'lemonade-tts': {
        apiKey: '',
        baseUrl: 'http://localhost:13305/v1',
        enabled: true,
        modelId: 'kokoro-v1',
      },
    });

    expect(providers.map((provider) => provider.providerId)).toEqual(['lemonade-tts']);
  });
});
