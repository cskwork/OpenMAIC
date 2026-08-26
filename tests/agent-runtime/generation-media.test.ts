import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionMaterial, AssetStore } from '@openmaic/storage';

import { buildMaterialMediaTool } from '@/lib/server/agent-runtime/material-media';
import { buildScenePreviewTools } from '@/lib/server/agent-runtime/scene-preview';
import type { CourseStore } from '@/lib/server/agent-runtime/course-tools';

describe('generation media tools', () => {
  it('promotes session-scoped media bytes through the asset registry', async () => {
    const resolve = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      byteLength: 3,
    }));
    const put = vi.fn(async () => 'ast_course_media');
    const material = {
      id: 'mat_image',
      sessionId: 'session-a',
      kind: 'image',
      title: 'Image',
      sourceUrl: null,
      textAssetId: null,
      rawAssetId: 'ast_session_media',
      textChars: 0,
      derivedFrom: null,
      extraction: { status: 'done', attempts: 0 },
      createdAt: new Date(0).toISOString(),
    } satisfies AgentSessionMaterial;
    const tool = buildMaterialMediaTool({
      sessionId: 'session-a',
      getMaterial: vi.fn(async (sessionId) => (sessionId === 'session-a' ? material : null)),
      assetStore: { resolve, put } as unknown as AssetStore,
    });
    const response = await tool.execute('promote', { materialId: material.id } as never);
    expect(resolve).toHaveBeenCalledWith(
      { key: 'session-materials:session-a' },
      'ast_session_media',
    );
    expect(put).toHaveBeenCalledWith({ key: 'shared' }, expect.any(Blob), {
      contentType: 'image/png',
    });
    expect(response.details).toMatchObject({ src: 'ast_course_media', mimeType: 'image/png' });
  });

  it('renders only a page visible through the bound course store', async () => {
    const fetchPreview = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71])));
    const ownedStore = {
      loadDocument: vi.fn(async () => ({
        stage: { id: 'stage-a', name: 'Stage A' },
        scenes: [
          {
            id: 'scene-a',
            stageId: 'stage-a',
            order: 1,
            title: 'A',
            type: 'slide',
            content: { type: 'slide' },
            actions: [],
          },
        ],
      })),
    } as unknown as CourseStore;
    const [owned] = buildScenePreviewTools({
      store: ownedStore,
      renderService: { url: 'http://render.test' },
      fetchPreview: fetchPreview as typeof fetch,
    });
    const rendered = await owned!.execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(rendered.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });

    const foreignStore = { loadDocument: vi.fn(async () => null) } as unknown as CourseStore;
    const [foreign] = buildScenePreviewTools({
      store: foreignStore,
      renderService: { url: 'http://render.test' },
      fetchPreview: fetchPreview as typeof fetch,
    });
    const refused = await foreign!.execute('foreign', {
      stageId: 'stage-b',
      sceneId: 'scene-a',
    } as never);
    expect(refused).toMatchObject({ isError: true });
    expect(fetchPreview).toHaveBeenCalledTimes(1);
  });

  it('omits preview when the render service is not configured', () => {
    expect(
      buildScenePreviewTools({
        store: {} as CourseStore,
        renderService: { error: 'not_configured' },
      }),
    ).toEqual([]);
  });
});
