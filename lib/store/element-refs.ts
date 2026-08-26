'use client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SEAM — the workbench client data layer lands in the sibling U1 slice.
 *
 * The full reference `lib/store/element-refs.ts` (the owner-fenced draft store
 * with draft-generation stamps, `addMany`, hover wiring, `removeSent` matching)
 * is ported by the DATA-LAYER slice. This file is the thin local stand-in the
 * chat surface compiles and runs against: same exported API, same owner fence,
 * identity-based dedupe/removal. When the sibling lands, replace this file
 * wholesale; the components must not change.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { create } from 'zustand';
import { useEffect } from 'react';
import { createSelectors } from '@/lib/utils/create-selectors';
import {
  MAX_ELEMENT_REFS,
  elementRefIdentity,
  type ElementRef,
} from '@/lib/workbench/element-refs';

interface ElementRefsState {
  /** Conversation that owns this draft list. */
  ownerSessionId: string | null;
  refs: ElementRef[];
  /** The ref the pointer is currently over, wherever it is being pointed at. */
  hovered: { stageId: string; sceneId: string; elementId: string } | null;

  attachOwner: (sessionId: string) => void;
  /** Drop an ephemeral draft when its chat detaches. */
  detachOwner: (sessionId?: string) => void;
  add: (ref: ElementRef) => void;
  remove: (stageId: string, sceneId: string, elementId: string) => void;
  removeRef: (ref: ElementRef) => void;
  removeSent: (sessionId: string, refs: readonly ElementRef[]) => void;
  clear: () => void;
  setHovered: (target: { stageId: string; sceneId: string; elementId: string } | null) => void;
}

const useElementRefsStoreBase = create<ElementRefsState>((set) => ({
  ownerSessionId: null,
  refs: [],
  hovered: null,

  attachOwner: (sessionId) =>
    set((state) =>
      state.ownerSessionId === sessionId
        ? state
        : { ownerSessionId: sessionId, refs: [], hovered: null },
    ),

  detachOwner: (sessionId) =>
    set((state) =>
      sessionId !== undefined && state.ownerSessionId !== sessionId
        ? state
        : { ownerSessionId: null, refs: [], hovered: null },
    ),

  add: (ref) =>
    set((state) => {
      if (state.refs.length >= MAX_ELEMENT_REFS) return state;
      if (
        state.refs.some((candidate) => elementRefIdentity(candidate) === elementRefIdentity(ref))
      ) {
        return state;
      }
      return { refs: [...state.refs, ref] };
    }),

  remove: (stageId, sceneId, elementId) =>
    set((state) => {
      const refs = state.refs.filter(
        (ref) =>
          !(
            ref.kind === 'slide-element' &&
            ref.stageId === stageId &&
            ref.sceneId === sceneId &&
            ref.elementId === elementId
          ),
      );
      const hovered =
        state.hovered &&
        state.hovered.stageId === stageId &&
        state.hovered.sceneId === sceneId &&
        state.hovered.elementId === elementId
          ? null
          : state.hovered;
      return { refs, hovered };
    }),

  removeRef: (target) =>
    set((state) => {
      const identity = elementRefIdentity(target);
      const refs = state.refs.filter((ref) => elementRefIdentity(ref) !== identity);
      const hovered =
        target.kind === 'slide-element' &&
        state.hovered?.stageId === target.stageId &&
        state.hovered.sceneId === target.sceneId &&
        state.hovered.elementId === target.elementId
          ? null
          : state.hovered;
      return refs === state.refs ? state : { refs, hovered };
    }),

  removeSent: (sessionId, sent) =>
    set((state) => {
      if (state.ownerSessionId !== sessionId || sent.length === 0) return state;
      const sentIds = new Set(sent.map(elementRefIdentity));
      const refs = state.refs.filter((ref) => !sentIds.has(elementRefIdentity(ref)));
      return refs.length === state.refs.length ? state : { refs };
    }),

  clear: () => set({ refs: [], hovered: null }),

  setHovered: (hovered) => set({ hovered }),
}));

export const useElementRefsStore = createSelectors(useElementRefsStoreBase);

const NO_OWNED_REFS: ElementRef[] = [];

/** Never render a draft owned by another chat. This selector has no lifecycle side effects. */
export function useElementRefsForSession(sessionId: string | null): ElementRef[] {
  return useElementRefsStore((state) =>
    sessionId && state.ownerSessionId === sessionId ? state.refs : NO_OWNED_REFS,
  );
}

/** The authoritative chat lifecycle. Auxiliary consumers must only use the fenced selector. */
export function useElementRefsOwnerLifecycle(sessionId: string | null): void {
  useEffect(() => {
    const store = useElementRefsStore.getState();
    if (!sessionId) {
      store.detachOwner();
      return;
    }
    store.attachOwner(sessionId);
    return () => useElementRefsStore.getState().detachOwner(sessionId);
  }, [sessionId]);
}

export { MAX_ELEMENT_REFS };
