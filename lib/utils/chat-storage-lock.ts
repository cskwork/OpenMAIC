const CHAT_STORAGE_GLOBAL_LOCK = 'openmaic:chat-storage:all';
const DEFAULT_EXCLUSIVE_ACQUIRE_TIMEOUT_MS = 5_000;
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

export interface RuntimeStorageExclusiveLockOptions {
  acquireTimeoutMs?: number;
}

export class RuntimeStorageLockAcquisitionTimeoutError extends Error {}

/** Quiesce runtime mutations before destructive whole-store work. */
export function withRuntimeStorageExclusiveLock<T>(
  work: () => Promise<T>,
  options: RuntimeStorageExclusiveLockOptions = {},
): Promise<T> {
  const manager = locks();
  if (!manager && typeof window === 'undefined') {
    return work();
  }

  const configuredTimeout = options.acquireTimeoutMs ?? DEFAULT_EXCLUSIVE_ACQUIRE_TIMEOUT_MS;
  const acquireTimeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_EXCLUSIVE_ACQUIRE_TIMEOUT_MS;
  let acquired = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new RuntimeStorageLockAcquisitionTimeoutError(
    `Timed out acquiring the runtime maintenance lock after ${acquireTimeoutMs}ms`,
  );
  const guardedWork = async (): Promise<T> => {
    if (cancelled) throw timeoutError;
    acquired = true;
    clearTimeout(timer);
    return work();
  };
  // Cross-realm exclusion is impossible without Web Locks. The fallback still
  // coordinates every writer in this realm and preserves the pre-cutover
  // ability to perform an explicit whole-database clear.
  const request = manager
    ? manager.request(CHAT_STORAGE_GLOBAL_LOCK, guardedWork)
    : withFallbackRuntimeLock('exclusive', guardedWork);

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (acquired) return;
      cancelled = true;
      reject(timeoutError);
    }, acquireTimeoutMs);
    void request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Compatibility aliases for the chat cutover's partitioned writers. */
export const withChatStorageSharedLock = withRuntimeStorageSharedLock;
export const withChatStorageExclusiveLock = withRuntimeStorageExclusiveLock;
