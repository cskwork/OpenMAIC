import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '../src/agent-session/pg.js';
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '../src/material/pg.js';
import { runAgentSessionMaterialContract } from './agent-session-material-contract.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL agent-session-material contract suite',
  );
}

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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

describe.skipIf(!contractUrl)('PgAgentSessionMaterialStore with PostgreSQL 16', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    await ensureAgentSessionSchema(pool as Queryable);
    await ensureAgentSessionMaterialSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE agent_session_materials, agent_session_urls, agent_session_entries,
                agent_session_events, agent_owner_session_events,
                agent_owner_session_event_counters, agent_sessions`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  runAgentSessionMaterialContract('PostgreSQL 16 (node-postgres)', () => {
    const sessionStore = new PgAgentSessionStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
    });
    // Advancing clock so rapid successive creates get strictly increasing
    // timestamps; `new Date()` has only millisecond precision and would make
    // ordering assertions flaky on ties (which resolve by id DESC instead).
    let tick = 0;
    const materialStore = new PgAgentSessionMaterialStore(pool as Queryable, {
      now: () => new Date(1_700_000_000_000 + (tick += 1_000)),
    });
    return {
      createSession: (input: Parameters<typeof sessionStore.createSession>[0]) =>
        sessionStore.createSession(input),
      createMaterial: materialStore.createMaterial.bind(materialStore),
      listMaterials: materialStore.listMaterials.bind(materialStore),
      getMaterial: materialStore.getMaterial.bind(materialStore),
    };
  });

  test('runs against PostgreSQL 16 or newer', async () => {
    const result = await pool.query<{ version_num: string }>(
      `SELECT current_setting('server_version_num') AS version_num`,
    );
    expect(Number(result.rows[0]!.version_num)).toBeGreaterThanOrEqual(160_000);
  });
});
