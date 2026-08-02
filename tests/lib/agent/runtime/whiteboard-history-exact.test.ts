import { beforeEach, describe, expect, it } from 'vitest';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import type { PPTElement } from '@openmaic/dsl';

const elements: PPTElement[] = [
  {
    id: 'text-1',
    type: 'text' as const,
    content: '<p>visible</p>',
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333',
    left: 0,
    top: 0,
    width: 100,
    height: 50,
    rotate: 0,
  },
];

describe('exact whiteboard history receipt', () => {
  beforeEach(() => useWhiteboardHistoryStore.getState().clearHistory());

  it('deduplicates only by exact digest and returns an authoritative receipt', () => {
    const first = useWhiteboardHistoryStore
      .getState()
      .pushExactSnapshot(elements, 'sha256:exact-a');
    const duplicate = useWhiteboardHistoryStore
      .getState()
      .pushExactSnapshot(elements, 'sha256:exact-a');
    const distinct = useWhiteboardHistoryStore
      .getState()
      .pushExactSnapshot(elements, 'sha256:exact-b');

    expect(first).toEqual({
      snapshotIndex: 0,
      boardContentDigest: 'sha256:exact-a',
      inserted: true,
    });
    expect(duplicate).toEqual({
      snapshotIndex: 0,
      boardContentDigest: 'sha256:exact-a',
      inserted: false,
    });
    expect(distinct).toEqual({
      snapshotIndex: 1,
      boardContentDigest: 'sha256:exact-b',
      inserted: true,
    });
    expect(useWhiteboardHistoryStore.getState().snapshots).toHaveLength(2);
  });

  it('does not let the legacy coarse fingerprint suppress a distinct exact snapshot', () => {
    useWhiteboardHistoryStore.getState().pushSnapshot(elements);
    const receipt = useWhiteboardHistoryStore
      .getState()
      .pushExactSnapshot(elements, 'sha256:exact');
    expect(receipt.inserted).toBe(true);
    expect(useWhiteboardHistoryStore.getState().snapshots).toHaveLength(2);
  });
});
