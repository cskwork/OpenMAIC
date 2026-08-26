/**
 * Session-scoped web materials — host adapter.
 *
 * The durable row is stored in the package's `agent_session_materials` table
 * (create/list/read paging over `PgAgentSessionMaterialStore`, lazy-bound like
 * `store.ts` / `user-skill-store.ts`). The bytes are not kept on the row: the
 * extracted markdown is stored through the host's hash-addressed asset
 * registry/byte store and the row records the returned asset id — the neutral
 * counterpart of the reference's `ossKey` linkage. `fetch_url` is this
 * adapter's first consumer; `read_material` / `search_material` resolve a
 * row's recorded asset id back to bytes through the same registry. Later
 * slices can persist uploads and derived records through the same store.
 */
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import {
  createMaterialId,
  toAssetId,
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
 * A confirmed material-row failure removes the just-stored asset. Ambiguous
 * database outcomes are verified before cleanup so a committed row never has
 * its asset removed underneath it.
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
  // Initialize the row store before writing bytes, narrowing the non-atomic
  // asset/metadata handoff to the two business writes themselves.
  const store = await getAgentSessionMaterialStore();
  const textAssetId = await provider.assetStore.put(
    principal,
    new Blob([body], { type: 'text/markdown' }),
    { contentType: 'text/markdown' },
  );
  try {
    return await store.createMaterial(sessionId, {
      id,
      kind: 'web',
      title: page.title.slice(0, 180) || undefined,
      sourceUrl: page.sourceUrl,
      textAssetId,
      textChars: page.markdown.length,
    });
  } catch (error) {
    // A database connection can fail after PostgreSQL committed the INSERT.
    // Verify absence before compensating; otherwise cleanup could delete the
    // asset underneath a durable material row. If verification itself fails,
    // preserve the asset and let orphan reconciliation handle it rather than
    // risk creating a dangling row.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) return committed;
    if (committed === null) {
      await provider.assetStore.remove(principal, textAssetId).catch(() => undefined);
    }
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

/**
 * Resolve a material's recorded text asset to its bytes, or `null` when the
 * asset is absent. The lookup is scoped to the session's own asset-registry
 * partition, so a foreign or stale `textAssetId` — even one read off another
 * session's row — resolves as a miss, never as another session's content.
 */
export async function resolveSessionMaterialText(
  sessionId: string,
  textAssetId: string,
): Promise<Buffer | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const resolved = await provider.assetStore.resolve(
    materialPrincipal(sessionId),
    toAssetId(textAssetId),
  );
  if (!resolved) return null;
  return Buffer.from(resolved.bytes);
}

/**
 * Safe metadata and typed-tool guidance for materials bound to one session.
 * Material contents stay in the asset registry and are available only through
 * the session-scoped material tools, never through this block. Ported from the
 * reference's session-materials prompt block, minus extraction queue tools.
 */
export function sessionMaterialsPromptBlock(materials: AgentSessionMaterial[]): string {
  if (materials.length === 0) return '';

  return [
    '## Registered session materials',
    '',
    'These materials are associated with this session:',
    ...materials.map(
      (material) =>
        `- "${material.title ?? material.id}" (${material.kind}, ${material.textChars} characters)`,
    ),
    '',
    'Material workflow: call `list_materials` to inspect the session materials and discover `mat_` ids; call `read_material` on a `mat_` id to read its text in pages (continue with the returned `nextOffset`); call `search_material` to locate case-insensitive literal text across the readable materials.',
    'To reuse session image, video, or audio bytes in a page, call `use_material_media` and use the returned stable `src`.',
    'A `web` material was already fetched and extracted; read it directly with `read_material` and page through offsets.',
  ].join('\n');
}
