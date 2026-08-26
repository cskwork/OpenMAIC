import { afterEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';

import {
  buildCourseAllowlist,
  buildDslCourseToolset,
} from '@/lib/server/agent-runtime/course-tools';
import { MAX_GENERATED_VIDEO_BYTES } from '@/lib/server/agent-runtime/generate-video';

const mocks = vi.hoisted(() => ({
  recordGenerationUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordGenerationUsage,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => null }));

import {
  buildGenerateVideoTool,
  defaultPersistGeneratedVideo,
  GenerateVideoParams,
} from '@/lib/server/agent-runtime/generate-video';

const providerConfig = {
  providerId: 'seedance' as const,
  apiKey: 'test-key',
  baseUrl: 'https://ark.cn-beijing.volces.com',
  model: 'doubao-seedance-1-5-pro-251215',
};

const configured = () => ({ seedance: { models: [providerConfig.model] } });

function courseDeps(overrides: Record<string, unknown> = {}) {
  return {
    store: {} as never,
    onCheckpoint: () => undefined,
    sessionId: 'session-owner',
    ...overrides,
  };
}

describe('generate_video tool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('validates the provider-supported request shape', () => {
    expect(
      Check(GenerateVideoParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope rotating slowly',
        aspectRatio: '9:16',
        durationSec: 5,
        resolution: '720p',
      }),
    ).toBe(true);
    expect(Check(GenerateVideoParams, { stageId: 'stage-owner', prompt: '' })).toBe(false);
    expect(Check(GenerateVideoParams, { prompt: 'motion' })).toBe(false);
    expect(
      Check(GenerateVideoParams, {
        stageId: 'stage-owner',
        prompt: 'motion',
        resolution: '4k',
      }),
    ).toBe(false);
  });

  it('is absent from registration and the allowlist when no provider is configured', () => {
    const deps = courseDeps({
      getConfiguredVideoProviders: () => ({}),
      resolveVideoProviderConfig: () => providerConfig,
    });
    expect(buildDslCourseToolset(deps).map((tool) => tool.name)).not.toContain('generate_video');
    expect(buildCourseAllowlist(deps)).not.toContain('generate_video');
  });

  it('registers when a configured provider has its required API key', () => {
    const deps = courseDeps({
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
    });
    expect(buildDslCourseToolset(deps).map((tool) => tool.name)).toContain('generate_video');
    expect(buildCourseAllowlist(deps)).toContain('generate_video');
  });

  it('fails loud when the server resolves no model for a model-bearing provider', async () => {
    const generateConfiguredVideo = vi.fn();
    const tool = buildGenerateVideoTool({
      getConfiguredVideoProviders: () => ({ seedance: { models: [] } }),
      resolveVideoProviderConfig: () => ({
        providerId: 'seedance',
        apiKey: 'test-key',
        model: undefined,
      }),
      generateConfiguredVideo,
    });
    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no model is configured');
    expect(result.details.reason).toBe('missing-model');
    // Never a silent adapter default: the provider is not called.
    expect(generateConfiguredVideo).not.toHaveBeenCalled();
  });

  it('submits, waits for the terminal result, persists and returns media metadata', async () => {
    const generateConfiguredVideo = vi.fn().mockResolvedValue({
      url: 'https://cdn.example.com/generated/lesson.webm',
      duration: 5,
      width: 1280,
      height: 720,
    });
    const persistGeneratedVideo = vi.fn().mockResolvedValue({
      src: 'ast_generated-video',
      mime: 'video/webm',
    });
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo,
      persistGeneratedVideo,
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'A microscope rotating slowly',
      aspectRatio: '16:9',
      durationSec: 5,
      resolution: '720p',
    })) as {
      isError?: boolean;
      content: { text: string }[];
      details: { src: string; mime: string; durationSec: number; provider: string };
    };

    expect(result.isError).toBeUndefined();
    expect(generateConfiguredVideo).toHaveBeenCalledWith(
      providerConfig,
      expect.objectContaining({
        prompt: 'A microscope rotating slowly',
        aspectRatio: '16:9',
        duration: 5,
        resolution: '720p',
        stageId: 'stage-owner',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(persistGeneratedVideo).toHaveBeenCalledWith({
      result: expect.objectContaining({ url: 'https://cdn.example.com/generated/lesson.webm' }),
      stageId: 'stage-owner',
      signal: expect.any(AbortSignal),
    });
    expect(result.details).toEqual({
      src: 'ast_generated-video',
      mime: 'video/webm',
      durationSec: 5,
      provider: 'seedance',
    });
    expect(result.content[0].text).toContain('autoplay and poster');
    expect(mocks.recordGenerationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', unit: 'second', quantity: 5 }),
    );
  });

  it('materializes a provider download URL through the shared asset registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(Buffer.from('real-video-bytes'), {
          headers: { 'content-type': 'video/quicktime' },
        }),
      ),
    );
    const put = vi.fn().mockResolvedValue('ast_provider-video');
    await expect(
      defaultPersistGeneratedVideo(
        {
          result: {
            url: 'https://cdn.example.com/generated/lesson.mov',
            duration: 6,
            width: 1280,
            height: 720,
          },
          stageId: 'stage-owner',
          signal: new AbortController().signal,
        },
        { put },
      ),
    ).resolves.toEqual({
      src: 'ast_provider-video',
      mime: 'video/quicktime',
    });
    expect(put).toHaveBeenCalledWith(
      { key: 'shared' },
      expect.objectContaining({
        size: Buffer.from('real-video-bytes').length,
        type: 'video/quicktime',
      }),
      { contentType: 'video/quicktime' },
    );
  });

  it('fails loud when the generated video exceeds the byte cap', async () => {
    // The declared content-length trips the cap before any body is buffered.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(MAX_GENERATED_VIDEO_BYTES + 1),
          },
        }),
      ),
    );
    const put = vi.fn();
    await expect(
      defaultPersistGeneratedVideo(
        {
          result: {
            url: 'https://cdn.example.com/generated/lesson.mp4',
            duration: 5,
            width: 1280,
            height: 720,
          },
          stageId: 'stage-owner',
          signal: new AbortController().signal,
        },
        { put },
      ),
    ).rejects.toThrow(`Download exceeded the ${MAX_GENERATED_VIDEO_BYTES}-byte response limit`);
    expect(put).not.toHaveBeenCalled();
  });

  it('fails loudly on provider errors without falling back', async () => {
    const generateConfiguredVideo = vi.fn().mockRejectedValue(new Error('content rejected'));
    const tool = buildGenerateVideoTool({
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo,
    });
    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('content rejected');
    expect(result.details.reason).toBe('provider-or-storage-error');
    expect(generateConfiguredVideo).toHaveBeenCalledTimes(1);
  });

  it('fails loudly on timeout', async () => {
    const tool = buildGenerateVideoTool({
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo: () => new Promise(() => undefined),
      timeoutMs: 5,
    });
    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timed out after 5ms');
    expect(result.details.reason).toBe('timeout');
  });

  it('aborts an in-flight provider call', async () => {
    const controller = new AbortController();
    const tool = buildGenerateVideoTool({
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo: () => new Promise(() => undefined),
    });
    const pending = tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'motion' },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});
