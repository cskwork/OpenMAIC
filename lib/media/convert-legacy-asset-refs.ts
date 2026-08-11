/**
 * Legacy asset-reference converter (#1007 part 2, step c).
 *
 * Pre-conversion documents reference generated media through context-relative
 * handles whose bytes live outside any storage abstraction: `gen_img_*` /
 * `gen_vid_*` slide placeholders (bytes in the Dexie `mediaFiles` table, keyed
 * `${stageId}:${ref}`), TTS-derived `audioId`s (bytes in Dexie `audioFiles`),
 * and server-classroom speech actions carrying a raw `audioUrl` beside the
 * `audioId`. This module rewrites a loaded document to the 0.2.0 reference
 * model: every legacy handle whose bytes are available is ingested into the
 * asset pool and replaced by the allocated asset id.
 *
 * Conversion rules, per reference:
 *
 * - Slide placeholder with a usable `mediaFiles` row (no error, non-empty
 *   blob): ingest the row's bytes, rewrite the reference. One logical ref
 *   allocates ONE asset no matter how many slots (or the video manifest) name
 *   it -- the row they shared was already one byte store.
 * - Speech `audioId` with an `audioFiles` row: ingest, rewrite, and mirror the
 *   row under the new id (Dexie stays a deliberate compatibility copy until
 *   Part 3 converges exporters onto the pool). A co-present `audioUrl`
 *   collapses into the same single asset: the pair names one narration.
 * - Co-present pair whose `audioId` is dangling (no pool entry, no Dexie row):
 *   the URL is the only live handle, so it is fetched and ingested; the
 *   `audioId` becomes the allocated id and the URL is dropped.
 * - An `audioUrl` that no longer resolves (a definitive HTTP refusal):
 *   converts to NO asset and an emptied reference -- a dead URL is never
 *   carried into the new format.
 * - Bytes unavailable (missing/failed Dexie row, transient fetch failure):
 *   the legacy references are kept UNTOUCHED rather than lost silently; the
 *   document converts on a later open once the bytes are back.
 *
 * Idempotent: a converted document holds pool-backed allocated ids, no
 * placeholders, and no `audioUrl`, so re-running is a no-op.
 *
 * The pure DSL migration ladder (`0.1.0 -> 0.2.0`) deliberately does none of
 * this: it cannot read local bytes or probe URLs. It covers only documents
 * this converter never reached.
 */

import type { AssetMeta, Slide } from '@openmaic/dsl';
import { createLogger } from '@/lib/logger';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { Action, SpeechAction } from '@/lib/types/action';
import type { AppScene, Stage } from '@/lib/types/stage';
import { makeScene } from '@/lib/types/stage';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';
import { isGeneratedMediaPlaceholder } from './media-ref';
import { slideMediaReferenceSlots } from './slide-media-slots';

const log = createLogger('LegacyAssetConversion');

/**
 * The removed-from-contract field as stored documents and server classroom
 * payloads still carry it. Only this converter (and the pure ladder, for
 * documents it never reaches) may still read it; every other consumer was
 * switched to the converted shape in the same delivery unit.
 */
type LegacySpeechAction = SpeechAction & { audioUrl?: string };

/**
 * Outcome of reaching for the bytes behind a legacy `audioUrl`. The fetch is
 * also the reachability probe: one GET answers both. `dead` is a definitive
 * refusal (HTTP 4xx -- the server asserts the bytes are gone); anything
 * transient (network error, 5xx, timeout) is `unavailable`, so a flaky
 * connection never empties a reference that a later open could still convert.
 */
export type LegacyUrlFetch =
  | { readonly kind: 'ok'; readonly blob: Blob }
  | { readonly kind: 'dead' }
  | { readonly kind: 'unavailable' };

export interface LegacyAssetConversionDeps {
  /** Ingest bytes into the asset pool; resolves to the allocated asset id. */
  putAsset(blob: Blob, meta: AssetMeta): Promise<string>;
  /** Whether the pool already holds an entry for a ref (an allocated id). */
  assetRefExists(ref: string): Promise<boolean>;
  /** Legacy generated-media row for a `${stageId}:${ref}` placeholder. */
  getMediaRecord(stageId: string, ref: string): Promise<MediaFileRecord | undefined>;
  /** Legacy TTS row for an `audioId`. */
  getAudioRecord(audioId: string): Promise<AudioFileRecord | undefined>;
  /** Write the post-conversion Dexie compatibility copy of an audio row. */
  putAudioRecord(record: AudioFileRecord): Promise<void>;
  /** Fetch (and thereby probe) a legacy `audioUrl`. */
  fetchLegacyUrl(url: string): Promise<LegacyUrlFetch>;
}

export interface LegacyAssetConversionReport {
  /** References rewritten to a freshly allocated asset id. */
  converted: number;
  /** References emptied because their only handle no longer resolves. */
  emptied: number;
  /** Legacy references left untouched because their bytes are unavailable. */
  kept: number;
}

export interface LegacyAssetConversionResult {
  document: AppDocument;
  /** False when nothing was rewritten -- the input is returned by identity. */
  changed: boolean;
  report: LegacyAssetConversionReport;
}

/** The default production wiring: Dexie legacy tables plus the app asset pool. */
async function defaultDeps(): Promise<LegacyAssetConversionDeps> {
  const [{ db, mediaFileKey }, { putAsset }, { assetRefExists }] = await Promise.all([
    import('@/lib/utils/database'),
    import('./asset-pool'),
    import('./use-asset-url'),
  ]);
  return {
    putAsset: (blob, meta) => putAsset(blob, meta),
    assetRefExists: (ref) => assetRefExists(ref),
    getMediaRecord: (stageId, ref) => db.mediaFiles.get(mediaFileKey(stageId, ref)),
    getAudioRecord: (audioId) => db.audioFiles.get(audioId),
    putAudioRecord: (record) => db.audioFiles.put(record).then(() => undefined),
    fetchLegacyUrl: async (url) => {
      try {
        const response = await fetch(url);
        if (response.ok) return { kind: 'ok', blob: await response.blob() };
        return { kind: response.status >= 400 && response.status < 500 ? 'dead' : 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

/** A media row is a usable byte source only when it holds real bytes. */
function usableMediaRecord(record: MediaFileRecord | undefined): record is MediaFileRecord {
  return !!record && !record.error && !!record.blob && record.blob.size > 0;
}

function mediaMeta(record: MediaFileRecord, blob: Blob): AssetMeta {
  let params: unknown;
  try {
    params = JSON.parse(record.params || '{}');
  } catch {
    params = {};
  }
  return {
    contentType: blob.type || record.mimeType,
    mediaType: record.type,
    prompt: record.prompt,
    params,
    origin: 'legacy-mediaFiles',
  };
}

function audioFormat(blob: Blob, record: AudioFileRecord | undefined, fallback = 'mp3'): string {
  if (record?.format) return record.format;
  const subtype = blob.type.split('/')[1];
  return subtype || fallback;
}

function audioMeta(
  blob: Blob,
  record: AudioFileRecord | undefined,
  action: LegacySpeechAction,
): AssetMeta {
  const voice = action.voice ?? record?.voice;
  return {
    contentType: blob.type || `audio/${audioFormat(blob, record)}`,
    mediaType: 'audio',
    text: action.text,
    ...(voice ? { voice } : {}),
    ...(record?.duration !== undefined ? { duration: record.duration } : {}),
    origin: record ? 'legacy-audioFiles' : 'legacy-audioUrl',
  };
}

type SlideLike = Pick<Slide, 'background' | 'elements'>;

/**
 * Convert every legacy media reference in a loaded document to an allocated
 * asset id. The input document is never mutated; the side effects are pool
 * ingests and Dexie compatibility mirror writes.
 *
 * Crash-safety ordering mirrors the generation write paths: pool bytes first,
 * the Dexie compatibility copy second, and the in-memory document rewrite
 * last, so a failure mid-conversion never leaves the persisted document
 * pointing at bytes that were never stored.
 */
export async function convertDocumentAssetRefs(
  document: AppDocument,
  deps?: LegacyAssetConversionDeps,
): Promise<LegacyAssetConversionResult> {
  const resolvedDeps = deps ?? (await defaultDeps());
  const stageId = document.stage.id;
  // One allocation per logical legacy ref, shared across every slot, manifest
  // key, and speech action that names it -- they already shared one byte
  // store. Null caches a negative lookup so an unusable row is read once.
  const allocationByRef = new Map<string, string | null>();
  const report: LegacyAssetConversionReport = { converted: 0, emptied: 0, kept: 0 };
  let changed = false;

  /** Allocate (once) for a placeholder with local bytes; null when unusable. */
  const allocateMediaRef = async (ref: string): Promise<string | null> => {
    if (allocationByRef.has(ref)) return allocationByRef.get(ref) ?? null;
    const record = await resolvedDeps.getMediaRecord(stageId, ref);
    if (!usableMediaRecord(record)) {
      allocationByRef.set(ref, null);
      report.kept += 1;
      return null;
    }
    const blob = record.blob.type
      ? record.blob
      : new Blob([record.blob], { type: record.mimeType });
    const assetId = await resolvedDeps.putAsset(blob, mediaMeta(record, blob));
    allocationByRef.set(ref, assetId);
    report.converted += 1;
    return assetId;
  };

  const convertSlide = async <T extends SlideLike>(slide: T): Promise<T> => {
    const slots = [...slideMediaReferenceSlots(slide)];
    const rewrites: Array<{ index: number; assetId: string }> = [];
    for (let index = 0; index < slots.length; index += 1) {
      const ref = slots[index].read();
      if (!isGeneratedMediaPlaceholder(ref)) continue;
      const assetId = await allocateMediaRef(ref);
      if (assetId) rewrites.push({ index, assetId });
    }
    if (rewrites.length === 0) return slide;
    // Rewrite on a clone so the caller's document is never mutated. Slot
    // iteration order is deterministic, so the clone's slots align by index.
    const clone = structuredClone(slide);
    const cloneSlots = [...slideMediaReferenceSlots(clone)];
    for (const { index, assetId } of rewrites) cloneSlots[index].write(assetId);
    changed = true;
    return clone;
  };

  const convertSpeechAction = async (action: Action): Promise<Action> => {
    if (action.type !== 'speech') return action;
    const speech = action as LegacySpeechAction;
    const audioId = speech.audioId || undefined;
    const audioUrl = speech.audioUrl || undefined;
    if (!audioId && !audioUrl) return action;

    if (audioId && (await resolvedDeps.assetRefExists(audioId))) {
      // Already converted (pool-backed). Only a stale co-present URL remains
      // to drop; the pair collapsed when the id was allocated.
      if (!audioUrl) return action;
      const next: LegacySpeechAction = { ...speech };
      delete next.audioUrl;
      changed = true;
      return next;
    }

    const record = audioId ? await resolvedDeps.getAudioRecord(audioId) : undefined;
    if (audioId && record?.blob && record.blob.size > 0) {
      // Several speech actions can share one derived id; they shared one
      // audioFiles row, so they collapse into one allocated asset.
      const cached = allocationByRef.get(audioId);
      const assetId =
        cached ??
        (await (async () => {
          const allocated = await resolvedDeps.putAsset(
            record.blob,
            audioMeta(record.blob, record, speech),
          );
          // Dexie stays a deliberate compatibility double-write until Part 3
          // converges exporters and import/export onto the pool; mirror the
          // row under the allocated id, keyed like the generation write path.
          await resolvedDeps.putAudioRecord({ ...record, id: allocated, stageId });
          allocationByRef.set(audioId, allocated);
          return allocated;
        })());
      const next: LegacySpeechAction = { ...speech, audioId: assetId };
      delete next.audioUrl;
      changed = true;
      report.converted += 1;
      return next;
    }

    if (audioUrl) {
      // The audioId is dangling (or absent): the URL is the only live handle.
      const fetched = await resolvedDeps.fetchLegacyUrl(audioUrl);
      if (fetched.kind === 'ok') {
        const assetId = await resolvedDeps.putAsset(
          fetched.blob,
          audioMeta(fetched.blob, undefined, speech),
        );
        await resolvedDeps.putAudioRecord({
          id: assetId,
          stageId,
          blob: fetched.blob,
          format: audioFormat(fetched.blob, undefined),
          text: speech.text,
          voice: speech.voice,
          createdAt: Date.now(),
        });
        const next: LegacySpeechAction = { ...speech, audioId: assetId };
        delete next.audioUrl;
        changed = true;
        report.converted += 1;
        return next;
      }
      if (fetched.kind === 'dead') {
        // A URL that no longer resolves converts to NO asset and an emptied
        // reference: a dead URL is never carried into the new format.
        const next: LegacySpeechAction = { ...speech };
        delete next.audioId;
        delete next.audioUrl;
        changed = true;
        report.emptied += 1;
        return next;
      }
      // Transient fetch failure: keep both legacy handles and retry on a
      // later open rather than losing the reference silently.
    }
    report.kept += 1;
    return action;
  };

  const stage = document.stage;
  let whiteboard = stage.whiteboard;
  if (whiteboard) {
    const converted = await Promise.all(whiteboard.map((slide) => convertSlide(slide)));
    if (converted.some((slide, index) => slide !== whiteboard![index])) {
      whiteboard = converted;
    }
  }

  const scenes: AppScene[] = [];
  for (const scene of document.scenes) {
    let nextScene = scene;
    if (scene.content.type === 'slide') {
      const canvas = await convertSlide(scene.content.canvas);
      if (canvas !== scene.content.canvas) {
        // Rebuild through makeScene so the discriminated union stays bound:
        // a plain spread cannot prove the canvas lands on the slide member.
        const { type: _type, content: _content, ...core } = nextScene;
        void _type;
        void _content;
        nextScene = makeScene(core, { ...scene.content, canvas });
      }
    }
    if (scene.whiteboards) {
      const converted = await Promise.all(scene.whiteboards.map((slide) => convertSlide(slide)));
      if (converted.some((slide, index) => slide !== scene.whiteboards![index])) {
        nextScene = { ...nextScene, whiteboards: converted };
      }
    }
    if (scene.actions) {
      const converted: Action[] = [];
      for (const action of scene.actions) converted.push(await convertSpeechAction(action));
      if (converted.some((action, index) => action !== scene.actions![index])) {
        nextScene = { ...nextScene, actions: converted };
      }
    }
    scenes.push(nextScene);
  }

  // The video manifest is keyed by the same media refs; re-key placeholder
  // entries whose bytes were (or can still be) ingested.
  let videoManifest = stage.videoManifest;
  if (videoManifest) {
    let manifestChanged = false;
    const nextManifest: typeof videoManifest = {};
    for (const [key, entry] of Object.entries(videoManifest)) {
      if (isGeneratedMediaPlaceholder(key)) {
        const assetId = await allocateMediaRef(key);
        if (assetId) {
          nextManifest[assetId] = entry;
          manifestChanged = true;
          continue;
        }
      }
      nextManifest[key] = entry;
    }
    if (manifestChanged) {
      videoManifest = nextManifest;
      changed = true;
    }
  }

  if (!changed) return { document, changed: false, report };

  const nextStage: Stage =
    whiteboard !== stage.whiteboard || videoManifest !== stage.videoManifest
      ? {
          ...stage,
          ...(whiteboard !== stage.whiteboard ? { whiteboard } : {}),
          ...(videoManifest !== stage.videoManifest ? { videoManifest } : {}),
        }
      : stage;

  log.info(
    `Converted legacy asset refs for ${stageId}: ${report.converted} converted, ` +
      `${report.emptied} emptied (dead URL), ${report.kept} kept (bytes unavailable)`,
  );
  return { document: { ...document, stage: nextStage, scenes }, changed: true, report };
}
