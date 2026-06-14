/**
 * Per-speech managed-TTS helpers for the timeline editor.
 *
 * Mirrors the generation pipeline (app/generation-preview): synthesize one
 * speech line via /api/generate/tts using the user's TTS settings and cache the
 * audio blob in IndexedDB (`db.audioFiles`) keyed by `tts_<actionId>`, so
 * playback/export pick it up exactly like generated audio.
 */
import { db } from '@/lib/utils/database';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import { getVoxCPMProviderOptions } from '@/lib/audio/voxcpm-voices';
import { VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';

/** Stable audio cache key for a speech action. */
export function speechAudioId(actionId: string): string {
  return `tts_${actionId}`;
}

/** Managed (server) TTS is on — browser-native TTS has no cached file to manage. */
export function isManagedTtsActive(): boolean {
  const s = useSettingsStore.getState();
  return s.ttsEnabled && s.ttsProviderId !== 'browser-native-tts';
}

/** True if an audio blob is cached under this exact audioId. */
export async function audioExists(audioId: string): Promise<boolean> {
  return !!(await db.audioFiles.get(audioId));
}

/** Object URL for the audio cached under this exact audioId (caller revokes). */
export async function audioObjectUrl(audioId: string): Promise<string | null> {
  const rec = await db.audioFiles.get(audioId);
  return rec ? URL.createObjectURL(rec.blob) : null;
}

/**
 * (Re)generate TTS audio for one speech line and cache it. Returns the audioId
 * on success. Throws on failure; returns null when TTS isn't applicable.
 */
export async function generateSpeechAudio(
  action: { id: string; text?: string },
  signal?: AbortSignal,
): Promise<string | null> {
  const settings = useSettingsStore.getState();
  if (!settings.ttsEnabled || settings.ttsProviderId === 'browser-native-tts') return null;
  const text = action.text?.trim();
  if (!text || !action.id) return null;

  const audioId = speechAudioId(action.id);
  const cfg = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const languageDirective = useStageStore.getState().stage?.languageDirective;
  const providerOptions =
    settings.ttsProviderId === VOXCPM_TTS_PROVIDER_ID
      ? {
          ...(cfg?.providerOptions || {}),
          ...(await getVoxCPMProviderOptions(settings.ttsVoice, { role: 'teacher', language: languageDirective })),
        }
      : cfg?.providerOptions;

  const resp = await fetch('/api/generate/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      audioId,
      ttsProviderId: settings.ttsProviderId,
      ttsModelId: cfg?.modelId,
      ttsVoice: settings.ttsVoice,
      ttsSpeed: settings.ttsSpeed,
      ttsApiKey: cfg?.apiKey || undefined,
      // Managed providers resolve their base URL server-side; only custom ones send theirs.
      ttsBaseUrl: cfg?.baseUrl || cfg?.customDefaultBaseUrl || undefined,
      ttsProviderOptions: providerOptions,
    }),
    signal,
  });
  if (!resp.ok) throw new Error(`TTS request failed (${resp.status})`);
  const data = await resp.json();
  if (!data.success) throw new Error(data.error || 'TTS generation failed');

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  await db.audioFiles.put({ id: audioId, blob, format: data.format, text, createdAt: Date.now() });
  return audioId;
}
