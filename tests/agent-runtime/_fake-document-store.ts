/**
 * Shared in-memory DocumentStore facade for the stage route tests.
 *
 * The routes reach the store through `getOwnerScopedDocumentStore`, which
 * binds the provider's document store to the request owner with `forOwner`.
 * Route tests mock `@/lib/persistence/server-provider` to return THIS facade,
 * already scoped to one owner: seeding it with a document is "a document this
 * owner owns", and an id absent from it reads as missing — the same
 * no-existence-oracle the real owner-bound store produces for a foreign id.
 */
import type { DocumentStore, MaicDocument } from '@openmaic/storage';

import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

export interface FakeDocumentStore {
  store: OwnerScopedFakeStore;
  docs: Map<string, MaicDocument<AppScene, AppStage>>;
  saveCalls: MaicDocument<AppScene, AppStage>[];
  /** Make the next saveDocument call throw (e.g. a validation failure). */
  failNextSaveWith(error: unknown): void;
}

/** The fake store is already one owner's partition, so scoping is identity. */
export type OwnerScopedFakeStore = DocumentStore<AppScene, AppStage> & {
  forOwner(ownerId: string): OwnerScopedFakeStore;
};

export function createFakeDocumentStore(): FakeDocumentStore {
  const docs = new Map<string, MaicDocument<AppScene, AppStage>>();
  const saveCalls: MaicDocument<AppScene, AppStage>[] = [];
  let saveError: unknown = null;

  const store = {
    forOwner: () => store,
    async saveDocument(doc: MaicDocument<AppScene, AppStage>) {
      if (saveError) throw saveError;
      saveCalls.push(structuredClone(doc));
      docs.set(doc.stage.id, structuredClone(doc));
    },
    async loadDocument(stageId: string) {
      const doc = docs.get(stageId);
      return doc ? structuredClone(doc) : null;
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
    },
    async putStage(stageId: string, stage: AppStage) {
      const doc = docs.get(stageId);
      if (!doc) throw new Error('@openmaic/storage: document not found');
      docs.set(stageId, { ...doc, stage });
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
    },
    async getScene(stageId: string, sceneId: string) {
      return docs.get(stageId)?.scenes.find((scene) => scene.id === sceneId) ?? null;
    },
    async deleteScene(stageId: string, sceneId: string) {
      const doc = docs.get(stageId);
      if (doc) {
        docs.set(stageId, { ...doc, scenes: doc.scenes.filter((scene) => scene.id !== sceneId) });
      }
    },
  } as OwnerScopedFakeStore;

  return {
    store,
    docs,
    saveCalls,
    failNextSaveWith(error) {
      saveError = error;
    },
  };
}
