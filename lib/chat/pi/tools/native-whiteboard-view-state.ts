import type { AcceptedTargetBinding } from '@/lib/agent/runtime/client-effect-contract';
import type { StatelessChatRequest } from '@/lib/types/chat';

/**
 * Request-scoped projection of whiteboard visibility.
 *
 * The request-start snapshot seeds this value once. Afterwards only verified,
 * committed client effects may advance it; the original snapshot must not be
 * consulted again because it can be stale after a Native lifecycle effect.
 */
export class NativeWhiteboardViewState {
  private open: boolean;
  private whiteboardId: string | undefined;

  constructor(body: StatelessChatRequest) {
    this.open = body.storeState.whiteboardOpen === true;
    const latestWhiteboardId = body.storeState.stage?.whiteboard?.at(-1)?.id;
    this.whiteboardId =
      typeof latestWhiteboardId === 'string' && latestWhiteboardId.length > 0
        ? latestWhiteboardId
        : undefined;
  }

  isOpen(): boolean {
    return this.open;
  }

  getWhiteboardId(): string | undefined {
    return this.whiteboardId;
  }

  commitVisible(binding: AcceptedTargetBinding): void {
    if (!binding.whiteboardId) {
      throw new Error('CLIENT_EFFECT_WHITEBOARD_COMMIT_BINDING_MISSING');
    }
    this.whiteboardId = binding.whiteboardId;
    this.open = true;
  }
}
