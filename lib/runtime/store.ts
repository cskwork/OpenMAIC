/**
 * Lazy app-wide RuntimeStore singleton (#869). One `maic-runtime` IndexedDB
 * per origin, shared by every runtime kind (pbl, chat, quizAttempt, playback)
 * as they migrate onto the runtime layer. Nothing reads or writes it yet;
 * Part C2 adds the first real writer.
 */
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

let store: RuntimeStore | undefined;

export function getRuntimeStore(): RuntimeStore {
  return (store ??= new BrowserRuntimeStore());
}
