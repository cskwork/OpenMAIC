/**
 * Localized display names for the built-in audio providers.
 *
 * The `name` field in `ASR_PROVIDERS` / `TTS_PROVIDERS` is a registry label, not
 * a UI string: several are written in Chinese (`浏览器原生 ASR (Web Speech API)`,
 * `Qwen ASR (阿里云百炼)`). Rendering it directly leaks Chinese into every other
 * locale, so any surface that shows a provider to the user must resolve the
 * name through i18n instead.
 *
 * Kept here rather than in a component so the settings dialog and the
 * generation toolbar cannot drift apart on what a provider is called.
 */

import type { ASRProviderId, TTSProviderId, TTSVoiceInfo } from './types';
import { VOXCPM_AUTO_VOICE_ID } from './voxcpm';

const ASR_PROVIDER_NAME_KEYS: Record<string, string> = {
  'openai-whisper': 'settings.providerOpenAIWhisper',
  'browser-native': 'settings.providerBrowserNative',
  'qwen-asr': 'settings.providerQwenASR',
  'azure-asr': 'settings.providerAzureASR',
  'funasr-asr': 'settings.providerFunASRASR',
  'lemonade-asr': 'settings.providerLemonadeASR',
};

const TTS_PROVIDER_NAME_KEYS: Record<string, string> = {
  'local-qwen-tts': 'settings.providerLocalQwenTTS',
  'openai-tts': 'settings.providerOpenAITTS',
  'azure-tts': 'settings.providerAzureTTS',
  'glm-tts': 'settings.providerGLMTTS',
  'qwen-tts': 'settings.providerQwenTTS',
  'voxcpm-tts': 'settings.providerVoxCPMTTS',
  'doubao-tts': 'settings.providerDoubaoTTS',
  'elevenlabs-tts': 'settings.providerElevenLabsTTS',
  'minimax-tts': 'settings.providerMiniMaxTTS',
  'google-tts': 'settings.providerGoogleTTS',
  'lemonade-tts': 'settings.providerLemonadeTTS',
  'browser-native-tts': 'settings.providerBrowserNativeTTS',
};

/**
 * Translate a built-in ASR provider's name. Unknown ids (custom providers,
 * which carry their own user-supplied name) fall back to `fallback`, then to
 * the id, so a caller never renders an empty label.
 */
export function resolveASRProviderName(
  providerId: ASRProviderId | string,
  t: (key: string) => string,
  fallback?: string,
): string {
  const key = ASR_PROVIDER_NAME_KEYS[providerId];
  return key ? t(key) : fallback || providerId;
}

/** TTS counterpart of {@link resolveASRProviderName}. */
export function resolveTTSProviderName(
  providerId: TTSProviderId | string,
  t: (key: string) => string,
  fallback?: string,
): string {
  const key = TTS_PROVIDER_NAME_KEYS[providerId];
  return key ? t(key) : fallback || providerId;
}

/** Registry voice identifiers stay stable while descriptive UI labels translate. */
export function resolveTTSVoiceName(
  providerId: TTSProviderId | string,
  voice: Pick<TTSVoiceInfo, 'id' | 'name'>,
  t: (key: string) => string,
): string {
  if (providerId === 'local-qwen-tts' && voice.id === 'announcer-female-calm-ko') {
    return t('settings.localQwenVoice');
  }
  if (providerId === 'voxcpm-tts' && voice.id === VOXCPM_AUTO_VOICE_ID) {
    return t('settings.voxcpmAutoVoice');
  }
  return voice.name;
}
