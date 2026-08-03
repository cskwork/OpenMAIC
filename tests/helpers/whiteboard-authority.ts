import { useStageStore } from '@/lib/store/stage';
import { getDefaultWhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';

type StageState = ReturnType<typeof useStageStore.getState>;
type StageStorePatch = Partial<StageState> | ((state: StageState) => Partial<StageState>);

/**
 * Test-fixture writer for state that can contain a whole Stage document.
 * Production callers must use their product adapter rather than this helper.
 */
export function setStageStoreStateThroughAuthority(patch: StageStorePatch): void {
  const authority = getDefaultWhiteboardEnvironmentAuthority();
  if (!authority) {
    throw new Error('Default WhiteboardEnvironmentAuthority is not registered');
  }
  const result = authority.transact({
    label: 'test.fixture.stageStorePatch',
    writes: [
      {
        label: 'test.fixture.setState',
        write: () => useStageStore.setState(patch),
      },
    ],
  });
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.errors.join('; ')}`);
  }
}
