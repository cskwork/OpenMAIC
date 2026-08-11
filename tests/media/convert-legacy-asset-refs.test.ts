import { describe, expect, test } from 'vitest';
import type { AssetMeta } from '@openmaic/dsl';

import {
  convertDocumentAssetRefs,
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
    getMediaRecord: async (stageId, ref) => mediaRows.get(`${stageId}:${ref}`),
    getAudioRecord: async (audioId) => audioRows.get(audioId),
    putAudioRecord: async (record) => {
      audioRows.set(record.id, record);
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
