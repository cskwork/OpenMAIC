import { describe, expect, test } from 'vitest';

import type { AgentSessionContractStore } from './agent-session-contract.js';
import { makeAgentSessionInput } from './agent-session-contract.js';

/**
 * Locking semantics shared by database-backed implementations. Embedded
 * single-connection engines run the stale-takeover and generation checks;
 * only a multi-connection PostgreSQL harness enables the races whose result
 * depends on real row-lock waits.
 */
export function runAgentSessionConcurrencyContract(
  name: string,
  makeStore: () => AgentSessionContractStore,
  options: { genuineConcurrency: boolean },
): void {
  describe(`AgentSession concurrency contract: ${name}`, () => {
    test('steals a released or stale lease and preserves the claim watermark', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      const first = await store.claimNextSession('worker-a', 101, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      });
      expect(first).toMatchObject({ attempt: 1, claimSeq: 0 });
      await store.appendUserMessage('session-1', { text: 'Pending', delivery: 'steer' });
      await store.releaseLease('session-1', 'worker-a');

      const stolen = await store.claimNextSession('worker-b', 102, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      });
      expect(stolen).toMatchObject({
        attempt: 2,
        claimReason: 'orphaned',
        claimSeq: 1,
        lease: { workerId: 'worker-b' },
      });
      expect(
        await store.appendRunEvent('session-1', 'worker-a', {
          ts: 2,
          attempt: 1,
          type: 'late',
          data: null,
        }),
      ).toBeNull();
      expect(await store.heartbeat('session-1', 'worker-a')).toBe(false);
    });

    test.skipIf(!options.genuineConcurrency)(
      'allows exactly one worker to win a simultaneous claim',
      async () => {
        const store = makeStore();
        await store.createSession(makeAgentSessionInput());
        const [left, right] = await Promise.all([
          store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 }),
          store.claimNextSession('worker-b', 102, { leaseTtlMs: 10_000, maxAttempts: 3 }),
        ]);
        expect([left, right].filter(Boolean)).toHaveLength(1);
        expect((await store.getSession('session-1'))?.attempt).toBe(1);
      },
    );

    test.skipIf(!options.genuineConcurrency)(
      'keeps session and owner-counter lock order free of a smoke-test deadlock',
      async () => {
        const store = makeStore();
        await store.createSession(makeAgentSessionInput());
        await Promise.all([
          store.setActiveStage('session-1', 'stage-2'),
          store.postUserMessage('session-1', { text: 'Concurrent message' }),
          store.requestCancel('session-1'),
        ]);
        expect(await store.readMaxId('owner-a')).toBe(BigInt(4));
      },
    );
  });
}
