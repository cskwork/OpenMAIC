import { describe, expect, it } from 'vitest';
import type { ChatSession } from '@/lib/types/chat';
import {
  getPiSingleRequestOutcome,
  isOpenLiveSession,
  normalizeStoredSessionsForRestore,
  resumeSoftClosingSessionForFollowUp,
  withPiInclassWhiteboardTools,
} from '@/components/chat/use-chat-sessions';
import type { ChatRequestTemplate } from '@/components/chat/use-chat-sessions';
import type { UIMessage } from 'ai';
import type { ChatMessageMetadata } from '@/lib/types/chat';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    type: 'qa',
    title: 'Q&A',
    status: 'active',
    messages: [],
    config: { agentIds: ['default-1'], defaultAgentId: 'default-1' },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('normalizeStoredSessionsForRestore', () => {
  it('does not restore transient active or soft-closing statuses', () => {
    const restored = normalizeStoredSessionsForRestore([
      makeSession({ id: 'active', status: 'active' }),
      makeSession({ id: 'soft-closing', status: 'soft-closing', endReason: 'user_goodbye' }),
      makeSession({ id: 'completed', status: 'completed' }),
    ]);

    expect(restored.map((session) => [session.id, session.status, session.endReason])).toEqual([
      ['active', 'interrupted', undefined],
      ['soft-closing', 'completed', 'user_goodbye'],
      ['completed', 'completed', undefined],
    ]);
  });
});

describe('isOpenLiveSession', () => {
  it('treats soft-closing QA/discussion sessions as still open for live controls', () => {
    expect(isOpenLiveSession({ type: 'qa', status: 'active' })).toBe(true);
    expect(isOpenLiveSession({ type: 'discussion', status: 'soft-closing' })).toBe(true);
    expect(isOpenLiveSession({ type: 'qa', status: 'completed' })).toBe(false);
    expect(isOpenLiveSession({ type: 'lecture', status: 'soft-closing' })).toBe(false);
  });
});

describe('resumeSoftClosingSessionForFollowUp', () => {
  it('keeps the visible wrap-up history and reactivates the session for a follow-up', () => {
    const wrapUpMessage: UIMessage<ChatMessageMetadata> = {
      id: 'teacher-wrap-up',
      role: 'assistant',
      parts: [{ type: 'text', text: '总结一下：树荫通过减少直射辐射来降低地表吸热。' }],
    };
    const followUpMessage: UIMessage<ChatMessageMetadata> = {
      id: 'user-follow-up',
      role: 'user',
      parts: [{ type: 'text', text: '那湿度会影响吗？' }],
    };

    const next = resumeSoftClosingSessionForFollowUp(
      makeSession({
        status: 'soft-closing',
        endReason: 'user_done',
        messages: [wrapUpMessage],
      }),
      followUpMessage,
      99,
    );

    expect(next.status).toBe('active');
    expect(next.endReason).toBeUndefined();
    expect(next.updatedAt).toBe(99);
    expect(next.messages).toEqual([wrapUpMessage, followUpMessage]);
  });
});

describe('getPiSingleRequestOutcome', () => {
  it('enters soft-closing for a server-side close after the stream has drained', () => {
    const directorState = {
      turnCount: 1,
      agentResponses: [],
      whiteboardLedger: [],
    };

    expect(
      getPiSingleRequestOutcome({
        directorState,
        totalAgents: 1,
        agentHadContent: true,
        cueUserReceived: false,
        sessionClosed: true,
        endReason: 'user_done',
      }),
    ).toEqual({ type: 'soft_closing', endReason: 'user_done', directorState });
  });

  it('keeps the session open when Pi cues the user', () => {
    const directorState = {
      turnCount: 1,
      agentResponses: [],
      whiteboardLedger: [],
    };

    expect(
      getPiSingleRequestOutcome({
        directorState,
        totalAgents: 1,
        agentHadContent: true,
        cueUserReceived: true,
        sessionClosed: false,
      }),
    ).toEqual({ type: 'cue_user', directorState });
  });

  it('treats empty Pi child output as a stream error even if fallback cue_user fired', () => {
    const directorState = {
      turnCount: 0,
      agentResponses: [],
      whiteboardLedger: [],
    };

    expect(
      getPiSingleRequestOutcome({
        directorState,
        totalAgents: 0,
        agentHadContent: false,
        cueUserReceived: true,
        sessionClosed: false,
      }),
    ).toEqual({ type: 'error', messageKey: 'chat.error.streamInterrupted' });
  });
});

describe('withPiInclassWhiteboardTools', () => {
  it('enables Pi whiteboard tools on the inclass request config without dropping fields', () => {
    const request = {
      messages: [],
      storeState: {},
      config: {
        agentIds: ['default-1'],
        sessionType: 'qa',
        triggerAgentId: 'default-2',
      },
      apiKey: 'test-key',
    } satisfies ChatRequestTemplate;

    const next = withPiInclassWhiteboardTools(request);

    expect(next).not.toBe(request);
    expect(next.config).toEqual({
      agentIds: ['default-1'],
      sessionType: 'qa',
      triggerAgentId: 'default-2',
      piEnableWhiteboardTools: true,
    });
    expect(request.config).not.toHaveProperty('piEnableWhiteboardTools');
  });
});
