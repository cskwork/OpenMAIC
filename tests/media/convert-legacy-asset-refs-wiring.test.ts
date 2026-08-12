import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// Drives the converter through its production dependency graph: the real
// Dexie tables, the real browser asset pool, and the real media-proxy
// request shape -- not the injected in-memory maps. Only the network is
// stubbed.
describe('legacy conversion with production wiring', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('window', globalThis as unknown as Window);
    vi.stubGlobal('location', { origin: 'http://localhost' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('converts a dangling pair through the media proxy, the real pool, and real Dexie', async () => {
    const proxyCalls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        proxyCalls.push({ url: input, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(new Blob(['proxy-audio'], { type: 'audio/mpeg' }), { status: 200 });
      }),
    );
    const { db } = await import('@/lib/utils/database');
    const { convertDocumentAssetRefs } = await import('@/lib/media/convert-legacy-asset-refs');

    const legacyUrl = 'https://server.example.com/audio/real.mp3';
    const doc = {
      stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: { type: 'slide', canvas: { id: 'c1', elements: [] } },
          actions: [
            { id: 'a1', type: 'speech', text: 'Hi', audioId: 'tts_s0_a1', audioUrl: legacyUrl },
          ],
        },
      ],
    } as never;

    const result = await convertDocumentAssetRefs(doc);

    // The URL went through the same-origin proxy, not a direct fetch.
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]?.url).toBe('/api/proxy-media');
    expect(proxyCalls[0]?.body).toEqual({ url: legacyUrl });

    // The document was rewritten to a pool-backed id, the pool holds the
    // bytes, and the compatibility mirror carries both recovery keys.
    const action = result.document.scenes[0].actions?.[0] as unknown as Record<string, unknown>;
    const assetId = action.audioId as string;
    expect(assetId).toMatch(/^ast_/);
    expect(action.audioUrl).toBeUndefined();

    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();
    expect(await pool.exists?.(assetId as never)).toBe(true);

    const mirror = await db.audioFiles.get(assetId);
    expect(mirror?.originAudioId).toBe('tts_s0_a1');
    expect(mirror?.originAudioUrl).toBe(legacyUrl);
    expect(await mirror?.blob.text()).toBe('proxy-audio');

    // Second open is a no-op through the same wiring.
    const again = await convertDocumentAssetRefs(result.document);
    expect(again.changed).toBe(false);
    expect(proxyCalls).toHaveLength(1);
  });
});
