'use client';

import {
  REVISIONED_WHITEBOARD_ACK_HEADER,
  createRevisionedWhiteboardAcceptedAck,
  createRevisionedWhiteboardTerminalAck,
  isRevisionedWhiteboardEffectDelivery,
  type RevisionedWhiteboardAuthorityReceipt,
  type RevisionedWhiteboardEffectDelivery,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  digestRevisionedValue,
  immutableRevisionedSnapshot,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import {
  browserRevisionedWhiteboardTargetRegistry,
  type RevisionedWhiteboardTargetRegistry,
} from './revisioned-whiteboard-target-registry';
import {
  getDefaultWhiteboardEnvironmentAuthority,
  type WhiteboardEnvironmentAuthority,
} from '@/lib/store/whiteboard-environment-authority';

const MAX_BROWSER_REVISIONED_EFFECTS = 32;

export interface BrowserRevisionedWhiteboardEffectRuntimeOptions {
  requestId: string;
  sessionId: string;
  readCurrentStageId: () => string | null | undefined;
  readCurrentSceneId: () => string | null | undefined;
  fetchAck?: typeof fetch;
  getAuthority?: () => WhiteboardEnvironmentAuthority | null;
  targetRegistry?: RevisionedWhiteboardTargetRegistry;
  now?: () => number;
}

type BrowserExecution = {
  deliveryDigest: string;
  delivery: RevisionedWhiteboardEffectDelivery;
  execution?: Promise<RevisionedWhiteboardAuthorityReceipt>;
};

export class BrowserRevisionedWhiteboardEffectRuntime {
  private readonly executions = new Map<string, BrowserExecution>();
  private readonly fetchAck: typeof fetch;
  private readonly getAuthority: () => WhiteboardEnvironmentAuthority | null;
  private readonly targetRegistry: RevisionedWhiteboardTargetRegistry;
  private readonly now: () => number;

  constructor(private readonly opts: BrowserRevisionedWhiteboardEffectRuntimeOptions) {
    this.fetchAck = opts.fetchAck ?? ((input, init) => globalThis.fetch(input, init));
    this.getAuthority = opts.getAuthority ?? getDefaultWhiteboardEnvironmentAuthority;
    this.targetRegistry = opts.targetRegistry ?? browserRevisionedWhiteboardTargetRegistry;
    this.now = opts.now ?? Date.now;
  }

  reserve(value: unknown): void {
    if (!isRevisionedWhiteboardEffectDelivery(value)) {
      throw new Error('REVISIONED_WHITEBOARD_DELIVERY_INVALID');
    }
    const deliveryDigest = digestRevisionedValue(value);
    const existing = this.executions.get(value.executionId);
    if (existing) {
      if (existing.deliveryDigest !== deliveryDigest) {
        throw new Error('REVISIONED_WHITEBOARD_DELIVERY_CONFLICT');
      }
      return;
    }
    if (this.executions.size >= MAX_BROWSER_REVISIONED_EFFECTS) {
      throw new Error('REVISIONED_WHITEBOARD_BROWSER_CAPACITY_EXCEEDED');
    }
    this.targetRegistry.register(value, {
      requestId: this.opts.requestId,
      sessionId: this.opts.sessionId,
      readCurrentStageId: this.opts.readCurrentStageId,
      readCurrentSceneId: this.opts.readCurrentSceneId,
    });
    const delivery = immutableRevisionedSnapshot(value) as RevisionedWhiteboardEffectDelivery;
    this.executions.set(value.executionId, { deliveryDigest, delivery });
  }

  execute(
    delivery: RevisionedWhiteboardEffectDelivery,
    signal?: AbortSignal,
  ): Promise<RevisionedWhiteboardAuthorityReceipt> {
    this.reserve(delivery);
    const entry = this.executions.get(delivery.executionId)!;
    if (!entry.execution) entry.execution = this.executeReserved(entry.delivery, signal);
    return entry.execution;
  }

  clear(): void {
    for (const executionId of this.executions.keys()) this.targetRegistry.release(executionId);
    this.executions.clear();
  }

  private async executeReserved(
    delivery: RevisionedWhiteboardEffectDelivery,
    signal?: AbortSignal,
  ): Promise<RevisionedWhiteboardAuthorityReceipt> {
    if (delivery.deadlineAt <= this.now()) {
      this.targetRegistry.release(delivery.executionId);
      throw new Error('REVISIONED_WHITEBOARD_DEADLINE_EXCEEDED');
    }
    const authority = this.getAuthority();
    if (!authority) {
      this.targetRegistry.release(delivery.executionId);
      throw new Error('WHITEBOARD_AUTHORITY_UNAVAILABLE');
    }
    authority.configureAuthenticatedTargetRegistry(this.targetRegistry);
    const observed = authority.querySnapshot();
    if (!observed.ok || observed.value.stageId === null) {
      this.targetRegistry.release(delivery.executionId);
      throw new Error(observed.ok ? 'WHITEBOARD_TARGET_UNAVAILABLE' : observed.code);
    }

    await this.postAck(
      delivery,
      createRevisionedWhiteboardAcceptedAck({
        executionId: delivery.executionId,
        requestDigest: delivery.requestDigest,
        targetBinding: {
          stageId: observed.value.stageId,
          whiteboardId: observed.value.activeWhiteboardId,
          observedRevision: observed.value.revision,
        },
      }),
      signal,
      false,
    );

    // There is intentionally no await between authenticated accepted and this
    // synchronous Authority CAS. The final receipt, not accepted, decides the outcome.
    const mutationInput = {
      executionId: delivery.executionId,
      requestDigest: delivery.requestDigest,
      expected: delivery.expectedBinding,
      authenticatedTarget: delivery.authenticatedTarget,
      deadlineAt: delivery.deadlineAt,
      intentDigest: digestRevisionedValue(delivery.intent),
      intent: delivery.intent,
    };
    const result = (() => {
      switch (delivery.toolName) {
        case 'wb_open':
          return authority.transactRevisionedOpen({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_close':
          return authority.transactRevisionedClose({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_draw_text':
          return authority.transactRevisionedDrawText({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_draw_shape':
          return authority.transactRevisionedDrawShape({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_draw_line':
          return authority.transactRevisionedDrawLine({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_draw_latex':
          return authority.transactRevisionedDrawLatex({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_draw_table':
          return authority.transactRevisionedDrawTable({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_draw_chart':
          return authority.transactRevisionedDrawChart({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_draw_code':
          return authority.transactRevisionedDrawCode({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_edit_code':
          return authority.transactRevisionedEditCode({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_delete':
          return authority.transactRevisionedDelete({
            ...mutationInput,
            intent: delivery.intent,
          });
        case 'wb_clear':
          return authority.transactRevisionedClear({
            ...mutationInput,
            intent: delivery.intent,
          });
      }
    })();
    if (!result.ok) throw new Error(result.code);
    const terminalAck = createRevisionedWhiteboardTerminalAck(result.receipt);
    await this.postAck(delivery, terminalAck, undefined, true);
    return result.receipt;
  }

  private async postAck(
    delivery: RevisionedWhiteboardEffectDelivery,
    body: ReturnType<typeof createRevisionedWhiteboardAcceptedAck>,
    signal: AbortSignal | undefined,
    retryOnResponseLoss: boolean,
  ): Promise<void> {
    const serialized = JSON.stringify(body);
    const post = () => {
      const remainingMs = Math.max(1, delivery.deadlineAt - this.now());
      const timeout = AbortSignal.timeout(remainingMs);
      const deliverySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      return this.fetchAck(
        `/api/chat/pi/revisioned-whiteboard-effects/${encodeURIComponent(delivery.executionId)}/ack`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [REVISIONED_WHITEBOARD_ACK_HEADER]: delivery.acknowledgementToken,
          },
          body: serialized,
          signal: deliverySignal,
        },
      );
    };
    let response: Response;
    try {
      response = await post();
    } catch (error) {
      if (!retryOnResponseLoss) throw error;
      response = await post();
    }
    if (!response.ok) {
      throw new Error(`REVISIONED_WHITEBOARD_ACK_FAILED:${response.status}`);
    }
  }
}
