import { describe, expect, test, vi } from 'vitest';
import type { AssetMeta } from '@openmaic/dsl';

import {
  containsClassroomMediaUrls,
  convertDocumentAssetRefs,
  findLegacyMediaRecord,
  type LegacyAssetConversionDeps,
  type LegacyUrlFetch,
} from '@/lib/media/convert-legacy-asset-refs';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { Action } from '@/lib/types/action';
import type { AppScene, Stage } from '@/lib/types/stage';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let allocationCounter = 0;

function makeHarness() {
  const pool = new Map<string, { blob: Blob; meta: AssetMeta }>();
  const mediaRows = new Map<string, MediaFileRecord>();
  const audioRows = new Map<string, AudioFileRecord>();
  const urlFetches = new Map<string, LegacyUrlFetch>();

  const deps: LegacyAssetConversionDeps = {
    putAsset: async (blob, meta) => {
      const id = `ast_test_${(allocationCounter += 1)}`;
      pool.set(id, { blob, meta });
      return id;
    },
    assetRefExists: async (ref) => pool.has(ref),
    getMediaRecord: async (stageId, ref) => {
      // Mirrors the production lookup: a pool-backed mirror wins (it is the
      // retry's recovery handle), then the exact key, then any placeholderRef
      // match.
      const exact = mediaRows.get(`${stageId}:${ref}`);
      const mirror = [...mediaRows.values()].find(
        (row) =>
          row.stageId === stageId && row.placeholderRef === ref && row.id !== `${stageId}:${ref}`,
      );
      if (mirror) {
        const keyedRef = mirror.id.slice(stageId.length + 1);
        if (pool.has(keyedRef)) return mirror;
      }
      return exact ?? mirror;
    },
    getAudioRecord: async (audioId) => audioRows.get(audioId),
    putMediaRecord: async (stageId, ref, record) => {
      mediaRows.set(`${stageId}:${ref}`, { ...record, id: `${stageId}:${ref}`, stageId });
    },
    putAudioRecord: async (record) => {
      audioRows.set(record.id, record);
    },
    getMirroredAudioRecord: async (stageId, keys) =>
      [...audioRows.values()].find(
        (row) =>
          row.stageId === stageId &&
          ((keys.audioId !== undefined && row.originAudioId === keys.audioId) ||
            (keys.audioUrl !== undefined && row.originAudioUrl === keys.audioUrl)),
      ),
    removeAsset: async (ref) => {
      pool.delete(ref);
    },
    fetchLegacyUrl: async (url) => urlFetches.get(url) ?? { kind: 'unavailable' },
  };

  return { pool, mediaRows, audioRows, urlFetches, deps };
}

function mediaRecord(partial: Partial<MediaFileRecord> = {}): MediaFileRecord {
  return {
    id: 'unused',
    stageId: 'stage-1',
    type: 'image',
    blob: new Blob(['image-bytes'], { type: 'image/png' }),
    mimeType: 'image/png',
    size: 11,
    prompt: 'a prompt',
    params: '{"aspectRatio":"16:9"}',
    createdAt: 1,
    ...partial,
  };
}

function audioRecord(partial: Partial<AudioFileRecord> = {}): AudioFileRecord {
  return {
    id: 'unused',
    stageId: 'stage-1',
    blob: new Blob(['audio-bytes'], { type: 'audio/mpeg' }),
    duration: 2.5,
    format: 'mp3',
    text: 'narration',
    createdAt: 1,
    ...partial,
  };
}

function stage(partial: Partial<Stage> = {}): Stage {
  return { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2, ...partial };
}

function slideScene(actions: Action[] = [], elements: unknown[] = []): AppScene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene',
    order: 0,
    content: { type: 'slide', canvas: { id: 'canvas-1', elements } },
    actions,
    createdAt: 1,
    updatedAt: 2,
  } as AppScene;
}

function document(partial: Partial<AppDocument> = {}): AppDocument {
  return { stage: stage(), scenes: [], ...partial };
}

function speech(extra: Record<string, unknown>): Action {
  return { id: 'a1', type: 'speech', text: 'Hello', ...extra } as Action;
}

// ---------------------------------------------------------------------------
// Slide placeholder conversion
// ---------------------------------------------------------------------------

describe('slide placeholder conversion', () => {
  test('placeholder with local bytes is rewritten to an allocated asset id', async () => {
    const { mediaRows, pool, deps } = makeHarness();
    mediaRows.set('stage-1:gen_img_1', mediaRecord());
    const doc = document({
      scenes: [slideScene([], [{ id: 'el1', type: 'image', src: 'gen_img_1' }])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(result.changed).toBe(true);
    const canvas = (
      result.document.scenes[0].content as { canvas: { elements: { src: string }[] } }
    ).canvas;
    const newSrc = canvas.elements[0].src;
    expect(newSrc).toMatch(/^ast_test_/);
    expect(pool.has(newSrc)).toBe(true);
    expect(pool.get(newSrc)?.meta).toMatchObject({
      contentType: 'image/png',
      mediaType: 'image',
      prompt: 'a prompt',
    });
    // The input document is never mutated.
    expect(
      (doc.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas.elements[0].src,
    ).toBe('gen_img_1');
  });

  test('one logical ref allocates one asset across slots, whiteboards, and the manifest', async () => {
    const { mediaRows, pool, deps } = makeHarness();
    mediaRows.set(
      'stage-1:gen_vid_1',
      mediaRecord({ type: 'video', mimeType: 'video/mp4', blob: new Blob(['vid']) }),
    );
    const video = { id: 'v1', type: 'video', src: 'gen_vid_1', mediaRef: 'gen_vid_1' };
    const doc = document({
      stage: stage({
        whiteboard: [
          { id: 'wb', elements: [{ id: 'el2', type: 'image', src: 'gen_vid_1' }] },
        ] as Stage['whiteboard'],
        videoManifest: { gen_vid_1: { prompt: 'p' } } as unknown as Stage['videoManifest'],
      }),
      scenes: [slideScene([], [video])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    const canvas = (
      result.document.scenes[0].content as {
        canvas: { elements: { src: string; mediaRef: string }[] };
      }
    ).canvas;
    expect(canvas.elements[0].src).toBe(assetId);
    expect(canvas.elements[0].mediaRef).toBe(assetId);
    expect(result.document.stage.whiteboard?.[0].elements[0]).toMatchObject({ src: assetId });
    expect(Object.keys(result.document.stage.videoManifest ?? {})).toEqual([assetId]);
    expect(result.report.converted).toBe(1);
  });

  test('concurrent slides naming one ref share a single in-flight allocation', async () => {
    // Whiteboard slides convert under Promise.all: a slow byte source must not
    // let two slides each allocate their own asset for the same placeholder.
    const { mediaRows, pool, deps } = makeHarness();
    mediaRows.set('stage-1:gen_img_1', mediaRecord());
    const slowGet: LegacyAssetConversionDeps['getMediaRecord'] = async (stageId, ref) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return mediaRows.get(`${stageId}:${ref}`);
    };
    const doc = document({
      stage: stage({
        whiteboard: [
          { id: 'wb1', elements: [{ id: 'el1', type: 'image', src: 'gen_img_1' }] },
          { id: 'wb2', elements: [{ id: 'el2', type: 'image', src: 'gen_img_1' }] },
          { id: 'wb3', elements: [{ id: 'el3', type: 'image', src: 'gen_img_1' }] },
        ] as Stage['whiteboard'],
      }),
    });

    const result = await convertDocumentAssetRefs(doc, { ...deps, getMediaRecord: slowGet });

    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    for (const slide of result.document.stage.whiteboard ?? []) {
      expect(slide.elements[0]).toMatchObject({ src: assetId });
    }
  });

  test('converted media mirrors its Dexie row under the allocated id', async () => {
    // collectMediaFiles derives export references from row keys: without the
    // mirror, an exported manifest would name media the ZIP only knows by
    // the old placeholder, and the round-trip loses it.
    const { mediaRows, pool, deps } = makeHarness();
    mediaRows.set('stage-1:gen_img_1', mediaRecord());
    const doc = document({
      scenes: [slideScene([], [{ id: 'el1', type: 'image', src: 'gen_img_1' }])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    const [assetId] = [...pool.keys()];
    const mirror = mediaRows.get(`stage-1:${assetId}`);
    expect(mirror).toBeDefined();
    expect(mirror?.placeholderRef).toBe('gen_img_1');
    expect(await mirror?.blob.text()).toBe('image-bytes');
    // The original row stays: stage deletion still reclaims by the legacy key.
    expect(mediaRows.get('stage-1:gen_img_1')).toBeDefined();
    expect(result.changed).toBe(true);
  });

  test('a retried conversion reuses the mirrored allocation instead of orphaning a twin', async () => {
    // Simulates a previous run that allocated and mirrored but never saved
    // the document: the retry finds the mirror and rewrites to the same id.
    const { mediaRows, pool, deps } = makeHarness();
    const priorId = 'ast_pool_prior';
    pool.set(priorId, { blob: new Blob(['image-bytes']), meta: {} });
    mediaRows.set(
      `stage-1:${priorId}`,
      mediaRecord({ id: `stage-1:${priorId}`, placeholderRef: 'gen_img_1' }),
    );
    // The legacy row is gone (re-keyed), so the exact key misses.
    const doc = document({
      scenes: [slideScene([], [{ id: 'el1', type: 'image', src: 'gen_img_1' }])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(pool.size).toBe(1);
    const canvas = (
      result.document.scenes[0].content as { canvas: { elements: { src: string }[] } }
    ).canvas;
    expect(canvas.elements[0].src).toBe(priorId);
  });

  test('speech actions sharing one dangling pair fetch and allocate once', async () => {
    const { audioRows, pool, urlFetches, deps } = makeHarness();
    const url = 'https://server.example.com/audio/shared.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['shared-audio'], { type: 'audio/mpeg' }) });
    const first = speech({ id: 'a1', audioId: 'tts_s0_a1', audioUrl: url });
    const second = speech({ id: 'a2', audioId: 'tts_s0_a1', audioUrl: url });
    const doc = document({ scenes: [slideScene([first, second])] });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    const actions = result.document.scenes[0].actions as unknown as Array<Record<string, unknown>>;
    expect(actions[0]?.audioId).toBe(assetId);
    expect(actions[1]?.audioId).toBe(assetId);
    expect(audioRows.get(assetId)?.originAudioId).toBe('tts_s0_a1');
  });

  test('the URL is dropped after conversion even though the pool is server-backed', async () => {
    // The dev authenticator now issues one shared asset principal, so a
    // server-backed pool resolves the same ids for every browser: retaining
    // the URL as cross-browser recovery data is no longer needed, and a
    // retained URL can persist stale or deployment-specific addresses.
    const { pool, urlFetches, deps } = makeHarness();
    const url = 'https://server.example.com/audio/retained.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['retained-audio'], { type: 'audio/mpeg' }) });
    const doc = document({
      scenes: [slideScene([speech({ id: 'a1', audioId: 'tts_s0_a1', audioUrl: url })])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions?.[0] as unknown as Record<string, unknown>;
    const [assetId] = [...pool.keys()];
    expect(action.audioId).toBe(assetId);
    expect(action.audioUrl).toBeUndefined();
  });

  test('an allocation-shaped id absent from the pool falls through to the URL as the live handle', async () => {
    // An imported or cross-browser document can name an id this pool never
    // minted. The id must not be trusted as converted on shape alone: the
    // co-present URL is the only live handle, so it is fetched and allocated,
    // and the dangling id is replaced.
    const { pool, urlFetches, deps } = makeHarness();
    const url = 'https://server.example.com/audio/foreign.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['foreign-audio'], { type: 'audio/mpeg' }) });
    const assetRefExists = vi.fn(deps.assetRefExists);
    const doc = document({
      scenes: [slideScene([speech({ audioId: 'ast_foreign', audioUrl: url })])],
    });

    const result = await convertDocumentAssetRefs(doc, { ...deps, assetRefExists });

    // The allocated-shaped id was probed, not trusted.
    expect(assetRefExists).toHaveBeenCalledWith('ast_foreign');
    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action.audioId).toMatch(/^ast_test_/);
    expect(action.audioId).not.toBe('ast_foreign');
    expect(action).not.toHaveProperty('audioUrl');
    const [assetId] = [...pool.keys()];
    expect(await pool.get(assetId)?.blob.text()).toBe('foreign-audio');
  });

  test('one probe per id per pass, shared across actions naming it', async () => {
    const { pool, urlFetches, deps } = makeHarness();
    const url = 'https://server.example.com/audio/shared-probe.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['x'], { type: 'audio/mpeg' }) });
    const assetRefExists = vi.fn(deps.assetRefExists);
    const doc = document({
      scenes: [
        slideScene([
          speech({ id: 'a1', audioId: 'tts_shared', audioUrl: url }),
          speech({ id: 'a2', audioId: 'tts_shared', audioUrl: url }),
        ]),
      ],
    });

    const result = await convertDocumentAssetRefs(doc, { ...deps, assetRefExists });

    expect(assetRefExists).toHaveBeenCalledTimes(1);
    expect(assetRefExists).toHaveBeenCalledWith('tts_shared');
    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    const actions = result.document.scenes[0].actions as unknown as Array<Record<string, unknown>>;
    expect(actions[0]?.audioId).toBe(assetId);
    expect(actions[1]?.audioId).toBe(assetId);
  });

  test('an allocation-shaped id absent from the pool with no URL is left untouched', async () => {
    // No co-present URL means no live handle is at stake, so the allocation
    // shape is trusted without a probe and the action reads as already
    // converted: it returns by identity and counts as neither converted nor
    // kept-for-retry.
    const { pool, deps } = makeHarness();
    const doc = document({ scenes: [slideScene([speech({ audioId: 'ast_foreign' })])] });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(result.changed).toBe(false);
    expect((result.document.scenes[0].actions![0] as { audioId?: string }).audioId).toBe(
      'ast_foreign',
    );
    expect(pool.size).toBe(0);
    expect(result.report.kept).toBe(0);
  });

  test('speech conversion spans scenes through one pool, preserving order', async () => {
    const { pool, urlFetches, deps } = makeHarness();
    const url = 'https://server.example.com/audio/across.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['across-audio'], { type: 'audio/mpeg' }) });
    const sceneA = {
      ...slideScene([speech({ id: 'a1', audioUrl: url })]),
      id: 'scene-a',
      order: 0,
    };
    const sceneB = {
      ...slideScene([speech({ id: 'b1', audioUrl: url }), speech({ id: 'b2', text: 'Other' })]),
      id: 'scene-b',
      order: 1,
    };
    const doc = document({ scenes: [sceneA, sceneB] });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    expect(result.document.scenes).toHaveLength(2);
    expect(result.document.scenes[0].id).toBe('scene-a');
    expect(result.document.scenes[1].id).toBe('scene-b');
    const actionsA = result.document.scenes[0].actions as unknown as Array<Record<string, unknown>>;
    const actionsB = result.document.scenes[1].actions as unknown as Array<Record<string, unknown>>;
    expect(actionsA[0]?.audioId).toBe(assetId);
    expect(actionsB[0]?.audioId).toBe(assetId);
    expect(actionsB[1]).not.toHaveProperty('audioId');
  });

  test('background image placeholders convert like element refs', async () => {
    const { mediaRows, pool, deps } = makeHarness();
    mediaRows.set('stage-1:gen_img_bg', mediaRecord());
    const scene = slideScene();
    (scene.content as { canvas: { background?: unknown } }).canvas.background = {
      type: 'image',
      image: { src: 'gen_img_bg' },
    };
    const result = await convertDocumentAssetRefs(document({ scenes: [scene] }), deps);
    const background = (
      result.document.scenes[0].content as {
        canvas: { background: { image: { src: string } } };
      }
    ).canvas.background;
    expect([...pool.keys()]).toContain(background.image.src);
  });

  test('placeholder with missing bytes keeps the legacy reference untouched', async () => {
    const { deps } = makeHarness();
    const doc = document({
      scenes: [slideScene([], [{ id: 'el1', type: 'image', src: 'gen_img_gone' }])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(
      (result.document.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas
        .elements[0].src,
    ).toBe('gen_img_gone');
    expect(result.report.kept).toBe(1);
  });

  test('failed media rows (persisted generation errors) are not ingested', async () => {
    const { mediaRows, pool, deps } = makeHarness();
    mediaRows.set(
      'stage-1:gen_img_1',
      mediaRecord({ error: 'CONTENT_SENSITIVE', blob: new Blob() }),
    );
    const doc = document({
      scenes: [slideScene([], [{ id: 'el1', type: 'image', src: 'gen_img_1' }])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(result.changed).toBe(false);
    expect(pool.size).toBe(0);
    expect(result.report.kept).toBe(1);
  });

  test('concrete URLs and already-allocated ids are never touched', async () => {
    const { pool, deps } = makeHarness();
    const doc = document({
      scenes: [
        slideScene(
          [],
          [
            { id: 'el1', type: 'image', src: 'https://cdn.example.com/x.png' },
            { id: 'el2', type: 'image', src: 'ast_preexisting' },
          ],
        ),
      ],
    });
    const result = await convertDocumentAssetRefs(doc, deps);
    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(pool.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Speech reference conversion
// ---------------------------------------------------------------------------

describe('speech reference conversion', () => {
  test('audioId with local Dexie bytes converts and mirrors the compatibility row', async () => {
    const { audioRows, pool, deps } = makeHarness();
    audioRows.set('tts_s0_a1', audioRecord({ id: 'tts_s0_a1' }));
    const doc = document({ scenes: [slideScene([speech({ audioId: 'tts_s0_a1' })])] });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions![0] as { audioId?: string };
    expect(action.audioId).toMatch(/^ast_test_/);
    expect(pool.has(action.audioId!)).toBe(true);
    // The compatibility mirror is keyed by the allocated id, like the
    // generation write path's double-write.
    const mirror = audioRows.get(action.audioId!);
    expect(mirror).toBeDefined();
    expect(mirror?.stageId).toBe('stage-1');
    expect(mirror?.format).toBe('mp3');
    // The legacy row is left in place (orphan cleanup is stage deletion's job).
    expect(audioRows.has('tts_s0_a1')).toBe(true);
  });

  test('co-present pair collapses to one asset from local bytes; the URL is dropped unfetched', async () => {
    const { audioRows, urlFetches, pool, deps } = makeHarness();
    audioRows.set('tts_s0_a1', audioRecord({ id: 'tts_s0_a1' }));
    const url = 'https://server.example.com/api/classroom-media/c1/audio/tts_s0_a1.mp3';
    // No fetch fixture registered: any fetch would surface as `unavailable`.
    const doc = document({
      scenes: [slideScene([speech({ audioId: 'tts_s0_a1', audioUrl: url })])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action.audioId).toMatch(/^ast_test_/);
    expect(action).not.toHaveProperty('audioUrl');
    expect(pool.size).toBe(1);
    expect(urlFetches.size).toBe(0);
  });

  test('dangling audioId with a live URL ingests the fetched bytes', async () => {
    const { urlFetches, audioRows, pool, deps } = makeHarness();
    const url = 'https://server.example.com/audio/a1.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['remote-audio'], { type: 'audio/mpeg' }) });
    const doc = document({
      scenes: [slideScene([speech({ audioId: 'tts_s0_a1', audioUrl: url })])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action.audioId).toMatch(/^ast_test_/);
    expect(action).not.toHaveProperty('audioUrl');
    const pooled = pool.get(action.audioId as string);
    expect(await pooled?.blob.text()).toBe('remote-audio');
    expect(audioRows.get(action.audioId as string)?.blob).toBe(pooled?.blob);
  });

  test('dead URL converts to no asset and an emptied reference', async () => {
    const { urlFetches, pool, deps } = makeHarness();
    const url = 'https://server.example.com/audio/gone.mp3';
    urlFetches.set(url, { kind: 'dead' });
    const doc = document({
      scenes: [slideScene([speech({ audioId: 'tts_s0_a1', audioUrl: url })])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action).not.toHaveProperty('audioId');
    expect(action).not.toHaveProperty('audioUrl');
    expect(action.text).toBe('Hello');
    expect(pool.size).toBe(0);
    expect(result.report.emptied).toBe(1);
  });

  test('audioUrl-only reference converts from the fetched bytes', async () => {
    const { urlFetches, pool, deps } = makeHarness();
    const url = 'https://server.example.com/audio/only.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['x'], { type: 'audio/mpeg' }) });
    const doc = document({ scenes: [slideScene([speech({ audioUrl: url })])] });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action.audioId).toMatch(/^ast_test_/);
    expect(action).not.toHaveProperty('audioUrl');
    expect(pool.size).toBe(1);
  });

  test('dead audioUrl-only reference is dropped, leaving the reference unset', async () => {
    const { urlFetches, deps } = makeHarness();
    const url = 'https://server.example.com/audio/dead.mp3';
    urlFetches.set(url, { kind: 'dead' });
    const doc = document({ scenes: [slideScene([speech({ audioUrl: url })])] });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action).not.toHaveProperty('audioId');
    expect(action).not.toHaveProperty('audioUrl');
    expect(result.report.emptied).toBe(1);
  });

  test('transient fetch failure keeps both legacy handles untouched', async () => {
    const { deps } = makeHarness();
    const url = 'https://server.example.com/audio/flaky.mp3';
    // No fixture: the harness answers `unavailable` (network error / 5xx).
    const doc = document({
      scenes: [slideScene([speech({ audioId: 'tts_s0_a1', audioUrl: url })])],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(result.changed).toBe(false);
    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action.audioId).toBe('tts_s0_a1');
    expect(action.audioUrl).toBe(url);
    expect(result.report.kept).toBe(1);
  });

  test('audioId with no bytes anywhere keeps the legacy reference untouched', async () => {
    const { deps } = makeHarness();
    const doc = document({ scenes: [slideScene([speech({ audioId: 'tts_s0_missing' })])] });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(result.changed).toBe(false);
    expect((result.document.scenes[0].actions![0] as { audioId?: string }).audioId).toBe(
      'tts_s0_missing',
    );
    expect(result.report.kept).toBe(1);
  });

  test('pool-backed audioId with a stale co-present URL drops only the URL', async () => {
    const { pool, deps } = makeHarness();
    pool.set('ast_allocated', {
      blob: new Blob(['a']),
      meta: { contentType: 'audio/mpeg' },
    });
    const doc = document({
      scenes: [
        slideScene([
          speech({ audioId: 'ast_allocated', audioUrl: 'https://example.com/stale.mp3' }),
        ]),
      ],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action.audioId).toBe('ast_allocated');
    expect(action).not.toHaveProperty('audioUrl');
    expect(pool.size).toBe(1);
    expect(result.report.converted).toBe(0);
  });

  test('a converted document that retained its URL under the old server-backed mode is cleaned on next open', async () => {
    // Documents converted before the shared asset principal kept the URL as
    // inert recovery data. The same confirmed-resolvable rule cleans them up:
    // the id probes pool-backed, so the stale URL is dropped and the rewrite
    // persists on the next save.
    const { pool, deps } = makeHarness();
    pool.set('ast_prior', {
      blob: new Blob(['prior'], { type: 'audio/mpeg' }),
      meta: { contentType: 'audio/mpeg' },
    });
    const doc = document({
      scenes: [
        slideScene([
          speech({
            audioId: 'ast_prior',
            audioUrl: 'https://server.example.com/audio/retained-from-old-mode.mp3',
          }),
        ]),
      ],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    expect(result.changed).toBe(true);
    const action = result.document.scenes[0].actions![0] as unknown as Record<string, unknown>;
    expect(action.audioId).toBe('ast_prior');
    expect(action).not.toHaveProperty('audioUrl');
  });

  test("actions sharing an id but carrying different urls do not reuse each other's fetch outcome", async () => {
    // The dangling-pair cache must key on the (id, url) pair: two actions
    // sharing an id with different urls are different logical references. A
    // dead outcome for one url must not propagate to the other's live url,
    // and one url's bytes must never be stamped onto the other's reference.
    const { pool, urlFetches, deps } = makeHarness();
    const deadUrl = 'https://server.example.com/audio/dead-for-id.mp3';
    const liveUrl = 'https://server.example.com/audio/live-for-id.mp3';
    urlFetches.set(deadUrl, { kind: 'dead' });
    urlFetches.set(liveUrl, { kind: 'ok', blob: new Blob(['live-bytes'], { type: 'audio/mpeg' }) });
    const doc = document({
      scenes: [
        slideScene([
          speech({ id: 'a1', audioId: 'tts_shared_id', audioUrl: deadUrl }),
          speech({ id: 'a2', audioId: 'tts_shared_id', audioUrl: liveUrl }),
        ]),
      ],
    });

    const result = await convertDocumentAssetRefs(doc, deps);

    const actions = result.document.scenes[0].actions as unknown as Array<Record<string, unknown>>;
    // The dead pair is emptied...
    expect(actions[0]).not.toHaveProperty('audioId');
    expect(actions[0]).not.toHaveProperty('audioUrl');
    // ...while the live pair converts from its own bytes.
    expect(actions[1]?.audioId).toMatch(/^ast_test_/);
    expect(actions[1]).not.toHaveProperty('audioUrl');
    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    expect(await pool.get(assetId)?.blob.text()).toBe('live-bytes');
    expect(result.report.emptied).toBe(1);
  });

  test('idempotency: re-running on a converted document is a no-op', async () => {
    const { mediaRows, audioRows, urlFetches, pool, deps } = makeHarness();
    mediaRows.set('stage-1:gen_img_1', mediaRecord());
    audioRows.set('tts_s0_a1', audioRecord({ id: 'tts_s0_a1' }));
    const url = 'https://server.example.com/audio/a2.mp3';
    urlFetches.set(url, { kind: 'ok', blob: new Blob(['remote']) });
    const doc = document({
      scenes: [
        slideScene(
          [
            speech({ audioId: 'tts_s0_a1' }),
            { ...speech({ audioId: 'tts_s0_a2', audioUrl: url }), id: 'a2' } as Action,
          ],
          [{ id: 'el1', type: 'image', src: 'gen_img_1' }],
        ),
      ],
    });

    const once = await convertDocumentAssetRefs(doc, deps);
    expect(once.changed).toBe(true);
    const allocationsAfterFirst = pool.size;
    const twice = await convertDocumentAssetRefs(once.document, deps);

    expect(twice.changed).toBe(false);
    expect(twice.document).toBe(once.document);
    expect(pool.size).toBe(allocationsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// URL probe budget (ossKey fetches included)
// ---------------------------------------------------------------------------

describe('URL probe budget', () => {
  test('media ossKey recovery fetches stop when the aggregate budget is exhausted', async () => {
    // An evicted media row (empty blob, live ossKey) is a CDN byte source; its
    // fetch must obey the same aggregate deadline as the other probes, or a
    // document full of stalled CDN fetches could exceed the advertised budget.
    vi.useFakeTimers();
    try {
      const { mediaRows, urlFetches, deps } = makeHarness();
      mediaRows.set(
        'stage-1:gen_img_1',
        mediaRecord({ blob: new Blob([]), ossKey: 'https://cdn.example.com/gen_img_1.png' }),
      );
      let releaseGet!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      const slowGet: LegacyAssetConversionDeps['getMediaRecord'] = async (stageId, ref) => {
        await gate;
        return mediaRows.get(`${stageId}:${ref}`);
      };
      const doc = document({
        scenes: [slideScene([], [{ id: 'el1', type: 'image', src: 'gen_img_1' }])],
      });

      const pending = convertDocumentAssetRefs(doc, { ...deps, getMediaRecord: slowGet });
      // Exhaust the 60-second budget while the record read is still pending.
      vi.advanceTimersByTime(61_000);
      releaseGet();
      const result = await pending;

      expect(result.changed).toBe(false);
      expect(result.report.kept).toBe(1);
      // The ossKey was never fetched once the budget was gone.
      expect(urlFetches.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('audio ossKey recovery fetches stop when the aggregate budget is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const { audioRows, urlFetches, deps } = makeHarness();
      audioRows.set(
        'tts_s0_a1',
        audioRecord({
          id: 'tts_s0_a1',
          blob: new Blob([]),
          ossKey: 'https://cdn.example.com/a.mp3',
        }),
      );
      const doc = document({ scenes: [slideScene([speech({ audioId: 'tts_s0_a1' })])] });

      const pending = convertDocumentAssetRefs(doc, deps);
      vi.advanceTimersByTime(61_000);
      const result = await pending;

      expect(result.changed).toBe(false);
      expect(result.report.kept).toBe(1);
      expect(urlFetches.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Transport-URL completeness guard
// ---------------------------------------------------------------------------

describe('containsClassroomMediaUrls', () => {
  test('speech actions carrying a raw audioUrl trip the guard', async () => {
    // Audio conversion can fail while image/video conversion succeeds; a raw
    // speech transport URL must not pass the completeness check and be saved.
    const doc = document({
      scenes: [
        slideScene([
          speech({ audioId: 'tts_s0_a1', audioUrl: '/api/classroom-media/c1/audio/a1.mp3' }),
        ]),
      ],
    });

    expect(containsClassroomMediaUrls(doc)).toBe(true);
  });

  test('any unconverted speech audioUrl trips the guard, not just classroom-shaped ones', async () => {
    // The converter rewrites speech audioUrl regardless of shape, so a
    // remaining one of any kind means audio conversion did not complete.
    const doc = document({
      scenes: [
        slideScene([
          speech({ audioId: 'tts_s0_a1', audioUrl: 'https://cdn.example.com/narration.mp3' }),
        ]),
      ],
    });

    expect(containsClassroomMediaUrls(doc)).toBe(true);
  });

  test('a converted document with no speech URLs passes the guard', async () => {
    const doc = document({
      scenes: [slideScene([speech({ audioId: 'ast_resolved' })])],
    });

    expect(containsClassroomMediaUrls(doc)).toBe(false);
  });

  test('slide, whiteboard, and video-manifest transport URLs still trip the guard', async () => {
    const manifestOnly = document({
      stage: stage({
        videoManifest: {
          '/api/classroom-media/c1/videos/v.mp4': { prompt: 'p' },
        } as unknown as Stage['videoManifest'],
      }),
    });
    expect(containsClassroomMediaUrls(manifestOnly)).toBe(true);

    const whiteboardOnly = document({
      stage: stage({
        whiteboard: [
          {
            id: 'wb',
            elements: [{ id: 'el', type: 'image', src: '/api/classroom-media/c1/i.png' }],
          },
        ] as Stage['whiteboard'],
      }),
    });
    expect(containsClassroomMediaUrls(whiteboardOnly)).toBe(true);

    const sceneWhiteboard = slideScene();
    sceneWhiteboard.whiteboards = [
      { id: 'wb', elements: [{ id: 'el', type: 'image', src: '/api/classroom-media/c1/i.png' }] },
    ] as never;
    expect(containsClassroomMediaUrls(document({ scenes: [sceneWhiteboard] }))).toBe(true);
  });
});

describe('findLegacyMediaRecord', () => {
  const keyOf = (stageId: string, ref: string) => `${stageId}:${ref}`;
  const nothingInPool = async () => false;
  const pooled = (refs: string[]) => async (ref: string) => refs.includes(ref);

  function fakeTable(rows: MediaFileRecord[]) {
    return {
      get: async (key: string) => rows.find((row) => row.id === key),
      where: (_field: 'stageId') => ({
        equals: (stageId: string) => ({
          and: (pred: (row: MediaFileRecord) => boolean) => ({
            first: async () => rows.find((row) => row.stageId === stageId && pred(row)),
          }),
        }),
      }),
    };
  }

  test('a pool-backed mirror wins over the exact row: it is the retry recovery handle', async () => {
    // A previous run allocated and mirrored but never saved the document;
    // preferring the exact row would allocate a twin of the mirror.
    const exact = mediaRecord({ id: 'stage-1:gen_img_1' });
    const rekeyed = mediaRecord({ id: 'stage-1:ast_pool_1', placeholderRef: 'gen_img_1' });
    const db = { mediaFiles: fakeTable([exact, rekeyed]) };

    const found = await findLegacyMediaRecord(
      db,
      keyOf,
      'stage-1',
      'gen_img_1',
      pooled(['ast_pool_1']),
    );

    expect(found).toBe(rekeyed);
  });

  test('exact key wins when the mirror is not pool-backed', async () => {
    const exact = mediaRecord({ id: 'stage-1:gen_img_1' });
    const rekeyed = mediaRecord({ id: 'stage-1:ast_pool_1', placeholderRef: 'gen_img_1' });
    const db = { mediaFiles: fakeTable([exact, rekeyed]) };

    const found = await findLegacyMediaRecord(db, keyOf, 'stage-1', 'gen_img_1', nothingInPool);

    expect(found).toBe(exact);
  });

  test('a re-keyed row is found through its retained placeholderRef', async () => {
    // The recovery flow re-keys rows to the allocated id but keeps the gen_*
    // reference; a document not yet converted still names the placeholder.
    const rekeyed = mediaRecord({ id: 'stage-1:ast_pool_1', placeholderRef: 'gen_img_1' });
    const db = { mediaFiles: fakeTable([rekeyed]) };

    const found = await findLegacyMediaRecord(db, keyOf, 'stage-1', 'gen_img_1', nothingInPool);

    expect(found).toBe(rekeyed);
  });

  test("another stage's retained placeholder does not leak across", async () => {
    const foreign = mediaRecord({
      id: 'stage-2:ast_pool_1',
      stageId: 'stage-2',
      placeholderRef: 'gen_img_1',
    });
    const db = { mediaFiles: fakeTable([foreign]) };

    await expect(
      findLegacyMediaRecord(db, keyOf, 'stage-1', 'gen_img_1', nothingInPool),
    ).resolves.toBeUndefined();
  });
});
