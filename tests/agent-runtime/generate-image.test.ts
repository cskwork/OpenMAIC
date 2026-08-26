import { afterEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';

import { MAX_REMOTE_IMAGE_BYTES } from '@/lib/server/bounded-download';

const mocks = vi.hoisted(() => ({
  recordGenerationUsage: vi.fn().mockResolvedValue(undefined),
  getServerPersistenceProvider: vi.fn(),
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordGenerationUsage,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => null }));

import {
  buildGenerateImageTool,
  defaultPersistGeneratedImage,
  GenerateImageParams,
} from '@/lib/server/agent-runtime/generate-image';

describe('generate_image tool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('validates prompt and the supported aspect ratios', () => {
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '16:9',
      }),
    ).toBe(true);
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '1:1',
      }),
    ).toBe(true);
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '4:3',
      }),
    ).toBe(true);
    expect(Check(GenerateImageParams, { prompt: 'A microscope', aspectRatio: '16:9' })).toBe(false);
    expect(
      Check(GenerateImageParams, { stageId: 'stage-owner', prompt: '', aspectRatio: '16:9' }),
    ).toBe(false);
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '9:16',
      }),
    ).toBe(false);
  });

  it('fails loudly when no server image provider is configured', async () => {
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({}),
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as {
      isError?: boolean;
      content: { text: string }[];
      details: Record<string, unknown>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no server image provider is configured');
    expect(result.details).toMatchObject({
      stageId: 'stage-owner',
      sessionId: 'session-owner',
      provider: null,
    });
  });

  it('fails loudly when the server resolves no model for a model-bearing provider', async () => {
    const generateConfiguredImage = vi.fn();
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ 'openai-image': { models: [] } }),
      resolveProviderConfig: () => ({
        providerId: 'openai-image',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: undefined,
      }),
      generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no model is configured');
    expect(result.details.reason).toBe('missing-model');
    // Never a silent adapter default: the provider is not called.
    expect(generateConfiguredImage).not.toHaveBeenCalled();
  });

  it('honors a pre-aborted tool call before resolving owner scope or doing I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    const generateConfiguredImage = vi.fn();
    const tool = buildGenerateImageTool({
      getConfiguredProviders: () => ({ 'openai-image': {} }),
      generateConfiguredImage,
    });

    await expect(
      tool.execute('call-1', { stageId: 'stage-owner', prompt: 'A microscope' }, controller.signal),
    ).rejects.toThrow('aborted');
    expect(generateConfiguredImage).not.toHaveBeenCalled();
  });

  it('generates, persists and returns a renderable src under the bound course scope', async () => {
    vi.stubEnv('DEFAULT_IMAGE_PROVIDER', 'openai-image');
    const generated = {
      base64: Buffer.from('real-image-bytes').toString('base64'),
      width: 1024,
      height: 576,
    };
    const generateConfiguredImage = vi.fn().mockResolvedValue(generated);
    const put = vi.fn().mockResolvedValue('ast_generated-image');
    mocks.getServerPersistenceProvider.mockResolvedValue({ assetStore: { put } });
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ 'openai-image': { models: ['gpt-image-1'] } }),
      resolveProviderConfig: () => ({
        providerId: 'openai-image',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-1',
      }),
      generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '16:9',
        styleHint: 'editorial photo',
      },
      undefined,
    )) as {
      isError?: boolean;
      content: { text: string }[];
      details: { src: string; width: number; height: number; provider: string };
    };

    expect(result.isError).toBeUndefined();
    expect(generateConfiguredImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-image',
        model: 'gpt-image-1',
      }),
      expect.objectContaining({
        prompt: 'A microscope\nStyle direction: editorial photo',
        aspectRatio: '16:9',
        stageId: 'stage-owner',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(put).toHaveBeenCalledWith(
      { key: 'shared' },
      expect.objectContaining({ size: Buffer.from('real-image-bytes').length, type: 'image/png' }),
      { contentType: 'image/png' },
    );
    expect(result.details).toEqual({
      src: 'ast_generated-image',
      width: 1024,
      height: 576,
      provider: 'openai-image',
    });
    expect(result.content[0].text).toContain(result.details.src);
    expect(mocks.recordGenerationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', quantity: 1 }),
    );
  });

  it('fails loudly when the generated image exceeds the byte cap', async () => {
    const oversized = {
      base64: Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1).toString('base64'),
      width: 1024,
      height: 576,
    };
    const put = vi.fn();
    await expect(
      defaultPersistGeneratedImage(
        {
          result: oversized,
          stageId: 'stage-owner',
          signal: new AbortController().signal,
        },
        { put },
      ),
    ).rejects.toThrow(`exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit`);
    expect(put).not.toHaveBeenCalled();
  });

  it('materializes a provider-hosted URL through the shared asset registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(Buffer.from('real-image-bytes'), {
          headers: { 'content-type': 'image/jpeg' },
        }),
      ),
    );
    const put = vi.fn().mockResolvedValue('ast_provider-image');
    await expect(
      defaultPersistGeneratedImage(
        {
          result: { url: 'https://cdn.example.com/generated/photo.jpg', width: 1024, height: 576 },
          stageId: 'stage-owner',
          signal: new AbortController().signal,
        },
        { put },
      ),
    ).resolves.toBe('ast_provider-image');
    expect(put).toHaveBeenCalledWith(
      { key: 'shared' },
      expect.objectContaining({ size: Buffer.from('real-image-bytes').length, type: 'image/jpeg' }),
      { contentType: 'image/jpeg' },
    );
  });
});
