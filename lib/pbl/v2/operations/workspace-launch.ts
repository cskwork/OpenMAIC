import type { PBLProjectV2, PriorQuizResult } from '../types';
import { transitionProjectUiPhase } from './runtime-events';

/** Invalidate an async Hero launch before a different scene can reuse it. */
export function invalidatePendingWorkspaceLaunch(
  epoch: { current: number },
  setLaunching: (launching: boolean) => void,
): void {
  epoch.current += 1;
  setLaunching(false);
}

/** Prepare the project state written by the Hero when the learner starts.
 *
 * The Workspace mounts immediately; its Chat consumes
 * `pendingOpenTaskPriorQuizResults` to start the first `/open-task` stream,
 * then clears that transient payload before the request begins.
 */
export function prepareWorkspaceLaunchProject(
  project: PBLProjectV2,
  priorQuizResults: PriorQuizResult[],
): PBLProjectV2 {
  const next = transitionProjectUiPhase(project, 'workspace');
  if (priorQuizResults.length > 0) {
    next.pendingOpenTaskPriorQuizResults = priorQuizResults;
  } else {
    delete next.pendingOpenTaskPriorQuizResults;
  }
  return next;
}
