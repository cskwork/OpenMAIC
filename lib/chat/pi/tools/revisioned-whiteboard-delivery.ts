import type { RevisionedWhiteboardEffectDelivery } from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import type {
  RegisteredRevisionedMutation,
  RevisionedWhiteboardTerminal,
} from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type { SendEvent } from '../types';
import type { RevisionedWhiteboardMutationRuntime } from './revisioned-whiteboard-runtime';

export async function deliverAndAwaitRevisionedWhiteboardMutation(input: {
  registration: RegisteredRevisionedMutation;
  delivery?: RevisionedWhiteboardEffectDelivery;
  executionId: string;
  mutationRuntime: RevisionedWhiteboardMutationRuntime;
  send: SendEvent;
  signal?: AbortSignal;
  onActionDone: () => void;
}): Promise<RevisionedWhiteboardTerminal> {
  let releaseSettlementWait = () => {};
  const settlementWait = new Promise<void>((resolve) => {
    releaseSettlementWait = resolve;
  });
  let actionError: unknown;

  const chargeActionOnce = () => {
    if (!input.mutationRuntime.takeActionCharge(input.executionId)) return;
    try {
      input.onActionDone();
    } catch (error) {
      actionError = error;
    }
  };
  const settleDeliveryFailure = () => {
    input.mutationRuntime.settleDeliveryFailure(input.executionId);
    chargeActionOnce();
    releaseSettlementWait();
  };

  input.signal?.addEventListener('abort', settleDeliveryFailure, { once: true });
  if (input.signal?.aborted) settleDeliveryFailure();

  try {
    if (input.registration.kind === 'pending' && !input.signal?.aborted) {
      if (!input.delivery) {
        settleDeliveryFailure();
        throw new Error('REVISIONED_WHITEBOARD_DELIVERY_MISSING');
      }
      let sendSettlement: Promise<void>;
      try {
        sendSettlement = input
          .send({ type: 'revisioned_client_effect', data: input.delivery })
          .then(undefined, () => settleDeliveryFailure());
      } catch {
        settleDeliveryFailure();
        sendSettlement = Promise.resolve();
      }
      await Promise.race([
        sendSettlement,
        settlementWait,
        input.registration.terminal.then(() => undefined),
      ]);
    }

    const terminal = await input.registration.terminal;
    chargeActionOnce();
    if (actionError) throw actionError;
    return terminal;
  } finally {
    input.signal?.removeEventListener('abort', settleDeliveryFailure);
  }
}
