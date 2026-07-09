/**
 * Lazy app-wide RuntimeStore singleton (#869). One `maic-runtime` IndexedDB
 * per origin, shared by every runtime kind (pbl, chat, quizAttempt, playback)
 * as they migrate onto the runtime layer. Nothing reads or writes it yet
 * except the stage-deletion cascade; Part C2 adds the first real writer.
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
 * app DB — warn and move on; the deletion is idempotent and can be retried.
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
