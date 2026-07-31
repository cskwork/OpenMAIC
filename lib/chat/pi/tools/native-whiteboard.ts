import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  applyWhiteboardCodeEditV1,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
  digestWhiteboardChartV1,
  digestWhiteboardCodeV1,
  digestWhiteboardEditableCodeStateV1,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardLatexV1,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  digestWhiteboardTableV1,
  digestVisibleTextV1,
  normalizeWhiteboardChartV1,
  normalizeWhiteboardCodeV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeWhiteboardTableV1,
  resolveActiveEffectBudget,
  type ClientEffectRequest,
  type ClientEffectTerminalResult,
  type ClientEffectTarget,
  type WhiteboardCodeEditIntent,
  type WhiteboardEditableCodeState,
} from '@/lib/agent/runtime/client-effect-contract';
import { renderNativeWhiteboardLatexHtmlV1 } from '@/lib/action/whiteboard-latex';
import { piClientEffectCoordinator } from '@/lib/agent/runtime/client-effect-coordinator';
import type {
  NativeClientEffectHandler,
  RuntimeAgentToolResult,
} from '@/lib/agent/runtime/native-child-contract';
import { WB_OPEN_MS } from '@/lib/choreography/timing';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { SendEvent } from '../types';
import type { NativeWhiteboardCodeState } from './native-whiteboard-code-state';
import type { NativeWhiteboardViewState } from './native-whiteboard-view-state';

const NativeWhiteboardOpenParams = Type.Object({}, { additionalProperties: false });

type NativeWhiteboardOpenParams = Static<typeof NativeWhiteboardOpenParams>;

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

const NativeWhiteboardLatexParams = Type.Object({
  latex: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description:
      'LaTeX source for one display formula. Escape backslashes according to the native tool-call JSON protocol.',
  }),
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
  width: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 1000,
      description: 'Formula box width; x + width must stay within 1000. Defaults to 400.',
    }),
  ),
  height: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 563,
      description: 'Formula box height; y + height must stay within 563. Defaults to 80.',
    }),
  ),
  color: Type.Optional(
    Type.String({ minLength: 1, maxLength: 64, description: 'Outer CSS formula color.' }),
  ),
});

type NativeWhiteboardLatexParams = Static<typeof NativeWhiteboardLatexParams>;

const NativeWhiteboardTableParams = Type.Object({
  data: Type.Array(
    Type.Array(Type.String({ maxLength: 256 }), {
      minItems: 1,
      maxItems: 8,
      description: 'One table row. Every row must have the same number of cells.',
    }),
    {
      minItems: 1,
      maxItems: 12,
      description: 'Rectangular table data with at most 96 cells.',
    },
  ),
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
    description: 'Table width; x + width must stay within 1000.',
  }),
  height: Type.Number({
    exclusiveMinimum: 0,
    maximum: 563,
    description: 'Table height; y + height must stay within 563.',
  }),
  outline: Type.Optional(
    Type.Object({
      width: Type.Number({ minimum: 0, maximum: 20 }),
      style: Type.Union([Type.Literal('solid'), Type.Literal('dashed')]),
      color: Type.String({ minLength: 1, maxLength: 64 }),
    }),
  ),
  theme: Type.Optional(
    Type.Object({
      color: Type.String({ minLength: 1, maxLength: 64 }),
    }),
  ),
});

type NativeWhiteboardTableParams = Static<typeof NativeWhiteboardTableParams>;

const NativeWhiteboardChartType = Type.Union([
  Type.Literal('bar'),
  Type.Literal('column'),
  Type.Literal('line'),
  Type.Literal('pie'),
  Type.Literal('ring'),
  Type.Literal('area'),
  Type.Literal('radar'),
  Type.Literal('scatter'),
]);
const NativeWhiteboardChartParams = Type.Object({
  chartType: NativeWhiteboardChartType,
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
    description: 'Chart width; x + width must stay within 1000.',
  }),
  height: Type.Number({
    exclusiveMinimum: 0,
    maximum: 563,
    description: 'Chart height; y + height must stay within 563.',
  }),
  data: Type.Object({
    labels: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
      minItems: 1,
      maxItems: 64,
      description: 'Category, axis, slice, or point labels.',
    }),
    legends: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
      minItems: 1,
      maxItems: 8,
      description: 'Series legends. Their required count depends on chartType.',
    }),
    series: Type.Array(
      Type.Array(
        Type.Number({
          minimum: -1_000_000_000_000,
          maximum: 1_000_000_000_000,
        }),
        { minItems: 1, maxItems: 64 },
      ),
      {
        minItems: 1,
        maxItems: 8,
        description:
          'Cartesian/radar: one row per legend. Pie/ring: exactly one row. Scatter: exactly two X/Y rows.',
      },
    ),
  }),
  themeColors: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 1,
      maxItems: 10,
      description:
        'Renderer-safe CSS colors using #hex, named colors, or comma-form rgb(a)/hsl(a).',
    }),
  ),
});

type NativeWhiteboardChartParams = Static<typeof NativeWhiteboardChartParams>;

const NativeWhiteboardCodeParams = Type.Object({
  language: Type.String({
    minLength: 1,
    maxLength: 32,
    pattern: '^[A-Za-z0-9][A-Za-z0-9_+#.\\-]*$',
    description:
      'Programming language identifier. Common aliases such as js, ts, py, sh, yml, and md are normalized.',
  }),
  code: Type.String({
    minLength: 1,
    maxLength: 16_384,
    description:
      'Exact code source. Preserve indentation and use newline characters between at most 200 lines.',
  }),
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
  width: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 1000,
      description: 'Code block width; x + width must stay within 1000. Defaults to 500.',
    }),
  ),
  height: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 563,
      description: 'Code block height; y + height must stay within 563. Defaults to 300.',
    }),
  ),
  fileName: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 128,
      description: 'Optional display-only file name shown in the code-block header.',
    }),
  ),
});

type NativeWhiteboardCodeParams = Static<typeof NativeWhiteboardCodeParams>;
type NativeWhiteboardCodeCommittedParams = NativeWhiteboardCodeParams & {
  elementId: string;
  lineIds: string[];
};

const NativeWhiteboardCodeEditParams = Type.Union([
  Type.Object({
    elementId: Type.String({ minLength: 1, maxLength: 512 }),
    operation: Type.Literal('insert_after'),
    lineId: Type.String({ minLength: 1, maxLength: 256 }),
    content: Type.String({ maxLength: 16_384 }),
  }),
  Type.Object({
    elementId: Type.String({ minLength: 1, maxLength: 512 }),
    operation: Type.Literal('insert_before'),
    lineId: Type.String({ minLength: 1, maxLength: 256 }),
    content: Type.String({ maxLength: 16_384 }),
  }),
  Type.Object({
    elementId: Type.String({ minLength: 1, maxLength: 512 }),
    operation: Type.Literal('delete_lines'),
    lineIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      minItems: 1,
      maxItems: 200,
    }),
  }),
  Type.Object({
    elementId: Type.String({ minLength: 1, maxLength: 512 }),
    operation: Type.Literal('replace_lines'),
    lineIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      minItems: 1,
      maxItems: 200,
    }),
    content: Type.String({ maxLength: 16_384 }),
  }),
]);

type NativeWhiteboardCodeEditParams = Static<typeof NativeWhiteboardCodeEditParams>;
type NativeWhiteboardCodeEditCommittedParams = NativeWhiteboardCodeEditParams & {
  newLineIds: string[];
  afterState: WhiteboardEditableCodeState;
  noOp: boolean;
};
const WHITEBOARD_OPEN_SETTLEMENT_MARGIN_MS = 500;

interface NativeWhiteboardBaseOptions {
  body: StatelessChatRequest;
  messageId: string;
  send: SendEvent;
  onCancelled?: () => void;
  canExecute?: () => boolean;
  now?: () => number;
  viewState: NativeWhiteboardViewState;
}

interface NativeWhiteboardToolOptions<TParams> extends NativeWhiteboardBaseOptions {
  onCommitted?: (params: TParams) => void;
  onCommittedWithTerminal?: (params: TParams, terminal: ClientEffectTerminalResult) => void;
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
    (!opts.viewState.isOpen() &&
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
  successDetails?: Record<string, unknown>;
  failureLabel: string;
}): Promise<RuntimeAgentToolResult> {
  let registered;
  try {
    registered = piClientEffectCoordinator.register(opts.request);
  } catch (error) {
    if (error instanceof Error && error.message === 'CLIENT_EFFECT_RESOURCE_BUSY') {
      return {
        content: [
          {
            type: 'text',
            text: 'Whiteboard visibility is already being changed by another active request.',
          },
        ],
        details: { code: 'CLIENT_EFFECT_RESOURCE_BUSY', retryable: true },
        isError: true,
      };
    }
    throw error;
  }
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
      if (!terminal.targetBinding) {
        throw new Error('CLIENT_EFFECT_COMMIT_BINDING_MISSING');
      }
      opts.toolOptions.viewState.commitVisible(terminal.targetBinding);
      opts.toolOptions.onCommitted?.(opts.params);
      opts.toolOptions.onCommittedWithTerminal?.(opts.params, terminal);
      const stableElementId =
        'stableElementId' in opts.request.postcondition
          ? opts.request.postcondition.stableElementId
          : undefined;
      return {
        content: [{ type: 'text', text: opts.successMessage }],
        details: {
          status: terminal.status,
          executionId: opts.request.executionId,
          ...(stableElementId ? { stableElementId } : {}),
          targetBinding: terminal.targetBinding,
          ...(terminal.committedObservation
            ? {
                whiteboardId: terminal.committedObservation.whiteboardId,
                observedOpen: terminal.committedObservation.observedOpen,
                created: terminal.committedObservation.created,
                visibilityChanged: terminal.committedObservation.visibilityChanged,
                committedObservation: terminal.committedObservation,
                actionChanged:
                  terminal.committedObservation.created ||
                  terminal.committedObservation.visibilityChanged,
              }
            : {}),
          ...opts.successDetails,
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

export function buildNativeWhiteboardOpenTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardOpenParams>,
): { tool: AgentTool<typeof NativeWhiteboardOpenParams>; handler: NativeClientEffectHandler } {
  const tool: AgentTool<typeof NativeWhiteboardOpenParams> = {
    name: 'wb_open',
    label: 'Open whiteboard',
    description:
      'Reveal the classroom whiteboard without drawing an element. Drawing tools already reveal the board automatically, so use this only when showing the existing board is itself the intended action.',
    parameters: NativeWhiteboardOpenParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_open requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_open',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_open',
        normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
        desiredOpen: true,
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: params as NativeWhiteboardOpenParams,
      signal,
      toolOptions: opts,
      successMessage: 'Whiteboard visibility was verified.',
      failureLabel: 'Whiteboard open',
    });
  };

  return { tool, handler };
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

export function buildNativeWhiteboardLatexTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardLatexParams>,
): { tool: AgentTool<typeof NativeWhiteboardLatexParams>; handler: NativeClientEffectHandler } {
  const tool: AgentTool<typeof NativeWhiteboardLatexParams> = {
    name: 'wb_draw_latex',
    label: 'Draw whiteboard formula',
    description:
      'Draw one valid display-mode LaTeX formula on the classroom whiteboard. Explain what it represents before calling this tool, then continue teaching after the committed result.',
    parameters: NativeWhiteboardLatexParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_draw_latex requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardLatexParams;
    let latexSpec;
    let html;
    try {
      latexSpec = normalizeWhiteboardLatexV1(input);
      html = renderNativeWhiteboardLatexHtmlV1(latexSpec.latex);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard formula input was rejected: ${
              error instanceof Error ? error.message : 'invalid input'
            }.`,
          },
        ],
        details: {
          code: error instanceof Error ? error.message : 'CLIENT_EFFECT_LATEX_INPUT_INVALID',
        },
        isError: true,
      };
    }
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const stableElementId = `client-effect-${request.executionId}`;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_latex',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_latex_exists',
        stableElementId,
        elementType: 'latex',
        normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
        expectedFormulaDigest: await digestWhiteboardLatexV1(latexSpec),
        expectedHtmlDigest: await digestWhiteboardLatexHtmlV1(html),
        ...latexSpec,
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: input,
      signal,
      toolOptions: opts,
      successMessage: 'Whiteboard formula was rendered and its postcondition was verified.',
      failureLabel: 'Whiteboard formula',
    });
  };

  return { tool, handler };
}

export function buildNativeWhiteboardTableTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardTableParams>,
): { tool: AgentTool<typeof NativeWhiteboardTableParams>; handler: NativeClientEffectHandler } {
  const tool: AgentTool<typeof NativeWhiteboardTableParams> = {
    name: 'wb_draw_table',
    label: 'Draw whiteboard table',
    description:
      'Draw one concise rectangular comparison table on the classroom whiteboard. Explain what is being compared before calling this tool, then continue teaching after the committed result.',
    parameters: NativeWhiteboardTableParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_draw_table requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardTableParams;
    let tableSpec;
    try {
      tableSpec = normalizeWhiteboardTableV1(input);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard table input was rejected: ${
              error instanceof Error ? error.message : 'invalid input'
            }.`,
          },
        ],
        details: {
          code: error instanceof Error ? error.message : 'CLIENT_EFFECT_TABLE_INPUT_INVALID',
        },
        isError: true,
      };
    }
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const stableElementId = `client-effect-${request.executionId}`;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_table',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_table_exists',
        stableElementId,
        elementType: 'table',
        normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
        expectedTableDigest: await digestWhiteboardTableV1(tableSpec),
        ...tableSpec,
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: input,
      signal,
      toolOptions: opts,
      successMessage: 'Whiteboard table was rendered and its postcondition was verified.',
      failureLabel: 'Whiteboard table',
    });
  };

  return { tool, handler };
}

export function buildNativeWhiteboardChartTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardChartParams>,
): { tool: AgentTool<typeof NativeWhiteboardChartParams>; handler: NativeClientEffectHandler } {
  const tool: AgentTool<typeof NativeWhiteboardChartParams> = {
    name: 'wb_draw_chart',
    label: 'Draw whiteboard chart',
    description:
      'Draw one bounded chart on the classroom whiteboard. Cartesian and radar series must align with labels and legends; pie/ring use one non-negative series; scatter uses exactly two X/Y series. Explain the comparison before calling this tool, then continue teaching after the committed result.',
    parameters: NativeWhiteboardChartParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_draw_chart requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardChartParams;
    let chartSpec;
    try {
      chartSpec = normalizeWhiteboardChartV1(input);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard chart input was rejected: ${
              error instanceof Error ? error.message : 'invalid input'
            }.`,
          },
        ],
        details: {
          code: error instanceof Error ? error.message : 'CLIENT_EFFECT_CHART_INPUT_INVALID',
        },
        isError: true,
      };
    }
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const stableElementId = `client-effect-${request.executionId}`;
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_chart',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_chart_exists',
        stableElementId,
        elementType: 'chart',
        normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
        expectedChartDigest: await digestWhiteboardChartV1(chartSpec),
        ...chartSpec,
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: input,
      signal,
      toolOptions: opts,
      successMessage: 'Whiteboard chart was committed and its postcondition was verified.',
      failureLabel: 'Whiteboard chart',
    });
  };

  return { tool, handler };
}

export function buildNativeWhiteboardCodeTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardCodeCommittedParams>,
): { tool: AgentTool<typeof NativeWhiteboardCodeParams>; handler: NativeClientEffectHandler } {
  const tool: AgentTool<typeof NativeWhiteboardCodeParams> = {
    name: 'wb_draw_code',
    label: 'Draw whiteboard code',
    description:
      'Draw one bounded code block with stable Runtime-generated line IDs. Preserve indentation and line breaks. Explain what the code demonstrates before calling this tool, then continue teaching after the committed result.',
    parameters: NativeWhiteboardCodeParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_draw_code requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardCodeParams;
    let codeSpec;
    try {
      codeSpec = normalizeWhiteboardCodeV1(input);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard code input was rejected: ${
              error instanceof Error ? error.message : 'invalid input'
            }.`,
          },
        ],
        details: {
          code: error instanceof Error ? error.message : 'CLIENT_EFFECT_CODE_INPUT_INVALID',
        },
        isError: true,
      };
    }
    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const stableElementId = `client-effect-${request.executionId}`;
    const lineIds = codeSpec.lines.map((line) => line.id);
    const normalizedCode = codeSpec.lines.map((line) => line.content).join('\n');
    const committedParams: NativeWhiteboardCodeCommittedParams = {
      language: codeSpec.language,
      code: normalizedCode,
      x: codeSpec.bounds.x,
      y: codeSpec.bounds.y,
      width: codeSpec.bounds.width,
      height: codeSpec.bounds.height,
      ...(codeSpec.fileName ? { fileName: codeSpec.fileName } : {}),
      elementId: stableElementId,
      lineIds,
    };
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_draw_code',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_code_exists',
        stableElementId,
        elementType: 'code',
        normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
        expectedCodeDigest: await digestWhiteboardCodeV1(codeSpec),
        ...codeSpec,
      },
    };
    const lineIdentity =
      lineIds.length === 1
        ? 'L1'
        : `${lineIds[0]} through ${lineIds[lineIds.length - 1]} in source order`;
    return deliverClientEffect({
      request: effectRequest,
      params: committedParams,
      signal,
      toolOptions: opts,
      successMessage: `Whiteboard code block ${stableElementId} was committed and verified. Its stable line IDs are ${lineIdentity}.`,
      successDetails: { lineIds },
      failureLabel: 'Whiteboard code block',
    });
  };

  return { tool, handler };
}

export function buildNativeWhiteboardCodeEditTool(
  opts: NativeWhiteboardToolOptions<NativeWhiteboardCodeEditCommittedParams> & {
    codeState: NativeWhiteboardCodeState;
  },
): {
  tool: AgentTool<typeof NativeWhiteboardCodeEditParams>;
  handler: NativeClientEffectHandler;
} {
  const tool: AgentTool<typeof NativeWhiteboardCodeEditParams> = {
    name: 'wb_edit_code',
    label: 'Edit whiteboard code',
    description:
      'Edit one existing code block using its exact Runtime-provided element and line IDs. Supports insert_before, insert_after, delete_lines, and replace_lines. Empty insert/replace content means one blank line. Continue teaching only after the browser commits and verifies the edit.',
    parameters: NativeWhiteboardCodeEditParams,
    executionMode: 'sequential',
    execute: async (): Promise<RuntimeAgentToolResult> => {
      throw new Error('wb_edit_code requires the browser client-effect executor.');
    },
  };

  const handler: NativeClientEffectHandler = async ({ request, params, signal }) => {
    if (opts.canExecute?.() === false) return actionBudgetFailure();
    const input = params as NativeWhiteboardCodeEditParams;
    const expectedWhiteboardId = opts.codeState.getWhiteboardId();
    const before = opts.codeState.get(input.elementId);
    if (!expectedWhiteboardId || !before) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard code edit was rejected because code element "${input.elementId}" is not present in the request-scoped verified state.`,
          },
        ],
        details: { code: 'CLIENT_EFFECT_CODE_EDIT_ELEMENT_NOT_FOUND' },
        isError: true,
      };
    }

    let transition;
    try {
      transition = applyWhiteboardCodeEditV1({
        before,
        intent: input as WhiteboardCodeEditIntent,
        executionId: request.executionId,
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard code edit input was rejected: ${
              error instanceof Error ? error.message : 'invalid input'
            }.`,
          },
        ],
        details: {
          code: error instanceof Error ? error.message : 'CLIENT_EFFECT_CODE_EDIT_INPUT_INVALID',
        },
        isError: true,
      };
    }

    const prepared = prepareClientEffect(opts, request);
    if ('isError' in prepared) return prepared;
    const expectedBeforeCodeDigest = await digestWhiteboardEditableCodeStateV1(before);
    const expectedAfterCodeDigest = await digestWhiteboardEditableCodeStateV1(transition.after);
    const committedParams: NativeWhiteboardCodeEditCommittedParams = {
      ...input,
      newLineIds: transition.newLineIds,
      afterState: transition.after,
      noOp: transition.noOp,
    };
    const newLineIdentity =
      transition.newLineIds.length > 0
        ? ` New stable line IDs in output order: ${transition.newLineIds.join(', ')}.`
        : ' No new line IDs were created.';
    const effectRequest: ClientEffectRequest = {
      ...request,
      toolName: 'wb_edit_code',
      target: prepared.target,
      activeEffectBudgetMs: prepared.activeEffectBudgetMs,
      postcondition: {
        kind: 'whiteboard_code_edited',
        stableElementId: input.elementId,
        elementType: 'code',
        normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
        expectedWhiteboardId,
        expectedBeforeCodeDigest,
        expectedAfterCodeDigest,
        expectedAfterCodeState: transition.after,
        noOp: transition.noOp,
      },
    };
    return deliverClientEffect({
      request: effectRequest,
      params: committedParams,
      signal,
      toolOptions: {
        ...opts,
        onCommitted: undefined,
        onCommittedWithTerminal: (committed, terminal) => {
          const committedWhiteboardId = terminal.targetBinding?.whiteboardId;
          if (!committedWhiteboardId) {
            throw new Error('CLIENT_EFFECT_CODE_EDIT_COMMIT_BINDING_MISSING');
          }
          opts.codeState.commit(committedWhiteboardId, committed.elementId, committed.afterState);
          opts.onCommitted?.(committed);
          opts.onCommittedWithTerminal?.(committed, terminal);
        },
      },
      successMessage: `Whiteboard code block ${input.elementId} was edited and its before/after postconditions were verified.${newLineIdentity}`,
      successDetails: {
        lineIds: transition.after.lines.map((line) => line.id),
        newLineIds: transition.newLineIds,
        noOp: transition.noOp,
      },
      failureLabel: 'Whiteboard code edit',
    });
  };

  return { tool, handler };
}
