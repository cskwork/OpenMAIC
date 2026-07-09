import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveStageDataMock } = vi.hoisted(() => ({
  saveStageDataMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => saveStageDataMock(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { onStageSaved } from '@/lib/store/stage-save-signal';
import { useStageStore } from '@/lib/store/stage';
import type { Stage } from '@/lib/types/stage';

function makeStage(): Stage {
  return {
    id: 'stage-1',
    name: 'Test stage',
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  saveStageDataMock.mockReset();
  saveStageDataMock.mockResolvedValue(undefined);
  useStageStore.getState().clearStore();
  useStageStore.setState({ stage: makeStage(), scenes: [], currentSceneId: null, chats: [] });
});

describe('stage save signal', () => {
  it('fires only after saveToStorage succeeds and unsubscribes cleanly', async () => {
    let resolveSave!: () => void;
    saveStageDataMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const savedStageIds: string[] = [];
    const unsubscribe = onStageSaved((stageId) => {
      savedStageIds.push(stageId);
    });

    const save = useStageStore.getState().saveToStorage();
    expect(savedStageIds).toEqual([]);

    resolveSave();
    await save;
    expect(savedStageIds).toEqual(['stage-1']);

    unsubscribe();
    await useStageStore.getState().saveToStorage();
    expect(savedStageIds).toEqual(['stage-1']);
  });
});
