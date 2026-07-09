import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
} from '@openmaic/dsl';
import type { KVScope, KVStore, RuntimeSessionInit, RuntimeStore } from '@openmaic/storage';

import { drainProjectRuntime } from '@/lib/pbl/v2/runtime/drain';
import type { PBLProjectV2, PBLRuntimeEvent } from '@/lib/pbl/v2/types';

const STAGE_ID = 'stage-1';
const SCENE_ID = 'scene-1';
const LEARNER_KEY = 'anon:test-device';

interface PBLDrainWatermark {
  lastRuntimeEventId?: string;
}

function watermarkKey(stageId = STAGE_ID): string {
  return `runtime.pblDrain.${stageId}`;
}

class MemoryKVStore implements KVStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    return (this.values.get(`${scope}:${key}`) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    this.values.set(`${scope}:${key}`, value);
  }

  async remove(key: string, scope: KVScope = 'account'): Promise<void> {
    this.values.delete(`${scope}:${key}`);
  }

  async keys(prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    const scopedPrefix = `${scope}:`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(scopedPrefix))
      .map((key) => key.slice(scopedPrefix.length))
      .filter((key) => key.startsWith(prefix));
  }
}

class MemoryRuntimeStore implements RuntimeStore {
  readonly sessions: RuntimeSession[] = [];
  readonly records: RuntimeRecord[] = [];
  readonly appendAttempts: RuntimeRecordInit[] = [];
  private readonly failOnceIds = new Set<string>();

  failOnceOnRecord(id: string): void {
    this.failOnceIds.add(id);
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    const session: RuntimeSession = { ...init, runtimeDslVersion: 'test' };
    this.sessions.push(session);
    return session;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    return this.sessions.find((session) => session.id === sessionId);
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    return this.sessions.filter(
      (session) => session.stageId === stageId && session.learnerKey === learnerKey,
    );
  }

  async setSessionStatus(): Promise<void> {}

  async deleteSession(): Promise<void> {}

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    this.appendAttempts.push(init);
    if (this.failOnceIds.delete(init.id)) {
      throw new Error(`append failed for ${init.id}`);
    }
    const seq = this.records.filter((record) => record.sessionId === init.sessionId).length;
    const record: RuntimeRecord<TPayload> = { ...init, seq };
    this.records.push(record);
    return record;
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    return this.records.filter(
      (record) =>
        record.sessionId === sessionId && (opts?.sceneId ? record.sceneId === opts.sceneId : true),
    );
  }

  async mergeLearner(): Promise<number> {
    return 0;
  }

  async deleteLearnerRuntime(): Promise<void> {}

  async deleteStageRuntime(): Promise<void> {}
}

function runtimeEvent(id: string, overrides: Partial<PBLRuntimeEvent> = {}): PBLRuntimeEvent {
  return {
    id,
    kind: 'message_created',
    actorType: 'user',
    messageId: `msg-${id}`,
    threadId: 'role-i',
    ts: `2026-05-29T00:00:0${id.slice(-1)}.000Z`,
    ...overrides,
  } as PBLRuntimeEvent;
}

function makeProject(runtimeEvents: PBLRuntimeEvent[]): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Runtime drain project',
    description: 'Build something',
    proficiency: 'intermediate',
    language: 'en-US',
    tags: [],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone 1',
        status: 'active',
        order: 0,
        documents: [],
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    runtimeEvents,
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
  };
}

async function readWatermark(kv: KVStore): Promise<PBLDrainWatermark | null> {
  return kv.get<PBLDrainWatermark>(watermarkKey(), 'device');
}

async function drain(project: PBLProjectV2, store: RuntimeStore, kv: KVStore): Promise<void> {
  await drainProjectRuntime({
    stageId: STAGE_ID,
    sceneId: SCENE_ID,
    project,
    store,
    kv,
    learnerKey: LEARNER_KEY,
  });
}

describe('drainProjectRuntime', () => {
  it('creates a pbl runtime session, appends project runtime events, and advances the watermark', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const events = [
      runtimeEvent('evt-1', { milestoneId: 'ms-1', microtaskId: 'mt-1' }),
      runtimeEvent('evt-2', {
        kind: 'status_changed',
        actorType: 'system',
        entityType: 'milestone',
        entityId: 'ms-1',
        from: 'active',
        to: 'completed',
        milestoneId: 'ms-1',
      }),
      runtimeEvent('evt-3', {
        kind: 'proficiency_updated',
        actorType: 'system',
        tier: 'intermediate',
        score: 0.62,
        confidence: 0.9,
      }),
    ];
    const project = makeProject(events);

    await drain(project, store, kv);

    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({
      kind: 'pbl',
      stageId: STAGE_ID,
      learnerKey: LEARNER_KEY,
      status: 'active',
    });
    expect(Date.parse(store.sessions[0]!.createdAt)).not.toBeNaN();
    expect(store.records).toHaveLength(events.length);
    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(store.records.map((record) => record.sessionId)).toEqual([
      store.sessions[0]!.id,
      store.sessions[0]!.id,
      store.sessions[0]!.id,
    ]);
    expect(store.records.map((record) => record.sceneId)).toEqual([SCENE_ID, SCENE_ID, SCENE_ID]);
    expect(store.records.map((record) => record.subAnchor)).toEqual(['mt-1', 'ms-1', undefined]);
    expect(store.records.map((record) => record.createdAt)).toEqual(
      events.map((event) => event.ts),
    );
    expect(store.records.map((record) => record.payload)).toEqual(events);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-3' });
  });

  it('does not append anything on a second drain when no runtime events were added', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1'), runtimeEvent('evt-2')]);

    await drain(project, store, kv);
    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2']);
    expect(store.sessions).toHaveLength(1);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-2' });
  });

  it('appends only events after the persisted watermark', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1'), runtimeEvent('evt-2')]);
    await drain(project, store, kv);

    project.runtimeEvents?.push(runtimeEvent('evt-3'), runtimeEvent('evt-4'));
    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-4' });
  });

  it('never throws when append fails mid-drain and resumes from the last successful event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemoryRuntimeStore();
    store.failOnceOnRecord('evt-2');
    const kv = new MemoryKVStore();
    const project = makeProject([
      runtimeEvent('evt-1'),
      runtimeEvent('evt-2'),
      runtimeEvent('evt-3'),
    ]);

    await expect(drain(project, store, kv)).resolves.toBeUndefined();
    expect(store.records.map((record) => record.id)).toEqual(['evt-1']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-1' });
    expect(warn).toHaveBeenCalledOnce();

    await expect(drain(project, store, kv)).resolves.toBeUndefined();
    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-3' });
  });

  it('redrains the whole visible ledger when the watermark event id is no longer present', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1'), runtimeEvent('evt-2')]);
    await drain(project, store, kv);
    await kv.set<PBLDrainWatermark>(watermarkKey(), { lastRuntimeEventId: 'evicted' }, 'device');

    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-1', 'evt-2']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-2' });
  });
});
