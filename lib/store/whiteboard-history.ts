/**
 * Whiteboard History Store
 *
 * Lightweight in-memory store that saves snapshots of whiteboard elements
 * before destructive operations (clear, replace). Allows users to browse
 * and restore previous whiteboard states.
 *
 * History is per-session (not persisted to IndexedDB) to keep things simple.
 */

import { create } from 'zustand';
import type { PPTElement } from '@openmaic/dsl';
import { elementFingerprint } from '@/lib/utils/element-fingerprint';

export interface WhiteboardSnapshot {
  /** Deep copy of whiteboard elements at the time of capture */
  elements: PPTElement[];
  /** Timestamp when the snapshot was taken */
  timestamp: number;
  /** Cached fingerprint used for deduplication and no-op restore checks */
  fingerprint: string;
  /** Exact canonical board-content digest for Native destructive effects. */
  boardContentDigest?: string;
}

export interface WhiteboardSnapshotReceipt {
  snapshotIndex: number;
  boardContentDigest: string;
  inserted: boolean;
}

interface WhiteboardHistoryState {
  /** Stack of snapshots, newest last */
  snapshots: WhiteboardSnapshot[];
  /** Maximum number of snapshots to keep */
  maxSnapshots: number;
  // Actions
  /** Save a snapshot of the current whiteboard elements */
  pushSnapshot: (elements: PPTElement[]) => void;
  /** Persist an exact Native snapshot without relying on the coarse fingerprint. */
  pushExactSnapshot: (
    elements: PPTElement[],
    boardContentDigest: string,
  ) => WhiteboardSnapshotReceipt;
  /** Get a snapshot by index */
  getSnapshot: (index: number) => WhiteboardSnapshot | null;
  /** Clear all history */
  clearHistory: () => void;
}

export const useWhiteboardHistoryStore = create<WhiteboardHistoryState>((set, get) => ({
  snapshots: [],
  maxSnapshots: 20,

  pushSnapshot: (elements) => {
    // Don't save empty snapshots
    if (!elements || elements.length === 0) return;

    const { snapshots } = get();
    const newFingerprint = elementFingerprint(elements);
    if (snapshots.some((s) => s.fingerprint === newFingerprint)) {
      return;
    }

    const snapshot: WhiteboardSnapshot = {
      elements: JSON.parse(JSON.stringify(elements)), // Deep copy
      timestamp: Date.now(),
      fingerprint: newFingerprint,
    };

    set((state) => {
      const newSnapshots = [...state.snapshots, snapshot];
      // Enforce limit: drop oldest snapshots first.
      if (newSnapshots.length > state.maxSnapshots) {
        return { snapshots: newSnapshots.slice(-state.maxSnapshots) };
      }
      return { snapshots: newSnapshots };
    });
  },

  pushExactSnapshot: (elements, boardContentDigest) => {
    if (!elements || elements.length === 0) {
      throw new Error('CLIENT_EFFECT_HISTORY_EMPTY_SNAPSHOT');
    }
    if (!boardContentDigest.startsWith('sha256:')) {
      throw new Error('CLIENT_EFFECT_HISTORY_DIGEST_INVALID');
    }
    const { snapshots } = get();
    const existingIndex = snapshots.findIndex(
      (snapshot) => snapshot.boardContentDigest === boardContentDigest,
    );
    if (existingIndex >= 0) {
      return { snapshotIndex: existingIndex, boardContentDigest, inserted: false };
    }
    const snapshot: WhiteboardSnapshot = {
      elements: JSON.parse(JSON.stringify(elements)),
      timestamp: Date.now(),
      fingerprint: elementFingerprint(elements),
      boardContentDigest,
    };
    let snapshotIndex = 0;
    set((state) => {
      const next = [...state.snapshots, snapshot];
      const retained = next.slice(-state.maxSnapshots);
      snapshotIndex = retained.length - 1;
      return { snapshots: retained };
    });
    return { snapshotIndex, boardContentDigest, inserted: true };
  },

  getSnapshot: (index) => {
    const { snapshots } = get();
    return snapshots[index] ?? null;
  },

  clearHistory: () => set({ snapshots: [] }),
}));
