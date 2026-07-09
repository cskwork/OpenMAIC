import { describe, expect, it } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

import { getLearnerKey, LEARNER_KEY_KV_KEY } from '@/lib/runtime/learner-key';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

describe('getLearnerKey', () => {
  it('mints an anon key once and returns the same key afterwards', async () => {
    const kv = new BrowserKVStore({ storage: memoryStorage() });
    const first = await getLearnerKey(kv);
    expect(first).toMatch(/^anon:[0-9a-f-]{36}$/);
    await expect(getLearnerKey(kv)).resolves.toBe(first);
  });

  it('persists under the device scope, never the account scope', async () => {
    const storage = memoryStorage();
    const kv = new BrowserKVStore({ storage });
    const key = await getLearnerKey(kv);

    // BrowserKVStore encodes the scope in the storage key: `maic:<scope>:<key>`
    const entries = [...Array(storage.length).keys()].map((i) => storage.key(i));
    const deviceEntry = entries.find((k) => k?.includes(':device:'));
    expect(deviceEntry).toContain(LEARNER_KEY_KV_KEY);
    expect(storage.getItem(deviceEntry!)).toContain(key);
    expect(entries.find((k) => k?.includes(':account:'))).toBeUndefined();
  });

  it('two different devices (stores) mint different keys', async () => {
    const a = await getLearnerKey(new BrowserKVStore({ storage: memoryStorage() }));
    const b = await getLearnerKey(new BrowserKVStore({ storage: memoryStorage() }));
    expect(a).not.toBe(b);
  });
});
