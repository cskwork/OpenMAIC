import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import {
  digestVisibleTextV1,
  resolveActiveEffectBudget,
  type ClientEffectRequest,
} from '@/lib/agent/runtime/client-effect-contract';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import type {
  NativeClientEffectHandler,
  RuntimeAgentToolResult,
} from '@/lib/agent/runtime/native-child-contract';
import { WB_OPEN_MS } from '@/lib/choreography/timing';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { SendEvent } from '../types';

const NativeWhiteboardTextParams = Type.Object({
  content: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: 'Concise visible teaching text.',
  }),
  x: Type.Number({
    minimum: 40,
    maximum: 560,
    description: 'Left coordinate on a 1000×563 board.',
  }),
  y: Type.Number({
    minimum: 40,
    maximum: 323,
    description: 'Top coordinate on a 1000×563 board.',
  }),
  width: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, maximum: 400, description: 'Text box width.' }),
  ),
  height: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, maximum: 200, description: 'Text box height.' }),
  ),
  fontSize: Type.Optional(
    Type.Number({ minimum: 1, maximum: 512, description: 'Font size in pixels.' }),
  ),
  color: Type.Optional(
    Type.String({ minLength: 1, maxLength: 64, description: 'CSS text color.' }),
  ),
});

type NativeWhiteboardTextParams = Static<typeof NativeWhiteboardTextParams>;
const WHITEBOARD_OPEN_SETTLEMENT_MARGIN_MS = 500;

export function buildNativeWhiteboardTextTool(opts: {
  body: StatelessChatRequest;
  messageId: string;
  send: SendEvent;
  onCommitted?: (params: NativeWhiteboardTextParams) => void;
  onCancelled?: () => void;
  canExecute?: () => boolean;
  now?: () => number;
}): { tool: AgentTool<typeof NativeWhiteboardTextParams>; handler: NativeClientEffectHandler } {
  const now = opts.now ?? Date.now;
  const tool: AgentTool<typeof NativeWhiteboardTextParams> = {
    name: 'wb_draw_text',
    label: 'Draw whiteboard text',
    description:
      'Draw concise text on the classroom whiteboard. Explain what you are about to show before calling this tool, then continue teaching after the committed result.',
    parameters: NativeWhiteboardTextParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_draw_text requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) {
      return {
        content: [
          {
            type: 'text',
            text: 'Whiteboard action skipped because this agent turn used its action budget.',
          },
        ],
        details: { code: 'ACTION_BUDGET_EXHAUSTED' },
        isError: true,
      };
    }
    const input = params as NativeWhiteboardTextParams;
    const target = {
      requestId: opts.body.config.piRequestId ?? '',
      sessionId: opts.body.config.piSessionId ?? '',
      stageId: opts.body.storeState.stage?.id ?? '',
      sceneId: opts.body.storeState.currentSceneId ?? '',
      messageId: opts.messageId,
    };
    if (Object.values(target).some((value) => !value)) {
      return {
        content: [
          { type: 'text', text: 'Whiteboard execution target is unavailable for this request.' },
        ],
        details: { code: 'CLIENT_EFFECT_TARGET_UNAVAILABLE' },
        isError: true,
      };
    }

    const activeEffectBudgetMs = resolveActiveEffectBudget({
      configuredActiveEffectBudgetMs: 20_000,
      deadlineAt: request.deadlineAt,
      now: now(),
      settlementSafetyMarginMs: 1_000,
    });
    if (
      !activeEffectBudgetMs ||
      (!opts.body.storeState.whiteboardOpen &&
        activeEffectBudgetMs <= WB_OPEN_MS + WHITEBOARD_OPEN_SETTLEMENT_MARGIN_MS)
    ) {
      return {
        content: [{ type: 'text', text: 'Whiteboard execution deadline is exhausted.' }],
        details: { code: 'CLIENT_EFFECT_DEADLINE_EXHAUSTED' },
        isError: true,
      };
    }

    const stableElementId = `client-effect-${request.executionId}`;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_text',
      target,
      activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_text_exists',
        stableElementId,
        elementType: 'text',
        normalizationVersion: 'maic.visible-text.v1',
        expectedContentDigest: await digestVisibleTextV1(input.content),
      },
    };
    const registered = piClientEffectCoordinator.register(effectRequest);
    const cancel = () => {
      piClientEffectCoordinator.cancel(
        request.executionId,
        'REQUEST_ABORTED',
        'The whiteboard request was cancelled.',
      );
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      try {
        await opts.send({ type: 'client_effect', data: registered.delivery });
      } catch {
        piClientEffectCoordinator.cancel(
          request.executionId,
          'DELIVERY_FAILED',
          'The whiteboard request could not be delivered to the browser.',
        );
      }
      const terminal = await registered.result;
      if (terminal.status === 'effect_committed') {
        opts.onCommitted?.(input);
        return {
          content: [
            {
              type: 'text',
              text: 'Whiteboard text was rendered and its postcondition was verified.',
            },
          ],
          details: {
            status: terminal.status,
            executionId: request.executionId,
            stableElementId,
            targetBinding: terminal.targetBinding,
          },
          isError: false,
        };
      }
      if (terminal.status === 'cancelled') opts.onCancelled?.();
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard text was not committed: ${terminal.error?.message ?? terminal.status}.`,
          },
        ],
        details: {
          status: terminal.status,
          executionId: request.executionId,
          error: terminal.error,
        },
        isError: true,
        executionStatus:
          terminal.status === 'timed_out'
            ? 'timeout'
            : terminal.status === 'cancelled'
              ? 'cancelled'
              : 'execution_failed',
        ...(terminal.status === 'cancelled' ? { terminate: true } : {}),
      };
    } finally {
      signal?.removeEventListener('abort', cancel);
      piClientEffectCoordinator.cleanup(request.executionId);
    }
  };

  return { tool, handler };
}
