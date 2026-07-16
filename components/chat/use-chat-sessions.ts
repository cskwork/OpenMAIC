'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  ChatSession,
  SessionType,
  SessionStatus,
  ChatMessageMetadata,
  DirectorState,
  StatelessEvent,
  WhiteboardSessionBoundary,
} from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action, SpotlightAction, DiscussionAction } from '@/lib/types/action';
import type { UIMessage } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { USER_AVATAR } from '@/lib/types/roundtable';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import type { AgentStartItem, ActionItem } from '@/lib/buffer/stream-buffer';
import { runAgentLoop, type AgentLoopStoreState } from '@/lib/chat/agent-loop';
import { ActionEngine } from '@/lib/action/engine';
import { readSubmittedState } from '@/lib/quiz/persistence';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { isPiChatEnabled } from '@/lib/config/feature-flags';
import type { CleanupSource } from '@/lib/playback/auto-resume';
import { getActiveWhiteboardFingerprint } from '@/lib/chat/pi/whiteboard-boundary';
import { nanoid } from 'nanoid';
import type { Stage } from '@/lib/types/stage';

const log = createLogger('ChatSessions');
const SOFT_CLOSE_TIMEOUT_MS = 15_000;

export interface SoftCloseRegistration {
  token: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  endReason?: string;
  directorState?: DirectorState;
}

export function takeSoftCloseRegistration(
  registrations: Map<string, SoftCloseRegistration>,
  sessionId: string,
  expectedToken?: string,
): SoftCloseRegistration | undefined {
  const registration = registrations.get(sessionId);
  if (!registration || (expectedToken && registration.token !== expectedToken)) return undefined;
  registrations.delete(sessionId);
  clearTimeout(registration.timer);
  return registration;
}

/** Context used by playback cleanup and optional lecture auto-resume. */
export interface SessionCleanupPayload {
  sessionId: string;
  endReason?: string;
  source: CleanupSource;
}

export interface EndSessionOptions {
  source?: CleanupSource;
}

export const MANUAL_STOP_END_OPTIONS: EndSessionOptions = { source: 'manual_stop' };

export type PendingWhiteboardSessionBoundary = Omit<
  WhiteboardSessionBoundary,
  'targetSessionId' | 'status'
>;

export function createPendingWhiteboardSessionBoundary(
  sourceSessionId: string,
  stage: Stage | null | undefined,
  boundaryId: string = nanoid(),
): PendingWhiteboardSessionBoundary | undefined {
  const snapshot = getActiveWhiteboardFingerprint(stage);
  if (!snapshot) return undefined;
  return {
    boundaryId,
    sourceSessionId,
    whiteboardId: snapshot.whiteboardId,
    snapshotFingerprint: snapshot.fingerprint,
  };
}

export function claimWhiteboardSessionBoundary(
  pending: PendingWhiteboardSessionBoundary | undefined,
  sessionId: string,
  type: SessionType,
  piEnabled: boolean,
): { pending: undefined; boundary?: WhiteboardSessionBoundary } {
  if (!pending || !piEnabled || (type !== 'qa' && type !== 'discussion')) {
    return { pending: undefined };
  }
  return {
    pending: undefined,
    boundary: {
      ...pending,
      targetSessionId: sessionId,
      status: 'claimed',
    },
  };
}

export function settleClaimedWhiteboardSessionBoundary(
  boundary: WhiteboardSessionBoundary | undefined,
  sessionId: string,
  boundaryId: string,
  status: 'consumed' | 'invalidated',
): WhiteboardSessionBoundary | undefined {
  if (
    !boundary ||
    boundary.boundaryId !== boundaryId ||
    boundary.targetSessionId !== sessionId ||
    boundary.status !== 'claimed'
  ) {
    return undefined;
  }
  return { ...boundary, status };
}

export function reconcileWhiteboardBoundariesAfterSceneChange(
  pending: PendingWhiteboardSessionBoundary | undefined,
  sessions: ChatSession[],
): {
  pending: PendingWhiteboardSessionBoundary | undefined;
  sessions: ChatSession[];
} {
  return {
    pending,
    sessions: sessions.map((session) =>
      session.whiteboardBoundary ? { ...session, whiteboardBoundary: undefined } : session,
    ),
  };
}

/**
 * Hydrate post-submit quiz state for the active scene from localStorage so the
 * agent receives the student's actual answers and grader feedback. Returns
 * `undefined` when the active scene is not a quiz, the student has not submitted
 * yet, or the persisted blob is unreadable — `state-context.ts` then falls back
 * to the bare question summary.
 */
function buildQuizResultsForStoreState(
  scenes: { id: string; type?: string }[],
  currentSceneId: string | null,
):
  | {
      sceneId: string;
      answers: Record<string, string | string[]>;
      results: Array<{
        questionId: string;
        correct: boolean | null;
        status: 'correct' | 'incorrect';
        earned: number;
        aiComment?: string;
      }>;
    }
  | undefined {
  if (!currentSceneId) return undefined;
  const scene = scenes.find((s) => s.id === currentSceneId);
  if (!scene || scene.type !== 'quiz') return undefined;
  const submitted = readSubmittedState(currentSceneId);
  if (!submitted || submitted.kind !== 'reviewing') return undefined;
  return {
    sceneId: currentSceneId,
    answers: submitted.answers,
    results: submitted.results,
  };
}

interface UseChatSessionsOptions {
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onActiveBubble?: (messageId: string | null) => void;
  onLiveSessionError?: () => void;
  /** Called immediately when the server semantically closes a QA/Discussion session. */
  onSoftCloseSession?: (payload: SessionCleanupPayload) => void;
  /** Called when a QA/Discussion session completes naturally (director end). */
  onStopSession?: (payload: SessionCleanupPayload) => void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
  ) => void;
  /** When provided and returns true, StreamBuffer holds on the current text item after reveal. */
  shouldHoldAfterReveal?: () => { holding: boolean; segmentDone: number } | boolean;
}

export type ChatRequestTemplate = {
  messages: UIMessage<ChatMessageMetadata>[];
  storeState: Record<string, unknown>;
  config: {
    agentIds: string[];
    sessionType?: string;
    agentConfigs?: Record<string, unknown>[];
    piEnableWhiteboardTools?: boolean;
    [key: string]: unknown;
  };
  userProfile?: { nickname?: string; bio?: string };
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerType?: string;
  thinkingConfig?: ThinkingConfig;
  directorState?: DirectorState;
  whiteboardBoundary?: {
    boundaryId: string;
    sourceSessionId: string;
    targetSessionId: string;
    whiteboardId: string;
    snapshotFingerprint: string;
  };
};

export function withPiInclassWhiteboardTools(
  requestTemplate: ChatRequestTemplate,
): ChatRequestTemplate {
  return {
    ...requestTemplate,
    config: {
      ...requestTemplate.config,
      piEnableWhiteboardTools: true,
    },
  };
}

export function shouldAwaitPresentationAction(actionName: string): boolean {
  return actionName.startsWith('wb_');
}

export async function retireLiveRequestResources<
  T extends { shutdown(): void; waitForCurrentAction?(): Promise<void> },
>(
  controller: AbortController | null,
  sessionId: string | null,
  buffers: Map<string, T>,
): Promise<void> {
  controller?.abort();
  if (!sessionId) return;
  const buffer = buffers.get(sessionId);
  buffer?.shutdown();
  buffers.delete(sessionId);
  await buffer?.waitForCurrentAction?.();
}

type StatelessStreamConsumerFactory = (
  sessionId: string,
  controller: AbortController,
  sessionType: SessionType,
) => {
  onEvent: (event: StatelessEvent) => void;
  onIterationEnd: () => Promise<{
    directorState: DirectorState | undefined;
    totalAgents: number;
    agentHadContent: boolean;
    cueUserReceived?: boolean;
    sessionClosed?: boolean;
    endReason?: string;
  } | null>;
};

export function normalizeStoredSessionsForRestore(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((session) => {
    if (session.status === 'active') {
      return {
        ...session,
        status: 'interrupted' as SessionStatus,
        softCloseDeadline: undefined,
        whiteboardBoundary: undefined,
      };
    }
    if (session.status === 'soft-closing') {
      return {
        ...session,
        status: 'completed' as SessionStatus,
        softCloseDeadline: undefined,
        whiteboardBoundary: undefined,
      };
    }
    return session.whiteboardBoundary || session.softCloseDeadline
      ? { ...session, softCloseDeadline: undefined, whiteboardBoundary: undefined }
      : session;
  });
}

function isLiveSessionType(session: Pick<ChatSession, 'type'>): boolean {
  return session.type === 'qa' || session.type === 'discussion';
}

export function isOpenLiveSession(session: Pick<ChatSession, 'type' | 'status'>): boolean {
  return (
    isLiveSessionType(session) && (session.status === 'active' || session.status === 'soft-closing')
  );
}

export function resumeSoftClosingSessionForFollowUp(
  session: ChatSession,
  userMessage: UIMessage<ChatMessageMetadata>,
  now: number,
): ChatSession {
  return {
    ...session,
    messages: [...session.messages, userMessage],
    status: 'active' as SessionStatus,
    endReason: undefined,
    softCloseDeadline: undefined,
    updatedAt: now,
  };
}

export function resumeSoftClosingSessionWithoutMessage(
  session: ChatSession,
  now: number,
): ChatSession | undefined {
  if (session.status !== 'soft-closing') return undefined;
  return {
    ...session,
    status: 'active',
    endReason: undefined,
    softCloseDeadline: undefined,
    updatedAt: now,
  };
}

export type PiSingleRequestOutcome =
  | { type: 'error'; messageKey: 'chat.error.streamInterrupted' }
  | { type: 'soft_closing'; endReason?: string; directorState?: DirectorState }
  | { type: 'cue_user'; directorState?: DirectorState }
  | { type: 'completed'; directorState?: DirectorState };

export function getPiSingleRequestOutcome(
  doneData: Awaited<ReturnType<ReturnType<StatelessStreamConsumerFactory>['onIterationEnd']>>,
): PiSingleRequestOutcome {
  if (!doneData) {
    return { type: 'error', messageKey: 'chat.error.streamInterrupted' };
  }
  if (doneData.sessionClosed) {
    return {
      type: 'soft_closing',
      endReason: doneData.endReason,
      directorState: doneData.directorState,
    };
  }
  if (doneData.totalAgents === 0 || doneData.agentHadContent === false) {
    return { type: 'error', messageKey: 'chat.error.streamInterrupted' };
  }
  if (doneData.cueUserReceived) {
    return { type: 'cue_user', directorState: doneData.directorState };
  }
  return { type: 'completed', directorState: doneData.directorState };
}

export async function runPiSingleRequest(
  sessionId: string,
  requestTemplate: ChatRequestTemplate,
  controller: AbortController,
  sessionType: SessionType,
  createConsumer: StatelessStreamConsumerFactory,
  clearLiveSessionAfterError: (sessionId: string, message: string) => void,
  enterSoftClosing: (
    sessionId: string,
    data: { endReason?: string; directorState?: DirectorState },
  ) => void,
  markSessionCompleted: (
    sessionId: string,
    data?: { endReason?: string; directorState?: DirectorState },
  ) => void,
  storeDirectorState: (sessionId: string, directorState?: DirectorState) => void,
  onStopSessionRef: { current?: ((payload: SessionCleanupPayload) => void) | undefined },
  t: (key: string) => string,
): Promise<void> {
  const consumer = createConsumer(sessionId, controller, sessionType);
  const response = await fetch('/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestTemplate),
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`Pi chat request failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Pi chat response body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let sawDoneEvent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const parts = sseBuffer.split('\n\n');
    sseBuffer = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim() || part.startsWith(':')) continue;
      const dataLine = part.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6)) as StatelessEvent;
      if (event.type === 'done') sawDoneEvent = true;
      consumer.onEvent(event);
    }
  }

  const doneData = sawDoneEvent ? await consumer.onIterationEnd() : null;

  if (controller.signal.aborted) return;

  const outcome = getPiSingleRequestOutcome(doneData);
  if (outcome.type === 'error') {
    clearLiveSessionAfterError(sessionId, t(outcome.messageKey));
    onStopSessionRef.current?.({ sessionId, source: 'error' });
    return;
  }

  if (outcome.type === 'soft_closing') {
    enterSoftClosing(sessionId, {
      endReason: outcome.endReason,
      directorState: outcome.directorState,
    });
    return;
  }

  if (outcome.type === 'cue_user') {
    storeDirectorState(sessionId, outcome.directorState);
    return;
  }

  // The Pi endpoint owns the whole server-side loop; one successful done closes
  // this classroom turn instead of asking the frontend to POST another turn.
  markSessionCompleted(sessionId, { directorState: outcome.directorState });
  onStopSessionRef.current?.({ sessionId, source: 'turn_complete' });
}

export function useChatSessions(options: UseChatSessionsOptions = {}) {
  const onLiveSpeechRef = useRef(options.onLiveSpeech);
  const onSpeechProgressRef = useRef(options.onSpeechProgress);
  const onThinkingRef = useRef(options.onThinking);
  const onCueUserRef = useRef(options.onCueUser);
  const onActiveBubbleRef = useRef(options.onActiveBubble);
  const onLiveSessionErrorRef = useRef(options.onLiveSessionError);
  const onSoftCloseSessionRef = useRef(options.onSoftCloseSession);
  const onStopSessionRef = useRef(options.onStopSession);
  const onSegmentSealedRef = useRef(options.onSegmentSealed);
  const shouldHoldAfterRevealRef = useRef(options.shouldHoldAfterReveal);
  useEffect(() => {
    onLiveSpeechRef.current = options.onLiveSpeech;
    onSpeechProgressRef.current = options.onSpeechProgress;
    onThinkingRef.current = options.onThinking;
    onCueUserRef.current = options.onCueUser;
    onActiveBubbleRef.current = options.onActiveBubble;
    onLiveSessionErrorRef.current = options.onLiveSessionError;
    onSoftCloseSessionRef.current = options.onSoftCloseSession;
    onStopSessionRef.current = options.onStopSession;
    onSegmentSealedRef.current = options.onSegmentSealed;
    shouldHoldAfterRevealRef.current = options.shouldHoldAfterReveal;
  }, [
    options.onLiveSpeech,
    options.onSpeechProgress,
    options.onThinking,
    options.onCueUser,
    options.onActiveBubble,
    options.onLiveSessionError,
    options.onSoftCloseSession,
    options.onStopSession,
    options.onSegmentSealed,
    options.shouldHoldAfterReveal,
  ]);
  const { t } = useI18n();

  // Track current stageId for data isolation
  const stageId = useStageStore((s) => s.stage?.id);
  const stageIdRef = useRef(stageId);
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const currentSceneIdRef = useRef(currentSceneId);

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    // Restore sessions from store (loaded from IndexedDB)
    const stored = useStageStore.getState().chats;
    return normalizeStoredSessionsForRestore(stored);
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingSessionIdRef = useRef<string | null>(null);
  const softCloseRegistrationsRef = useRef<Map<string, SoftCloseRegistration>>(new Map());
  const softCloseLifecycleRef = useRef<Map<string, 'soft-closing' | 'active' | 'completed'>>(
    new Map(),
  );
  const sessionsRef = useRef<ChatSession[]>(sessions);
  const pendingWhiteboardBoundaryRef = useRef<PendingWhiteboardSessionBoundary | undefined>(
    undefined,
  );
  const whiteboardBoundariesRef = useRef<Map<string, WhiteboardSessionBoundary>>(new Map());
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Per-loop-iteration state — tracks done event data and cue_user for the agent loop
  const loopDoneDataRef = useRef<{
    directorState?: DirectorState;
    totalAgents: number;
    agentHadContent?: boolean;
    cueUserReceived: boolean;
    sessionClosed?: boolean;
    endReason?: string;
  } | null>(null);

  // Reload sessions when stage changes (course switch)
  // This synchronous setState is intentional: it resets derived state from
  // an external store (IndexedDB) when the stageId dependency changes.
  useEffect(() => {
    if (stageId === stageIdRef.current) return;
    stageIdRef.current = stageId;
    softCloseRegistrationsRef.current.forEach(({ timer }) => clearTimeout(timer));
    softCloseRegistrationsRef.current.clear();
    softCloseLifecycleRef.current.clear();
    // Stage changed — reload sessions from store (already populated by loadFromStorage)
    const stored = useStageStore.getState().chats;
    setSessions(normalizeStoredSessionsForRestore(stored));
    setActiveSessionId(null);
    setExpandedSessionIds(new Set());
    pendingWhiteboardBoundaryRef.current = undefined;
    whiteboardBoundariesRef.current.clear();
  }, [stageId]);

  useEffect(() => {
    if (currentSceneId === currentSceneIdRef.current) return;
    currentSceneIdRef.current = currentSceneId;
    // The stage whiteboard persists across slides. Preserve an unclaimed
    // manual-stop boundary so the next live session can clear the old topic,
    // while dropping tokens already bound to a session from the previous slide.
    whiteboardBoundariesRef.current.clear();
    const pendingBoundary = pendingWhiteboardBoundaryRef.current;
    setSessions(
      (prev) => reconcileWhiteboardBoundariesAfterSceneChange(pendingBoundary, prev).sessions,
    );
  }, [currentSceneId]);

  const settleWhiteboardBoundary = useCallback(
    (sessionId: string, boundaryId: string, status: 'consumed' | 'invalidated'): boolean => {
      const settled = settleClaimedWhiteboardSessionBoundary(
        whiteboardBoundariesRef.current.get(sessionId),
        sessionId,
        boundaryId,
        status,
      );
      if (!settled) return false;
      whiteboardBoundariesRef.current.set(sessionId, settled);
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, whiteboardBoundary: settled } : session,
        ),
      );
      return true;
    },
    [],
  );

  const claimPendingWhiteboardBoundary = useCallback(
    (sessionId: string, type: SessionType): WhiteboardSessionBoundary | undefined => {
      const claim = claimWhiteboardSessionBoundary(
        pendingWhiteboardBoundaryRef.current,
        sessionId,
        type,
        isPiChatEnabled(),
      );
      pendingWhiteboardBoundaryRef.current = claim.pending;
      if (claim.boundary) whiteboardBoundariesRef.current.set(sessionId, claim.boundary);
      return claim.boundary;
    },
    [],
  );

  // Sync sessions back to store for persistence (debounced via store's debouncedSave)
  // Guard: only write to the currently active stage
  useEffect(() => {
    if (stageIdRef.current && stageIdRef.current === useStageStore.getState().stage?.id) {
      useStageStore.getState().setChats(sessions);
    }
  }, [sessions]);

  // StreamBuffer instances per session (SSE + lecture share the same buffer model)
  const buffersRef = useRef<Map<string, StreamBuffer>>(new Map());
  const pendingRetirementRef = useRef<Promise<void>>(Promise.resolve());

  const retireActiveLiveRequest = useCallback(
    (fallbackSessionId?: string | null): string | null => {
      const interruptedSessionId = streamingSessionIdRef.current ?? fallbackSessionId ?? null;
      const previousRetirement = pendingRetirementRef.current;
      const retirement = retireLiveRequestResources(
        abortControllerRef.current,
        interruptedSessionId,
        buffersRef.current,
      );
      pendingRetirementRef.current = Promise.all([previousRetirement, retirement]).then(
        () => undefined,
      );
      abortControllerRef.current = null;
      streamingSessionIdRef.current = null;
      setIsStreaming(false);
      return interruptedSessionId;
    },
    [],
  );

  // Abort active stream and destroy buffers on unmount
  useEffect(() => {
    const buffers = buffersRef.current;
    const softCloseRegistrations = softCloseRegistrationsRef.current;
    const softCloseLifecycle = softCloseLifecycleRef.current;
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      softCloseRegistrations.forEach(({ timer }) => clearTimeout(timer));
      softCloseRegistrations.clear();
      softCloseLifecycle.clear();
      buffers.forEach((buf) => buf.shutdown());
      buffers.clear();
    };
  }, []);

  const claimSoftCloseRegistration = useCallback(
    (sessionId: string, expectedToken?: string): SoftCloseRegistration | undefined => {
      return takeSoftCloseRegistration(softCloseRegistrationsRef.current, sessionId, expectedToken);
    },
    [],
  );

  const clearSoftCloseRegistration = useCallback(
    (sessionId: string): boolean => {
      return Boolean(claimSoftCloseRegistration(sessionId));
    },
    [claimSoftCloseRegistration],
  );

  const markSessionCompleted = useCallback(
    (sessionId: string, data?: { endReason?: string; directorState?: DirectorState }) => {
      whiteboardBoundariesRef.current.delete(sessionId);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'completed' as SessionStatus,
                updatedAt: Date.now(),
                endReason: data?.endReason ?? s.endReason,
                softCloseDeadline: undefined,
                directorState: data?.directorState ?? s.directorState,
                whiteboardBoundary: undefined,
              }
            : s,
        ),
      );
    },
    [],
  );

  const finishSoftCloseTimeout = useCallback(
    (sessionId: string, expectedToken?: string): boolean => {
      const registration = claimSoftCloseRegistration(sessionId, expectedToken);
      if (!registration || softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing') {
        return false;
      }
      softCloseLifecycleRef.current.set(sessionId, 'completed');

      const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
      pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
        () => undefined,
      );
      markSessionCompleted(sessionId, {
        endReason: registration.endReason,
        directorState: registration.directorState,
      });
      onStopSessionRef.current?.({
        sessionId,
        endReason: registration.endReason,
        source: 'soft_close_timeout',
      });
      return true;
    },
    [claimSoftCloseRegistration, markSessionCompleted],
  );

  const storeDirectorState = useCallback((sessionId: string, directorState?: DirectorState) => {
    if (!directorState) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              directorState,
              updatedAt: Date.now(),
            }
          : s,
      ),
    );
  }, []);

  const enterSoftClosing = useCallback(
    (sessionId: string, data: { endReason?: string; directorState?: DirectorState }) => {
      clearSoftCloseRegistration(sessionId);
      const token = nanoid();
      const deadline = Date.now() + SOFT_CLOSE_TIMEOUT_MS;
      softCloseLifecycleRef.current.set(sessionId, 'soft-closing');
      // Entering the soft-closing window is NOT the timeout — only the 15s timer
      // firing below counts as soft_close_timeout (the auto-resume trigger).
      onSoftCloseSessionRef.current?.({
        sessionId,
        endReason: data.endReason,
        source: 'soft_close_enter',
      });
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'soft-closing' as SessionStatus,
                updatedAt: Date.now(),
                endReason: data.endReason ?? s.endReason,
                softCloseDeadline: deadline,
                directorState: data.directorState ?? s.directorState,
              }
            : s,
        ),
      );

      const timer = setTimeout(() => {
        finishSoftCloseTimeout(sessionId, token);
      }, SOFT_CLOSE_TIMEOUT_MS);

      softCloseRegistrationsRef.current.set(sessionId, {
        token,
        deadline,
        timer,
        endReason: data.endReason,
        directorState: data.directorState,
      });
    },
    [clearSoftCloseRegistration, finishSoftCloseTimeout],
  );

  useEffect(() => {
    const reconcileExpiredSoftClose = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      for (const [sessionId, registration] of softCloseRegistrationsRef.current) {
        if (now >= registration.deadline) {
          finishSoftCloseTimeout(sessionId, registration.token);
        }
      }
    };
    document.addEventListener('visibilitychange', reconcileExpiredSoftClose);
    return () => document.removeEventListener('visibilitychange', reconcileExpiredSoftClose);
  }, [finishSoftCloseTimeout]);

  // Session-scoped "paused intent" — survives buffer recreation across turns.
  // When true, newly created discussion/QA buffers are immediately paused.
  const livePausedRef = useRef(false);

  const clearLiveSessionAfterError = useCallback(
    (sessionId: string, message: string) => {
      const now = Date.now();
      const errorMessageId = `error-${now}`;
      whiteboardBoundariesRef.current.delete(sessionId);

      if (streamingSessionIdRef.current === sessionId) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'error' as SessionStatus,
                softCloseDeadline: undefined,
                whiteboardBoundary: undefined,
                updatedAt: now,
                messages: [
                  ...s.messages,
                  {
                    id: errorMessageId,
                    role: 'assistant' as const,
                    parts: [{ type: 'text', text: message }],
                    metadata: {
                      senderName: 'System',
                      originalRole: 'agent' as const,
                      createdAt: now,
                    },
                  },
                ],
              }
            : s,
        ),
      );

      onActiveBubbleRef.current?.(null);
      if (onLiveSessionErrorRef.current) {
        onLiveSessionErrorRef.current();
      } else {
        onSpeechProgressRef.current?.(null);
        onThinkingRef.current?.(null);
        onLiveSpeechRef.current?.(null, null);
      }
    },
    [retireActiveLiveRequest],
  );

  // Tracks the single message ID per lecture session
  const lectureMessageIds = useRef<Map<string, string>>(new Map());

  // Tracks last action index per lecture session (avoids stale closure reads)
  const lectureLastActionIndexRef = useRef<Map<string, number>>(new Map());

  const toggleSessionExpand = useCallback((sessionId: string) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  /**
   * Create a StreamBuffer for a session and wire its callbacks to React state.
   * Returns the buffer instance (also stored in buffersRef).
   */
  const createBufferForSession = useCallback(
    (sessionId: string, type?: SessionType): StreamBuffer => {
      // Dispose previous buffer if any
      // Shutdown (not dispose) — avoids stale onLiveSpeech(null,null) callback
      const prev = buffersRef.current.get(sessionId);
      if (prev) prev.shutdown();

      // For discussion/QA sessions, add pacing delays so fast models don't
      // rush through text and actions. Lecture pacing is handled by PlaybackEngine.
      const pacingOptions = type === 'lecture' ? {} : { postTextDelayMs: 1200, actionDelayMs: 800 };

      const buffer = new StreamBuffer(
        {
          onAgentStart(data: AgentStartItem) {
            const now = Date.now();
            const agentConfig = useAgentRegistry.getState().getAgent(data.agentId);
            const newMsg: UIMessage<ChatMessageMetadata> = {
              id: data.messageId,
              role: 'assistant',
              parts: [],
              metadata: {
                senderName: agentConfig?.name || data.agentName,
                senderAvatar: data.avatar || agentConfig?.avatar,
                originalRole: 'agent',
                agentId: data.agentId,
                createdAt: now,
              },
            };
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? { ...s, messages: [...s.messages, newMsg], updatedAt: now }
                  : s,
              ),
            );
            onActiveBubbleRef.current?.(data.messageId);
          },

          onAgentEnd() {
            // Remove empty assistant messages (agent started but produced no content)
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const msgs = s.messages.filter(
                  (m) => !(m.role === 'assistant' && m.parts.length === 0),
                );
                return msgs.length !== s.messages.length ? { ...s, messages: msgs } : s;
              }),
            );
          },

          onTextReveal(
            messageId: string,
            partId: string,
            revealedText: string,
            _isComplete: boolean,
          ) {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== messageId) return m;
                    const parts = [...m.parts];
                    // Match by _partId (supports multiple text parts per message, e.g. lecture)
                    const existingIdx = parts.findIndex(
                      (p) => (p as unknown as Record<string, unknown>)._partId === partId,
                    );
                    if (existingIdx >= 0) {
                      parts[existingIdx] = {
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                    } else {
                      parts.push({
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number]);
                    }
                    return { ...m, parts };
                  }),
                  // Don't update updatedAt on every tick — avoids thrashing persistence sync
                };
              }),
            );
          },

          async onActionReady(messageId: string, data: ActionItem, signal: AbortSignal) {
            const boundary = data.boundary;
            const getClaimedBoundary = () => {
              const current = whiteboardBoundariesRef.current.get(sessionId);
              return current?.status === 'claimed' &&
                current.boundaryId === boundary?.boundaryId &&
                current.targetSessionId === sessionId &&
                boundary.targetSessionId === sessionId
                ? current
                : undefined;
            };
            const matchesExpectedWhiteboard = () => {
              const snapshot = getActiveWhiteboardFingerprint(useStageStore.getState().stage);
              return Boolean(
                snapshot &&
                snapshot.whiteboardId === boundary?.expectedWhiteboardId &&
                snapshot.fingerprint === boundary?.expectedFingerprint,
              );
            };

            if (boundary?.disposition === 'guarded_clear' && !getClaimedBoundary()) return;
            if (boundary?.disposition === 'guarded_clear' && !matchesExpectedWhiteboard()) {
              settleWhiteboardBoundary(sessionId, boundary.boundaryId, 'invalidated');
              return;
            }

            // Boundary-generated clears are internal orchestration and should not
            // appear as a successful model action badge.
            if (boundary?.disposition !== 'guarded_clear') {
              const actionPart = {
                type: `action-${data.actionName}`,
                actionId: data.actionId,
                actionName: data.actionName,
                input: data.params,
                state: 'result',
                output: { success: true },
              } as unknown as UIMessage<ChatMessageMetadata>['parts'][number];
              setSessions((prev) =>
                prev.map((s) => {
                  if (s.id !== sessionId) return s;
                  return {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === messageId ? { ...m, parts: [...m.parts, actionPart] } : m,
                    ),
                    updatedAt: Date.now(),
                  };
                }),
              );
            }

            // Whiteboard effects mutate shared stage state after animation delays,
            // so keep them ordered. Long-running media playback stays interruptible.
            let completed = false;
            let guardRejected = false;
            try {
              const actionEngine = new ActionEngine(useStageStore);
              const action = {
                id: data.actionId,
                type: data.actionName,
                ...data.params,
              } as Action;
              const execution = actionEngine.execute(action, {
                signal,
                whiteboardClearGuard:
                  boundary?.disposition === 'guarded_clear'
                    ? () => !signal.aborted && matchesExpectedWhiteboard()
                    : undefined,
                onWhiteboardClearGuardRejected:
                  boundary?.disposition === 'guarded_clear'
                    ? () => {
                        guardRejected = true;
                      }
                    : undefined,
              });
              if (shouldAwaitPresentationAction(data.actionName)) {
                await execution;
                completed = !signal.aborted;
              } else {
                void execution.catch((err) => log.warn('[Buffer] Action execution error:', err));
              }
            } catch (err) {
              log.warn('[Buffer] Action execution error:', err);
            }

            if (!boundary || !getClaimedBoundary()) return;
            if (boundary.disposition === 'guarded_clear') {
              const snapshot = getActiveWhiteboardFingerprint(useStageStore.getState().stage);
              if (guardRejected && signal.aborted && matchesExpectedWhiteboard()) {
                return;
              }
              if (
                guardRejected ||
                !snapshot ||
                snapshot.whiteboardId !== boundary.expectedWhiteboardId
              ) {
                settleWhiteboardBoundary(sessionId, boundary.boundaryId, 'invalidated');
              } else if (completed && snapshot.elementCount === 0) {
                settleWhiteboardBoundary(sessionId, boundary.boundaryId, 'consumed');
              } else if (snapshot.fingerprint !== boundary.expectedFingerprint) {
                settleWhiteboardBoundary(sessionId, boundary.boundaryId, 'invalidated');
              }
              return;
            }
            if (completed) {
              settleWhiteboardBoundary(
                sessionId,
                boundary.boundaryId,
                boundary.disposition === 'invalidate' ? 'invalidated' : 'consumed',
              );
            }
          },

          onLiveSpeech(text: string | null, agentId: string | null) {
            // Lecture sessions: roundtable text is managed by PlaybackEngine → setLectureSpeech
            // in stage.tsx. Buffer only drives chat area pacing for lectures.
            if (type === 'lecture') return;
            onLiveSpeechRef.current?.(text, agentId);
          },

          onSpeechProgress(ratio: number | null) {
            onSpeechProgressRef.current?.(ratio);
          },

          onThinking(data: { stage: string; agentId?: string } | null) {
            onThinkingRef.current?.(data);
          },

          onCueUser(fromAgentId?: string, prompt?: string) {
            // Track cue_user for agent loop
            if (loopDoneDataRef.current) {
              loopDoneDataRef.current.cueUserReceived = true;
            } else {
              loopDoneDataRef.current = {
                totalAgents: 0,
                cueUserReceived: true,
              };
            }
            onCueUserRef.current?.(fromAgentId, prompt);
          },

          onDone(data: {
            totalActions: number;
            totalAgents: number;
            agentHadContent?: boolean;
            cueUserReceived?: boolean;
            sessionClosed?: boolean;
            endReason?: string;
            directorState?: DirectorState;
          }) {
            // Store done data for agent loop consumption
            loopDoneDataRef.current = {
              directorState: data.directorState,
              totalAgents: data.totalAgents,
              agentHadContent: data.agentHadContent ?? true,
              cueUserReceived:
                data.cueUserReceived ?? loopDoneDataRef.current?.cueUserReceived ?? false,
              sessionClosed: data.sessionClosed,
              endReason: data.endReason,
            };
            // Session completion is handled by runAgentLoopFn, not here
            // (Lectures don't use the agent loop and complete via endSession)
          },

          onError(message: string) {
            log.error('[Buffer] Stream error:', message);
          },

          onSegmentSealed(
            messageId: string,
            partId: string,
            fullText: string,
            agentId: string | null,
          ) {
            onSegmentSealedRef.current?.(messageId, partId, fullText, agentId);
          },

          shouldHoldAfterReveal() {
            return shouldHoldAfterRevealRef.current?.() ?? (false as const);
          },
        },
        pacingOptions,
      );

      buffersRef.current.set(sessionId, buffer);
      buffer.start();

      // Inherit paused intent for discussion/QA sessions so new-turn buffers
      // don't start revealing text while the user has paused reading.
      if (type !== 'lecture' && livePausedRef.current) {
        buffer.pause();
      }

      return buffer;
    },
    [settleWhiteboardBoundary],
  );

  const createStatelessStreamConsumer = useCallback(
    (sessionId: string, controller: AbortController, sessionType: SessionType) => {
      let currentBuffer: StreamBuffer | null = null;
      let currentMessageId: string | null = null;

      const onEvent = (event: StatelessEvent) => {
        if (!currentBuffer) {
          currentBuffer = createBufferForSession(sessionId, sessionType);
        }

        switch (event.type) {
          case 'agent_start': {
            const { messageId, agentId, agentName, agentAvatar, agentColor } = event.data;
            currentMessageId = messageId;
            currentBuffer.pushAgentStart({
              messageId,
              agentId,
              agentName,
              avatar: agentAvatar,
              color: agentColor,
            });
            break;
          }
          case 'agent_end': {
            currentBuffer.pushAgentEnd({
              messageId: event.data.messageId,
              agentId: event.data.agentId,
            });
            break;
          }
          case 'text_delta': {
            const targetId = event.data.messageId ?? currentMessageId;
            if (!targetId) break;
            currentBuffer.pushText(targetId, event.data.content);
            break;
          }
          case 'action': {
            const targetId = event.data.messageId ?? currentMessageId;
            if (!targetId) break;
            if (controller.signal.aborted) break;
            currentBuffer.pushAction({
              actionId: event.data.actionId,
              actionName: event.data.actionName,
              params: event.data.params,
              messageId: targetId,
              agentId: event.data.agentId,
              boundary: event.data.boundary,
            });
            break;
          }
          case 'thinking':
            currentBuffer.pushThinking(event.data);
            break;
          case 'cue_user':
            currentBuffer.pushCueUser(event.data);
            break;
          case 'done':
            currentBuffer.pushDone(event.data);
            break;
          case 'error':
            currentBuffer.pushError(event.data.message);
            throw new Error(event.data.message);
        }
      };

      const onIterationEnd = async () => {
        if (!currentBuffer) return null;

        try {
          await currentBuffer.waitUntilDrained();
        } catch {
          currentBuffer = null;
          return null;
        }

        currentBuffer = null;

        const doneData = loopDoneDataRef.current;
        loopDoneDataRef.current = null;

        if (!doneData) return null;
        return {
          directorState: doneData.directorState,
          totalAgents: doneData.totalAgents,
          agentHadContent: doneData.agentHadContent ?? true,
          cueUserReceived: doneData.cueUserReceived,
          sessionClosed: doneData.sessionClosed,
          endReason: doneData.endReason,
        };
      };

      return { onEvent, onIterationEnd };
    },
    [createBufferForSession],
  );

  /**
   * Frontend-driven agent loop. Delegates to the shared runAgentLoop
   * from lib/chat/agent-loop.ts, wiring StreamBuffer for UI pacing.
   *
   * Each iteration: POST /api/chat → process SSE → wait for buffer drain → check outcome.
   */
  const runAgentLoopFn = useCallback(
    async (
      sessionId: string,
      requestTemplate: ChatRequestTemplate,
      controller: AbortController,
      sessionType: SessionType,
    ): Promise<void> => {
      // Attach full configs for generated (non-default) agents so the server can use them.
      // The server-side registry only has default agents; generated agents exist only client-side.
      const generatedConfigs = requestTemplate.config.agentIds
        .filter((id: string) => !id.startsWith('default-'))
        .map((id: string) => useAgentRegistry.getState().getAgent(id))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map(({ createdAt: _c, updatedAt: _u, isDefault: _d, ...rest }) => rest);
      if (generatedConfigs.length > 0) {
        requestTemplate.config.agentConfigs = generatedConfigs;
      }

      if (isPiChatEnabled()) {
        const boundary = whiteboardBoundariesRef.current.get(sessionId);
        if (boundary?.status === 'claimed') {
          requestTemplate.whiteboardBoundary = {
            boundaryId: boundary.boundaryId,
            sourceSessionId: boundary.sourceSessionId,
            targetSessionId: boundary.targetSessionId,
            whiteboardId: boundary.whiteboardId,
            snapshotFingerprint: boundary.snapshotFingerprint,
          };
        } else {
          delete requestTemplate.whiteboardBoundary;
        }
        await runPiSingleRequest(
          sessionId,
          withPiInclassWhiteboardTools(requestTemplate),
          controller,
          sessionType,
          createStatelessStreamConsumer,
          clearLiveSessionAfterError,
          enterSoftClosing,
          markSessionCompleted,
          storeDirectorState,
          onStopSessionRef,
          t,
        );
        return;
      }

      const streamConsumer = createStatelessStreamConsumer(sessionId, controller, sessionType);

      const outcome = await runAgentLoop(
        {
          config: requestTemplate.config,
          userProfile: requestTemplate.userProfile,
          apiKey: requestTemplate.apiKey,
          baseUrl: requestTemplate.baseUrl,
          model: requestTemplate.model,
          providerType: requestTemplate.providerType,
          thinkingConfig: requestTemplate.thinkingConfig,
        },
        {
          getStoreState: (): AgentLoopStoreState => {
            const freshState = useStageStore.getState();
            return {
              stage: freshState.stage,
              scenes: freshState.scenes,
              currentSceneId: freshState.currentSceneId,
              mode: freshState.mode,
              whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
              quizResults: buildQuizResultsForStoreState(
                freshState.scenes,
                freshState.currentSceneId,
              ),
            };
          },

          getMessages: () => {
            const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
            return currentSession?.messages ?? requestTemplate.messages;
          },

          fetchChat: (body, signal) =>
            fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal,
            }),

          onEvent: streamConsumer.onEvent,
          onIterationEnd: streamConsumer.onIterationEnd,
        },
        controller.signal,
      );

      // Handle loop completion (UI-specific). Map each outcome.reason to a
      // distinct session state — don't conflate error paths with completion.
      if (!controller.signal.aborted) {
        switch (outcome.reason) {
          case 'cue_user':
            // Session stays active; UI waits for the next user message.
            break;
          case 'end':
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? { ...s, status: 'completed' as SessionStatus, updatedAt: Date.now() }
                  : s,
              ),
            );
            onStopSessionRef.current?.({ sessionId, source: 'turn_complete' });
            break;
          case 'empty_turns':
            clearLiveSessionAfterError(sessionId, t('chat.error.emptyAgentResponses'));
            onStopSessionRef.current?.({ sessionId, source: 'error' });
            break;
          case 'no_done':
            clearLiveSessionAfterError(sessionId, t('chat.error.streamInterrupted'));
            onStopSessionRef.current?.({ sessionId, source: 'error' });
            break;
          case 'aborted':
            // Already handled elsewhere via abort signal.
            break;
        }
      }
    },
    [
      clearLiveSessionAfterError,
      createStatelessStreamConsumer,
      enterSoftClosing,
      markSessionCompleted,
      storeDirectorState,
      t,
    ],
  );

  /**
   * Create a new chat session
   */
  const createSession = useCallback(
    async (type: SessionType, title: string): Promise<string> => {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();

      const whiteboardBoundary = claimPendingWhiteboardBoundary(sessionId, type);
      const newSession: ChatSession = {
        id: sessionId,
        type,
        title,
        status: 'active',
        messages: [],
        config: {
          agentIds: ['default-1'],
          defaultAgentId: 'default-1',
        },
        toolCalls: [],
        pendingToolCalls: [],
        createdAt: now,
        updatedAt: now,
        whiteboardBoundary,
      };

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      log.info(`[ChatArea] Created session: ${sessionId} (${type})`);
      return sessionId;
    },
    [claimPendingWhiteboardBoundary],
  );

  /**
   * End a chat session.
   * For QA/Discussion sessions with active streaming, appends "..." + interrupted marker.
   */
  const endSession = useCallback(
    async (sessionId: string, options: EndSessionOptions = {}): Promise<void> => {
      log.info(`[ChatArea] Ending session: ${sessionId}`);
      clearSoftCloseRegistration(sessionId);
      softCloseLifecycleRef.current.set(sessionId, 'completed');
      livePausedRef.current = false;

      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const isLiveSession = session && (session.type === 'qa' || session.type === 'discussion');
      const wasStreaming = !!(
        abortControllerRef.current && streamingSessionIdRef.current === sessionId
      );

      // Retire presentation work before callers start another session. An action
      // already inside ActionEngine cannot be cancelled, so wait for it to settle.
      if (wasStreaming) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }
      await pendingRetirementRef.current;
      whiteboardBoundariesRef.current.delete(sessionId);
      if (options.source === 'manual_stop' && isLiveSession && isPiChatEnabled()) {
        pendingWhiteboardBoundaryRef.current = createPendingWhiteboardSessionBoundary(
          sessionId,
          useStageStore.getState().stage,
        );
      }
      lectureMessageIds.current.delete(sessionId);
      lectureLastActionIndexRef.current.delete(sessionId);

      if (isLiveSession && wasStreaming) {
        // Append "..." + interrupted marker to last assistant message
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'assistant') {
                const parts = [...messages[i].parts];
                let appended = false;
                for (let j = parts.length - 1; j >= 0; j--) {
                  if (parts[j].type === 'text') {
                    const textPart = parts[j] as { type: 'text'; text: string };
                    parts[j] = {
                      type: 'text',
                      text: (textPart.text || '') + '...',
                    } as UIMessage<ChatMessageMetadata>['parts'][number];
                    appended = true;
                    break;
                  }
                }
                if (!appended) {
                  parts.push({
                    type: 'text',
                    text: '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number]);
                }
                messages[i] = {
                  ...messages[i],
                  parts,
                  metadata: { ...messages[i].metadata, interrupted: true },
                };
                break;
              }
            }
            return {
              ...s,
              messages,
              status: 'completed' as SessionStatus,
              softCloseDeadline: undefined,
              whiteboardBoundary: undefined,
            };
          }),
        );
        // Clear roundtable state via callbacks
        onLiveSpeechRef.current?.(null, null);
        onThinkingRef.current?.(null);
      } else {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  status: 'completed' as SessionStatus,
                  softCloseDeadline: undefined,
                  whiteboardBoundary: undefined,
                }
              : s,
          ),
        );
      }

      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
    [activeSessionId, clearSoftCloseRegistration, retireActiveLiveRequest],
  );

  const continueSoftClosingSession = useCallback(
    (sessionId: string): boolean => {
      if (
        softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing' ||
        !claimSoftCloseRegistration(sessionId)
      ) {
        return false;
      }
      softCloseLifecycleRef.current.set(sessionId, 'active');
      const now = Date.now();
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? (resumeSoftClosingSessionWithoutMessage(session, now) ?? session)
            : session,
        ),
      );
      return true;
    },
    [claimSoftCloseRegistration],
  );

  const confirmSoftClosingSession = useCallback(
    async (sessionId: string): Promise<SessionCleanupPayload | undefined> => {
      const registration = claimSoftCloseRegistration(sessionId);
      if (!registration || softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing') {
        return undefined;
      }
      softCloseLifecycleRef.current.set(sessionId, 'completed');
      const payload: SessionCleanupPayload = {
        sessionId,
        endReason: registration.endReason,
        source: 'soft_close_confirmed',
      };
      await endSession(sessionId, { source: 'soft_close_confirmed' });
      return payload;
    },
    [claimSoftCloseRegistration, endSession],
  );

  /**
   * End the currently active QA/Discussion session (if any).
   */
  const endActiveSession = useCallback(
    async (options: EndSessionOptions = {}): Promise<void> => {
      const active = sessionsRef.current.find(isOpenLiveSession);
      if (active) {
        await endSession(active.id, options);
      }
    },
    [endSession],
  );

  /**
   * Soft-pause the active QA/Discussion session.
   * Aborts SSE and appends "..." + interrupted marker, but keeps session 'active'
   * so the user can continue speaking in the same topic.
   */
  const softPauseSession = useCallback(
    async (sessionId: string): Promise<void> => {
      livePausedRef.current = false;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const isLiveSession = session.type === 'qa' || session.type === 'discussion';
      if (!isLiveSession || session.status !== 'active') return;

      const wasStreaming = !!(
        abortControllerRef.current && streamingSessionIdRef.current === sessionId
      );

      if (wasStreaming) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }
      await pendingRetirementRef.current;

      if (wasStreaming) {
        // Append "..." + interrupted marker to last assistant message, keep status 'active'
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'assistant') {
                const parts = [...messages[i].parts];
                let appended = false;
                for (let j = parts.length - 1; j >= 0; j--) {
                  if (parts[j].type === 'text') {
                    const textPart = parts[j] as { type: 'text'; text: string };
                    parts[j] = {
                      type: 'text',
                      text: (textPart.text || '') + '...',
                    } as UIMessage<ChatMessageMetadata>['parts'][number];
                    appended = true;
                    break;
                  }
                }
                if (!appended) {
                  parts.push({
                    type: 'text',
                    text: '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number]);
                }
                messages[i] = {
                  ...messages[i],
                  parts,
                  metadata: { ...messages[i].metadata, interrupted: true },
                };
                break;
              }
            }
            // Keep status 'active' — session continues when user speaks
            return { ...s, messages, updatedAt: Date.now() };
          }),
        );
        // Note: Do NOT call onLiveSpeech/onThinking here.
        // Caller (doSoftPause) manages roundtable state to keep the interrupted bubble visible.
      }

      log.info(`[ChatArea] Soft-paused session: ${sessionId}`);
    },
    [retireActiveLiveRequest],
  );

  /**
   * Soft-pause the currently active QA/Discussion session (if any).
   */
  const softPauseActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (active) {
      await softPauseSession(active.id);
    }
  }, [softPauseSession]);

  /**
   * Resume a soft-paused session by re-calling /chat with existing messages.
   * The director will pick the next agent to continue the topic.
   */
  const resumeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session || session.status !== 'active') return;

      await pendingRetirementRef.current;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const currentState = useStageStore.getState();

      try {
        log.info(`[ChatArea] Resuming session: ${sessionId}`);

        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        const agentIds =
          useSettingsStore.getState().selectedAgentIds?.length > 0
            ? useSettingsStore.getState().selectedAgentIds
            : session.config.agentIds;

        await runAgentLoopFn(
          sessionId,
          {
            messages: session.messages,
            storeState: {
              stage: currentState.stage,
              scenes: currentState.scenes,
              currentSceneId: currentState.currentSceneId,
              mode: currentState.mode,
              whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
              quizResults: buildQuizResultsForStoreState(
                currentState.scenes,
                currentState.currentSceneId,
              ),
            },
            config: {
              agentIds,
              sessionType: session.type,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            apiKey: mc.apiKey,
            baseUrl: mc.baseUrl,
            model: mc.modelString,
            providerType: mc.providerType,
            thinkingConfig: mc.thinkingConfig,
            directorState: session.directorState,
          },
          controller,
          session.type,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Resume aborted');
          return;
        }
        log.error('[ChatArea] Resume error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [clearLiveSessionAfterError, runAgentLoopFn],
  );

  /**
   * Resume the currently active soft-paused session (if any).
   */
  const resumeActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (active) {
      await resumeSession(active.id);
    }
  }, [resumeSession]);

  /**
   * Send a message to the active session
   */
  const sendMessage = useCallback(
    async (content: string): Promise<void> => {
      let sessionId = activeSessionId;

      // Interrupt active generation: abort stream and append "..." to the last agent message
      if (abortControllerRef.current) {
        const interruptedSessionId = retireActiveLiveRequest(sessionId);
        const interruptedMessageSessionId = interruptedSessionId ?? sessionId;

        if (interruptedMessageSessionId) {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== interruptedMessageSessionId) return s;
              const messages = [...s.messages];
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant') {
                  const parts = [...messages[i].parts];
                  for (let j = parts.length - 1; j >= 0; j--) {
                    if (parts[j].type === 'text') {
                      const textPart = parts[j] as {
                        type: 'text';
                        text: string;
                      };
                      parts[j] = {
                        type: 'text',
                        text: (textPart.text || '') + '...',
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                      messages[i] = { ...messages[i], parts };
                      return { ...s, messages, updatedAt: Date.now() };
                    }
                  }
                  break;
                }
              }
              return s;
            }),
          );
        }
      }

      // An interrupted action may still be finishing a delayed state mutation.
      // Capture the next request only after that mutation has settled.
      await pendingRetirementRef.current;

      // Validate model configuration before sending
      const modelConfig = getCurrentModelConfig();
      if (!modelConfig.modelId) {
        toast.error(t('settings.modelNotConfigured'));
        return;
      }
      if (modelConfig.requiresApiKey && !modelConfig.apiKey && !modelConfig.isServerConfigured) {
        toast.error(t('settings.setupNeeded'), {
          description: t('settings.apiKeyDesc'),
        });
        return;
      }

      // Create a new session when there's no active QA session to append to.
      // A completed session should NOT be reused — start a fresh one instead.
      const activeSession = sessionsRef.current.find((s) => s.id === sessionId);
      const needNewSession =
        !sessionId || activeSession?.type === 'lecture' || activeSession?.status === 'completed';

      if (needNewSession) {
        // End all active QA/Discussion sessions before creating new one
        const activeQAOrDiscussion = sessionsRef.current.filter(isOpenLiveSession);
        for (const session of activeQAOrDiscussion) {
          await endSession(session.id);
        }
        sessionId = await createSession('qa', 'Q&A');
      } else if (sessionId && activeSession?.status === 'soft-closing') {
        if (claimSoftCloseRegistration(sessionId)) {
          softCloseLifecycleRef.current.set(sessionId, 'active');
        } else {
          const lifecycle = softCloseLifecycleRef.current.get(sessionId);
          if (lifecycle === 'completed') {
            sessionId = await createSession('qa', 'Q&A');
          } else if (lifecycle !== 'active') {
            return;
          }
        }
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const now = Date.now();
      const userMessageId = `user-${now}`;

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const agentIds: string[] =
        settingsState.selectedAgentIds?.length > 0 ? settingsState.selectedAgentIds : ['default-1'];

      const userMessage: UIMessage<ChatMessageMetadata> = {
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: content }],
        metadata: {
          senderName: t('common.you'),
          senderAvatar: USER_AVATAR,
          originalRole: 'user',
          createdAt: now,
        },
      };

      // Read current session data from ref (avoids stale closure AND keeps updater pure)
      const existingSession = sessionsRef.current.find((s) => s.id === sessionId);
      const sessionMessages: UIMessage<ChatMessageMetadata>[] = existingSession
        ? [...existingSession.messages, userMessage]
        : [userMessage];
      const sessionType: SessionType = existingSession?.type || 'qa';

      // Pure updater — no side effects
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === sessionId);
        if (exists) {
          return prev.map((s) =>
            s.id === sessionId ? resumeSoftClosingSessionForFollowUp(s, userMessage, now) : s,
          );
        } else {
          const newSession: ChatSession = {
            id: sessionId!,
            type: 'qa',
            title: 'Q&A',
            status: 'active',
            messages: [userMessage],
            config: {
              agentIds,
              defaultAgentId: agentIds[0],
            },
            toolCalls: [],
            pendingToolCalls: [],
            createdAt: now,
            updatedAt: now,
            whiteboardBoundary: whiteboardBoundariesRef.current.get(sessionId!),
          };
          return [...prev, newSession];
        }
      });

      const currentState = useStageStore.getState();

      try {
        log.info(
          `[ChatArea] Sending message: "${content.slice(0, 50)}..." agents: ${agentIds.join(', ')}`,
        );

        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        await runAgentLoopFn(
          sessionId!,
          {
            messages: sessionMessages,
            storeState: {
              stage: currentState.stage,
              scenes: currentState.scenes,
              currentSceneId: currentState.currentSceneId,
              mode: currentState.mode,
              whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
              quizResults: buildQuizResultsForStoreState(
                currentState.scenes,
                currentState.currentSceneId,
              ),
            },
            config: {
              agentIds,
              sessionType,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            apiKey: mc.apiKey,
            baseUrl: mc.baseUrl,
            model: mc.modelString,
            providerType: mc.providerType,
            thinkingConfig: mc.thinkingConfig,
            directorState: existingSession?.directorState,
          },
          controller,
          sessionType,
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Request aborted by user');
          return;
        }

        log.error('[ChatArea] Error:', error);
        clearLiveSessionAfterError(
          sessionId!,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [
      activeSessionId,
      clearLiveSessionAfterError,
      createSession,
      endSession,
      claimSoftCloseRegistration,
      retireActiveLiveRequest,
      runAgentLoopFn,
      t,
    ],
  );

  /**
   * Start a discussion with agent speaking first
   */
  const startDiscussion = useCallback(
    async (request: DiscussionRequest): Promise<void> => {
      log.info(`[ChatArea] Starting discussion: "${request.topic}"`);
      // Explicitly clear buffer-pause intent (also cleared transitively via endSession,
      // but being explicit guards against future refactors)
      livePausedRef.current = false;

      // Validate model configuration before starting discussion
      const modelConfig = getCurrentModelConfig();
      if (!modelConfig.modelId) {
        toast.error(t('settings.modelNotConfigured'));
        return;
      }
      if (modelConfig.requiresApiKey && !modelConfig.apiKey && !modelConfig.isServerConfigured) {
        toast.error(t('settings.setupNeeded'), {
          description: t('settings.apiKeyDesc'),
        });
        return;
      }

      // Auto-end previous active QA/Discussion sessions to ensure only one is active
      const activeQAOrDiscussion = sessionsRef.current.filter(isOpenLiveSession);
      for (const session of activeQAOrDiscussion) {
        await endSession(session.id);
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const agentId = request.agentId || 'default-1';

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const agentIds: string[] =
        settingsState.selectedAgentIds?.length > 0
          ? [...settingsState.selectedAgentIds]
          : [agentId];
      // Ensure the trigger agent is included
      if (!agentIds.includes(agentId)) {
        agentIds.unshift(agentId);
      }

      // No pre-created assistant message — agent_start events create them dynamically
      const newSession: ChatSession = {
        id: sessionId,
        type: 'discussion',
        title: request.topic,
        status: 'active',
        messages: [],
        config: {
          agentIds,
          triggerAgentId: agentId,
        },
        toolCalls: [],
        pendingToolCalls: [],
        createdAt: now,
        updatedAt: now,
        whiteboardBoundary: claimPendingWhiteboardBoundary(sessionId, 'discussion'),
      };

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const currentState = useStageStore.getState();

      try {
        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        await runAgentLoopFn(
          sessionId,
          {
            messages: [],
            storeState: {
              stage: currentState.stage,
              scenes: currentState.scenes,
              currentSceneId: currentState.currentSceneId,
              mode: currentState.mode,
              whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
              quizResults: buildQuizResultsForStoreState(
                currentState.scenes,
                currentState.currentSceneId,
              ),
            },
            config: {
              agentIds,
              sessionType: 'discussion',
              discussionTopic: request.topic,
              discussionPrompt: request.prompt,
              triggerAgentId: agentId,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            apiKey: mc.apiKey,
            baseUrl: mc.baseUrl,
            model: mc.modelString,
            providerType: mc.providerType,
            thinkingConfig: mc.thinkingConfig,
          },
          controller,
          'discussion',
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Discussion aborted by user');
          return;
        }

        log.error('[ChatArea] Discussion error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error starting discussion: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from i18n context
    [claimPendingWhiteboardBoundary, clearLiveSessionAfterError, endSession, runAgentLoopFn],
  );

  /**
   * Handle interruption
   */
  const handleInterrupt = useCallback(() => {
    if (!abortControllerRef.current) return;

    log.info('[ChatArea] Interrupting active request');
    retireActiveLiveRequest(activeSessionId);
  }, [activeSessionId, retireActiveLiveRequest]);

  /**
   * Start a lecture session for a scene.
   * Creates a single assistant message that all actions will be appended to.
   * Deduplicates: returns existing active lecture session for the same sceneId if found.
   */
  const startLecture = useCallback(
    async (sceneId: string): Promise<string> => {
      // A lecture is the next session boundary even though it does not claim a Pi
      // token. Do not let an earlier manual-stop token leak past it into a later QA.
      pendingWhiteboardBoundaryRef.current = undefined;
      // Check for existing lecture session with same sceneId (active or completed)
      const existing = sessions.find(
        (s) =>
          s.type === 'lecture' &&
          s.sceneId === sceneId &&
          (s.status === 'active' || s.status === 'completed'),
      );
      if (existing) {
        // Reactivate a completed session so the chat panel shows it as active again.
        // Actions won't be re-appended because lastActionIndex already covers them.
        if (existing.status === 'completed') {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === existing.id ? { ...s, status: 'active' as SessionStatus } : s,
            ),
          );
          // Restore lecture tracking refs (cleared by endSession)
          const messageId = existing.messages[0]?.id;
          if (messageId) {
            lectureMessageIds.current.set(existing.id, messageId);
          }
          if (existing.lastActionIndex !== undefined) {
            lectureLastActionIndexRef.current.set(existing.id, existing.lastActionIndex);
          }
        }
        setActiveSessionId(existing.id);
        setExpandedSessionIds((prev) => new Set([...prev, existing.id]));
        return existing.id;
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const messageId = `lecture-msg-${now}`;

      const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
      const title = scene?.title || t('chat.lecture');

      const agentConfig = useAgentRegistry.getState().getAgent('default-1');

      // Create session with a single assistant message (all actions append parts here)
      const lectureMessage: UIMessage<ChatMessageMetadata> = {
        id: messageId,
        role: 'assistant',
        parts: [],
        metadata: {
          senderName: agentConfig?.name || t('settings.agentNames.default-1'),
          senderAvatar: agentConfig?.avatar,
          originalRole: 'teacher',
          agentId: 'default-1',
          createdAt: now,
        },
      };

      const newSession: ChatSession = {
        id: sessionId,
        type: 'lecture',
        title,
        status: 'active',
        messages: [lectureMessage],
        config: {
          agentIds: ['default-1'],
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId,
        lastActionIndex: -1,
        createdAt: now,
        updatedAt: now,
      };

      lectureMessageIds.current.set(sessionId, messageId);

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      log.info(`[ChatArea] Created lecture session: ${sessionId} for scene ${sceneId}`);
      return sessionId;
    },
    [sessions, t],
  );

  /**
   * Add a lecture action to the single message bubble via StreamBuffer.
   * Speech → pushText + sealText (buffer handles pacing).
   * Spotlight/laser/discussion → pushAction (badge appears after preceding text is revealed).
   */
  const addLectureMessage = useCallback(
    (sessionId: string, action: Action, actionIndex: number) => {
      const messageId = lectureMessageIds.current.get(sessionId);
      if (!messageId) return;

      // Skip if this action was already appended in a previous run
      const lastIndex = lectureLastActionIndexRef.current.get(sessionId) ?? -1;
      if (actionIndex <= lastIndex) return;
      lectureLastActionIndexRef.current.set(sessionId, actionIndex);

      // Update lastActionIndex in session
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, lastActionIndex: actionIndex, updatedAt: Date.now() } : s,
        ),
      );

      // Get or create buffer for this lecture session
      let buffer = buffersRef.current.get(sessionId);
      if (!buffer || buffer.disposed) {
        buffer = createBufferForSession(sessionId, 'lecture');
      }

      if (action.type === 'speech') {
        buffer.pushText(messageId, action.text, 'default-1');
        buffer.sealText(messageId);
      } else if (
        action.type === 'spotlight' ||
        action.type === 'laser' ||
        action.type === 'discussion'
      ) {
        const now = Date.now();
        buffer.pushAction({
          messageId,
          actionId: `${action.type}-${now}`,
          actionName: action.type,
          params:
            action.type === 'spotlight'
              ? {
                  elementId: action.elementId,
                  dimOpacity: (action as SpotlightAction).dimOpacity,
                }
              : action.type === 'laser'
                ? { elementId: action.elementId }
                : {
                    topic: (action as DiscussionAction).topic,
                    prompt: (action as DiscussionAction).prompt,
                  },
          agentId: 'default-1',
        });
      }
    },
    [createBufferForSession],
  );

  // Derive active session type for external consumers
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionType = activeSession?.type ?? null;

  const getLectureMessageId = useCallback((sessionId: string): string | null => {
    return lectureMessageIds.current.get(sessionId) ?? null;
  }, []);

  /** Pause the buffer for a session (lecture pause support). */
  const pauseBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.pause();
  }, []);

  /** Resume the buffer for a session. */
  const resumeBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.resume();
  }, []);

  /** Pause the active live (QA/Discussion) buffer and set sticky intent. Returns true if paused. */
  const pauseActiveLiveBuffer = useCallback((): boolean => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (!active) return false;
    const buf = buffersRef.current.get(active.id);
    if (!buf || buf.disposed) return false;
    livePausedRef.current = true;
    buf.pause();
    log.info('[ChatArea] Buffer-paused discussion:', active.id);
    return true;
  }, []);

  /** Resume the active live (QA/Discussion) buffer and clear sticky intent. */
  const resumeActiveLiveBuffer = useCallback(() => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (!active) return;
    livePausedRef.current = false;
    const buf = buffersRef.current.get(active.id);
    if (buf) buf.resume();
    log.info('[ChatArea] Buffer-resumed discussion:', active.id);
  }, []);

  return {
    sessions,
    activeSessionId,
    activeSessionType,
    expandedSessionIds,
    isStreaming,
    createSession,
    endSession,
    endActiveSession,
    continueSoftClosingSession,
    confirmSoftClosingSession,
    softPauseActiveSession,
    resumeActiveSession,
    sendMessage,
    startDiscussion,
    startLecture,
    addLectureMessage,
    toggleSessionExpand,
    handleInterrupt,
    getLectureMessageId,
    pauseBuffer,
    resumeBuffer,
    pauseActiveLiveBuffer,
    resumeActiveLiveBuffer,
  };
}
