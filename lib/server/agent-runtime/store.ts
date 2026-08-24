import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/agent-session/pg';
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

interface AgentSessionStoreState {
  connectionString?: string;
  storePromise?: Promise<PgAgentSessionStore>;
}

const AGENT_SESSION_STORE_STATE_KEY = Symbol.for('openmaic.agent-session.store');
const globalState = globalThis as typeof globalThis & {
  [AGENT_SESSION_STORE_STATE_KEY]?: AgentSessionStoreState;
};
const storeState = (globalState[AGENT_SESSION_STORE_STATE_KEY] ??= {});

/**
 * Adapt a node-postgres pool to the storage package's transaction contract.
 * Every transaction uses one checked-out client for its entire lifetime.
 */
export function nodePostgresTransaction(pool: Pool): WithTransaction {
  return async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function createAgentSessionStore(connectionString: string): Promise<PgAgentSessionStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureAgentSessionSchema(pool);
  return new PgAgentSessionStore(pool, {
    withTransaction: nodePostgresTransaction(pool),
  });
}

/**
 * Return the process-wide agent-session store, initializing its schema lazily.
 * Failed initialization is cleared so a later request can retry after the
 * database becomes available.
 */
export function getAgentSessionStore(): Promise<PgAgentSessionStore> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.storePromise && storeState.connectionString === connectionString) {
    return storeState.storePromise;
  }

  storeState.connectionString = connectionString;
  const initialization = createAgentSessionStore(connectionString).catch((error) => {
    if (storeState.storePromise === initialization) {
      storeState.storePromise = undefined;
      storeState.connectionString = undefined;
    }
    throw error;
  });
  storeState.storePromise = initialization;
  return initialization;
}
