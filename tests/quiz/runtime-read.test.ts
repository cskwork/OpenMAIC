import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import {
  loadQuizAttemptState,
  quizAttemptId,
  recordQuizAttempt,
  type QuizAttemptRuntimeDeps,
} from '@/lib/quiz/runtime';
import {
  ANSWERS_KEY_PREFIX,
  ATTEMPT_ID_KEY_PREFIX,
  DRAFT_KEY_PREFIX,
  RESULTS_KEY_PREFIX,
} from '@/lib/quiz/persistence';
import type { QuestionResult } from '@/lib/quiz/grading';

const values = new Map<string, string>();
const localStorageStub = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key: string) => values.get(key) ?? null,
  key: (index: number) => [...values.keys()][index] ?? null,
  removeItem: (key: string) => void values.delete(key),
  setItem: (key: string, value: string) => void values.set(key, String(value)),
} as Storage;

const results: QuestionResult[] = [
  { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
];

function makeStore(): RuntimeStore {
  return new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `quiz-runtime-read-${Math.random()}`,
  });
}

function deps(store: RuntimeStore, learnerKey: string): QuizAttemptRuntimeDeps {
  let tick = 0;
  return {
    store,
    learnerKey,
    now: () => new Date(Date.UTC(2026, 6, 14, 12, 0, tick++)).toISOString(),
    mintRecordId: () => `record-${learnerKey}-${tick}`,
  };
}

describe('quiz runtime authoritative reads', () => {
  beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', localStorageStub);
    vi.stubGlobal('window', { localStorage: localStorageStub });
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: IDBKeyRange,
    });
  });

  it('isolates the same quiz scene by learner', async () => {
    const store = makeStore();
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'attempt-a',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps(store, 'learner-a'),
    );
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'attempt-b',
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [{ ...results[0], correct: false, status: 'incorrect', earned: 0 }],
      },
      deps(store, 'learner-b'),
    );

    const learnerA = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      deps(store, 'learner-a'),
    );
    const learnerB = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      deps(store, 'learner-b'),
    );

    expect(learnerA.state?.answers).toEqual({ q1: 'A' });
    expect(learnerB.state?.answers).toEqual({ q1: 'B' });
    expect(learnerA.attemptId).not.toBe(learnerB.attemptId);
  });

  it('selects the latest attempt for the scene', async () => {
    const store = makeStore();
    const runtimeDeps = deps(store, 'learner-a');
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'attempt-old',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      runtimeDeps,
    );
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'attempt-new',
        phase: 'draft',
        answers: { q1: 'B' },
      },
      runtimeDeps,
    );

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      runtimeDeps,
    );

    expect(loaded.state).toMatchObject({
      sessionId: 'attempt-new',
      phase: 'draft',
      status: 'active',
      answers: { q1: 'B' },
    });
    expect(loaded.attemptId).toBe('attempt-new');
  });

  it('preserves reviewed empty results as a completed state', async () => {
    const store = makeStore();
    const runtimeDeps = deps(store, 'learner-a');
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'attempt-empty',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [],
      },
      runtimeDeps,
    );

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      runtimeDeps,
    );

    expect(loaded.state).toMatchObject({
      phase: 'reviewed',
      status: 'completed',
      results: [],
    });
  });

  it('migrates one legacy reviewed snapshot then deletes every legacy key', async () => {
    const store = makeStore();
    localStorageStub.setItem(ANSWERS_KEY_PREFIX + 'quiz-1', JSON.stringify({ q1: 'A' }));
    localStorageStub.setItem(RESULTS_KEY_PREFIX + 'quiz-1', JSON.stringify(results));
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 'quiz-1', JSON.stringify({ q1: 'draft' }));
    localStorageStub.setItem(ATTEMPT_ID_KEY_PREFIX + 'quiz-1', 'legacy-unscoped-attempt');

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      deps(store, 'learner-a'),
    );

    expect(loaded.state).toMatchObject({
      phase: 'reviewed',
      status: 'completed',
      answers: { q1: 'A' },
      results,
    });
    for (const prefix of [
      ANSWERS_KEY_PREFIX,
      RESULTS_KEY_PREFIX,
      DRAFT_KEY_PREFIX,
      ATTEMPT_ID_KEY_PREFIX,
    ]) {
      expect(localStorageStub.getItem(prefix + 'quiz-1')).toBeNull();
    }
  });

  it('keeps a stronger runtime submission over a stale legacy draft', async () => {
    const store = makeStore();
    const runtimeDeps = deps(store, 'learner-a');
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'runtime-attempt',
        phase: 'submitted',
        answers: { q1: 'runtime' },
      },
      runtimeDeps,
    );
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 'quiz-1', JSON.stringify({ q1: 'legacy' }));

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      runtimeDeps,
    );

    expect(loaded.state).toMatchObject({ phase: 'submitted', answers: { q1: 'runtime' } });
    expect(localStorageStub.getItem(DRAFT_KEY_PREFIX + 'quiz-1')).toBeNull();
  });

  it('migrates a reviewed legacy result over a weaker runtime submission', async () => {
    const store = makeStore();
    const runtimeDeps = deps(store, 'learner-a');
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'runtime-attempt',
        phase: 'submitted',
        answers: { q1: 'A' },
      },
      runtimeDeps,
    );
    localStorageStub.setItem(ANSWERS_KEY_PREFIX + 'quiz-1', JSON.stringify({ q1: 'A' }));
    localStorageStub.setItem(RESULTS_KEY_PREFIX + 'quiz-1', JSON.stringify(results));

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      runtimeDeps,
    );

    expect(loaded.state).toMatchObject({
      phase: 'reviewed',
      status: 'completed',
      answers: { q1: 'A' },
      results,
    });
    expect(localStorageStub.getItem(ANSWERS_KEY_PREFIX + 'quiz-1')).toBeNull();
    expect(localStorageStub.getItem(RESULTS_KEY_PREFIX + 'quiz-1')).toBeNull();
  });

  it('preserves a newer legacy retry over an older reviewed runtime attempt', async () => {
    const store = makeStore();
    const runtimeDeps = deps(store, 'learner-a');
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'old-attempt',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      runtimeDeps,
    );
    localStorageStub.setItem(ATTEMPT_ID_KEY_PREFIX + 'quiz-1', 'new-retry');
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 'quiz-1', JSON.stringify({ q1: 'B' }));

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      runtimeDeps,
    );

    expect(loaded).toMatchObject({
      attemptId: 'new-retry',
      state: {
        sessionId: 'new-retry',
        phase: 'draft',
        status: 'active',
        answers: { q1: 'B' },
      },
    });
  });

  it('preserves a pointer-only legacy retry as an empty draft attempt', async () => {
    const store = makeStore();
    const runtimeDeps = deps(store, 'learner-a');
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'old-attempt',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      runtimeDeps,
    );
    localStorageStub.setItem(ATTEMPT_ID_KEY_PREFIX + 'quiz-1', 'new-empty-retry');

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      runtimeDeps,
    );

    expect(loaded).toMatchObject({
      attemptId: 'new-empty-retry',
      state: {
        sessionId: 'new-empty-retry',
        phase: 'draft',
        status: 'active',
        answers: {},
      },
    });
  });

  it('migrates a newer equal-phase legacy draft over its stale shadow record', async () => {
    const store = makeStore();
    const runtimeDeps = deps(store, 'learner-a');
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: 'same-attempt',
        phase: 'draft',
        answers: { q1: 'stale' },
      },
      runtimeDeps,
    );
    localStorageStub.setItem(ATTEMPT_ID_KEY_PREFIX + 'quiz-1', 'same-attempt');
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 'quiz-1', JSON.stringify({ q1: 'latest' }));

    const loaded = await loadQuizAttemptState(
      { stageId: 'stage-1', sceneId: 'quiz-1' },
      runtimeDeps,
    );

    expect(loaded.state).toMatchObject({
      sessionId: 'same-attempt',
      phase: 'draft',
      answers: { q1: 'latest' },
    });
  });

  it('retains legacy keys when migration cannot commit to RuntimeStore', async () => {
    const store = makeStore();
    const failingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'appendRecord') {
          return async () => {
            throw new Error('storage unavailable');
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    localStorageStub.setItem(ANSWERS_KEY_PREFIX + 'quiz-1', JSON.stringify({ q1: 'legacy' }));

    await expect(
      loadQuizAttemptState(
        { stageId: 'stage-1', sceneId: 'quiz-1' },
        deps(failingStore, 'learner-a'),
      ),
    ).rejects.toThrow('storage unavailable');

    expect(localStorageStub.getItem(ANSWERS_KEY_PREFIX + 'quiz-1')).not.toBeNull();
  });

  it('awaits a locally queued write before reading the authoritative state', async () => {
    const store = makeStore();
    let releaseAppend!: () => void;
    const appendMayFinish = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const delayedStore = new Proxy(store, {
      get(target, property) {
        if (property === 'appendRecord') {
          return async (...args: Parameters<RuntimeStore['appendRecord']>) => {
            await appendMayFinish;
            return store.appendRecord(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const runtimeDeps = deps(delayedStore, 'learner-a');
    const writing = recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: quizAttemptId('stage-1', 'quiz-1', 'learner-a'),
        phase: 'submitted',
        answers: { q1: 'A' },
      },
      runtimeDeps,
    );
    const reading = loadQuizAttemptState({ stageId: 'stage-1', sceneId: 'quiz-1' }, runtimeDeps);
    let didRead = false;
    void reading.then(() => {
      didRead = true;
    });

    await Promise.resolve();
    expect(didRead).toBe(false);
    releaseAppend();
    await writing;

    await expect(reading).resolves.toMatchObject({
      state: { phase: 'submitted', answers: { q1: 'A' } },
    });
  });

  it('awaits the parent queue that writes into an active rollover session', async () => {
    const store = makeStore();
    let appendStarted!: () => void;
    const didStartAppend = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendMayFinish = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const delayedStore = new Proxy(store, {
      get(target, property) {
        if (property === 'appendRecord') {
          return async (...args: Parameters<RuntimeStore['appendRecord']>) => {
            const payload = args[0].payload as { answers?: Record<string, string> };
            if (payload.answers?.q1 === 'latest') {
              appendStarted();
              await appendMayFinish;
            }
            return store.appendRecord(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const runtimeDeps = deps(delayedStore, 'learner-a');
    const root = quizAttemptId('stage-1', 'quiz-1', 'learner-a');
    const retry = `${root}:retry:1`;

    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: root,
        phase: 'reviewed',
        answers: { q1: 'first' },
        results,
      },
      runtimeDeps,
    );
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: root,
        phase: 'draft',
        answers: {},
        startNewAttempt: true,
      },
      runtimeDeps,
    );
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: retry,
        phase: 'reviewed',
        answers: {},
        results: [],
      },
      runtimeDeps,
    );
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: retry,
        phase: 'draft',
        answers: {},
        startNewAttempt: true,
      },
      runtimeDeps,
    );

    const writing = recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'quiz-1',
        attemptId: retry,
        phase: 'draft',
        answers: { q1: 'latest' },
      },
      runtimeDeps,
    );
    await didStartAppend;
    const reading = loadQuizAttemptState({ stageId: 'stage-1', sceneId: 'quiz-1' }, runtimeDeps);
    const earlyOutcome = await Promise.race([
      reading.then(() => 'read' as const),
      new Promise<'blocked'>((resolve) => {
        setTimeout(() => resolve('blocked'), 50);
      }),
    ]);
    releaseAppend();
    await writing;

    expect(earlyOutcome).toBe('blocked');
    await expect(reading).resolves.toMatchObject({
      attemptId: `${retry}:retry:1`,
      state: { phase: 'draft', answers: { q1: 'latest' } },
    });
  });
});
