import { migrateScene } from '@/lib/edit/slide-schema';
import {
  hydratePBLScenesFromRuntime,
  type HydratePBLProjectArgs,
} from '@/lib/pbl/v2/runtime/hydration';
import type { Scene } from '@/lib/types/stage';

export async function hydrateClassroomFallbackScenes(
  stageId: string,
  scenes: readonly Scene[],
  options: Pick<HydratePBLProjectArgs, 'store' | 'kv' | 'learnerKey'> = {},
): Promise<Scene[]> {
  return hydratePBLScenesFromRuntime(stageId, scenes.map(migrateScene), options);
}
