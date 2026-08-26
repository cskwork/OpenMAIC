import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
} from '../src/agent-session/pg.js';
import {
  DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES,
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '../src/material/pg.js';
import { runAgentSessionMaterialContract } from './agent-session-material-contract.js';

function combinedStore(db: PGlite) {
  const sessionStore = new PgAgentSessionStore(db, {
    withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
  });
  // Advancing clock so rapid successive creates get strictly increasing
  // timestamps; `new Date()` has only millisecond precision and would make
  // ordering assertions flaky on ties (which resolve by id DESC instead).
  let tick = 0;
  const materialStore = new PgAgentSessionMaterialStore(db, {
    now: () => new Date(1_700_000_000_000 + (tick += 1_000)),
  });
  return {
    createSession: (input: Parameters<typeof sessionStore.createSession>[0]) =>
      sessionStore.createSession(input),
    createMaterial: materialStore.createMaterial.bind(materialStore),
    listMaterials: materialStore.listMaterials.bind(materialStore),
    getMaterial: materialStore.getMaterial.bind(materialStore),
  };
}

describe('PgAgentSessionMaterialStore with PGlite', () => {
  let db: PGlite;
  let store: PgAgentSessionMaterialStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    // The material table references agent_sessions(id), so the agent-session
    // schema must be provisioned first (the same host-side ordering).
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    store = new PgAgentSessionMaterialStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  runAgentSessionMaterialContract('Postgres (PGlite)', () => combinedStore(db));

  test('provisions the material table idempotently', async () => {
    await expect(ensureAgentSessionMaterialSchema(db)).resolves.toBeUndefined();
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [Object.values(DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES)],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(
      Object.values(DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES).sort(),
    );
  });

  test('cascades material rows away when the session row is hard-deleted', async () => {
    await new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    }).createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { kind: 'web', sourceUrl: 'https://example.com/' });

    await db.query('DELETE FROM agent_sessions WHERE id = $1', ['session-1']);

    expect(await store.listMaterials('session-1')).toEqual([]);
  });

  test('fails closed for soft-deleted sessions on create, list, and read', async () => {
    const sessionStore = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    const material = await store.createMaterial('session-1', {
      kind: 'web',
      sourceUrl: 'https://example.com/',
    });

    await sessionStore.softDeleteSession('session-1', 'owner-a');

    await expect(store.getMaterial('session-1', material.id)).resolves.toBeNull();
    await expect(store.listMaterials('session-1')).resolves.toEqual([]);
    await expect(store.createMaterial('session-1', { kind: 'web' })).rejects.toMatchObject({
      code: 'session_missing',
    });
  });

  test('honours the table-name override for the material table', async () => {
    const overrideDb = new PGlite();
    await overrideDb.waitReady;
    await ensureAgentSessionSchema(overrideDb);
    await ensureAgentSessionMaterialSchema(overrideDb, { materials: 'custom_materials' });
    const overridden = new PgAgentSessionMaterialStore(overrideDb, {
      tableNames: { materials: 'custom_materials' },
    });
    await new PgAgentSessionStore(overrideDb, {
      withTransaction: (body) => overrideDb.transaction((tx: Queryable) => body(tx)),
    }).createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

    const material = await overridden.createMaterial('session-1', {
      kind: 'web',
      sourceUrl: 'https://example.com/',
    });

    expect((await overridden.getMaterial('session-1', material.id))?.id).toBe(material.id);
    // Only the overridden table was created; the default one stays absent.
    const tables = await overrideDb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['custom_materials', 'agent_session_materials']],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(['custom_materials']);
    await overrideDb.close();
  });

  test('rejects an invalid table-name override', () => {
    expect(
      () => new PgAgentSessionMaterialStore(db, { tableNames: { materials: 'Bad Name' } }),
    ).toThrow(/invalid agent-session-material table name/);
  });
});
