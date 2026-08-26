'use client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SEAM — the workbench client data layer lands in the sibling U1 slice.
 *
 * The full reference `lib/store/course-refs.ts` (the owner-fenced draft store
 * with draft-generation stamps) is ported by the DATA-LAYER slice. This file is
 * the thin local stand-in the chat surface compiles and runs against: same
 * exported API, same owner fence. When the sibling lands, replace this file
 * wholesale; the components must not change.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { create } from 'zustand';
import { useEffect } from 'react';
import { createSelectors } from '@/lib/utils/create-selectors';
import {
  MAX_COURSE_REFS,
  addCourseRef,
  hasCourseRef,
  removeCourseRef,
  type CourseRef,
} from '@/lib/workbench/course-refs';

interface CourseRefsState {
  /** Conversation that owns this draft list. */
  ownerSessionId: string | null;
  refs: CourseRef[];

  attachOwner: (sessionId: string) => void;
  /** Drop an ephemeral draft when its chat detaches. */
  detachOwner: (sessionId?: string) => void;
  add: (ref: CourseRef) => void;
  remove: (stageId: string) => void;
  removeSent: (sessionId: string, refs: readonly CourseRef[]) => void;
  clear: () => void;
}

const useCourseRefsStoreBase = create<CourseRefsState>((set) => ({
  ownerSessionId: null,
  refs: [],

  attachOwner: (sessionId) =>
    set((state) =>
      state.ownerSessionId === sessionId ? state : { ownerSessionId: sessionId, refs: [] },
    ),

  detachOwner: (sessionId) =>
    set((state) =>
      sessionId !== undefined && state.ownerSessionId !== sessionId
        ? state
        : { ownerSessionId: null, refs: [] },
    ),

  add: (ref) =>
    set((state) => {
      if (state.refs.length >= MAX_COURSE_REFS || hasCourseRef(state.refs, ref.stageId)) {
        return state;
      }
      return { refs: addCourseRef(state.refs, ref) };
    }),

  remove: (stageId) => set((state) => ({ refs: removeCourseRef(state.refs, stageId) })),

  removeSent: (sessionId, sent) =>
    set((state) => {
      if (state.ownerSessionId !== sessionId || sent.length === 0) return state;
      const sentIds = new Set(sent.map((ref) => ref.stageId));
      const refs = state.refs.filter((ref) => !sentIds.has(ref.stageId));
      return refs.length === state.refs.length ? state : { refs };
    }),

  clear: () => set({ refs: [] }),
}));

export const useCourseRefsStore = createSelectors(useCourseRefsStoreBase);

const NO_OWNED_REFS: CourseRef[] = [];

/** Never render a draft owned by another chat. This selector has no lifecycle side effects. */
export function useCourseRefsForSession(sessionId: string | null): CourseRef[] {
  return useCourseRefsStore((state) =>
    sessionId && state.ownerSessionId === sessionId ? state.refs : NO_OWNED_REFS,
  );
}

/** The authoritative chat lifecycle. Auxiliary consumers must only use the fenced selector. */
export function useCourseRefsOwnerLifecycle(sessionId: string | null): void {
  useEffect(() => {
    const store = useCourseRefsStore.getState();
    if (!sessionId) {
      store.detachOwner();
      return;
    }
    store.attachOwner(sessionId);
    return () => useCourseRefsStore.getState().detachOwner(sessionId);
  }, [sessionId]);
}

export { MAX_COURSE_REFS };
