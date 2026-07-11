import { migrateScene } from '@/lib/edit/slide-schema';
import {
  hydratePBLScenesFromRuntime,
  type HydratePBLProjectArgs,
} from '@/lib/pbl/v2/runtime/hydration';
import type { Scene, Stage } from '@/lib/types/stage';

export function shouldApplyClassroomFallbackScenes(
  stageId: string,
  latestStageId: string | null | undefined,
): boolean {
  return !latestStageId || latestStageId === stageId;
}

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
  getLatestStageId: () => string | null | undefined;
  applyStageAndScenes: (stage: Stage, scenes: Scene[]) => void;
}

export async function applyHydratedClassroomFallbackScenes({
  stage,
  scenes,
  hydrateScenes = hydrateClassroomFallbackScenes,
  getLatestStageId,
  applyStageAndScenes,
}: ApplyHydratedClassroomFallbackScenesArgs): Promise<boolean> {
  const hydrated = await hydrateScenes(stage.id, scenes);
  if (!shouldApplyClassroomFallbackScenes(stage.id, getLatestStageId())) {
    return false;
  }
  applyStageAndScenes(stage, hydrated);
  return true;
}
