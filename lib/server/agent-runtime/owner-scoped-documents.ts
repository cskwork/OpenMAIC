import type { DocumentStore } from '@openmaic/storage';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { AppScene } from '@/lib/types/stage';

/**
 * The owner-bound document store for one HTTP request.
 *
 * This is the exact seam the agent runner uses (`runner.ts`): the document
 * provider is bound to the resolved owner through the stage access layer.
 * Reads are capability-by-id, writes and listings are owner-only, and every
 * operation re-checks `stage_meta` inside its transaction. A browser holding a
 * course id may therefore read it without gaining mutation authority.
 * `withPlainJsonDocumentWrites` keeps the write
 * boundary identical to the agent tools' (undefined-valued members are never
 * persisted as JSON nulls).
 */
export async function getOwnerScopedDocumentStore(
  ownerId: string,
): Promise<DocumentStore<AppScene, AppStage>> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return withPlainJsonDocumentWrites(
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }),
  );
}
