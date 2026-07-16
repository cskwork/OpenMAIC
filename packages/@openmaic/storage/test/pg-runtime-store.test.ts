import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  PgRuntimeStore,
  ensureSchema,
  type PgRuntimeStoreOptions,
  type Queryable,
} from '../src/runtime/pg.js';
import type { RuntimeStore } from '../src/runtime/types.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

function transactionOptions(db: PGlite): PgRuntimeStoreOptions {
  return {
    withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
  };
}

describe('PgRuntimeStore with PGlite', () => {
  let db: PGlite;
  let store: RuntimeStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureSchema(db);
    store = new PgRuntimeStore(db, transactionOptions(db));
  });

  afterEach(async () => {
    await db.close();
  });

  runRuntimeStoreContract('Postgres (PGlite)', () => store);
});

describe('PgRuntimeStore Postgres behavior', () => {
  let db: PGlite;
  let store: PgRuntimeStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureSchema(db);
    store = new PgRuntimeStore(db, transactionOptions(db));
  });

  afterEach(async () => {
    await db.close();
  });

  test('ensureSchema is idempotent', async () => {
    await expect(ensureSchema(db)).resolves.toBeUndefined();
    await expect(ensureSchema(db)).resolves.toBeUndefined();

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('runtime_sessions', 'runtime_records')
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'runtime_records',
      'runtime_sessions',
    ]);
  });

  test('concurrent appends assign a gapless, duplicate-free per-session seq', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));

    const appended = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        store.appendRecord(
          makeRecordInit('sess-1', {
            id: `concurrent-${index}`,
            payload: { index },
          }),
        ),
      ),
    );

    const seqs = appended.map((record) => record.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(new Set(seqs).size).toBe(32);
    expect((await store.listRecords('sess-1')).map((record) => record.seq)).toEqual(seqs);
  });

  test('mergeLearner is repeatably idempotent and preserves target sessions and records', async () => {
    await store.createSession(makeSession({ id: 'source', kind: 'playback' }));
    await store.appendRecord(
      makeRecordInit('source', { id: 'source-record', payload: { owner: 'source' } }),
    );
    await store.createSession(
      makeSession({ id: 'target', learnerKey: 'user:42', kind: 'playback' }),
    );
    await store.appendRecord(
      makeRecordInit('target', { id: 'target-record', payload: { owner: 'target' } }),
    );

    await expect(store.mergeLearner('anon:device-1', 'user:42')).resolves.toBe(1);
    await expect(store.mergeLearner('anon:device-1', 'user:42')).resolves.toBe(0);
    await expect(store.mergeLearner('anon:device-1', 'user:42')).resolves.toBe(0);

    expect(
      (await store.listSessions('stage-1', 'user:42')).map((session) => session.id).sort(),
    ).toEqual(['source', 'target']);
    expect((await store.listRecords('source')).map((record) => record.id)).toEqual([
      'source-record',
    ]);
    expect((await store.listRecords('target')).map((record) => record.id)).toEqual([
      'target-record',
    ]);
  });

  test('writes fail loud for a future-stamped stored session', async () => {
    const created = await store.createSession(makeSession());
    await db.query('UPDATE runtime_sessions SET data = $2::jsonb WHERE id = $1', [
      created.id,
      JSON.stringify({ ...created, runtimeDslVersion: '99.0.0' }),
    ]);

    await expect(
      store.setSessionStatus(created.id, 'completed', created.updatedAt),
    ).rejects.toThrow(/newer than this client's/);
    await expect(store.appendRecord(makeRecordInit(created.id))).rejects.toThrow(
      /newer than this client's/,
    );
  });

  test('a document-line envelope stored as a session fails loud', async () => {
    const created = await store.createSession(makeSession());
    const { runtimeDslVersion: _runtimeDslVersion, ...withoutRuntimeStamp } = created;
    await db.query('UPDATE runtime_sessions SET data = $2::jsonb WHERE id = $1', [
      created.id,
      JSON.stringify({ ...withoutRuntimeStamp, dslVersion: '0.1.0' }),
    ]);

    await expect(store.getSession(created.id)).rejects.toThrow();
    await expect(store.appendRecord(makeRecordInit(created.id))).rejects.toThrow();
  });
});
