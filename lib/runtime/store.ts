/**
 * Lazy app-wide RuntimeStore singleton (#869). One `maic-runtime` IndexedDB
 * per origin, shared by every runtime kind (pbl, chat, quizAttempt, playback)
 * as they migrate onto the runtime layer. Nothing reads or writes it yet
 * except the stage-deletion cascade; Part C2 adds the first real writer.
 *
 * Client-only: the store lazily opens IndexedDB. Server code must not import
 * this module without injecting its own `RuntimeStore`.
 */
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

let store: RuntimeStore | undefined;

export function getRuntimeStore(): RuntimeStore {
  return (store ??= new BrowserRuntimeStore());
}

/**
 * Cascade a stage deletion into the runtime store without ever throwing.
 * The runtime layer lives in a separate IndexedDB database (`maic-runtime`),
 * so a broken or hung runtime DB must not brick stage deletion in the main
 * app DB — warn and move on. A failed cascade leaves orphaned runtime rows,
 * which are inert today (nothing reads them yet); a startup sweep is
 * deliberately deferred to Part C2, when the store gains real readers.
 */
export async function deleteStageRuntimeSafely(
  stageId: string,
  runtimeStore?: RuntimeStore,
): Promise<void> {
  try {
    await (runtimeStore ?? getRuntimeStore()).deleteStageRuntime(stageId);
  } catch (error) {
    console.warn(`Failed to delete runtime data for stage ${stageId}:`, error);
  }
}
