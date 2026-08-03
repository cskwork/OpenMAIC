import { useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { ActionEngine } from '@/lib/action/engine';
import type { Action } from '@/lib/types/action';
import type { PPTElement } from '@openmaic/dsl';
import type { Stage, Scene } from '@/lib/types/stage';
import { getDefaultWhiteboardEnvironmentAuthority } from '@/lib/store/whiteboard-environment-authority';

interface InitialState {
  stage: Stage | null;
  scenes: Scene[];
  currentSceneId: string | null;
  whiteboardElements?: PPTElement[];
}

/**
 * Manages headless Zustand stores + ActionEngine for eval.
 *
 * Zustand stores are singletons (module-level). We reset them
 * for each scenario via setState(). ActionEngine reads/writes
 * these same stores — no simulation drift.
 */
export class EvalStateManager {
  private actionEngine: ActionEngine;

  constructor(initial: InitialState) {
    // Reset non-domain history immediately. Stage + whiteboard visibility are
    // committed together through the same Environment Authority used in-app.
    useWhiteboardHistoryStore.setState({ snapshots: [] });

    // Build stage with optional pre-existing whiteboard elements
    const now = Date.now();
    const baseStage: Stage = initial.stage ?? {
      id: 'eval-stage',
      name: 'Eval Stage',
      languageDirective: 'en-US',
      createdAt: now,
      updatedAt: now,
    };

    // If pre-existing whiteboard elements are provided, construct the seeded
    // document immutably before it enters the Authority transaction.
    const stage: Stage =
      initial.whiteboardElements && initial.whiteboardElements.length > 0
        ? {
            ...baseStage,
            whiteboard: [
              {
                id: 'eval-whiteboard',
                viewportSize: 1000,
                viewportRatio: 16 / 9,
                elements: initial.whiteboardElements,
                background: { type: 'solid', color: '#ffffff' },
                animations: [],
              },
            ],
          }
        : baseStage;

    const hydrate = () => {
      useCanvasStore.setState({
        whiteboardOpen: false,
        whiteboardClearing: false,
      });
      useStageStore.setState({
        stage,
        scenes: initial.scenes,
        currentSceneId: initial.currentSceneId,
        mode: 'autonomous',
      });
    };
    const authority = getDefaultWhiteboardEnvironmentAuthority();
    const result = authority?.transact({
      label: 'eval.whiteboard-layout.hydrate',
      writes: [{ label: 'eval.hydrate', write: hydrate }],
    });
    if (!authority) hydrate();
    if (result && !result.ok && !result.mutationMayHaveCommitted) {
      throw new Error(`${result.code}: ${result.errors.join('; ')}`);
    }

    // ActionEngine takes the store module as its StageStore argument
    this.actionEngine = new ActionEngine(useStageStore);
  }

  async executeAction(action: Action): Promise<void> {
    await this.actionEngine.execute(action);
  }

  getStoreState(): {
    stage: Stage | null;
    scenes: Scene[];
    currentSceneId: string | null;
    mode: string;
    whiteboardOpen: boolean;
  } {
    const s = useStageStore.getState();
    return {
      stage: s.stage,
      scenes: s.scenes,
      currentSceneId: s.currentSceneId,
      mode: s.mode,
      whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
    };
  }

  getWhiteboardElements(): PPTElement[] {
    const active = getDefaultWhiteboardEnvironmentAuthority()?.queryActiveWhiteboard();
    return active?.ok ? (active.value?.elements ?? []) : [];
  }

  dispose(): void {
    this.actionEngine.dispose();
  }
}
