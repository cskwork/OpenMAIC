import { describe, expect, it } from 'vitest';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
} from '@openmaic/dsl';
import type { KVScope, KVStore, RuntimeSessionInit, RuntimeStore } from '@openmaic/storage';

import type { PBLProjectConfig } from '@/lib/pbl/types';
import { transitionProjectUiPhase } from '@/lib/pbl/v2/operations/runtime-events';
import { drainProjectRuntime } from '@/lib/pbl/v2/runtime/drain';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import {
  hydrateClassroomFallbackScenes,
  shouldApplyClassroomFallbackScenes,
} from '@/lib/classroom/pbl-fallback-hydration';
import { makeScene, type Scene } from '@/lib/types/stage';

const STAGE_ID = 'stage-1';
const SCENE_ID = 'scene-1';
const LEARNER_KEY = 'anon:test-device';

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

function makeProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'Fallback PBL project',
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
    runtimeEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

function makePBLScene(project: PBLProjectV2): Scene {
  return makeScene(
    {
      id: SCENE_ID,
      stageId: STAGE_ID,
      title: 'PBL scene',
      order: 0,
    },
    {
      type: 'pbl',
      projectConfig: {} as PBLProjectConfig,
      projectV2: project,
    },
  );
}

describe('classroom server fallback PBL hydration', () => {
  it('does not apply fallback scenes after navigation changes the current stage', () => {
    expect(shouldApplyClassroomFallbackScenes('stage-a', null)).toBe(true);
    expect(shouldApplyClassroomFallbackScenes('stage-a', undefined)).toBe(true);
    expect(shouldApplyClassroomFallbackScenes('stage-a', 'stage-a')).toBe(true);
    expect(shouldApplyClassroomFallbackScenes('stage-a', 'stage-b')).toBe(false);
  });

  it('hydrates server-fallback scenes from existing runtime records', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const runtimeProject = transitionProjectUiPhase(makeProject(), 'workspace');
    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: runtimeProject,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    const serverFallbackScenes = [makePBLScene({ ...runtimeProject, runtimeEvents: [] })];

    const hydrated = await hydrateClassroomFallbackScenes(STAGE_ID, serverFallbackScenes, {
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated[0]?.content.type).toBe('pbl');
    expect(hydrated[0]?.content.type === 'pbl' && hydrated[0].content.projectV2?.uiPhase).toBe(
      'workspace',
    );
  });
});
