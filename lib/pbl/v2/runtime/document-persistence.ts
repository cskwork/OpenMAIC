import type { Scene } from '@/lib/types/stage';
import { hasPBLProjectV2Containers } from '@/lib/pbl/v2/types';
import { synchronizePBLProjectRuntime } from './hydration';
import { stripToDesignTemplate } from './learner-state';

/**
 * Strip scenes with projectV2 to their design templates before document persistence. Any legacy
 * projectConfig on the same scene is intentionally passed through untouched so the original v1
 * record, including its chat history, is never rewritten or lost.
 */
export async function preparePBLScenesForDocumentPersistence(
  stageId: string,
  scenes: readonly Scene[],
): Promise<Scene[]> {
  await Promise.all(
    scenes.map(async (scene) => {
      const content = scene.content;
      if (content.type !== 'pbl') return;
      const projectV2 = content.projectV2;
      // Preserve malformed stored bytes unchanged: persistence cannot safely
      // interpret, strip, or replace a project that lacks the runtime containers.
      if (projectV2 == null || !hasPBLProjectV2Containers(projectV2)) return;
      await synchronizePBLProjectRuntime({
        stageId,
        sceneId: scene.id,
        project: projectV2,
      });
    }),
  );

  return scenes.map((scene) => {
    const content = scene.content;
    if (content.type !== 'pbl') return scene;
    const projectV2 = content.projectV2;
    // See the synchronization pass above: damaged v2 payloads must round-trip byte-for-byte.
    if (projectV2 == null || !hasPBLProjectV2Containers(projectV2)) return scene;
    const designTemplate = stripToDesignTemplate(projectV2);
    return {
      ...scene,
      content: {
        ...content,
        projectV2: designTemplate,
      },
    } as Scene;
  });
}
