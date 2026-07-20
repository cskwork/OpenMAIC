import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the elementId → mediaRef bridge in the app-side compiler deps.
 *
 * A `play_video` action targets a slide element by its `.id` (e.g. `video_abc`),
 * but generated-media records are keyed by the element's media ref (`gen_vid_…`).
 * Without the bridge, `assets.media()` / `timing.videoDurationMs()` miss for every
 * generated video, which cascades to a dropped clip in the export (regression the
 * user reported as "视频元素丢失"). These tests mock Dexie (no Dexie-in-node
 * harness, per the repo pattern) and run the real factory.
 */
const mediaToArray = vi.fn();
const audioGet = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: { get: (...args: unknown[]) => audioGet(...args) },
    mediaFiles: {
      where: () => ({ equals: () => ({ toArray: () => mediaToArray() }) }),
    },
  },
}));

import { createVideoTimelineDeps } from '@/lib/video-export-app/timeline-deps';
import type { MediaFileRecord } from '@/lib/utils/database';
import type { Scene } from '@/lib/types/stage';
import type { PlayVideoAction } from '@openmaic/dsl';

const STAGE_ID = 'stage-1';
const MEDIA_REF = 'gen_vid_abc123';
const ELEMENT_ID = 'video_element_1';

/** A media record present via ossKey (no local bytes → no DOM probe in Node). */
function videoRecord(over: Partial<MediaFileRecord> = {}): MediaFileRecord {
  return {
    id: `${STAGE_ID}:${MEDIA_REF}`,
    stageId: STAGE_ID,
    type: 'video',
    blob: new Blob([], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    ossKey: 'https://cdn.example/v.mp4',
    size: 0,
    prompt: '',
    params: '',
    createdAt: 0,
    ...over,
  } as MediaFileRecord;
}

/** A slide scene whose element points at the media ref via `mediaRef`. */
function slideScene(el: Record<string, unknown>): Scene {
  return {
    id: 'scene-1',
    stageId: STAGE_ID,
    title: 'Scene',
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [el] } },
  } as unknown as Scene;
}

const playVideo = (elementId: string): PlayVideoAction =>
  ({ type: 'play_video', elementId }) as PlayVideoAction;

beforeEach(() => {
  mediaToArray.mockReset();
  audioGet.mockReset().mockImplementation(() => Promise.resolve(undefined));
});

describe('createVideoTimelineDeps — media ref bridge', () => {
  it('resolves a play_video element id to its media record via mediaRef', async () => {
    mediaToArray.mockResolvedValue([videoRecord()]);
    const scene = slideScene({ id: ELEMENT_ID, type: 'video', mediaRef: MEDIA_REF });

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    const meta = deps.assets.media(ELEMENT_ID, scene);

    expect(meta).not.toBeNull();
    expect(meta?.id).toBe(`${STAGE_ID}:${MEDIA_REF}`);
    expect(meta?.present).toBe(true);
    expect(meta?.format).toBe('mp4');
  });

  it('bridges a legacy placeholder `src` (gen_vid_…) when no explicit mediaRef', async () => {
    mediaToArray.mockResolvedValue([videoRecord()]);
    const scene = slideScene({ id: ELEMENT_ID, type: 'video', src: MEDIA_REF });

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    expect(deps.assets.media(ELEMENT_ID, scene)?.id).toBe(`${STAGE_ID}:${MEDIA_REF}`);
  });

  it('returns null for an element with no generated media', async () => {
    mediaToArray.mockResolvedValue([videoRecord()]);
    const scene = slideScene({ id: 'plain_text', type: 'text' });

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    expect(deps.assets.media('plain_text', scene)).toBeNull();
  });
});
