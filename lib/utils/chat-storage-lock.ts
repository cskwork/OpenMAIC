const CHAT_STORAGE_GLOBAL_LOCK = 'openmaic:chat-storage:all';

export function chatStoragePartitionLockName(key: string): string {
  const name = `openmaic:chat-storage:${encodeURIComponent(key)}`;
  return name === CHAT_STORAGE_GLOBAL_LOCK ? `${name}:partition` : name;
}

function locks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

/** Let independent chat partitions run together while excluding whole-store maintenance. */
export async function withChatStorageSharedLock<T>(work: () => Promise<T>): Promise<T> {
  const manager = locks();
  if (manager) {
    return manager.request(CHAT_STORAGE_GLOBAL_LOCK, { mode: 'shared' }, work);
  }
  return work();
}

/** Quiesce every cross-tab chat mutation before destructive whole-store work. */
export async function withChatStorageExclusiveLock<T>(work: () => Promise<T>): Promise<T> {
  const manager = locks();
  if (manager) {
    return manager.request(CHAT_STORAGE_GLOBAL_LOCK, work);
  }
  // Default legacy-backed chat mutations already fail before touching runtime
  // storage when Web Locks are unavailable. Preserve the pre-cutover ability
  // to perform an explicit whole-database clear in those environments.
  return work();
}
