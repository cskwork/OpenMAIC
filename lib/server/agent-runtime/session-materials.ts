/**
 * Session-scoped web materials — host adapter.
 *
 * The durable row lives in the package's `agent_session_materials` table
 * (create/list/read paging over `PgAgentSessionMaterialStore`, lazy-bound like
 * `store.ts` / `user-skill-store.ts`). The bytes never live on the row: the
 * extracted markdown is stored through the host's hash-addressed asset
 * registry/byte store and the row records the returned asset id — the neutral
 * counterpart of the reference's `ossKey` linkage. `fetch_url` is this
 * adapter's first consumer; later slices can persist uploads and derived
 * records through the same store.
 */
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import {
  createMaterialId,
  type AgentSessionMaterial,
  type AssetPrincipal,
  type ListAgentSessionMaterialsOptions,
} from '@openmaic/storage';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import type { ExtractedWebPage } from './fetch-url';

interface AgentSessionMaterialStoreState {
  connectionString?: string;
  storePromise?: Promise<PgAgentSessionMaterialStore>;
}

const MATERIAL_STORE_STATE_KEY = Symbol.for('openmaic.agent-session-material.store');
const globalState = globalThis as typeof globalThis & {
  [MATERIAL_STORE_STATE_KEY]?: AgentSessionMaterialStoreState;
};
const storeState = (globalState[MATERIAL_STORE_STATE_KEY] ??= {});

async function createMaterialStore(connectionString: string): Promise<PgAgentSessionMaterialStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  // The material table references agent_sessions(id), so the agent-session
  // schema (provisioned by getAgentSessionStore) must exist first — the same
  // dependency the URL trust-gate table has inside that schema.
  await ensureAgentSessionMaterialSchema(pool);
  return new PgAgentSessionMaterialStore(pool);
}

/**
 * Return the process-wide session-material store, initializing its schema
 * lazily. Failed initialization is cleared so a later request can retry after
 * the database becomes available.
 */
export function getAgentSessionMaterialStore(): Promise<PgAgentSessionMaterialStore> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.storePromise && storeState.connectionString === connectionString) {
    return storeState.storePromise;
  }

  storeState.connectionString = connectionString;
  const initialization = createMaterialStore(connectionString).catch((error) => {
    if (storeState.storePromise === initialization) {
      storeState.storePromise = undefined;
      storeState.connectionString = undefined;
    }
    throw error;
  });
  storeState.storePromise = initialization;
  return initialization;
}

/** Each session's material bytes form their own asset-registry partition. */
function materialPrincipal(sessionId: string): AssetPrincipal {
  return { key: `session-materials:${sessionId}` };
}

/**
 * Persist a fetched web page as a session material: the extracted markdown
 * goes into the asset registry, the material row records the returned asset
 * id plus the fetch's provenance (title / source URL / text character count).
 * A material-row failure removes the just-stored asset again so the fetch
 * cannot leak orphaned bytes (reference byte-store cleanup semantics).
 */
export async function createWebMaterial(
  sessionId: string,
  page: ExtractedWebPage,
): Promise<AgentSessionMaterial> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const id = createMaterialId();
  const body = Buffer.from(page.markdown, 'utf8');
  const principal = materialPrincipal(sessionId);
  const textAssetId = await provider.assetStore.put(
    principal,
    new Blob([body], { type: 'text/markdown' }),
    { contentType: 'text/markdown' },
  );
  try {
    const store = await getAgentSessionMaterialStore();
    return await store.createMaterial(sessionId, {
      id,
      kind: 'web',
      title: page.title.slice(0, 180) || undefined,
      sourceUrl: page.sourceUrl,
      textAssetId,
      textChars: page.markdown.length,
    });
  } catch (error) {
    await provider.assetStore.remove(principal, textAssetId).catch(() => undefined);
    throw error;
  }
}

/** Newest-first session material listing with keyset paging. */
export async function listSessionMaterials(
  sessionId: string,
  options?: ListAgentSessionMaterialsOptions,
): Promise<AgentSessionMaterial[]> {
  const store = await getAgentSessionMaterialStore();
  return store.listMaterials(sessionId, options);
}

/** Session-scoped material read; foreign and nonexistent ids read as absent. */
export async function getSessionMaterial(
  sessionId: string,
  materialId: string,
): Promise<AgentSessionMaterial | null> {
  const store = await getAgentSessionMaterialStore();
  return store.getMaterial(sessionId, materialId);
}
