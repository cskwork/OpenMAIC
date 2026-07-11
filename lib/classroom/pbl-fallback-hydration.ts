import { migrateScene } from '@/lib/edit/slide-schema';
import {
  hydratePBLScenesFromRuntime,
  type HydratePBLProjectArgs,
} from '@/lib/pbl/v2/runtime/hydration';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

export async function hydrateClassroomFallbackScenes(
  stageId: string,
  scenes: readonly Scene[],
  options: Pick<HydratePBLProjectArgs, 'store' | 'kv' | 'learnerKey'> = {},
): Promise<Scene[]> {
  return hydratePBLScenesFromRuntime(stageId, scenes.map(migrateScene), options);
}

export interface ApplyHydratedClassroomFallbackScenesArgs {
  stage: Stage;
  scenes: readonly Scene[];
  hydrateScenes?: (stageId: string, scenes: readonly Scene[]) => Promise<Scene[]>;
  applyStageAndScenes: (stage: Stage, scenes: Scene[]) => void;
}

export async function applyHydratedClassroomFallbackScenes({
  stage,
  scenes,
  hydrateScenes = hydrateClassroomFallbackScenes,
  applyStageAndScenes,
}: ApplyHydratedClassroomFallbackScenesArgs): Promise<boolean> {
  const token = claimStageSceneLoadToken();
  const hydrated = await hydrateScenes(stage.id, scenes);
  if (!isCurrentStageSceneLoadToken(token)) {
    return false;
  }
  applyStageAndScenes(stage, hydrated);
  return true;
}
