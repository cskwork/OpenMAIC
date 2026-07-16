import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PgRuntimeStore,
  ensureSchema,
  type Queryable,
  type WithTransaction,
} from '../src/runtime/pg.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

const contractUrl = process.env.PG_CONTRACT_URL;

function transactionFor(pool: Pool, afterBegin?: () => Promise<void>): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await afterBegin?.();
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the transaction body's original error.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}

describe.skipIf(!contractUrl)('PgRuntimeStore with PostgreSQL 16', () => {
  let pool: Pool;
  let store: PgRuntimeStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    await ensureSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE runtime_records, runtime_sessions');
    store = new PgRuntimeStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await pool.end();
  });

  runRuntimeStoreContract('PostgreSQL 16 (node-postgres)', () => store);

  test('genuinely concurrent appends assign distinct gapless sequences', async () => {
    const concurrentTransactions = 8;
    await store.createSession(makeSession({ kind: 'playback' }));
    const allTransactionsStarted = makeBarrier(concurrentTransactions);
    const concurrentStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: transactionFor(pool, allTransactionsStarted),
    });

    const appended = await Promise.all(
      Array.from({ length: concurrentTransactions }, (_, index) =>
        concurrentStore.appendRecord(
          makeRecordInit('sess-1', {
            id: `pg-concurrent-${index}`,
            payload: { index },
          }),
        ),
      ),
    );

    const seqs = appended.map((record) => record.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: concurrentTransactions }, (_, index) => index));
    expect(new Set(seqs).size).toBe(concurrentTransactions);
  });
});
