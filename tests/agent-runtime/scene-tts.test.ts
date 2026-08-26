import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  generate: vi.fn(),
  put: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerTTSProviders: mocks.providers,
  resolveTTSApiKey: vi.fn(() => ''),
  resolveTTSBaseUrl: vi.fn(() => undefined),
  resolveTTSModel: vi.fn(() => ''),
}));

vi.mock('@/lib/audio/tts-providers', () => ({ generateTTS: mocks.generate }));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: vi.fn(async () => ({ assetStore: { put: mocks.put } })),
}));

import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import type { Scene } from '@/lib/types/stage';

const scene = {
  id: 'scene-a',
  stageId: 'stage-a',
  order: 1,
  title: 'A',
  type: 'slide',
  content: { type: 'slide' },
  actions: [{ id: 'speech-a', type: 'speech', text: 'Hello' }],
} as Scene;

describe('scene TTS capability routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('honors the server capability force-off before synthesis', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': { disabled: true } });
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
    });
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('stores generated narration bytes in the asset registry', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': {} });
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.put.mockResolvedValue('ast_audio');
    const target = structuredClone(scene);
    const summary = await synthesizeSceneNarration({ scene: target, force: false });
    expect(summary).toMatchObject({ available: true, changed: true, generated: 1 });
    expect(target.actions?.[0]).toMatchObject({ audioId: 'ast_audio' });
    expect(mocks.put).toHaveBeenCalledWith({ key: 'shared' }, expect.any(Blob), {
      contentType: 'audio/mpeg',
    });
  });
});
