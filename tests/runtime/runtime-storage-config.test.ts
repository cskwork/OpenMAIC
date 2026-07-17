import type { KVStore, RuntimeStore } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function stubStore(deleteStageRuntime = vi.fn().mockResolvedValue(undefined)): RuntimeStore {
  return { deleteStageRuntime } as unknown as RuntimeStore;
}

describe('configureRuntimeStorage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('retains the lazy BrowserRuntimeStore singleton by default', async () => {
    const { BrowserRuntimeStore } = await import('@openmaic/storage');
    const { getRuntimeStore } = await import('@/lib/runtime/store');

    const first = getRuntimeStore();

    expect(first).toBeInstanceOf(BrowserRuntimeStore);
    expect(getRuntimeStore()).toBe(first);
  });

  it('routes an existing consumer through an injected RuntimeStore', async () => {
    vi.stubGlobal('indexedDB', {});
    const deleteStageRuntime = vi.fn().mockResolvedValue(undefined);
    const injected = stubStore(deleteStageRuntime);
    const { configureRuntimeStorage, deleteStageRuntimeSafely, getRuntimeStore } =
      await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: injected });

    await deleteStageRuntimeSafely('stage-injected');

    expect(getRuntimeStore()).toBe(injected);
    expect(deleteStageRuntime).toHaveBeenCalledExactlyOnceWith('stage-injected');
  });

  it('evaluates a store factory lazily and only once', async () => {
    const injected = stubStore();
    const factory = vi.fn(() => injected);
    const { configureRuntimeStorage, getRuntimeStore } = await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: factory });

    expect(factory).not.toHaveBeenCalled();
    expect(getRuntimeStore()).toBe(injected);
    expect(getRuntimeStore()).toBe(injected);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('throws when configured after runtime storage has been used', async () => {
    const { configureRuntimeStorage, getRuntimeStore } = await import('@/lib/runtime/store');
    getRuntimeStore();

    expect(() => configureRuntimeStorage({ store: stubStore() })).toThrow(
      'Runtime storage has already been used',
    );
  });

  it('throws on repeated configuration before first use', async () => {
    const { configureRuntimeStorage } = await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: stubStore() });

    expect(() => configureRuntimeStorage({ learnerKey: () => 'account:second' })).toThrow(
      'Runtime storage has already been configured',
    );
  });

  it('uses an injected learnerKey provider instead of device-key storage', async () => {
    const learnerKey = vi.fn(() => 'account:user-42');
    const kv = {
      get: vi.fn(() => Promise.reject(new Error('device KV must not be read'))),
    } as unknown as KVStore;
    const { configureRuntimeStorage } = await import('@/lib/runtime/store');
    const { getLearnerKey } = await import('@/lib/runtime/learner-key');
    configureRuntimeStorage({ learnerKey });

    await expect(getLearnerKey(kv)).resolves.toBe('account:user-42');
    expect(learnerKey).toHaveBeenCalledOnce();
    expect(kv.get).not.toHaveBeenCalled();
  });
});
