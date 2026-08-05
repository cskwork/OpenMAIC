import type { Scene } from '@/lib/types/stage';
import { synchronizePBLProjectRuntime } from './hydration';
import { stripToDesignTemplate } from './learner-state';

export async function preparePBLScenesForDocumentPersistence(
  stageId: string,
  scenes: readonly Scene[],
): Promise<Scene[]> {
  await Promise.all(
    scenes.map(async (scene) => {
      const content = scene.content;
      if (content.type !== 'pbl' || !content.projectV2) return;
      await synchronizePBLProjectRuntime({
        stageId,
        sceneId: scene.id,
        project: content.projectV2,
      });
    }),
  );

  return scenes.map((scene) => {
    const content = scene.content;
    if (content.type !== 'pbl' || !content.projectV2) return scene;
    const designTemplate = stripToDesignTemplate(content.projectV2);
    return {
      ...scene,
      content: {
        ...content,
        projectV2: designTemplate,
      },
    } as Scene;
  });
}
