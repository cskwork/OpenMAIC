import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_AGENT_SESSION_TABLE_NAMES,
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type PgAgentSessionStoreOptions,
  type Queryable,
} from '../src/agent-session/pg.js';
import { runAgentSessionConcurrencyContract } from './agent-session-concurrency-contract.js';
import { makeAgentSessionInput, runAgentSessionStoreContract } from './agent-session-contract.js';

function optionsFor(db: PGlite): PgAgentSessionStoreOptions {
  return { withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)) };
}

describe('PgAgentSessionStore with PGlite', () => {
  let db: PGlite;
  let store: PgAgentSessionStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    store = new PgAgentSessionStore(db, optionsFor(db));
  });

  afterEach(async () => {
    await db.close();
  });

  runAgentSessionStoreContract('Postgres (PGlite)', () => store);
  runAgentSessionConcurrencyContract('Postgres (PGlite)', () => store, {
    genuineConcurrency: false,
  });

  test('provisions all five tables idempotently', async () => {
    await expect(ensureAgentSessionSchema(db)).resolves.toBeUndefined();
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [Object.values(DEFAULT_AGENT_SESSION_TABLE_NAMES)],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(
      Object.values(DEFAULT_AGENT_SESSION_TABLE_NAMES).sort(),
    );
  });

  test('requires a correctly pinned transaction hook', () => {
    expect(() => new PgAgentSessionStore(db, {} as PgAgentSessionStoreOptions)).toThrow(
      /withTransaction.*fresh.*connection.*transaction/i,
    );
  });

  test('runs owner resolution before insertion and creation hook before commit', async () => {
    const observed: string[] = [];
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      resolveFinalOwner: async (tx, ownerId) => {
        const count = await tx.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM agent_sessions',
        );
        observed.push(`resolve:${count.rows[0]!.n}`);
        return `${ownerId}-final`;
      },
      onSessionCreated: async (tx, meta) => {
        const row = await tx.query<{ owner_id: string }>(
          'SELECT owner_id FROM agent_sessions WHERE id = $1',
          [meta.id],
        );
        observed.push(`created:${row.rows[0]!.owner_id}`);
      },
    });

    await hooked.createSession(makeAgentSessionInput());
    expect(observed).toEqual(['resolve:0', 'created:owner-a-final']);
  });

  test('swallows a projection failure without rolling back the business mutation', async () => {
    const logged: unknown[] = [];
    const brokenProjection = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      logger: { error: (...args) => logged.push(args) },
    });
    await db.query(
      `ALTER TABLE agent_owner_session_events
       ADD CONSTRAINT reject_projection CHECK (type <> 'session_created')`,
    );

    await expect(brokenProjection.createSession(makeAgentSessionInput())).resolves.toMatchObject({
      id: 'session-1',
    });
    expect(await brokenProjection.getSession('session-1')).not.toBeNull();
    expect(await brokenProjection.readMaxId('owner-a')).toBe(BigInt(0));
    expect(logged).toHaveLength(1);
  });

  test('keeps event and tree rows physically present after a tombstone', async () => {
    await store.createSession(makeAgentSessionInput());
    await store.appendControlEvent('session-1', {
      ts: 1,
      attempt: 0,
      type: 'control',
      data: {},
    });
    await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
    const tree = await store.openEntryTree('session-1', 'worker-a', 1);
    await tree.appendEntry({
      id: 'root',
      parentId: null,
      type: 'message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {},
    });
    await store.softDeleteSession('session-1', 'owner-a');

    expect((await db.query('SELECT 1 FROM agent_session_events')).rows).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM agent_session_entries')).rows).toHaveLength(1);
  });

  test('supports isolated custom table names', async () => {
    const custom = {
      sessions: 'spec_sessions',
      events: 'spec_events',
      entries: 'spec_entries',
      ownerEventCounters: 'spec_owner_event_counters',
      ownerEvents: 'spec_owner_events',
    };
    await ensureAgentSessionSchema(db, custom);
    const customStore = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      tableNames: custom,
    });
    await customStore.createSession(makeAgentSessionInput({ id: 'custom-1' }));
    expect(await customStore.getSession('custom-1')).toMatchObject({ id: 'custom-1' });
    expect(await store.getSession('custom-1')).toBeNull();
  });
});
