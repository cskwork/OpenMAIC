import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStore } from '@openmaic/storage';

import { deleteStageRuntimeSafely } from '@/lib/runtime/store';

function stubStore(deleteStageRuntime: (stageId: string) => Promise<void>): RuntimeStore {
  return { deleteStageRuntime } as unknown as RuntimeStore;
}

describe('deleteStageRuntimeSafely', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cascades the deletion to the runtime store with the right stageId', async () => {
    const deleteStageRuntime = vi.fn().mockResolvedValue(undefined);
    await deleteStageRuntimeSafely('stage-42', stubStore(deleteStageRuntime));
    expect(deleteStageRuntime).toHaveBeenCalledExactlyOnceWith('stage-42');
  });

  it('never throws when the runtime store fails; warns instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteStageRuntime = vi.fn().mockRejectedValue(new Error('runtime DB is broken'));

    await expect(
      deleteStageRuntimeSafely('stage-42', stubStore(deleteStageRuntime)),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0])).toContain('stage-42');
  });
});
