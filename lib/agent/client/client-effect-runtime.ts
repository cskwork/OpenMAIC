'use client';

import { nanoid } from 'nanoid';
import type { StageStore } from '@/lib/api/stage-api';
import {
  CLIENT_EFFECT_ACK_HEADER,
  type AcceptedTargetBinding,
  type ClientEffectAck,
  type ClientEffectDelivery,
  type ClientEffectStatus,
  type ClientEffectTerminalStatus,
} from '@/lib/agent/runtime/client-effect-contract';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';
import {
  executeNativeWhiteboardTextEffect,
  prepareNativeWhiteboardTarget,
} from '@/lib/action/client-effect-whiteboard';

type EffectRecord = {
  delivery: ClientEffectDelivery;
  status: ClientEffectStatus;
  binding?: AcceptedTargetBinding;
  ackChain: Promise<void>;
  resumeWaiters: Set<() => void>;
  execution?: Promise<ClientEffectStatus>;
  presentationReady: boolean;
  serverPaused: boolean;
  ackFailure?: Error;
};

export interface BrowserClientEffectRuntimeOptions {
  sessionId: string;
  requestId: string;
  store: StageStore;
  waitForPresentation: (executionId: string, signal: AbortSignal) => Promise<void>;
  ensureWhiteboardVisible: (signal: AbortSignal) => Promise<void>;
  onState?: (executionId: string, status: ClientEffectStatus, error?: string) => void;
  fetchAck?: typeof fetch;
  now?: () => number;
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}

class AuthoritativeClientEffectError extends Error {
  constructor(readonly status: ClientEffectStatus) {
    super(`Client effect is already ${status}.`);
  }
}

function errorDetails(error: unknown): { code: string; message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  const targetChanged = message.includes('CLIENT_EFFECT_TARGET_CHANGED');
  return {
    code: targetChanged ? 'CLIENT_EFFECT_TARGET_CHANGED' : 'CLIENT_EFFECT_EXECUTION_FAILED',
    message,
    retryable: !targetChanged,
  };
}

export class BrowserClientEffectRuntime {
  private readonly records = new Map<string, EffectRecord>();
  private readonly fetchAck: typeof fetch;
  private readonly now: () => number;
  private paused = false;

  constructor(private readonly opts: BrowserClientEffectRuntimeOptions) {
    // Browser-native fetch requires Window as its receiver in Chromium. Keep
    // injected test transports untouched, but invoke the default through the
    // global object instead of storing an unbound method reference.
    this.fetchAck = opts.fetchAck ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  reserve(delivery: ClientEffectDelivery): void {
    const { request } = delivery;
    if (
      request.target.sessionId !== this.opts.sessionId ||
      request.target.requestId !== this.opts.requestId
    ) {
      throw new Error('CLIENT_EFFECT_REQUEST_TARGET_MISMATCH');
    }
    const existing = this.records.get(request.executionId);
    if (existing) {
      const previous = existing.delivery.request;
      if (
        previous.protocolVersion !== request.protocolVersion ||
        previous.kind !== request.kind ||
        previous.idempotencyKey !== request.idempotencyKey ||
        previous.toolName !== request.toolName ||
        previous.argsDigest !== request.argsDigest ||
        previous.postcondition.stableElementId !== request.postcondition.stableElementId ||
        previous.postcondition.elementType !== request.postcondition.elementType ||
        previous.postcondition.normalizationVersion !==
          request.postcondition.normalizationVersion ||
        previous.postcondition.expectedContentDigest !==
          request.postcondition.expectedContentDigest ||
        previous.target.requestId !== request.target.requestId ||
        previous.target.sessionId !== request.target.sessionId ||
        previous.target.stageId !== request.target.stageId ||
        previous.target.sceneId !== request.target.sceneId ||
        previous.target.messageId !== request.target.messageId ||
        existing.delivery.acknowledgementToken !== delivery.acknowledgementToken
      ) {
        throw new Error('CLIENT_EFFECT_DUPLICATE_CONFLICT');
      }
      return;
    }
    const record: EffectRecord = {
      delivery,
      status: 'pending',
      ackChain: Promise.resolve(),
      resumeWaiters: new Set(),
      presentationReady: false,
      serverPaused: true,
    };
    this.records.set(request.executionId, record);
    this.opts.onState?.(request.executionId, 'pending');
    // Presentation pacing (including pre-tool typewriter text) must not consume
    // the active browser-execution budget. The hard wall-clock deadline remains.
    record.ackChain = this.queueAck(record, { status: 'presentation_paused' });
  }

  execute(delivery: ClientEffectDelivery, signal: AbortSignal): Promise<ClientEffectStatus> {
    this.reserve(delivery);
    const record = this.records.get(delivery.request.executionId)!;
    if (!record.execution) record.execution = this.executeReserved(record, signal);
    return record.execution;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const record of this.records.values()) {
      if (this.isTerminal(record.status) || record.serverPaused) continue;
      record.serverPaused = true;
      record.ackChain = this.queueAck(record, { status: 'presentation_paused' });
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const record of this.records.values()) {
      if (this.isTerminal(record.status) || !record.serverPaused || !record.presentationReady) {
        continue;
      }
      record.ackChain = this.queueAck(record, { status: 'presentation_resumed' })
        .then(() => {
          if (record.ackFailure) throw record.ackFailure;
          record.serverPaused = false;
          for (const resolve of record.resumeWaiters) resolve();
          record.resumeWaiters.clear();
        })
        .catch((error: unknown) => {
          record.ackFailure =
            error instanceof Error ? error : new Error('Client effect ACK failed.');
          for (const resolve of record.resumeWaiters) resolve();
          record.resumeWaiters.clear();
        });
    }
  }

  private async executeReserved(
    record: EffectRecord,
    signal: AbortSignal,
  ): Promise<ClientEffectStatus> {
    const { request } = record.delivery;
    try {
      await this.opts.waitForPresentation(request.executionId, signal);
      record.presentationReady = true;
      await this.waitWhilePaused(record, signal);
      if (record.serverPaused) {
        await this.enqueueAck(record, { status: 'presentation_resumed' });
        record.serverPaused = false;
      }
      const binding = prepareNativeWhiteboardTarget(this.opts.store, request.target);
      record.binding = binding;
      await this.enqueueAck(record, { status: 'accepted', targetBinding: binding });
      record.status = 'accepted';
      this.opts.onState?.(request.executionId, 'accepted');

      await this.waitWhilePaused(record, signal);
      await this.opts.ensureWhiteboardVisible(signal);
      await this.waitWhilePaused(record, signal);
      const params = request.args as Record<string, unknown>;
      const result = await executeNativeWhiteboardTextEffect({
        store: this.opts.store,
        targetBinding: binding,
        input: {
          executionId: request.executionId,
          stableElementId: request.postcondition.stableElementId,
          content: String(params.content ?? ''),
          x: Number(params.x),
          y: Number(params.y),
          ...(params.width !== undefined ? { width: Number(params.width) } : {}),
          ...(params.height !== undefined ? { height: Number(params.height) } : {}),
          ...(params.fontSize !== undefined ? { fontSize: Number(params.fontSize) } : {}),
          ...(params.color !== undefined ? { color: String(params.color) } : {}),
        },
        expectedContentDigest: request.postcondition.expectedContentDigest,
        signal,
      });
      await this.enqueueAck(record, {
        status: 'effect_committed',
        targetBinding: binding,
        postcondition: result.postcondition,
      });
      record.status = 'effect_committed';
      this.opts.onState?.(request.executionId, 'effect_committed');
      return record.status;
    } catch (error) {
      const aborted =
        signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const authoritativeStatus =
        error instanceof AuthoritativeClientEffectError && this.isTerminal(error.status)
          ? error.status
          : undefined;
      const details = aborted
        ? {
            code: 'CLIENT_EFFECT_CANCELLED',
            message: 'Client effect was cancelled.',
            retryable: false,
          }
        : errorDetails(error);
      const localFailureStatus: 'cancelled' | 'effect_failed' =
        aborted || details.code === 'CLIENT_EFFECT_TARGET_CHANGED' || !record.binding
          ? 'cancelled'
          : 'effect_failed';
      const status = authoritativeStatus ?? localFailureStatus;
      if (!authoritativeStatus) {
        try {
          await this.enqueueAck(record, { status: localFailureStatus, error: details });
        } catch {
          // Preserve the original execution failure; the server hard deadline is
          // still the authoritative settlement if the ACK channel is unavailable.
        }
      }
      record.status = status;
      this.opts.onState?.(request.executionId, status, details.message);
      return record.status;
    }
  }

  private waitWhilePaused(record: EffectRecord, signal: AbortSignal): Promise<void> {
    if (!this.paused) {
      return record.ackChain.then(() => {
        if (record.ackFailure) throw record.ackFailure;
      });
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        record.resumeWaiters.delete(onResume);
        reject(abortError());
      };
      const onResume = () => {
        signal.removeEventListener('abort', onAbort);
        if (record.ackFailure) reject(record.ackFailure);
        else resolve();
      };
      record.resumeWaiters.add(onResume);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private enqueueAck(
    record: EffectRecord,
    payload:
      | Pick<
          Extract<ClientEffectAck, { status: 'presentation_paused' | 'presentation_resumed' }>,
          'status'
        >
      | Pick<Extract<ClientEffectAck, { status: 'accepted' }>, 'status' | 'targetBinding'>
      | Pick<
          Extract<ClientEffectAck, { status: 'effect_committed' }>,
          'status' | 'targetBinding' | 'postcondition'
        >
      | Pick<
          Extract<ClientEffectAck, { status: 'effect_failed' | 'cancelled' }>,
          'status' | 'error'
        >,
  ): Promise<void> {
    record.ackChain = this.queueAck(record, payload);
    return record.ackChain.then(() => {
      if (record.ackFailure) throw record.ackFailure;
    });
  }

  private queueAck(
    record: EffectRecord,
    payload:
      | Pick<
          Extract<ClientEffectAck, { status: 'presentation_paused' | 'presentation_resumed' }>,
          'status'
        >
      | Pick<Extract<ClientEffectAck, { status: 'accepted' }>, 'status' | 'targetBinding'>
      | Pick<
          Extract<ClientEffectAck, { status: 'effect_committed' }>,
          'status' | 'targetBinding' | 'postcondition'
        >
      | Pick<
          Extract<ClientEffectAck, { status: 'effect_failed' | 'cancelled' }>,
          'status' | 'error'
        >,
  ): Promise<void> {
    return record.ackChain
      .then(() => {
        if (record.ackFailure) return;
        return this.sendAck(record, payload);
      })
      .catch((error: unknown) => {
        record.ackFailure = error instanceof Error ? error : new Error('Client effect ACK failed.');
      });
  }

  private async sendAck(
    record: EffectRecord,
    payload:
      | Pick<ClientEffectAck, 'status'>
      | Pick<Extract<ClientEffectAck, { status: 'accepted' }>, 'status' | 'targetBinding'>
      | Pick<
          Extract<ClientEffectAck, { status: 'effect_committed' }>,
          'status' | 'targetBinding' | 'postcondition'
        >
      | Pick<
          Extract<ClientEffectAck, { status: 'effect_failed' | 'cancelled' }>,
          'status' | 'error'
        >,
  ): Promise<void> {
    const ack = {
      protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
      executionId: record.delivery.request.executionId,
      idempotencyKey: record.delivery.request.idempotencyKey,
      clientEventId: nanoid(),
      observedAt: this.now(),
      ...payload,
    } as ClientEffectAck;
    const response = await this.fetchAck(
      `/api/chat/pi/client-effects/${encodeURIComponent(ack.executionId)}/ack`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CLIENT_EFFECT_ACK_HEADER]: record.delivery.acknowledgementToken,
        },
        body: JSON.stringify(ack),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error(`CLIENT_EFFECT_ACK_FAILED_${response.status}`);
    const body = (await response.json()) as {
      success?: boolean;
      state?: { status?: ClientEffectStatus };
    };
    if (body.success !== true || !body.state?.status) {
      throw new Error('CLIENT_EFFECT_ACK_REJECTED');
    }
    if (
      (payload.status === 'accepted' || this.isTerminal(payload.status)) &&
      body.state.status !== payload.status
    ) {
      throw new AuthoritativeClientEffectError(body.state.status);
    }
  }

  private isTerminal(status: string): status is ClientEffectTerminalStatus {
    return (
      status === 'effect_committed' ||
      status === 'effect_failed' ||
      status === 'timed_out' ||
      status === 'cancelled'
    );
  }
}
