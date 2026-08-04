import { describe, expect, it, vi } from 'vitest';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import type { ClientEffectDelivery } from '@/lib/agent/runtime/client-effect-contract';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedDrawTextDigests,
  type RevisionedWhiteboardEffectDelivery,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import { TOOL_EXECUTION_PROTOCOL_VERSION } from '@/lib/agent/runtime/native-child-contract';

const clientEffectDelivery = {
  acknowledgementToken: 'token',
  request: {
    protocolVersion: TOOL_EXECUTION_PROTOCOL_VERSION,
    kind: 'client_effect',
    traceId: 'trace',
    runId: 'run',
    agentInvocationId: 'message-1',
    agentId: 'teacher-1',
    depth: 1,
    sequence: 1,
    toolCallId: 'tool-call-1',
    executionId: 'execution-1',
    idempotencyKey: 'idempotency-1',
    toolName: 'wb_draw_text',
    args: { content: 'hello', x: 1, y: 1 },
    argsDigest: 'sha256:args',
    issuedAt: 1,
    deadlineAt: 10_000,
    attempt: 1,
    target: {
      requestId: 'request-1',
      sessionId: 'session-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      messageId: 'message-1',
    },
    activeEffectBudgetMs: 1_000,
    postcondition: {
      kind: 'whiteboard_text_exists',
      stableElementId: 'element-1',
      elementType: 'text',
      normalizationVersion: 'maic.visible-text.v1',
      expectedContentDigest: 'sha256:text',
    },
  },
} satisfies ClientEffectDelivery;

const revisionedExpectedBinding = { stageId: 'stage-1', whiteboardId: null, revision: 0 };
const revisionedAuthenticatedTarget = {
  childInvocationId: 'message-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  sceneId: 'scene-1',
};
const revisionedIntent = { content: 'hello', x: 100, y: 100 };
const revisionedDeadline = Date.now() + 60_000;
const revisionedDigests = createRevisionedDrawTextDigests({
  executionId: 'revisioned-execution-1',
  expectedBinding: revisionedExpectedBinding,
  authenticatedTarget: revisionedAuthenticatedTarget,
  deadlineAt: revisionedDeadline,
  intent: revisionedIntent,
})!;
const revisionedDelivery = {
  protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  executionId: 'revisioned-execution-1',
  requestDigest: revisionedDigests.requestDigest,
  toolName: 'wb_draw_text',
  expectedBinding: revisionedExpectedBinding,
  authenticatedTarget: revisionedAuthenticatedTarget,
  deadlineAt: revisionedDeadline,
  intent: revisionedIntent,
  acknowledgementToken: 'revisioned-token',
} satisfies RevisionedWhiteboardEffectDelivery;

describe('StreamBuffer Pi wrap-up ordering', () => {
  it('orders and pauses a revisioned client effect like a presentation mutation', async () => {
    const lifecycle: string[] = [];
    let releaseEffect!: () => void;
    const effectCompletion = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal(_messageId, _partId, text, complete) {
          if (complete) lifecycle.push(`text:${text}`);
        },
        onActionReady() {},
        onRevisionedClientEffectQueued() {
          lifecycle.push('reserved');
        },
        onRevisionedClientEffectReady() {
          lifecycle.push('revisioned-effect');
          return effectCompletion;
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {
          lifecycle.push('done');
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, charsPerTick: 100 },
    );
    buffer.pushAgentStart({
      messageId: 'message-1',
      agentId: 'teacher-1',
      agentName: 'Teacher',
    });
    buffer.pushText('message-1', '先读取，再修改。');
    buffer.pushRevisionedClientEffect('message-1', revisionedDelivery);
    buffer.pushAgentEnd({ messageId: 'message-1', agentId: 'teacher-1' });
    buffer.pushDone({ totalActions: 1, totalAgents: 1 });
    buffer.pause();
    buffer.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lifecycle).toEqual(['reserved']);
    buffer.resume();
    await vi.waitFor(() =>
      expect(lifecycle).toEqual(['reserved', 'text:先读取，再修改。', 'revisioned-effect']),
    );
    releaseEffect();
    await buffer.waitUntilDrained();
    expect(lifecycle).toEqual(['reserved', 'text:先读取，再修改。', 'revisioned-effect', 'done']);
  });

  it('presents pre-tool text before a client effect without waiting for TTS dwell', async () => {
    const lifecycle: string[] = [];
    let releaseEffect!: () => void;
    const effectCompletion = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal(_messageId, _partId, text, complete) {
          if (complete) lifecycle.push(`text:${text}`);
        },
        onActionReady() {},
        onClientEffectQueued() {
          lifecycle.push('reserved');
        },
        onClientEffectReady() {
          lifecycle.push('effect');
          return effectCompletion;
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {
          lifecycle.push('done');
        },
        onError(message) {
          throw new Error(message);
        },
        shouldHoldAfterReveal: () => true,
      },
      { tickMs: 1, charsPerTick: 100, postTextDelayMs: 5_000 },
    );
    buffer.pushAgentStart({
      messageId: 'message-1',
      agentId: 'teacher-1',
      agentName: 'Teacher',
    });
    buffer.pushText('message-1', '先看这个要点。');
    buffer.pushClientEffect(clientEffectDelivery);
    buffer.pushAgentEnd({ messageId: 'message-1', agentId: 'teacher-1' });
    buffer.pushDone({ totalActions: 1, totalAgents: 1 });
    buffer.start();

    await vi.waitFor(() =>
      expect(lifecycle).toEqual(['reserved', 'text:先看这个要点。', 'effect']),
    );
    releaseEffect();
    await buffer.waitUntilDrained();
    expect(lifecycle).toEqual(['reserved', 'text:先看这个要点。', 'effect', 'done']);
  });
  it('resolves immediately when done was processed before the drain waiter was registered', async () => {
    const lifecycle: string[] = [];
    const buffer = new StreamBuffer({
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {},
      onLiveSpeech() {},
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {
        lifecycle.push('done');
      },
      onError(message) {
        throw new Error(message);
      },
    });

    buffer.pushDone({ totalActions: 0, totalAgents: 0 });
    buffer.flush();

    await expect(buffer.waitUntilDrained()).resolves.toBeUndefined();
    expect(lifecycle).toEqual(['done']);
  });

  it('reveals teacher wrap-up text before done can trigger soft-closing', async () => {
    const visibleTexts: string[] = [];
    const lifecycle: string[] = [];
    const donePayloads: unknown[] = [];
    const buffer = new StreamBuffer(
      {
        onAgentStart(data) {
          lifecycle.push(`start:${data.agentId}`);
        },
        onAgentEnd(data) {
          lifecycle.push(`end:${data.agentId}`);
        },
        onTextReveal(_messageId, _partId, revealedText, isComplete) {
          if (isComplete) visibleTexts.push(revealedText);
        },
        onActionReady() {},
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone(data) {
          lifecycle.push('done');
          donePayloads.push(data);
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, charsPerTick: 100 },
    );

    buffer.pushAgentStart({
      messageId: 'wrap-up-message',
      agentId: 'teacher-1',
      agentName: 'AI teacher',
    });
    buffer.pushText('wrap-up-message', '总结一下：树荫通过减少直射辐射，让地面少吸热。');
    buffer.pushAgentEnd({ messageId: 'wrap-up-message', agentId: 'teacher-1' });
    buffer.pushDone({
      totalActions: 0,
      totalAgents: 1,
      agentHadContent: true,
      cueUserReceived: false,
      sessionClosed: true,
      endReason: 'user_done',
    });

    buffer.start();
    await buffer.waitUntilDrained();

    expect(visibleTexts).toEqual(['总结一下：树荫通过减少直射辐射，让地面少吸热。']);
    expect(lifecycle).toEqual(['start:teacher-1', 'end:teacher-1', 'done']);
    expect(donePayloads).toEqual([
      expect.objectContaining({ sessionClosed: true, endReason: 'user_done' }),
    ]);
  });

  it('waits for each action to complete before starting the next queued action', async () => {
    const lifecycle: string[] = [];
    let resolveClear: (() => void) | undefined;
    const clearCompleted = new Promise<void>((resolve) => {
      resolveClear = resolve;
    });
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady(_messageId, action) {
          lifecycle.push(`start:${action.actionName}`);
          if (action.actionName === 'wb_clear') {
            return clearCompleted.then(() => {
              lifecycle.push('finish:wb_clear');
            });
          }
          lifecycle.push(`finish:${action.actionName}`);
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {
          lifecycle.push('done');
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, actionDelayMs: 0 },
    );

    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'clear-1',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'draw-1',
      actionName: 'wb_draw_text',
      params: { content: 'new content' },
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 2, totalAgents: 1 });
    buffer.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifecycle).toEqual(['start:wb_clear']);

    resolveClear?.();
    await buffer.waitUntilDrained();

    expect(lifecycle).toEqual([
      'start:wb_clear',
      'finish:wb_clear',
      'start:wb_draw_text',
      'finish:wb_draw_text',
      'done',
    ]);
  });

  it('waits for an in-flight action before flushing later actions and done', async () => {
    const lifecycle: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstCompleted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady(_messageId, action) {
          lifecycle.push(`start:${action.actionId}`);
          if (action.actionId === 'first') {
            return firstCompleted.then(() => {
              lifecycle.push('finish:first');
            });
          }
          lifecycle.push(`finish:${action.actionId}`);
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {
          lifecycle.push('done');
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, actionDelayMs: 0 },
    );

    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'first',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'second',
      actionName: 'wb_draw_text',
      params: { content: 'new content' },
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 2, totalAgents: 1 });
    buffer.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const flushing = buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle).toEqual(['start:first']);

    resolveFirst?.();
    await flushing;
    await buffer.waitUntilDrained();

    expect(lifecycle).toEqual([
      'start:first',
      'finish:first',
      'start:second',
      'finish:second',
      'done',
    ]);
  });

  it('coalesces concurrent flush calls so each action executes once', async () => {
    const lifecycle: string[] = [];
    let resolveAction: (() => void) | undefined;
    const actionCompleted = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const buffer = new StreamBuffer({
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {
        lifecycle.push('action');
        return actionCompleted;
      },
      onLiveSpeech() {},
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {
        lifecycle.push('done');
      },
      onError(message) {
        throw new Error(message);
      },
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'action-1',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 1, totalAgents: 1 });

    const firstFlush = buffer.flush();
    const secondFlush = buffer.flush();
    expect(secondFlush).toBe(firstFlush);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle).toEqual(['action']);

    let actionSettled = false;
    const actionSettlement = buffer.waitForCurrentAction().then(() => {
      actionSettled = true;
    });
    await Promise.resolve();
    expect(actionSettled).toBe(false);

    resolveAction?.();
    await Promise.all([firstFlush, secondFlush, actionSettlement]);
    expect(actionSettled).toBe(true);
    expect(lifecycle).toEqual(['action', 'done']);
  });

  it('stops flush callbacks after shutdown during an awaited action', async () => {
    const lifecycle: string[] = [];
    let resolveAction: (() => void) | undefined;
    const actionCompleted = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const buffer = new StreamBuffer({
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {
        lifecycle.push('action');
        return actionCompleted;
      },
      onLiveSpeech() {
        lifecycle.push('speech');
      },
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {
        lifecycle.push('done');
      },
      onError(message) {
        throw new Error(message);
      },
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'action-1',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 1, totalAgents: 1 });

    const flushing = buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let actionSettled = false;
    const actionSettlement = buffer.waitForCurrentAction().then(() => {
      actionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actionSettled).toBe(false);
    buffer.shutdown();
    resolveAction?.();
    await Promise.all([flushing, actionSettlement]);

    expect(lifecycle).toEqual(['action']);
  });

  it('aborts background action work when the buffer shuts down', async () => {
    let actionSignal: AbortSignal | undefined;
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady(_messageId, _action, signal) {
          actionSignal = signal;
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {},
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1 },
    );
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'video-1',
      actionName: 'play_video',
      params: { elementId: 'video-element-1' },
      agentId: 'teacher-1',
    });
    buffer.start();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(actionSignal?.aborted).toBe(false);
    buffer.shutdown();
    expect(actionSignal?.aborted).toBe(true);
  });

  it('releases request-scoped resources exactly once when the buffer is retired', () => {
    let cleanupCount = 0;
    const callbacks = {
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {},
      onDispose() {
        cleanupCount++;
      },
      onLiveSpeech() {},
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {},
      onError(message: string) {
        throw new Error(message);
      },
    };

    const disposed = new StreamBuffer(callbacks);
    disposed.dispose();
    disposed.dispose();
    expect(cleanupCount).toBe(1);

    const shutDown = new StreamBuffer(callbacks);
    shutDown.shutdown();
    shutDown.shutdown();
    expect(cleanupCount).toBe(2);
  });
});
