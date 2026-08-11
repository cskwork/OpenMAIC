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
export type { LegacySpeechAction };

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
  /**
   * Write the post-conversion Dexie compatibility copy of a media row, keyed
   * by the ref the document now names. Without it the export/import
   * round-trip breaks: collectMediaFiles derives ZIP references from row
   * keys, so a converted document would point at media the export only knows
   * by the old placeholder. Same double-write discipline as the audio path.
   */
  putMediaRecord(stageId: string, ref: string, record: MediaFileRecord): Promise<void>;
  /** Write the post-conversion Dexie compatibility copy of an audio row. */
  putAudioRecord(record: AudioFileRecord): Promise<void>;
  /**
   * The compatibility row a previous (possibly partial) conversion mirrored
   * for this legacy audio id, if any. This is what makes a retry idempotent:
   * without it, a conversion that failed after allocating would allocate a
   * fresh twin on every retry.
   */
  getMirroredAudioRecord(stageId: string, legacyId: string): Promise<AudioFileRecord | undefined>;
  /**
   * Remove an allocation nothing references anymore -- the compensation when
   * a compatibility write fails after the allocation succeeded, so a failed
   * conversion does not strand entries (and their quota) in the pool.
   */
  removeAsset(ref: string): Promise<void>;
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

/**
 * Locate a legacy media row by exact key first, then by a retained
 * `placeholderRef`. Rows re-keyed to an allocated id keep the original gen_*
 * reference in that field for reload reconciliation, and a document not yet
 * converted still names the placeholder -- the exact key alone would miss
 * bytes that are right there.
 */
export async function findLegacyMediaRecord(
  db: {
    mediaFiles: {
      get(key: string): Promise<MediaFileRecord | undefined>;
      where(field: 'stageId'): {
        equals(stageId: string): {
          and(pred: (row: MediaFileRecord) => boolean): {
            first(): Promise<MediaFileRecord | undefined>;
          };
        };
      };
    };
  },
  mediaFileKey: (stageId: string, ref: string) => string,
  stageId: string,
  ref: string,
): Promise<MediaFileRecord | undefined> {
  const exact = await db.mediaFiles.get(mediaFileKey(stageId, ref));
  if (exact) return exact;
  return db.mediaFiles
    .where('stageId')
    .equals(stageId)
    .and((row) => row.placeholderRef === ref)
    .first();
}

/** The default production wiring: Dexie legacy tables plus the app asset pool. */
async function defaultDeps(): Promise<LegacyAssetConversionDeps> {
  const [{ db, mediaFileKey }, { putAsset, removeAsset }, { assetRefExists }] = await Promise.all([
    import('@/lib/utils/database'),
    import('./asset-pool'),
    import('./use-asset-url'),
  ]);
  return {
    putAsset: (blob, meta) => putAsset(blob, meta),
    assetRefExists: (ref) => assetRefExists(ref),
    getMediaRecord: (stageId, ref) => findLegacyMediaRecord(db, mediaFileKey, stageId, ref),
    getAudioRecord: (audioId) => db.audioFiles.get(audioId),
    putMediaRecord: (stageId, ref, record) =>
      db.mediaFiles
        .put({ ...record, id: mediaFileKey(stageId, ref), stageId })
        .then(() => undefined),
    putAudioRecord: (record) => db.audioFiles.put(record).then(() => undefined),
    getMirroredAudioRecord: (stageId, legacyId) =>
      db.audioFiles
        .filter((row) => row.stageId === stageId && row.originAudioId === legacyId)
        .first(),
    removeAsset: (ref) => removeAsset(ref),
    fetchLegacyUrl: async (url) => {
      try {
        // Bounded wait: conversion runs on the document load path, and one
        // stalled URL must not hold the document lock indefinitely.
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (response.ok) return { kind: 'ok', blob: await response.blob() };
        // Only definitive absence empties the reference. A 408 or 429 is
        // transient by definition, a 401 or 403 may clear on a credential
        // refresh, and any of them would make the deletion permanent for a
        // temporary condition.
        return {
          kind: response.status === 404 || response.status === 410 ? 'dead' : 'unavailable',
        };
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
  // store. The map holds the in-flight promise, not just the settled value:
  // slides convert concurrently, and caching only completed allocations would
  // let two slides naming one ref each allocate their own asset.
  const allocationByRef = new Map<string, Promise<string | null>>();
  /** Outcome of the URL-backed speech path, cached per dangling pair. */
  type UrlOutcome =
    | { readonly kind: 'allocated'; readonly assetId: string }
    | { readonly kind: 'dead' }
    | { readonly kind: 'unavailable' };
  const urlOutcomeByRef = new Map<string, Promise<UrlOutcome>>();
  const report: LegacyAssetConversionReport = { converted: 0, emptied: 0, kept: 0 };
  let changed = false;

  /** Allocate (once) for a placeholder with local bytes; null when unusable. */
  const allocateMediaRef = (ref: string): Promise<string | null> => {
    const inFlight = allocationByRef.get(ref);
    if (inFlight) return inFlight;
    const pending = (async (): Promise<string | null> => {
      const record = await resolvedDeps.getMediaRecord(stageId, ref);
      if (!usableMediaRecord(record)) {
        report.kept += 1;
        return null;
      }
      // A previous conversion -- or the recovery write path -- may already
      // have keyed this row to an allocated id. Reuse it rather than
      // allocating a twin entry for the same bytes.
      const keyedRef = record.id.startsWith(`${stageId}:`)
        ? record.id.slice(stageId.length + 1)
        : undefined;
      if (keyedRef && keyedRef !== ref && (await resolvedDeps.assetRefExists(keyedRef))) {
        report.converted += 1;
        return keyedRef;
      }
      const blob = record.blob.type
        ? record.blob
        : new Blob([record.blob], { type: record.mimeType });
      const assetId = await resolvedDeps.putAsset(blob, mediaMeta(record, blob));
      try {
        // Mirror the row under the allocated id, like the audio path and the
        // generation write path: collectMediaFiles derives export references
        // from row keys, so without the copy an exported manifest would name
        // media the ZIP only knows by the old placeholder. The original ref
        // stays on placeholderRef for reload reconciliation.
        await resolvedDeps.putMediaRecord(stageId, assetId, {
          ...record,
          placeholderRef: record.placeholderRef ?? ref,
        });
      } catch (error) {
        // Do not strand an allocation nothing references.
        await resolvedDeps.removeAsset(assetId).catch(() => undefined);
        throw error;
      }
      report.converted += 1;
      return assetId;
    })();
    allocationByRef.set(ref, pending);
    return pending;
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
      // audioFiles row, so they collapse into one allocated asset. Speech
      // actions convert concurrently, and the cache is the same
      // promise-keyed one the slide path uses.
      const pendingAudio =
        allocationByRef.get(audioId) ??
        (async (): Promise<string | null> => {
          // A previous partially committed conversion may already have
          // mirrored this row; reuse its allocation instead of orphaning a
          // twin entry on every retry.
          const mirrored = await resolvedDeps.getMirroredAudioRecord(stageId, audioId);
          if (mirrored && (await resolvedDeps.assetRefExists(mirrored.id))) {
            report.converted += 1;
            return mirrored.id;
          }
          const allocated = await resolvedDeps.putAsset(
            record.blob,
            audioMeta(record.blob, record, speech),
          );
          try {
            // Dexie stays a deliberate compatibility double-write until Part
            // 3 converges exporters and import/export onto the pool; mirror
            // the row under the allocated id, keyed like the generation
            // write path, with the legacy id retained for retry recovery.
            await resolvedDeps.putAudioRecord({
              ...record,
              id: allocated,
              stageId,
              originAudioId: audioId,
            });
          } catch (error) {
            // Do not strand an allocation nothing references.
            await resolvedDeps.removeAsset(allocated).catch(() => undefined);
            throw error;
          }
          report.converted += 1;
          return allocated;
        })();
      allocationByRef.set(audioId, pendingAudio);
      const assetId = await pendingAudio;
      if (!assetId) {
        report.kept += 1;
        return action;
      }
      const next: LegacySpeechAction = { ...speech, audioId: assetId };
      delete next.audioUrl;
      changed = true;
      return next;
    }

    if (audioUrl) {
      // The audioId is dangling (or absent): the URL is the only live handle.
      // Actions sharing one pair also share this allocation, cached like the
      // local-byte paths -- otherwise each would fetch identical bytes and
      // receive its own twin entry.
      const urlKey = audioId ?? audioUrl;
      const pendingUrl =
        urlOutcomeByRef.get(urlKey) ??
        (async (): Promise<UrlOutcome> => {
          const fetched = await resolvedDeps.fetchLegacyUrl(audioUrl);
          if (fetched.kind === 'ok') {
            const assetId = await resolvedDeps.putAsset(
              fetched.blob,
              audioMeta(fetched.blob, undefined, speech),
            );
            try {
              await resolvedDeps.putAudioRecord({
                id: assetId,
                stageId,
                blob: fetched.blob,
                format: audioFormat(fetched.blob, undefined),
                text: speech.text,
                voice: speech.voice,
                createdAt: Date.now(),
                ...(audioId ? { originAudioId: audioId } : {}),
              });
            } catch (error) {
              // Do not strand an allocation nothing references.
              await resolvedDeps.removeAsset(assetId).catch(() => undefined);
              throw error;
            }
            report.converted += 1;
            return { kind: 'allocated', assetId };
          }
          return fetched.kind === 'dead' ? { kind: 'dead' } : { kind: 'unavailable' };
        })();
      urlOutcomeByRef.set(urlKey, pendingUrl);
      const outcome = await pendingUrl;
      if (outcome.kind === 'allocated') {
        const next: LegacySpeechAction = { ...speech, audioId: outcome.assetId };
        delete next.audioUrl;
        changed = true;
        return next;
      }
      if (outcome.kind === 'dead') {
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
      // Bounded concurrency: server classrooms carry one dangling URL per
      // clip, and awaiting them one at a time would price the document open
      // at the sum of every fetch. The promise caches make concurrent
      // conversion of shared references safe.
      const converted: Action[] = [];
      const SPEECH_CONCURRENCY = 4;
      for (let index = 0; index < scene.actions.length; index += SPEECH_CONCURRENCY) {
        const chunk = await Promise.all(
          scene.actions.slice(index, index + SPEECH_CONCURRENCY).map(convertSpeechAction),
        );
        converted.push(...chunk);
      }
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
