'use client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SEAM — the workbench client data layer lands in the sibling U1 slice.
 *
 * The full reference `lib/workbench/session-store.ts` (≈2,100 LOC: the zustand
 * fold over the agent-session SSE event log, the replay/compaction rules and
 * the control-plane API client) is ported by the DATA-LAYER slice, not by the
 * chat surface. This file is the thin local stand-in the chat surface compiles
 * and tests against: it declares the store's exported API exactly as the
 * reference defines it and supplies the never-ran initial state, so the UI can
 * be written and rendered against the real contract. It deliberately does NOT
 * port the fold (`foldEvent` / `foldEvents` / `compactReplayEvents` …) — the
 * sibling slice owns that implementation, and duplicating it here would
 * conflict with its landing.
 *
 * When the sibling lands, this file is replaced wholesale by the real
 * `session-store.ts`; the components in `components/workbench/` must not change.
 * The API functions below throw so a runtime call fails loudly on a build that
 * somehow shipped without the sibling slice, instead of silently sending
 * nothing.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { create } from 'zustand';
import type { WorkbenchCopyKey } from '@/lib/i18n/workbench';
import type { CourseRef } from './course-refs';
import type { ElementRef } from './element-refs';

export type ChatNodeKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'system'
  | 'tool'
  | 'boundary'
  | 'course'
  | 'waiting'
  | 'question';

export type SystemTone = 'info' | 'success' | 'error';

/** One choice offered by `ask_user`, exactly as the tool validated it. */
export interface QuestionOption {
  id: string;
  label: string;
}

export interface ChatNode {
  key: string;
  kind: ChatNodeKind;
  text: string;
  /** Product-owned copy resolved at render time; `text` is the zh fallback. */
  copyKey?: WorkbenchCopyKey;
  /** User nodes only: display names from `user_message.data.materials`. */
  materials?: string[];
  elementRefs?: ElementRef[];
  courseRefs?: CourseRef[];
  /** Assistant / thinking nodes only: still receiving deltas. */
  streaming?: boolean;
  /** System markers only. */
  tone?: SystemTone;
  /** Course rows only: the classrooms this exchange produced or was pointed at. */
  stageIds?: readonly string[];
  detail?: string;
  hint?: string;
  hintCopyKey?: WorkbenchCopyKey;
  /** Thinking bars only: wall-clock bounds for the "已思考 Ns" summary. */
  startedAt?: number;
  endedAt?: number;
  /** Tool cards only. */
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: 'running' | 'done' | 'failed';
  toolDetails?: unknown;
  toolResultText?: string;
  toolResultTruncated?: boolean;
  toolResultCopyKey?: WorkbenchCopyKey;
  toolStartedAt?: number;
  toolEndedAt?: number;
  toolTraces?: string[];
  sceneId?: string;
  questionOptions?: QuestionOption[];
  questionMultiSelect?: boolean;
  questionAnswered?: boolean;
}

export interface PlannedPage {
  order: number;
  title: string;
  type: string;
  widgetType?: string;
}

export interface BuiltPage {
  order: number;
  title?: string;
  sceneId?: string;
  sceneType?: string;
  excerpt?: string;
  elementCount?: number;
}

export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** The base key of the LEGACY unbound course row (a v1 page checkpoint carried no stageId). */
export const COURSE_NODE_KEY = 'course-deck';

/** The fold's half of the store: everything `foldEvent` may read or write. */
export interface WorkbenchFold {
  status: SessionStatus;
  lastEventId: number;
  error: string | null;
  courseTitle: string | null;
  sessionPrompt: string | null;
  sessionTitle: string | null;
  skillId: string | null;
  skillViolations: string[];
  plan: PlannedPage[];
  pages: Record<number, BuiltPage>;
  chat: ChatNode[];
  libraryRevision: number;
  stageLinkStageIds: readonly string[];
  touchedStageIds: readonly string[];
  runCourseStageIds: readonly string[];
  generatingOrder: number | null;
  panelOpen: boolean;
  panelPinned: boolean;
  thinkingKey: string | null;
  assistantKey: string | null;
  generationOpen: boolean;
  epoch: number;
  waitingKey: string | null;
  waitingArmed: boolean;
  stageId: string | null;
}

export interface WorkbenchSessionState extends WorkbenchFold {
  sessionId: string | null;
  attached: boolean;
  replaying: boolean;
  replayedStageLinkCount: number;
  playbackOn: boolean;
}

export interface WorkbenchState extends WorkbenchSessionState {
  attach: (sessionId: string, stageId: string | null) => void;
  detach: () => void;
  setPanelOpen: (open: boolean, byUser?: boolean) => void;
  setPlaybackOn: (on: boolean) => void;
  applyEvent: (event: WorkbenchEvent) => void;
  applyEvents: (events: readonly WorkbenchEvent[]) => void;
  setAttached: (attached: boolean) => void;
  setReplaying: (replaying: boolean) => void;
  finishReplay: () => void;
  setError: (error: string | null) => void;
  setSessionPrompt: (prompt: string | null) => void;
  setSessionTitle: (title: string | null) => void;
  setSessionBootstrap: (input: {
    prompt?: string | null;
    title?: string | null;
    status?: SessionStatus;
    stageId?: string | null;
  }) => void;
}

/** One frame of the SSE stream. Mirrors the runner's `PersistedEvent`. */
export interface WorkbenchEvent {
  id: number;
  ts: number;
  attempt: number;
  type: string;
  data: unknown;
}

/**
 * THE single source for "this store holds no session" — the never-ran state
 * with every fold field initialised (see the reference's rationale: a
 * hand-written reset is twenty-nine chances to miss one field).
 */
export function createInitialSessionState(): WorkbenchSessionState {
  return {
    // ── Attachment ──────────────────────────────────────────────────────
    sessionId: null,
    attached: false,
    replaying: false,
    replayedStageLinkCount: 0,
    playbackOn: false,
    // ── The run ─────────────────────────────────────────────────────────
    status: 'idle',
    lastEventId: 0,
    error: null,
    epoch: 0,
    // ── What the run produced ───────────────────────────────────────────
    courseTitle: null,
    sessionPrompt: null,
    sessionTitle: null,
    skillId: null,
    skillViolations: [],
    plan: [],
    pages: {},
    chat: [],
    libraryRevision: 0,
    stageLinkStageIds: [],
    touchedStageIds: [],
    runCourseStageIds: [],
    generatingOrder: null,
    // ── In-flight markers ───────────────────────────────────────────────
    thinkingKey: null,
    assistantKey: null,
    generationOpen: false,
    waitingKey: null,
    waitingArmed: false,
    // ── Panes ───────────────────────────────────────────────────────────
    panelOpen: false,
    panelPinned: false,
    stageId: null,
  };
}

const SEAM_MISSING = () => {
  throw new Error(
    'lib/workbench/session-store is a SEAM: the real store (event fold + API client) lands with ' +
      'the sibling data-layer slice. A component reached a store action before it landed.',
  );
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  ...createInitialSessionState(),

  attach: (sessionId, stageId) =>
    set(() => ({
      ...createInitialSessionState(),
      sessionId,
      stageId,
      status: 'connecting',
      replaying: true,
    })),
  detach: () => set(createInitialSessionState()),
  setPanelOpen: (open, byUser = false) =>
    set((state) => ({ panelOpen: open, panelPinned: byUser ? true : state.panelPinned })),
  setPlaybackOn: (on) => set({ playbackOn: on }),
  setAttached: (attached) => set({ attached }),
  setReplaying: (replaying) => set({ replaying }),
  finishReplay: () =>
    set((state) => ({ replaying: false, replayedStageLinkCount: state.stageLinkStageIds.length })),
  setError: (error) => set({ error }),
  setSessionPrompt: (sessionPrompt) => set({ sessionPrompt }),
  setSessionTitle: (sessionTitle) => set({ sessionTitle }),
  setSessionBootstrap: (input) =>
    set((state) => ({
      ...(input.prompt !== undefined ? { sessionPrompt: input.prompt } : {}),
      ...(input.title !== undefined ? { sessionTitle: input.title } : {}),
      ...(input.status && state.lastEventId === 0 ? { status: input.status } : {}),
      ...(input.stageId && !state.stageId ? { stageId: input.stageId } : {}),
    })),
  applyEvent: () => SEAM_MISSING(),
  applyEvents: () => SEAM_MISSING(),
}));

// ── Control-plane client (seam stubs — real fetch wrappers land with U1) ────

/** The session meta the control plane returns on create. */
export interface WorkbenchSessionMeta {
  id: string;
  stageId: string;
  status: SessionStatus;
  prompt: string;
  /** False when the server dropped the `@`-named classrooms it was sent. */
  courseRefsAccepted?: boolean;
}

/** A control-plane failure that keeps the HTTP status / error code. */
export class WorkbenchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly terminalStatus?: SessionStatus,
  ) {
    super(message);
    this.name = 'WorkbenchApiError';
  }
}

export async function createWorkbenchSession(input: {
  prompt: string;
  skill?: string;
  materials?: WorkbenchMaterial[];
  courseRefs?: readonly CourseRef[];
  stageId?: string;
  existingCourse?: boolean;
}): Promise<WorkbenchSessionMeta> {
  void input;
  return SEAM_MISSING();
}

export async function renameWorkbenchSession(
  sessionId: string,
  title: string | null,
): Promise<string | null> {
  void sessionId;
  void title;
  return SEAM_MISSING();
}

export async function cancelWorkbenchSession(sessionId: string): Promise<void> {
  void sessionId;
  return SEAM_MISSING();
}

/** Recover the terminal status reported by cancel's already-finished conflict. */
export function terminalStatusFromCancelError(_error: unknown): SessionStatus | null {
  return null;
}

/** Handle a terminal cancel conflict; mutate only if its session is still attached. */
export function recoverTerminalCancelStatus(sessionId: string, error: unknown): boolean {
  void sessionId;
  void error;
  return false;
}

export async function postWorkbenchMessage(
  sessionId: string,
  text: string,
  materials: WorkbenchMaterial[] = [],
  elementRefs: readonly ElementRef[] = [],
  courseRefs: readonly CourseRef[] = [],
): Promise<{ elementRefsAccepted: boolean; courseRefsAccepted: boolean }> {
  void sessionId;
  void text;
  void materials;
  void elementRefs;
  void courseRefs;
  return SEAM_MISSING();
}

/** A durable material asset selected in a workbench composer. */
export interface WorkbenchMaterial {
  materialId: string;
  name: string;
  bytes: number;
  mimeType?: string;
  extractionStatus?: 'idle' | 'pending' | 'running' | 'done' | 'failed';
}

export class WorkbenchMaterialUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'WorkbenchMaterialUploadError';
  }
}

export async function uploadWorkbenchMaterial(file: File): Promise<WorkbenchMaterial> {
  void file;
  return SEAM_MISSING();
}
