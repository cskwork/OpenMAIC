const CHAT_STORAGE_GLOBAL_LOCK = 'openmaic:chat-storage:all';
type FallbackLockMode = 'shared' | 'exclusive';
interface FallbackLockWaiter {
  mode: FallbackLockMode;
  start(): void;
}

const fallbackWaiters: FallbackLockWaiter[] = [];
let fallbackReaders = 0;
let fallbackWriter = false;

export function chatStoragePartitionLockName(key: string): string {
  const name = `openmaic:chat-storage:${encodeURIComponent(key)}`;
  return name === CHAT_STORAGE_GLOBAL_LOCK ? `${name}:partition` : name;
}

function locks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

function pumpFallbackLocks(): void {
  if (fallbackWriter || fallbackWaiters.length === 0) return;
  if (fallbackWaiters[0]!.mode === 'exclusive') {
    if (fallbackReaders === 0) fallbackWaiters.shift()!.start();
    return;
  }
  while (fallbackWaiters[0]?.mode === 'shared' && !fallbackWriter) {
    fallbackWaiters.shift()!.start();
  }
}

function withFallbackRuntimeLock<T>(mode: FallbackLockMode, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fallbackWaiters.push({
      mode,
      start() {
        if (mode === 'shared') fallbackReaders += 1;
        else fallbackWriter = true;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            if (mode === 'shared') fallbackReaders -= 1;
            else fallbackWriter = false;
            pumpFallbackLocks();
          });
      },
    });
    pumpFallbackLocks();
  });
}

/** Let runtime writers run together while excluding whole-store maintenance. */
export async function withRuntimeStorageSharedLock<T>(work: () => Promise<T>): Promise<T> {
  const manager = locks();
  if (manager) {
    return manager.request(CHAT_STORAGE_GLOBAL_LOCK, { mode: 'shared' }, work);
  }
  return typeof window === 'undefined' ? work() : withFallbackRuntimeLock('shared', work);
}

/** Quiesce runtime mutations before destructive whole-store work. */
export async function withRuntimeStorageExclusiveLock<T>(work: () => Promise<T>): Promise<T> {
  const manager = locks();
  if (manager) {
    return manager.request(CHAT_STORAGE_GLOBAL_LOCK, work);
  }
  // Cross-realm exclusion is impossible without Web Locks. The fallback still
  // coordinates every writer in this realm and preserves the pre-cutover
  // ability to perform an explicit whole-database clear.
  return typeof window === 'undefined' ? work() : withFallbackRuntimeLock('exclusive', work);
}

/** Compatibility aliases for the chat cutover's partitioned writers. */
export const withChatStorageSharedLock = withRuntimeStorageSharedLock;
export const withChatStorageExclusiveLock = withRuntimeStorageExclusiveLock;
