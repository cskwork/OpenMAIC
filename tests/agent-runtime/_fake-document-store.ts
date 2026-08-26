/**
 * Shared in-memory DocumentStore facade for the stage route tests.
 *
 * The routes reach the store through `getOwnerScopedDocumentStore`, which
 * binds the provider's document store to the request owner with `forOwner`.
 * Route tests mock `@/lib/persistence/server-provider` to return THIS facade,
 * already scoped to one owner: seeding it with a document is "a document this
 * owner owns", and an id absent from it reads as missing — the same
 * no-existence-oracle the real owner-bound store produces for a foreign id.
 *
 * The facade also mirrors the PG backend's trigger-maintained freshness
 * revisions: every write method bumps the stage revision, and a scene write
 * bumps that scene's revision, exactly like the DB triggers the real store
 * relies on. Route tests seed `stageRevs` / `sceneRevs` to fix the numbers a
 * manifest response must carry.
 */
import type { DocumentStore, MaicDocument, StageFreshnessManifestStore } from '@openmaic/storage';

import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

export interface FakeDocumentStore {
  store: OwnerScopedFakeStore;
  docs: Map<string, MaicDocument<AppScene, AppStage>>;
  /** Per-stage revisions, mirroring the `document_stage_revision` trigger rows. */
  stageRevs: Map<string, number>;
  /** Per-(stage, scene) revisions, mirroring the `document_scene_revision` rows. */
  sceneRevs: Map<string, Map<string, number>>;
  saveCalls: MaicDocument<AppScene, AppStage>[];
  /** Make the next saveDocument call throw (e.g. a validation failure). */
  failNextSaveWith(error: unknown): void;
}

/** The fake store is already one owner's partition, so scoping is identity. */
export type OwnerScopedFakeStore = DocumentStore<AppScene, AppStage> &
  StageFreshnessManifestStore & {
    forOwner(ownerId: string): OwnerScopedFakeStore;
  };

export function createFakeDocumentStore(): FakeDocumentStore {
  const docs = new Map<string, MaicDocument<AppScene, AppStage>>();
  const stageRevs = new Map<string, number>();
  const sceneRevs = new Map<string, Map<string, number>>();
  const saveCalls: MaicDocument<AppScene, AppStage>[] = [];
  let saveError: unknown = null;

  const bumpStage = (stageId: string) => {
    stageRevs.set(stageId, (stageRevs.get(stageId) ?? 0) + 1);
  };
  const bumpScene = (stageId: string, sceneId: string) => {
    bumpStage(stageId);
    const perScene = sceneRevs.get(stageId) ?? new Map<string, number>();
    perScene.set(sceneId, (perScene.get(sceneId) ?? 0) + 1);
    sceneRevs.set(stageId, perScene);
  };
  const revOf = (stageId: string, sceneId: string) => sceneRevs.get(stageId)?.get(sceneId) ?? 0;

  const store = {
    forOwner: () => store,
    async saveDocument(doc: MaicDocument<AppScene, AppStage>) {
      if (saveError) throw saveError;
      saveCalls.push(structuredClone(doc));
      docs.set(doc.stage.id, structuredClone(doc));
      const stageId = doc.stage.id;
      bumpStage(stageId);
      const incoming = new Set(doc.scenes.map((scene) => scene.id));
      for (const scene of doc.scenes) bumpScene(stageId, scene.id);
      // Scenes the coarse save no longer contains are gone; drop their rows
      // the way the DELETE cascade would.
      const perScene = sceneRevs.get(stageId);
      if (perScene) {
        for (const sceneId of [...perScene.keys()]) {
          if (!incoming.has(sceneId)) perScene.delete(sceneId);
        }
      }
    },
    async loadDocument(stageId: string) {
      const doc = docs.get(stageId);
      return doc ? structuredClone(doc) : null;
    },
    async readFreshnessManifest(stageId: string) {
      const doc = docs.get(stageId);
      if (!doc) return null;
      return {
        rev: stageRevs.get(stageId) ?? 0,
        scenes: [...doc.scenes]
          .sort((left, right) => left.order - right.order)
          .map((scene) => ({
            id: scene.id,
            order: scene.order,
            rev: revOf(stageId, scene.id),
          })),
      };
    },
    async listDocuments() {
      return [...docs.values()]
        .map((doc) => ({
          id: doc.stage.id,
          name: doc.stage.name,
          ...(doc.stage.description ? { description: doc.stage.description } : {}),
          createdAt: doc.stage.createdAt,
          updatedAt: doc.stage.updatedAt,
          sceneCount: doc.scenes.length,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    async deleteDocument(stageId: string) {
      docs.delete(stageId);
      stageRevs.delete(stageId);
      sceneRevs.delete(stageId);
    },
    async putStage(stageId: string, stage: AppStage) {
      const doc = docs.get(stageId);
      if (!doc) throw new Error('@openmaic/storage: document not found');
      docs.set(stageId, { ...doc, stage });
      bumpStage(stageId);
    },
    async putScene(stageId: string, scene: AppScene) {
      const doc = docs.get(stageId);
      if (!doc) throw new Error('@openmaic/storage: document not found');
      docs.set(stageId, {
        ...doc,
        scenes: [...doc.scenes.filter((s) => s.id !== scene.id), scene].sort(
          (left, right) => left.order - right.order,
        ),
      });
      bumpScene(stageId, scene.id);
    },
    async getScene(stageId: string, sceneId: string) {
      return docs.get(stageId)?.scenes.find((scene) => scene.id === sceneId) ?? null;
    },
    async deleteScene(stageId: string, sceneId: string) {
      const doc = docs.get(stageId);
      if (doc) {
        docs.set(stageId, { ...doc, scenes: doc.scenes.filter((scene) => scene.id !== sceneId) });
      }
      bumpStage(stageId);
      sceneRevs.get(stageId)?.delete(sceneId);
    },
  } as OwnerScopedFakeStore;

  return {
    store,
    docs,
    stageRevs,
    sceneRevs,
    saveCalls,
    failNextSaveWith(error) {
      saveError = error;
    },
  };
}
