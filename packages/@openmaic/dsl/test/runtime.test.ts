import { describe, expect, it } from 'vitest';
import {
  CHAT_RUNTIME_ROLES,
  CORE_RUNTIME_KINDS,
  DSL_VERSION,
  QUIZ_ATTEMPT_PHASES,
  RUNTIME_SESSION_STATUSES,
  isChatMessageSkeleton,
  isChatRuntimeRole,
  isCoreRuntimeKind,
  isQuizAttemptPhase,
  isQuizAttemptSkeleton,
  isRuntimeSessionStatus,
  migrate,
  type ChatMessageSkeleton,
  type QuizAttemptSkeleton,
  type RuntimeRecord,
  type RuntimeRecordInit,
  type RuntimeSession,
} from '@openmaic/dsl';

describe('runtime envelope guards', () => {
  it('accepts every declared session status and rejects others', () => {
    for (const s of RUNTIME_SESSION_STATUSES) expect(isRuntimeSessionStatus(s)).toBe(true);
    expect(isRuntimeSessionStatus('paused')).toBe(false);
    expect(isRuntimeSessionStatus(undefined)).toBe(false);
    expect(isRuntimeSessionStatus(1)).toBe(false);
  });

  it('accepts every core kind and rejects app-defined kinds', () => {
    expect(CORE_RUNTIME_KINDS).toEqual(['chat', 'quizAttempt', 'playback']);
    for (const k of CORE_RUNTIME_KINDS) expect(isCoreRuntimeKind(k)).toBe(true);
    expect(isCoreRuntimeKind('myWidget')).toBe(false);
  });

  it('accepts every chat role and quiz phase', () => {
    for (const r of CHAT_RUNTIME_ROLES) expect(isChatRuntimeRole(r)).toBe(true);
    expect(isChatRuntimeRole('tool')).toBe(false);
    for (const p of QUIZ_ATTEMPT_PHASES) expect(isQuizAttemptPhase(p)).toBe(true);
    expect(isQuizAttemptPhase('graded')).toBe(false);
  });
});

describe('runtime envelope shapes (compile-time contract)', () => {
  it('a session owns identity/lifecycle; a record owns ordering/anchoring/payload', () => {
    const session: RuntimeSession = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dslVersion: '0.1.0',
    };
    const record: RuntimeRecord<ChatMessageSkeleton> = {
      id: 'r1',
      sessionId: session.id,
      seq: 0,
      sceneId: 'scene1',
      actionIndex: 3,
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: { role: 'user', content: 'hello' },
    };
    expect(record.sessionId).toBe(session.id);
    expect(record.payload.role).toBe('user');
    const quiz: RuntimeRecord<QuizAttemptSkeleton> = {
      id: 'r2',
      sessionId: 's2',
      seq: 0,
      sceneId: 'scene2',
      subAnchor: 'question-3',
      createdAt: '2026-01-01T00:00:02.000Z',
      payload: { phase: 'submitted', answers: { q1: 'A' } },
    };
    expect(quiz.payload.phase).toBe('submitted');
  });

  it('lets a producer construct a RuntimeRecordInit without a store-assigned seq', () => {
    // Compile-time contract: `seq` is store-owned, so the creation shape omits
    // it. Supplying `seq` here would be a type error; leaving it out type-checks.
    const init: RuntimeRecordInit<ChatMessageSkeleton> = {
      id: 'r1',
      sessionId: 's1',
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: { role: 'assistant', content: 'hi' },
    };
    expect(init.id).toBe('r1');
  });
});

describe('runtime payload skeleton guards', () => {
  it('narrows chat message skeletons and rejects malformed ones', () => {
    expect(isChatMessageSkeleton({ role: 'user', content: 'hi' })).toBe(true);
    expect(isChatMessageSkeleton({ role: 'assistant', content: '' })).toBe(true);
    expect(isChatMessageSkeleton({ role: 'tool', content: 'hi' })).toBe(false); // bad role
    expect(isChatMessageSkeleton({ role: 'user', content: 42 })).toBe(false); // non-string
    expect(isChatMessageSkeleton({ role: 'user' })).toBe(false); // missing content
    expect(isChatMessageSkeleton(null)).toBe(false);
    expect(isChatMessageSkeleton('user')).toBe(false);
  });

  it('narrows quiz attempt skeletons and rejects malformed ones', () => {
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: {} })).toBe(true);
    expect(isQuizAttemptSkeleton({ phase: 'submitted', answers: { q1: 'A' } })).toBe(true);
    expect(isQuizAttemptSkeleton({ phase: 'graded', answers: {} })).toBe(false); // bad phase
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: [] })).toBe(false); // array, not object
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: null })).toBe(false); // null answers
    expect(isQuizAttemptSkeleton({ phase: 'draft' })).toBe(false); // missing answers
    expect(isQuizAttemptSkeleton(null)).toBe(false);
  });
});

describe('runtime envelope rides the DSL version ladder', () => {
  it('lifts an unversioned session to the current DSL_VERSION', () => {
    // A RuntimeSession persisted before the `dslVersion` stamp existed: no
    // envelope field, so `migrate` treats it as legacy/unversioned and walks it
    // up the ladder, stamping the result — the session rides the same
    // migrate-on-read path as a document.
    const legacy: Omit<RuntimeSession, 'dslVersion'> = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const lifted = migrate(legacy) as RuntimeSession;
    expect(lifted.dslVersion).toBe(DSL_VERSION);
    // Migration is pure: the payload is carried through untouched, only stamped.
    expect(lifted).toEqual({ ...legacy, dslVersion: DSL_VERSION });
  });

  it('leaves a current-version session untouched', () => {
    const current: RuntimeSession = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dslVersion: DSL_VERSION,
    };
    expect(migrate(current)).toEqual(current);
  });
});
