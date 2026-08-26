import type { AssetStore } from '@openmaic/storage';

import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { generateTTS } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import {
  getServerTTSProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export interface SceneTtsSummary {
  available: boolean;
  changed: boolean;
  generated: number;
  skipped: number;
  failed: string[];
}

export interface SceneTtsInput {
  scene: Scene;
  force: boolean;
  roster?: readonly GeneratedAgentConfig[] | null;
  signal?: AbortSignal;
}

function enabledProviderIds(): TTSProviderId[] {
  return Object.entries(getServerTTSProviders())
    .filter(([id, config]) => id !== BROWSER_NATIVE_TTS_PROVIDER_ID && !config.disabled)
    .map(([id]) => id as TTSProviderId);
}

function narratorVoice(roster: SceneTtsInput['roster']) {
  return roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig)?.voiceConfig;
}

function audioMime(format: string) {
  return format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
}

/** Server-configured, capability-aware narration synthesis into the asset registry. */
export async function synthesizeSceneNarration(
  input: SceneTtsInput,
  assetStore?: Pick<AssetStore, 'put'>,
): Promise<SceneTtsSummary> {
  const enabled = enabledProviderIds();
  const bound = narratorVoice(input.roster);
  const providerId = (
    bound?.providerId && enabled.includes(bound.providerId as TTSProviderId)
      ? bound.providerId
      : enabled[0]
  ) as TTSProviderId | undefined;
  if (!providerId) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const apiKey = resolveTTSApiKey(providerId);
  if (provider?.requiresApiKey && !apiKey) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const voice =
    bound?.providerId === providerId && bound.voiceId
      ? bound.voiceId
      : DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || '';
  const modelId =
    resolveTTSModel(
      providerId,
      DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
      voice,
    ) || '';
  const store =
    assetStore ?? (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).assetStore;
  let generated = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const action of input.scene.actions ?? []) {
    if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
    const speech = action as SpeechAction;
    if (!input.force && speech.audioId) {
      skipped += 1;
      continue;
    }
    if (input.signal?.aborted) throw new Error('aborted');
    try {
      const audio = await generateTTS(
        {
          providerId,
          modelId,
          apiKey,
          baseUrl: resolveTTSBaseUrl(providerId),
          voice,
          speed: speech.speed,
        },
        speech.text,
      );
      if (input.signal?.aborted) throw new Error('aborted');
      speech.audioId = await store.put(
        { key: 'shared' },
        new Blob([Buffer.from(audio.audio)], { type: audioMime(audio.format) }),
        { contentType: audioMime(audio.format) },
      );
      generated += 1;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      failed.push(action.id);
    }
  }
  return {
    available: true,
    changed: generated > 0,
    generated,
    skipped,
    failed,
  };
}
