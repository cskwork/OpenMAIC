import { describe, expect, it } from 'vitest';
import {
  CHAT_RUNTIME_ROLES,
  CORE_RUNTIME_KINDS,
  QUIZ_ATTEMPT_PHASES,
  RUNTIME_SESSION_STATUSES,
  isChatRuntimeRole,
  isCoreRuntimeKind,
  isQuizAttemptPhase,
  isRuntimeSessionStatus,
  type ChatMessageSkeleton,
  type QuizAttemptSkeleton,
  type RuntimeRecord,
  type RuntimeSession,
} from '../src/index.js';

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
});
