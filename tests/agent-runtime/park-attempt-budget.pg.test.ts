import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureAgentSessionSchema,
  PgAgentSessionStore,
  type Queryable,
  type WithTransaction,
} from '../../packages/@openmaic/storage/src/agent-session/pg';
import { isOverAttemptCap } from '@/lib/server/agent-runtime/runner';

const contractUrl = process.env.PG_CONTRACT_URL;

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
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

describe.skipIf(!contractUrl)('session attempt budget takeovers', () => {
  let pool: Pool;
  let store: PgAgentSessionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl });
    await ensureAgentSessionSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE agent_session_entries, agent_session_events,
                agent_owner_session_events, agent_owner_session_event_counters,
                agent_sessions`,
    );
    store = new PgAgentSessionStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('survives six clean park and takeover cycles with a cap of five', async () => {
    await store.createSession({
      id: 'parked-session',
      ownerId: 'owner',
      prompt: 'Keep working',
      stageId: 'stage',
    });

    let claim = await store.claimNextSession('worker-0', 100, {
      leaseTtlMs: 10_000,
      maxAttempts: 5,
    });
    expect(claim).not.toBeNull();
    expect(isOverAttemptCap(claim!)).toBe(false);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      await store.releaseLease('parked-session', `worker-${cycle}`);
      claim = await store.claimNextSession(`worker-${cycle + 1}`, 101 + cycle, {
        leaseTtlMs: 10_000,
        maxAttempts: 5,
      });
      expect(claim).toMatchObject({ attempt: 1, claimReason: 'orphaned' });
      expect(isOverAttemptCap(claim!)).toBe(false);
    }

    expect(await store.getSession('parked-session')).toMatchObject({
      status: 'running',
      attempt: 1,
    });
  });

  it('caps six unclean-death takeovers with a cap of five', async () => {
    await store.createSession({
      id: 'crashloop-session',
      ownerId: 'owner',
      prompt: 'Keep crashing',
      stageId: 'stage',
    });

    let claim = await store.claimNextSession('worker-0', 100, {
      leaseTtlMs: 10_000,
      maxAttempts: 5,
    });
    expect(claim).not.toBeNull();
    expect(isOverAttemptCap(claim!)).toBe(false);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      await pool.query(
        `UPDATE agent_sessions SET lease_heartbeat_at = 0
         WHERE id = 'crashloop-session'`,
      );
      claim = await store.claimNextSession(`worker-${cycle + 1}`, 101 + cycle, {
        leaseTtlMs: 10_000,
        maxAttempts: 5,
      });
      expect(claim).toMatchObject({ attempt: cycle + 2, claimReason: 'orphaned' });
    }

    expect(isOverAttemptCap(claim!)).toBe(true);
    expect(await store.getSession('crashloop-session')).toMatchObject({
      status: 'running',
      attempt: 7,
    });
  });
});
