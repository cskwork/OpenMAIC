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

    test.skipIf(!options.genuineConcurrency)(
      'keeps mergeOwner and cross-owner projections result-consistent under concurrent contention',
      async () => {
        const store = makeStore();
        await store.createSession(makeAgentSessionInput());
        await store.createSession(
          makeAgentSessionInput({ id: 'session-2', ownerId: 'owner-b', stageId: 'stage-2' }),
        );
        await store.createSession(
          makeAgentSessionInput({ id: 'session-3', ownerId: 'owner-b', stageId: 'stage-3' }),
        );
        // This is a result-consistency probe, not a deadlock probe. Every
        // writer in this package (mergeOwner and the projection writers) uses a
        // single global lock order — the parent session row before its child
        // rows, and the session row before that owner's counter — so no
        // opposite-order path exists for this race to exercise a deadlock.
        // Deadlock freedom follows from that invariant, which this free-running
        // race cannot falsify. What it does verify deterministically: the
        // session-row locks serialize each projection against the merge, so all
        // four transactions commit, and the assertions below pin the merged
        // result (duplicate-free stream, durable counter == highest allocated
        // id, source counter deleted, owner rosters).
        await Promise.all([
          store.mergeOwner('owner-a', 'owner-b'),
          store.setActiveStage('session-1', 'stage-1b'),
          store.requestCancel('session-2'),
          store.postUserMessage('session-3', { text: 'Concurrent message' }),
        ]);
        // All four committed: the merged owner stream is duplicate-free and
        // its durable counter matches the highest allocated id.
        const targetEvents = await store.readAfter('owner-b', BigInt(0));
        const ids = targetEvents.map((event) => Number(event.id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(await store.readMaxId('owner-b')).toBe(BigInt(Math.max(0, ...ids)));
        expect(await store.readMaxId('owner-a')).toBe(BigInt(0));
        expect(await store.listSessionsByOwner('owner-a')).toEqual([]);
        expect((await store.listSessionsByOwner('owner-b')).map((session) => session.id)).toEqual([
          'session-1',
          'session-2',
          'session-3',
        ]);
      },
    );
  });
}
