const CHAT_STORAGE_GLOBAL_LOCK = 'openmaic:chat-storage:all';

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
  if (!manager) {
    throw new Error('Clearing chat storage requires the Web Locks API in this browser');
  }
  return manager.request(CHAT_STORAGE_GLOBAL_LOCK, work);
}
