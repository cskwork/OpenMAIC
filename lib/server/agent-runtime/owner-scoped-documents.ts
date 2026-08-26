import type { DocumentStore, StageFreshnessManifestStore } from '@openmaic/storage';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { AppScene } from '@/lib/types/stage';

/**
 * The owner-bound document store for one HTTP request, plus the
 * trigger-maintained freshness manifest read the PG backend provides.
 */
export type OwnerScopedDocumentStore = DocumentStore<AppScene, AppStage> &
  StageFreshnessManifestStore;

/**
 * The owner-bound document store for one HTTP request.
 *
 * This is the exact seam the agent runner uses (`runner.ts`): the document
 * provider is bound to the resolved owner via `forOwner`, so every read and
 * write is partitioned to that identity — a stage created by the agent for an
 * owner is visible to the same browser and to nobody else, and a foreign id
 * reads as absent and cannot be written (the owner scope is re-checked inside
 * the write transaction). `withPlainJsonDocumentWrites` keeps the write
 * boundary identical to the agent tools' (undefined-valued members are never
 * persisted as JSON nulls).
 */
export async function getOwnerScopedDocumentStore(
  ownerId: string,
): Promise<OwnerScopedDocumentStore> {
  const { documentStore } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return withPlainJsonDocumentWrites(
    documentStore.forOwner(ownerId) as unknown as OwnerScopedDocumentStore,
  );
}
