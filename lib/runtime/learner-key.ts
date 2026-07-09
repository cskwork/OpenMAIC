/**
 * Device-anonymous learner identity for the runtime layer (#869).
 *
 * `learnerKey` partitions all learner-runtime data (RuntimeStore sessions).
 * Until sign-in exists it is a per-device anonymous key: minted once and kept
 * in the KV `device` scope, which never syncs across devices — a synced key
 * would merge two people's runtime into one partition. When sign-in lands,
 * `RuntimeStore.mergeLearner(anonKey, accountKey)` is the migration path.
 */
import { BrowserKVStore, type KVStore } from '@openmaic/storage';

export const LEARNER_KEY_KV_KEY = 'runtime.learnerKey';

let defaultKv: KVStore | undefined;

export async function getLearnerKey(kv?: KVStore): Promise<string> {
  const store = kv ?? (defaultKv ??= new BrowserKVStore());
  const existing = await store.get<string>(LEARNER_KEY_KV_KEY, 'device');
  if (existing) return existing;
  const minted = `anon:${crypto.randomUUID()}`;
  await store.set(LEARNER_KEY_KV_KEY, minted, 'device');
  return minted;
}
