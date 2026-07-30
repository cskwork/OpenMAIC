import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import {
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  digestVisibleTextV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  resolveActiveEffectBudget,
  type ClientEffectRequest,
  type ClientEffectTarget,
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

const NativeWhiteboardShapeParams = Type.Object({
  shape: Type.Union([Type.Literal('rectangle'), Type.Literal('circle'), Type.Literal('triangle')]),
  x: Type.Number({
    minimum: 0,
    maximum: 999,
    description: 'Left coordinate on a 1000×563 board.',
  }),
  y: Type.Number({
    minimum: 0,
    maximum: 562,
    description: 'Top coordinate on a 1000×563 board.',
  }),
  width: Type.Number({
    exclusiveMinimum: 0,
    maximum: 1000,
    description: 'Shape width; x + width must stay within 1000.',
  }),
  height: Type.Number({
    exclusiveMinimum: 0,
    maximum: 563,
    description: 'Shape height; y + height must stay within 563.',
  }),
  fillColor: Type.Optional(
    Type.String({ minLength: 1, maxLength: 64, description: 'CSS fill color.' }),
  ),
});

type NativeWhiteboardShapeParams = Static<typeof NativeWhiteboardShapeParams>;

const NativeWhiteboardLineMarker = Type.Union([Type.Literal(''), Type.Literal('arrow')]);
const NativeWhiteboardLineParams = Type.Object({
  startX: Type.Number({
    minimum: 0,
    maximum: 1000,
    description: 'Ordered start x coordinate on a 1000×563 board.',
  }),
  startY: Type.Number({
    minimum: 0,
    maximum: 562,
    description: 'Ordered start y coordinate on a 1000×563 board.',
  }),
  endX: Type.Number({
    minimum: 0,
    maximum: 1000,
    description: 'Ordered end x coordinate on a 1000×563 board.',
  }),
  endY: Type.Number({
    minimum: 0,
    maximum: 562,
    description: 'Ordered end y coordinate on a 1000×563 board.',
  }),
  color: Type.Optional(
    Type.String({ minLength: 1, maxLength: 64, description: 'CSS stroke color.' }),
  ),
  width: Type.Optional(
    Type.Number({ minimum: 1, maximum: 100, description: 'Stroke width in pixels.' }),
  ),
  style: Type.Optional(Type.Union([Type.Literal('solid'), Type.Literal('dashed')])),
  points: Type.Optional(
    Type.Array(NativeWhiteboardLineMarker, {
      minItems: 2,
      maxItems: 2,
      description: 'Start and end markers; use "arrow" for a directed endpoint.',
    }),
  ),
});

type NativeWhiteboardLineParams = Static<typeof NativeWhiteboardLineParams>;
const WHITEBOARD_OPEN_SETTLEMENT_MARGIN_MS = 500;

interface NativeWhiteboardBaseOptions {
  body: StatelessChatRequest;
  messageId: string;
  send: SendEvent;
  onCancelled?: () => void;
  canExecute?: () => boolean;
  now?: () => number;
}

interface NativeWhiteboardToolOptions<TParams> extends NativeWhiteboardBaseOptions {
  onCommitted?: (params: TParams) => void;
}

function prepareClientEffect(
  opts: NativeWhiteboardBaseOptions,
  request: Parameters<NativeClientEffectHandler>[0]['request'],
): { target: ClientEffectTarget; activeEffectBudgetMs: number } | RuntimeAgentToolResult {
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
    now: (opts.now ?? Date.now)(),
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
  return { target, activeEffectBudgetMs };
}

async function deliverClientEffect<TParams>(opts: {
  request: ClientEffectRequest;
  params: TParams;
  signal?: AbortSignal;
  toolOptions: NativeWhiteboardToolOptions<TParams>;
  successMessage: string;
  failureLabel: string;
}): Promise<RuntimeAgentToolResult> {
  const registered = piClientEffectCoordinator.register(opts.request);
  const cancel = () => {
    piClientEffectCoordinator.cancel(
      opts.request.executionId,
      'REQUEST_ABORTED',
      'The whiteboard request was cancelled.',
    );
  };
  opts.signal?.addEventListener('abort', cancel, { once: true });
  try {
    try {
      await opts.toolOptions.send({ type: 'client_effect', data: registered.delivery });
    } catch {
      piClientEffectCoordinator.cancel(
        opts.request.executionId,
        'DELIVERY_FAILED',
        'The whiteboard request could not be delivered to the browser.',
      );
    }
    const terminal = await registered.result;
    if (terminal.status === 'effect_committed') {
      opts.toolOptions.onCommitted?.(opts.params);
      return {
        content: [{ type: 'text', text: opts.successMessage }],
        details: {
          status: terminal.status,
          executionId: opts.request.executionId,
          stableElementId: opts.request.postcondition.stableElementId,
          targetBinding: terminal.targetBinding,
        },
        isError: false,
      };
    }
    if (terminal.status === 'cancelled') opts.toolOptions.onCancelled?.();
    return {
      content: [
        {
          type: 'text',
          text: `${opts.failureLabel} was not committed: ${terminal.error?.message ?? terminal.status}.`,
        },
      ],
      details: {
        status: terminal.status,
        executionId: opts.request.executionId,
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
    opts.signal?.removeEventListener('abort', cancel);
    piClientEffectCoordinator.cleanup(opts.request.executionId);
  }
}

function actionBudgetFailure(): RuntimeAgentToolResult {
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

export function buildNativeWhiteboardTextTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardTextParams>,
): { tool: AgentTool<typeof NativeWhiteboardTextParams>; handler: NativeClientEffectHandler } {
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
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardTextParams;
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const stableElementId = `client-effect-${request.executionId}`;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_text',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_text_exists',
        stableElementId,
        elementType: 'text',
        normalizationVersion: 'maic.visible-text.v1',
        expectedContentDigest: await digestVisibleTextV1(input.content),
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: input,
      signal,
      toolOptions: opts,
      successMessage: 'Whiteboard text was rendered and its postcondition was verified.',
      failureLabel: 'Whiteboard text',
    });
  };

  return { tool, handler };
}

export function buildNativeWhiteboardShapeTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardShapeParams>,
): { tool: AgentTool<typeof NativeWhiteboardShapeParams>; handler: NativeClientEffectHandler } {
  const tool: AgentTool<typeof NativeWhiteboardShapeParams> = {
    name: 'wb_draw_shape',
    label: 'Draw whiteboard shape',
    description:
      'Draw one rectangle, circle, or triangle on the classroom whiteboard. Explain what it represents before calling this tool, then continue teaching after the committed result.',
    parameters: NativeWhiteboardShapeParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_draw_shape requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardShapeParams;
    let shapeSpec;
    try {
      shapeSpec = normalizeWhiteboardShapeV1(input);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard shape input was rejected: ${
              error instanceof Error ? error.message : 'invalid input'
            }.`,
          },
        ],
        details: {
          code: error instanceof Error ? error.message : 'CLIENT_EFFECT_SHAPE_INPUT_INVALID',
        },
        isError: true,
      };
    }
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const stableElementId = `client-effect-${request.executionId}`;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_shape',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_shape_exists',
        stableElementId,
        elementType: 'shape',
        normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
        expectedShapeDigest: await digestWhiteboardShapeV1(shapeSpec),
        ...shapeSpec,
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: input,
      signal,
      toolOptions: opts,
      successMessage: 'Whiteboard shape was rendered and its postcondition was verified.',
      failureLabel: 'Whiteboard shape',
    });
  };

  return { tool, handler };
}

export function buildNativeWhiteboardLineTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardLineParams>,
): { tool: AgentTool<typeof NativeWhiteboardLineParams>; handler: NativeClientEffectHandler } {
  const tool: AgentTool<typeof NativeWhiteboardLineParams> = {
    name: 'wb_draw_line',
    label: 'Draw whiteboard line',
    description:
      'Draw one straight line or directed arrow to connect concepts, show a relationship or flow, or annotate the classroom whiteboard. Explain the connection before calling this tool, then continue teaching after the committed result.',
    parameters: NativeWhiteboardLineParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_draw_line requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardLineParams;
    let lineSpec;
    try {
      lineSpec = normalizeWhiteboardLineV1(input);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard line input was rejected: ${
              error instanceof Error ? error.message : 'invalid input'
            }.`,
          },
        ],
        details: {
          code: error instanceof Error ? error.message : 'CLIENT_EFFECT_LINE_INPUT_INVALID',
        },
        isError: true,
      };
    }
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const stableElementId = `client-effect-${request.executionId}`;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_line',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_line_exists',
        stableElementId,
        elementType: 'line',
        normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
        expectedLineDigest: await digestWhiteboardLineV1(lineSpec),
        ...lineSpec,
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: input,
      signal,
      toolOptions: opts,
      successMessage: 'Whiteboard line was rendered and its postcondition was verified.',
      failureLabel: 'Whiteboard line',
    });
  };

  return { tool, handler };
}
