import { describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@/lib/types/chat';
import {
  claimWhiteboardSessionBoundary,
  createPendingWhiteboardSessionBoundary,
  getPiSingleRequestOutcome,
  isOpenLiveSession,
  normalizeStoredSessionsForRestore,
  reconcileWhiteboardBoundariesAfterSceneChange,
  retireLiveRequestResources,
  resumeSoftClosingSessionForFollowUp,
  resumeSoftClosingSessionWithoutMessage,
  runPiSingleRequest,
  settleClaimedWhiteboardSessionBoundary,
  shouldAwaitPresentationAction,
  withPiInclassWhiteboardTools,
  MANUAL_STOP_END_OPTIONS,
  takeSoftCloseRegistration,
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

  it('discards persisted boundary tokens on restore', () => {
    const [restored] = normalizeStoredSessionsForRestore([
      makeSession({
        status: 'active',
        whiteboardBoundary: {
          boundaryId: 'boundary-1',
          sourceSessionId: 'old',
          targetSessionId: 'session-1',
          whiteboardId: 'wb-1',
          snapshotFingerprint: 'fingerprint',
          status: 'claimed',
        },
      }),
    ]);

    expect(restored.whiteboardBoundary).toBeUndefined();
  });
});

describe('whiteboard session boundary lifecycle', () => {
  const stage = {
    id: 'stage-1',
    whiteboard: [
      {
        id: 'wb-1',
        elements: [{ id: 'old-note', type: 'text', content: 'old topic' }],
      },
    ],
  } as never;

  it('mints after manual-stop capture and lets exactly one new Pi live session claim it', () => {
    expect(MANUAL_STOP_END_OPTIONS).toEqual({ source: 'manual_stop' });
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    const first = claimWhiteboardSessionBoundary(pending, 'session-new', 'qa', true);
    const second = claimWhiteboardSessionBoundary(
      first.pending,
      'session-later',
      'discussion',
      true,
    );

    expect(first.boundary).toMatchObject({
      boundaryId: 'boundary-1',
      sourceSessionId: 'session-old',
      targetSessionId: 'session-new',
      status: 'claimed',
    });
    expect(second.boundary).toBeUndefined();
  });

  it('discards pending at a lecture boundary instead of leaking it to a later QA', () => {
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    const lecture = claimWhiteboardSessionBoundary(pending, 'lecture-1', 'lecture', true);
    const laterQa = claimWhiteboardSessionBoundary(lecture.pending, 'session-new', 'qa', true);

    expect(lecture.boundary).toBeUndefined();
    expect(laterQa.boundary).toBeUndefined();
  });

  it('keeps a claimed token across text-only requests until a matching mutation settles it', () => {
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    const boundary = claimWhiteboardSessionBoundary(pending, 'session-new', 'qa', true).boundary;

    // A text-only response never calls the settlement helper, so the same token
    // remains available to the next request in this session.
    expect(boundary?.status).toBe('claimed');
    expect(
      settleClaimedWhiteboardSessionBoundary(boundary, 'session-new', 'boundary-1', 'consumed')
        ?.status,
    ).toBe('consumed');
  });

  it('rejects late or cross-session action settlement', () => {
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    const boundary = claimWhiteboardSessionBoundary(pending, 'session-new', 'qa', true).boundary;

    expect(
      settleClaimedWhiteboardSessionBoundary(boundary, 'session-later', 'boundary-1', 'consumed'),
    ).toBeUndefined();
    expect(
      settleClaimedWhiteboardSessionBoundary(boundary, 'session-new', 'boundary-old', 'consumed'),
    ).toBeUndefined();
  });

  it('does not expose boundary state to the non-Pi runtime', () => {
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    expect(claimWhiteboardSessionBoundary(pending, 'session-new', 'qa', false)).toEqual({
      pending: undefined,
    });
  });

  it('preserves an unclaimed manual-stop boundary across a scene change', () => {
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    const changed = reconcileWhiteboardBoundariesAfterSceneChange(pending, []);
    const claimed = claimWhiteboardSessionBoundary(changed.pending, 'session-new', 'qa', true);

    expect(changed.pending).toEqual(pending);
    expect(claimed.boundary).toMatchObject({
      boundaryId: 'boundary-1',
      sourceSessionId: 'session-old',
      targetSessionId: 'session-new',
      status: 'claimed',
    });
  });

  it('does not create a boundary for an ordinary scene change', () => {
    const changed = reconcileWhiteboardBoundariesAfterSceneChange(undefined, []);

    expect(changed.pending).toBeUndefined();
    expect(
      claimWhiteboardSessionBoundary(changed.pending, 'session-new', 'qa', true).boundary,
    ).toBeUndefined();
  });

  it('drops a claimed session boundary when the scene changes', () => {
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    const boundary = claimWhiteboardSessionBoundary(pending, 'session-new', 'qa', true).boundary;
    const changed = reconcileWhiteboardBoundariesAfterSceneChange(undefined, [
      makeSession({ id: 'session-new', whiteboardBoundary: boundary }),
    ]);

    expect(changed.sessions[0].whiteboardBoundary).toBeUndefined();
  });

  it('still discards a scene-preserved pending boundary when lecture starts next', () => {
    const pending = createPendingWhiteboardSessionBoundary('session-old', stage, 'boundary-1');
    const changed = reconcileWhiteboardBoundariesAfterSceneChange(pending, []);
    const lecture = claimWhiteboardSessionBoundary(changed.pending, 'lecture-1', 'lecture', true);

    expect(lecture).toEqual({ pending: undefined });
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
    const whiteboardBoundary = {
      boundaryId: 'boundary-1',
      sourceSessionId: 'session-old',
      targetSessionId: 'session-1',
      whiteboardId: 'wb-1',
      snapshotFingerprint: 'fingerprint',
      status: 'claimed' as const,
    };
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
        softCloseDeadline: 123,
        messages: [wrapUpMessage],
        whiteboardBoundary,
      }),
      followUpMessage,
      99,
    );

    expect(next.status).toBe('active');
    expect(next.endReason).toBeUndefined();
    expect(next.softCloseDeadline).toBeUndefined();
    expect(next.updatedAt).toBe(99);
    expect(next.messages).toEqual([wrapUpMessage, followUpMessage]);
    expect(next.whiteboardBoundary).toBe(whiteboardBoundary);
  });

  it('resumes without appending a message for explicit continue or input activity', () => {
    const session = makeSession({
      status: 'soft-closing',
      endReason: 'user_done',
      softCloseDeadline: 123,
    });

    const next = resumeSoftClosingSessionWithoutMessage(session, 99);

    expect(next).toMatchObject({
      status: 'active',
      endReason: undefined,
      softCloseDeadline: undefined,
      updatedAt: 99,
      messages: [],
    });
    expect(resumeSoftClosingSessionWithoutMessage(makeSession(), 99)).toBeUndefined();
  });
});

describe('soft-close registration arbitration', () => {
  it('allows exactly one path to claim a soft-close cycle', () => {
    const timer = setTimeout(() => undefined, 60_000);
    const registrations = new Map([['session-1', { token: 'cycle-1', deadline: 100, timer }]]);

    expect(takeSoftCloseRegistration(registrations, 'session-1', 'stale')).toBeUndefined();
    expect(takeSoftCloseRegistration(registrations, 'session-1', 'cycle-1')).toMatchObject({
      token: 'cycle-1',
      deadline: 100,
    });
    expect(takeSoftCloseRegistration(registrations, 'session-1', 'cycle-1')).toBeUndefined();
    expect(registrations.size).toBe(0);
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

describe('retireLiveRequestResources', () => {
  it('retires resources immediately but waits for an in-flight action to settle', async () => {
    const controller = new AbortController();
    let finishAction: (() => void) | undefined;
    const actionCompletion = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    const buffer = {
      shutdown: vi.fn(),
      waitForCurrentAction: vi.fn(() => actionCompletion),
    };
    const buffers = new Map([['session-1', buffer]]);

    let retirementSettled = false;
    const retirement = retireLiveRequestResources(controller, 'session-1', buffers).then(() => {
      retirementSettled = true;
    });

    expect(controller.signal.aborted).toBe(true);
    expect(buffer.shutdown).toHaveBeenCalledOnce();
    expect(buffers.has('session-1')).toBe(false);
    expect(retirementSettled).toBe(false);

    finishAction?.();
    await retirement;
    expect(retirementSettled).toBe(true);
  });
});

describe('shouldAwaitPresentationAction', () => {
  it('waits for shared whiteboard mutations without blocking on long media playback', () => {
    expect(shouldAwaitPresentationAction('wb_clear')).toBe(true);
    expect(shouldAwaitPresentationAction('wb_edit_code')).toBe(true);
    expect(shouldAwaitPresentationAction('play_video')).toBe(false);
  });
});

describe('runPiSingleRequest', () => {
  it('treats EOF without a done event as interrupted without waiting for drain', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'agent_start',
              data: {
                messageId: 'message-1',
                agentId: 'teacher-1',
                agentName: 'Teacher',
              },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const onIterationEnd = vi.fn(async () => {
      throw new Error('must not wait for a missing done event');
    });
    const clearAfterError = vi.fn();

    try {
      await runPiSingleRequest(
        'session-1',
        {
          messages: [],
          storeState: {},
          config: { agentIds: ['teacher-1'] },
          apiKey: '',
        } as unknown as ChatRequestTemplate,
        new AbortController(),
        'qa',
        () => ({ onEvent: vi.fn(), onIterationEnd }),
        clearAfterError,
        vi.fn(),
        vi.fn(),
        vi.fn(),
        { current: vi.fn() },
        (key) => key,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onIterationEnd).not.toHaveBeenCalled();
    expect(clearAfterError).toHaveBeenCalledWith('session-1', 'chat.error.streamInterrupted');
  });
});
