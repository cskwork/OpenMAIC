import type { RuntimeStore } from '@openmaic/storage';

export interface RuntimeStorageOptions {
  /** A RuntimeStore instance, or a factory that is evaluated lazily on first use. */
  store?: RuntimeStore | (() => RuntimeStore);
  /** Resolves the current learner partition key (for example, a signed-in user ID). */
  learnerKey?: () => string | Promise<string>;
}

let options: RuntimeStorageOptions | undefined;
let resolutionStarted = false;

/**
 * Configure the app-wide runtime persistence backend and learner identity.
 *
 * This is a single-shot bootstrap API: a second call always throws, even if
 * runtime storage has not been used yet. It must run before the first call to
 * either `getRuntimeStore()` or `getLearnerKey()`; once resolution has started,
 * configuration throws so a live app cannot split data across backends or
 * learner partitions. Omitted fields retain the browser IndexedDB backend and
 * anonymous device-key behavior.
 *
 * A store factory is called lazily once by `getRuntimeStore()`.
 *
 * @example
 * ```ts
 * configureRuntimeStorage({
 *   store: new HttpRuntimeStore({ baseUrl: '/api' }),
 *   learnerKey: () => session.userId,
 * });
 * ```
 */
export function configureRuntimeStorage(next: RuntimeStorageOptions): void {
  if (resolutionStarted) {
    throw new Error('Runtime storage has already been used and can no longer be configured');
  }
  if (options) {
    throw new Error('Runtime storage has already been configured');
  }
  options = next;
}

/** @internal Resolve and seal the configured store override, if any. */
export function resolveConfiguredRuntimeStore(): RuntimeStore | undefined {
  resolutionStarted = true;
  const configured = options?.store;
  return typeof configured === 'function' ? configured() : configured;
}

/** @internal Resolve and seal the configured learner-key override, if any. */
export function resolveConfiguredLearnerKey(): Promise<string> | undefined {
  resolutionStarted = true;
  const provider = options?.learnerKey;
  return provider ? Promise.resolve().then(provider) : undefined;
}
