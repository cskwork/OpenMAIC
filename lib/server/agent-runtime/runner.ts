/**
 * Lease-coordinated background execution for durable agent conversations.
 *
 * Every application process may run this loop. PostgreSQL is the authority for
 * claims, lease generations, event ordering, cancellation, and conversation
 * recovery. A client connection is never part of the execution lifetime.
 */
import { randomUUID } from 'node:crypto';
import { Session, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core';
import {
  AgentSessionLeaseLostError,
  type AgentSessionClaimReason,
  type AgentSessionMeta,
  type AgentSessionUserMessage,
  type ClaimedAgentSession,
} from '@openmaic/storage';

import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { HOST_AGENT_LIFECYCLE as LIFECYCLE } from '@/lib/agent-runtime/lifecycle';
import { createLogger } from '@/lib/logger';

import { resolveAgentDriverModel } from './agent-driver-model';
import { buildAskUserTool } from './ask-user';
import { agentRuntimeConfig as config } from './config';
import {
  AgentSessionEntryStorage,
  loadSessionEntryHistory,
  type SessionEntryHistory,
} from './entry-tree-storage';
import { planResume, type ResumeAction } from './resume';
import { getAgentSessionStore } from './store';

const log = createLogger('AgentRunner');
const WORKER_ID = `${randomUUID().slice(0, 8)}:${process.pid}`;
const SESSION_WAKEUP_FALLBACK_MS = 5_000;
const MESSAGE_UPDATE_MIN_INTERVAL_MS = 150;

/** The runner starts with one capability and no product-specific tools. */
export const MINIMAL_AGENT_TOOL_NAMES = new Set(['ask_user']);

/** Product-neutral prompt for the zero-tool runtime slice. */
export const AGENT_RUNTIME_SYSTEM_PROMPT = [
  'You are a capable assistant working in a durable background session.',
  'Complete the user request carefully and explain the result clearly.',
  'The conversation may pause, restart on another worker, or receive follow-up messages.',
  'Treat earlier conversation messages as durable context.',
  'Do not claim access to tools or data that are not present in this session.',
  'Your only available tool is ask_user.',
  'Use ask_user only when a decision genuinely belongs to the user.',
  'Make every question self-contained and concise.',
  'Offer stable, unique option ids when choices are useful.',
  'After ask_user succeeds, stop and wait for the next user message.',
  'Do not answer your own question or invent the user decision.',
  'If no clarification is needed, answer directly without calling a tool.',
  'Follow later user messages as updates to the same conversation.',
  'Be honest about uncertainty and unavailable capabilities.',
  "Reply in the user's language unless the user requests another language.",
].join('\n');

function isLeaseLostError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    if (current instanceof AgentSessionLeaseLostError) return true;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A required tree write cannot be downgraded to telemetry. */
export async function writeRequiredSessionEntry(
  write: () => Promise<void>,
  onLeaseLost: () => void,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (isLeaseLostError(error)) {
      onLeaseLost();
      return;
    }
    throw error;
  }
}

interface RunResultMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function messageContentLength(message: unknown): number {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 0;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((length, block) => {
    if (typeof block === 'string') return length + block.length;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return length;
    const text = (block as { text?: unknown }).text;
    const thinking = (block as { thinking?: unknown }).thinking;
    return (
      length +
      (typeof text === 'string' ? text.length : 0) +
      (typeof thinking === 'string' ? thinking.length : 0)
    );
  }, 0);
}

function slimRunResultMessage(message: unknown): RunResultMessage {
  const source = (message ?? {}) as RunResultMessage;
  return {
    role: source.role,
    stopReason: source.stopReason,
    errorMessage: source.errorMessage,
  };
}

const TOOL_RESULT_LOG_FIELDS = ['role', 'toolCallId', 'toolName', 'isError', 'timestamp'] as const;

function slimToolResultsForLog(toolResults: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(toolResults)) return null;
  const results: Record<string, unknown>[] = [];
  for (const result of toolResults) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const source = result as Record<string, unknown>;
    if (
      source.role !== 'toolResult' ||
      typeof source.toolCallId !== 'string' ||
      typeof source.toolName !== 'string' ||
      typeof source.isError !== 'boolean' ||
      typeof source.timestamp !== 'number' ||
      !Array.isArray(source.content)
    ) {
      return null;
    }
    const slimmed: Record<string, unknown> = {};
    for (const field of TOOL_RESULT_LOG_FIELDS) slimmed[field] = source[field];
    results.push(slimmed);
  }
  return results;
}

/** Keep replay payloads small without mutating pi's recovery transcript. */
export function slimEventDataForLog(type: string, data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const source = data as Record<string, unknown>;

  if (type === 'agent_end' && Array.isArray(source.messages)) {
    const last = source.messages[source.messages.length - 1];
    return {
      ...source,
      messageCount: source.messages.length,
      lastMessageContentLength: messageContentLength(last),
      messages: last === undefined ? [] : [slimRunResultMessage(last)],
    };
  }

  if (type === 'turn_end') {
    const slimmed: Record<string, unknown> = {
      ...source,
      ...(source.message === undefined ? {} : { message: slimRunResultMessage(source.message) }),
    };
    if (source.toolResults !== undefined) {
      const toolResults = slimToolResultsForLog(source.toolResults);
      if (toolResults === null) {
        log.warn(
          'turn_end toolResults shape unrecognized; preserving original payload via deep clone',
        );
        try {
          slimmed.toolResults = structuredClone(source.toolResults);
        } catch (error) {
          log.warn(
            'turn_end toolResults deep clone failed; preserving original payload reference',
            error,
          );
          slimmed.toolResults = source.toolResults;
        }
      } else {
        slimmed.toolResults = toolResults;
      }
    }
    return slimmed;
  }

  if (type === 'tool_execution_update') {
    const slimmed = { ...source };
    delete slimmed.args;
    delete slimmed.partialResult;
    return slimmed;
  }

  if (type === 'message_start' || type === 'message_end') {
    const message = source.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const messageSource = message as Record<string, unknown>;
      if (messageSource.role === 'toolResult') {
        return { ...source, message: { ...messageSource, content: [] } };
      }
    }
  }
  return data;
}

/** The cap itself is a legal run; a claim after it is a verdict-only claim. */
export function isOverAttemptCap(meta: { attempt: number }): boolean {
  return meta.attempt > config.maxAttempts;
}

const RUN_LIFECYCLE_EVENT_TYPES = new Set<string>([
  LIFECYCLE.sessionStart,
  LIFECYCLE.sessionResumed,
  LIFECYCLE.sessionInterrupted,
  LIFECYCLE.sessionEnd,
]);

/** Runtime tripwire for the client's attempt-reset fence. */
export function markRunEventEmitted(alreadyEmitted: boolean, type: string): boolean {
  return alreadyEmitted || RUN_LIFECYCLE_EVENT_TYPES.has(type);
}

export const LENGTH_STOP_ERROR =
  'model output hit the max token limit and was truncated; this run did not finish';

export function terminalLoopError(
  messages: readonly AgentMessage[],
  errorMessage: string | undefined,
): string | undefined {
  if (errorMessage) return errorMessage;
  const lastAssistant = messages.findLast((message) => message.role === 'assistant') as
    | (AgentMessage & { stopReason?: unknown })
    | undefined;
  return lastAssistant?.stopReason === 'length' ? LENGTH_STOP_ERROR : undefined;
}

export type UndeliveredRequeueAction = 'none' | 'reset' | 'retry';

/** Classify undelivered work relative to the exact claim watermark. */
export function planUndeliveredRequeue(input: {
  logged: { seq: number; ts: number }[];
  handled: number;
  claimSeq: number;
  atVerdict: boolean;
}): UndeliveredRequeueAction {
  const undelivered = input.logged.slice(input.handled);
  if (undelivered.length === 0) return 'none';
  if (undelivered.some((message) => message.seq > input.claimSeq)) return 'reset';
  return input.atVerdict ? 'none' : 'retry';
}

export type RunStart = { kind: 'prompt'; text: string } | { kind: 'continue' };

export interface FollowUpMessage {
  text: string;
  materials?: Array<{
    materialId?: string;
    originalName?: string;
    mime?: string;
    bytes?: number;
  }>;
}

/** Derive delivery from the immutable entry sequence, not in-memory state. */
export function loggedMessageCursor(input: {
  transcriptUserCount: number;
  firstTranscriptUserText?: string;
  loggedCount: number;
  firstLoggedText?: string;
  idleAttach?: boolean;
}): { idle: boolean; delivered: number } {
  const idle = input.idleAttach === true;
  return {
    idle,
    delivered: idle ? input.transcriptUserCount : Math.max(0, input.transcriptUserCount - 1),
  };
}

export function composeFollowUpText(message: FollowUpMessage): string {
  if (!message.materials?.length) return message.text;
  const list = message.materials
    .map((material) => {
      const id = material.materialId ?? 'attached material';
      const mime = material.mime ?? 'unknown mime';
      return `"${material.originalName ?? id}" (${mime}, ${material.bytes ?? 0} bytes)`;
    })
    .join(', ');
  return `${message.text}\n\n[The user attached session material: ${list}. It is registered with this session; reading support will be provided in a later delivery.]`;
}

export function planRunStart(input: {
  plan: ResumeAction;
  claimReason: AgentSessionClaimReason;
  pending: FollowUpMessage[];
  prompt: string;
  idleAttach?: boolean;
}): RunStart {
  if (input.plan.kind === 'start' && input.pending.length > 0 && input.idleAttach) {
    return { kind: 'prompt', text: composeFollowUpText(input.pending[0]!) };
  }
  if (input.plan.kind === 'start') return { kind: 'prompt', text: input.prompt };
  if (input.claimReason === 'queued' && input.pending.length > 0) {
    return { kind: 'prompt', text: composeFollowUpText(input.pending[0]!) };
  }
  return { kind: 'continue' };
}

export function shouldTerminateAfterToolCall(toolName: string, isError: boolean): boolean {
  return toolName === 'ask_user' && !isError;
}

/** Make successful ask_user termination sticky across a mixed tool batch. */
export function createAskUserTerminateLatch(): {
  shouldTerminate(toolName: string, isError: boolean): boolean;
} {
  let committed = false;
  return {
    shouldTerminate(toolName, isError) {
      if (shouldTerminateAfterToolCall(toolName, isError)) committed = true;
      return committed;
    },
  };
}

export interface AgentRunnerHandle {
  readonly workerId: string;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface RunContext {
  running: Map<string, { abort: AbortController }>;
  shuttingDown: boolean;
}

function toFollowUp(message: AgentSessionUserMessage): FollowUpMessage {
  return {
    text: message.text,
    ...(message.materials.length
      ? { materials: message.materials as FollowUpMessage['materials'] }
      : {}),
  };
}

function leaseMatches(
  session: AgentSessionMeta | null,
  workerId: string,
  attempt: number,
): boolean {
  return session?.lease?.workerId === workerId && session.attempt === attempt;
}

// Session execution is intentionally one large state machine: its nested
// finally blocks pair every timer, subscription, and agent listener with the
// exact lifetime in which it can fire.
export async function runSession(ctx: RunContext, meta: ClaimedAgentSession): Promise<void> {
  const id = meta.id;
  const attempt = meta.attempt;
  const claimSeq = meta.claimSeq;
  const abort = new AbortController();
  ctx.running.set(id, { abort });

  let store: Awaited<ReturnType<typeof getAgentSessionStore>>;
  try {
    store = await getAgentSessionStore();
  } catch (error) {
    ctx.running.delete(id);
    throw error;
  }
  let leaseLost = false;
  let cancelled = false;
  let chain: Promise<void> = Promise.resolve();
  let criticalWriteError: unknown;
  let entryWritesHealthy = true;

  const markLeaseLost = () => {
    leaseLost = true;
    abort.abort();
  };
  const enqueue = (write: () => Promise<void>, critical = false): void => {
    chain = chain.then(async () => {
      if (leaseLost || (critical && !entryWritesHealthy)) return;
      try {
        if (critical) await writeRequiredSessionEntry(write, markLeaseLost);
        else await write();
      } catch (error) {
        if (isLeaseLostError(error)) {
          markLeaseLost();
          return;
        }
        log.error(`session ${id}: ${critical ? 'entry' : 'event'} write failed`, error);
        if (critical && criticalWriteError === undefined) {
          entryWritesHealthy = false;
          criticalWriteError = error;
          abort.abort();
        }
      }
    });
  };
  const flushAll = async (propagateEntryFailure = true): Promise<void> => {
    await chain;
    if (propagateEntryFailure && criticalWriteError !== undefined && !leaseLost) {
      throw criticalWriteError;
    }
  };

  let entrySession: Session | undefined;
  const loadEntryHistory = async (): Promise<SessionEntryHistory> => {
    entrySession ??= new Session(
      await AgentSessionEntryStorage.open({ sessionId: id, workerId: WORKER_ID, attempt }),
    );
    return loadSessionEntryHistory(entrySession, {
      sessionId: id,
      hasPriorRun: await store.hasSessionRunHistory(id),
    });
  };

  let runEventEmitted = false;
  let tripwireViolated = false;
  let lastMessageUpdateAt = 0;
  let messageHadThinking = false;
  let thinkingEndPending = false;
  let thinkingEndEmitted = false;

  const appendEvent = (type: string, data: unknown, ts: number): void => {
    enqueue(async () => {
      const seq = await store.appendRunEvent(id, WORKER_ID, {
        ts,
        attempt,
        type,
        data: slimEventDataForLog(type, data),
      });
      if (seq === null) markLeaseLost();
    });
  };

  const emit = (type: string, data: unknown): void => {
    if (!markRunEventEmitted(runEventEmitted, type)) {
      if (!tripwireViolated) {
        tripwireViolated = true;
        log.error(
          `TRIPWIRE VIOLATION session ${id}: first runner event must be lifecycle, got ${type}`,
        );
        abort.abort();
      }
      return;
    }
    runEventEmitted = true;
    if (leaseLost) return;

    const now = Date.now();
    const endOwesThinkingEnd = type === 'message_end' && thinkingEndPending && !thinkingEndEmitted;
    if (type === 'message_start' || type === 'message_end') {
      lastMessageUpdateAt = 0;
      messageHadThinking = false;
      thinkingEndPending = false;
      thinkingEndEmitted = false;
    }
    if (type === 'message_start' || type === 'message_update') {
      const message = (data as { message?: { role?: string; content?: unknown[] } })?.message;
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        let hasThinking = false;
        let hasText = false;
        for (const block of message.content as Array<{
          type?: string;
          text?: string;
          thinking?: string;
        }>) {
          if (block?.type === 'thinking' && String(block.thinking ?? '').trim()) {
            hasThinking = true;
          }
          if (block?.type === 'text' && String(block.text ?? '').trim()) hasText = true;
        }
        if (hasThinking) messageHadThinking = true;
        if (hasText && messageHadThinking && !thinkingEndEmitted) thinkingEndPending = true;
      }
    }
    if (type === 'message_update') {
      if (now - lastMessageUpdateAt < MESSAGE_UPDATE_MIN_INTERVAL_MS) return;
      lastMessageUpdateAt = now;
    }

    appendEvent(type, data, now);
    if (type === 'message_update' && thinkingEndPending && !thinkingEndEmitted) {
      thinkingEndPending = false;
      thinkingEndEmitted = true;
      appendEvent(LIFECYCLE.thinkingEnd, {}, now);
    }
    if (endOwesThinkingEnd) {
      thinkingEndEmitted = true;
      appendEvent(LIFECYCLE.thinkingEnd, {}, now);
    }
  };

  /** Every terminal exit checks whether a durable message lacked a consumer. */
  const requeueIfUndelivered = async (why: string, atVerdict = false): Promise<void> => {
    try {
      const logged = await store.listUserMessages(id);
      const history = await loadEntryHistory();
      const users = history.cursorMessages.filter((message) => message.role === 'user');
      const handled = loggedMessageCursor({
        transcriptUserCount: users.length,
        firstTranscriptUserText:
          typeof users[0]?.content === 'string' ? users[0].content : undefined,
        loggedCount: logged.length,
        firstLoggedText: logged[0]?.text,
        idleAttach: meta.existingCourse,
      }).delivered;
      const action = planUndeliveredRequeue({ logged, handled, claimSeq, atVerdict });
      if (action === 'reset' && (await store.requeueSession(id))) {
        log.info(
          `session ${id}: ${logged.length - handled} fresh undelivered message(s) at ${why}; requeued with attempt reset`,
        );
      } else if (action === 'retry' && (await store.requeueForRetry(id))) {
        log.info(
          `session ${id}: ${logged.length - handled} stranded message(s) at ${why}; requeued preserving attempt`,
        );
      }
    } catch (error) {
      log.warn(`session ${id}: post-terminal requeue check (${why}) failed`, error);
    }
  };

  // A verdict claim never executes the model. A message posted after the
  // claim still receives one attended redemption through the common check.
  if (isOverAttemptCap(meta)) {
    try {
      const error =
        `session failed ${config.maxAttempts} consecutive unattended attempts; ` +
        'send a new message to retry';
      emit(LIFECYCLE.sessionEnd, { status: 'failed', error });
      await flushAll();
      await store.finishSession(id, WORKER_ID, { status: 'failed', error });
      await requeueIfUndelivered('over-cap verdict', true);
      return;
    } finally {
      await flushAll(false);
      ctx.running.delete(id);
    }
  }

  const heartbeatTimer = setInterval(() => {
    store
      .heartbeat(id, WORKER_ID)
      .then((held) => {
        if (!held && !leaseLost) {
          log.warn(`session ${id}: lease lost; aborting local run`);
          markLeaseLost();
        }
      })
      .catch((error) => log.warn(`session ${id}: heartbeat failed`, error));
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  const checkCancel = (): void => {
    store
      .isCancelRequested(id)
      .then((requested) => {
        if (requested) {
          cancelled = true;
          abort.abort();
        }
      })
      .catch(() => {});
  };
  const cancelPoll = setInterval(checkCancel, SESSION_WAKEUP_FALLBACK_MS);
  cancelPoll.unref?.();

  try {
    const recovery = await loadEntryHistory();
    const historyMessages = recovery.messages;
    const plan = planResume(historyMessages);
    const repairedCount = plan.kind === 'continue' ? plan.repairedToolCalls.length : 0;
    const plannedMessages = plan.kind === 'start' ? [] : plan.messages;
    const retainedCount = plannedMessages.length - repairedCount;

    // planResume may strip an incomplete suffix and synthesize missing tool
    // results. Reflect both changes in the append-only tree before execution.
    if (retainedCount < historyMessages.length) {
      const targetId = retainedCount > 0 ? recovery.contextEntryIds[retainedCount - 1]! : null;
      await writeRequiredSessionEntry(async () => {
        await entrySession!.moveTo(targetId);
      }, markLeaseLost);
    }
    for (const repaired of plannedMessages.slice(retainedCount)) {
      await writeRequiredSessionEntry(async () => {
        await entrySession!.appendMessage(repaired);
      }, markLeaseLost);
    }
    if (leaseLost) throw new AgentSessionLeaseLostError(id, WORKER_ID, attempt);

    const loggedMessages = await store.listUserMessages(id);
    const historyUsers = recovery.cursorMessages.filter((message) => message.role === 'user');
    const cursor = loggedMessageCursor({
      transcriptUserCount: historyUsers.length,
      firstTranscriptUserText:
        typeof historyUsers[0]?.content === 'string' ? historyUsers[0].content : undefined,
      loggedCount: loggedMessages.length,
      firstLoggedText: loggedMessages[0]?.text,
      idleAttach: meta.existingCourse,
    });
    const followUpsDelivered = cursor.delivered;
    const pending = loggedMessages.slice(followUpsDelivered).map(toFollowUp);
    const idleAttach = cursor.idle;

    if (plan.kind === 'already-complete' && pending.length === 0) {
      emit(LIFECYCLE.sessionEnd, {
        status: 'succeeded',
        note: 'entry history already terminal',
      });
      await flushAll();
      await store.finishSession(id, WORKER_ID, {
        status: 'succeeded',
        resetAttempt: true,
      });
      await requeueIfUndelivered('early settle');
      return;
    }

    if (plan.kind === 'start' && (pending.length === 0 || !idleAttach)) {
      emit(LIFECYCLE.sessionStart, {
        workerId: WORKER_ID,
        pid: process.pid,
        prompt: meta.prompt,
      });
    } else {
      emit(LIFECYCLE.sessionResumed, {
        workerId: WORKER_ID,
        pid: process.pid,
        attempt,
        reason: plan.kind === 'start' || meta.claimReason === 'queued' ? 'follow_up' : 'crash',
        transcriptMessages: plan.kind === 'start' ? 0 : plan.messages.length,
        repairedToolCalls: plan.kind === 'continue' ? plan.repairedToolCalls : [],
      });
    }

    const plannedStart = planRunStart({
      plan,
      claimReason: meta.claimReason,
      pending,
      prompt: meta.prompt,
      idleAttach,
    });
    const driver = await resolveAgentDriverModel();
    const streamFn = createCallLlmStreamFn({
      languageModel: driver.connection.model,
      maxOutputTokens: driver.wireMaxOutputTokens,
      omitMaxOutputTokens: driver.wireMaxOutputTokens === undefined,
      thinkingConfig: driver.connection.thinkingConfig,
      source: 'agent-runtime',
      abortSignal: abort.signal,
    });
    const askUserTool = buildAskUserTool({
      onUserQuestion: (question) => emit(LIFECYCLE.userQuestion, question),
    });
    const tools = [askUserTool];
    const askUserLatch = createAskUserTerminateLatch();
    let toolCalls = 0;
    const agent = buildAgent({
      streamFn,
      systemPrompt: AGENT_RUNTIME_SYSTEM_PROMPT,
      model: driver.piModel,
      tools,
      allowedToolNames: MINIMAL_AGENT_TOOL_NAMES,
      ...(plan.kind === 'start' ? {} : { history: plan.messages }),
      afterToolCall: (toolContext) => {
        toolCalls += 1;
        if (askUserLatch.shouldTerminate(toolContext.toolCall.name, toolContext.isError)) {
          return { terminate: true };
        }
        return undefined;
      },
    });

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      emit(event.type, event);
      if (event.type === 'message_end') {
        enqueue(async () => {
          await entrySession!.appendMessage(event.message);
        }, true);
      }
    });
    const abortAgent = () => agent.abort();
    abort.signal.addEventListener('abort', abortAgent);

    // Same-run steering needs a guard because steer() accepts a message before
    // its eventual message_end has reached the durable tree.
    let steeredThisAttempt = 0;
    const deliveredFollowUps = (): number => {
      const users = agent.state.messages.filter((message) => message.role === 'user').length;
      return cursor.idle ? users : Math.max(0, users - 1);
    };
    const drainMessages = async (): Promise<number> => {
      const all = await store.listUserMessages(id);
      const current = await store.getSession(id);
      if (!leaseMatches(current, WORKER_ID, attempt)) {
        markLeaseLost();
        return 0;
      }
      const handled = Math.max(deliveredFollowUps(), steeredThisAttempt);
      let delivered = 0;
      for (const [index, message] of all.entries()) {
        if (index < handled) continue;
        agent.steer({
          role: 'user',
          content: composeFollowUpText(toFollowUp(message)),
        } as unknown as AgentMessage);
        delivered += 1;
      }
      if (delivered > 0) {
        steeredThisAttempt = handled + delivered;
        log.info(`session ${id}: steered ${delivered} follow-up message(s)`);
      }
      return delivered;
    };

    // Serialize drains so a timer firing during the settle drain cannot steer
    // the same message twice. A queued request is absorbed into the same cycle.
    let drainInFlight: Promise<number> | null = null;
    let drainQueued = false;
    const requestDrain = (): Promise<number> => {
      if (drainInFlight) {
        drainQueued = true;
        return drainInFlight;
      }
      drainInFlight = (async () => {
        let delivered = 0;
        do {
          drainQueued = false;
          delivered += await drainMessages().catch(() => 0);
        } while (drainQueued && !abort.signal.aborted);
        return delivered;
      })().finally(() => {
        drainInFlight = null;
      });
      return drainInFlight;
    };
    const messagePoll = setInterval(() => void requestDrain(), SESSION_WAKEUP_FALLBACK_MS);
    messagePoll.unref?.();

    try {
      if (plannedStart.kind === 'prompt') {
        if (plan.kind !== 'start' || pending.length > 0) {
          steeredThisAttempt = followUpsDelivered + 1;
        }
        await agent.prompt(plannedStart.text);
      } else {
        await agent.continue();
      }

      // A follow-up arriving while the loop winds down extends this run. Only
      // settle after an idle/drain cycle finds no new durable message.
      for (;;) {
        await agent.waitForIdle();
        if (abort.signal.aborted) break;
        const before = steeredThisAttempt;
        const delivered = await requestDrain();
        if (abort.signal.aborted) break;
        if (delivered === 0 || steeredThisAttempt === before) break;
      }
      await flushAll();

      const loopError = terminalLoopError(agent.state.messages, agent.state.errorMessage);
      const shutdown = ctx.shuttingDown && abort.signal.aborted && !cancelled;
      if (shutdown || tripwireViolated || (leaseLost && abort.signal.aborted)) {
        emit(LIFECYCLE.sessionInterrupted, {
          reason: shutdown
            ? 'runner shutdown'
            : tripwireViolated
              ? 'runner event-order tripwire'
              : 'lease lost',
          attempt,
        });
        await flushAll();
        if (!leaseLost) await store.releaseLease(id, WORKER_ID);
        log.info(`session ${id} parked at attempt ${attempt}`);
        return;
      }

      const error = !cancelled && loopError ? loopError : undefined;
      const status = cancelled ? 'cancelled' : error ? 'failed' : 'succeeded';
      emit(LIFECYCLE.sessionEnd, { status, toolCalls, ...(error ? { error } : {}) });
      await flushAll();
      await store.finishSession(id, WORKER_ID, {
        status,
        ...(error ? { error } : {}),
        resetAttempt: status !== 'failed',
      });
      if (cancelled) {
        await store.clearCancel(id);
      } else {
        await requeueIfUndelivered('settle');
      }
      log.info(`session ${id} -> ${status} (attempt ${attempt}, ${toolCalls} tool calls)`);
    } catch (error) {
      if (isLeaseLostError(error)) markLeaseLost();
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.shuttingDown || leaseLost || tripwireViolated) {
        emit(LIFECYCLE.sessionInterrupted, {
          reason: tripwireViolated ? 'runner event-order tripwire' : 'runner shutdown',
          attempt,
        });
        await flushAll(false);
        if (!leaseLost) await store.releaseLease(id, WORKER_ID);
      } else {
        emit(LIFECYCLE.sessionEnd, { status: 'failed', error: message });
        await flushAll(false);
        await store.finishSession(id, WORKER_ID, { status: 'failed', error: message });
        await requeueIfUndelivered('run failure');
        log.error(`session ${id} failed`, error);
      }
    } finally {
      abort.signal.removeEventListener('abort', abortAgent);
      unsubscribe();
      clearInterval(messagePoll);
    }
  } catch (error) {
    if (isLeaseLostError(error)) markLeaseLost();
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.shuttingDown || leaseLost || tripwireViolated) {
      if (tripwireViolated) {
        emit(LIFECYCLE.sessionInterrupted, {
          reason: 'runner event-order tripwire',
          attempt,
        });
        await flushAll(false).catch(() => {});
      }
      if (!leaseLost) await store.releaseLease(id, WORKER_ID).catch(() => {});
    } else {
      emit(LIFECYCLE.sessionEnd, { status: 'failed', error: message });
      await flushAll(false).catch(() => {});
      await store
        .finishSession(id, WORKER_ID, { status: 'failed', error: message })
        .catch(() => {});
      await requeueIfUndelivered('setup failure');
    }
    log.error(`session ${id} failed during setup`, error);
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(cancelPoll);
    await flushAll(false);
    ctx.running.delete(id);
  }
}

/** Start scanning. Store/schema construction remains lazy behind each scan. */
export function startAgentRunner(): AgentRunnerHandle {
  const ctx: RunContext = { running: new Map(), shuttingDown: false };
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;

  const scan = async (): Promise<void> => {
    if (scanning || ctx.shuttingDown) return;
    scanning = true;
    try {
      const store = await getAgentSessionStore();
      while (ctx.running.size < config.maxConcurrent && !ctx.shuttingDown) {
        const meta = await store.claimNextSession(WORKER_ID, process.pid, {
          leaseTtlMs: config.leaseTtlMs,
          maxAttempts: config.maxAttempts,
        });
        if (!meta) break;
        // Process-local fence in addition to the store's lease exclusion.
        if (ctx.running.has(meta.id)) continue;
        log.info(`claiming ${meta.id} (attempt ${meta.attempt})`);
        void runSession(ctx, meta).catch((error) => {
          log.error(`runSession ${meta.id} crashed`, error);
          ctx.running.delete(meta.id);
        });
      }
    } catch (error) {
      log.error('claim scan failed', error);
    } finally {
      scanning = false;
    }
  };

  scanTimer = setInterval(() => void scan(), config.scanIntervalMs);
  scanTimer.unref?.();
  void scan();
  log.info(
    `runner ${WORKER_ID} started (scan=${config.scanIntervalMs}ms, ` +
      `heartbeat=${config.heartbeatIntervalMs}ms, leaseTtl=${config.leaseTtlMs}ms, ` +
      `maxConcurrent=${config.maxConcurrent}, maxAttempts=${config.maxAttempts})`,
  );
  log.info('minimal tool set enabled: ask_user');

  return {
    workerId: WORKER_ID,
    async stop(options?: { timeoutMs?: number }): Promise<void> {
      ctx.shuttingDown = true;
      if (scanTimer) clearInterval(scanTimer);
      const deadlineAt = Date.now() + (options?.timeoutMs ?? 15_000);
      for (const session of ctx.running.values()) session.abort.abort();
      while (ctx.running.size > 0 && Date.now() < deadlineAt) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (ctx.running.size > 0) {
        log.warn(`stop() timed out with ${ctx.running.size} session(s) still settling`);
      }
      log.info(`runner ${WORKER_ID} stopped`);
    },
  };
}
