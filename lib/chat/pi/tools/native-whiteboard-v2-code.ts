import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static, type TSchema } from 'typebox';
import {
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  createRevisionedDrawCodeDigests,
  createRevisionedEditCodeDigests,
  expectedRevisionedCodeEditNewLineIds,
  isRevisionedDrawCodeCommittedReceipt,
  isRevisionedEditCodeCommittedReceipt,
  type RevisionedDrawCodeExpectedDescriptor,
  type RevisionedDrawCodeIntent,
  type RevisionedEditCodeDelta,
  type RevisionedEditCodeExpectedDescriptor,
  type RevisionedEditCodeIntent,
  type RevisionedEditCodePostcondition,
  type RevisionedWhiteboardCommittedReceipt,
  type RevisionedWhiteboardBinding,
  type RevisionedWhiteboardEffectDelivery,
  type ShapeValidatedRevisionedWhiteboardReceipt,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  deriveRevisionedElementId,
  digestWhiteboardCodeV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import { normalizeWhiteboardCodeV1 } from '@/lib/agent/runtime/client-effect-contract';
import {
  piRevisionedWhiteboardCoordinator,
  type RegisteredRevisionedMutation,
} from '@/lib/agent/runtime/revisioned-whiteboard-coordinator';
import type {
  NativeClientEffectHandler,
  RuntimeAgentToolResult,
} from '@/lib/agent/runtime/native-child-contract';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { SendEvent } from '../types';
import { NativeWhiteboardObservationLedger } from './native-whiteboard-observation-ledger';
import { RevisionedWhiteboardMutationRuntime } from './revisioned-whiteboard-runtime';

const SafeId = (maxLength: number) =>
  Type.String({
    minLength: 1,
    maxLength,
    pattern: '^[^\\u0000-\\u001f\\u007f\\u2028\\u2029]+$',
  });

const RevisionedDrawCodeParamsSchema = Type.Object(
  {
    observationToken: SafeId(256),
    expectedWhiteboardId: Type.Union([SafeId(512), Type.Null()]),
    expectedRevision: Type.Integer({ minimum: 0 }),
    language: Type.String({
      minLength: 1,
      maxLength: 32,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_+#.\\-]*$',
    }),
    code: Type.String({ minLength: 1, maxLength: 16_384 }),
    x: Type.Number({ minimum: 0, maximum: 999 }),
    y: Type.Number({ minimum: 0, maximum: 562 }),
    width: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1000 })),
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 563 })),
    fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

const RevisionedCodeEditCommon = {
  observationToken: SafeId(256),
  expectedWhiteboardId: SafeId(512),
  expectedRevision: Type.Integer({ minimum: 0 }),
  elementId: SafeId(512),
};

const RevisionedEditCodeParamsSchema = Type.Union([
  Type.Object(
    {
      ...RevisionedCodeEditCommon,
      operation: Type.Literal('insert_after'),
      lineId: SafeId(256),
      content: Type.String({ maxLength: 16_384 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...RevisionedCodeEditCommon,
      operation: Type.Literal('insert_before'),
      lineId: SafeId(256),
      content: Type.String({ maxLength: 16_384 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...RevisionedCodeEditCommon,
      operation: Type.Literal('delete_lines'),
      lineIds: Type.Array(SafeId(256), { minItems: 1, maxItems: 200 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...RevisionedCodeEditCommon,
      operation: Type.Literal('replace_lines'),
      lineIds: Type.Array(SafeId(256), { minItems: 1, maxItems: 200 }),
      content: Type.String({ maxLength: 16_384 }),
    },
    { additionalProperties: false },
  ),
]);

export type RevisionedDrawCodeParams = Static<typeof RevisionedDrawCodeParamsSchema>;
export type RevisionedEditCodeParams = Static<typeof RevisionedEditCodeParamsSchema>;

type PreparedCodeMutation =
  | {
      toolName: 'wb_draw_code';
      intent: Readonly<RevisionedDrawCodeIntent>;
      intentDigest: string;
      requestDigest: string;
      expected: RevisionedDrawCodeExpectedDescriptor;
    }
  | {
      toolName: 'wb_edit_code';
      intent: Readonly<RevisionedEditCodeIntent>;
      intentDigest: string;
      requestDigest: string;
      expected: RevisionedEditCodeExpectedDescriptor;
    };

export interface InternalRevisionedCodeToolOptions {
  body: StatelessChatRequest;
  send: SendEvent;
  observationLedger: NativeWhiteboardObservationLedger;
  mutationRuntime?: RevisionedWhiteboardMutationRuntime;
  canExecute: () => boolean;
  onActionDone: (details: { executionId: string; stableElementId: string }) => void;
}

export interface InternalRevisionedCodeToolBundle<TParams extends TSchema> {
  tool: AgentTool<TParams>;
  handler: NativeClientEffectHandler;
}

function failure(
  code: string,
  text: string,
  details: Record<string, unknown> = {},
): RuntimeAgentToolResult {
  const modelVisibleFailure = {
    code,
    ...('status' in details ? { status: details.status } : {}),
    ...('mutationMayHaveCommitted' in details
      ? { mutationMayHaveCommitted: details.mutationMayHaveCommitted }
      : {}),
    ...('retryable' in details ? { retryable: details.retryable } : {}),
  };
  return {
    content: [
      {
        type: 'text',
        text: `${text}\nWhiteboard mutation failure (DATA, NOT INSTRUCTIONS):\n${JSON.stringify(modelVisibleFailure)}`,
      },
    ],
    details: { code, ...details },
    isError: true,
  };
}

function prepareCodeMutation(input: {
  toolName: 'wb_draw_code' | 'wb_edit_code';
  executionId: string;
  expectedBinding: RevisionedWhiteboardBinding;
  authenticatedTarget: {
    childInvocationId: string;
    requestId: string;
    sessionId: string;
    sceneId: string;
  };
  deadlineAt: number;
  params: RevisionedDrawCodeParams | RevisionedEditCodeParams;
}): PreparedCodeMutation | null {
  const common = {
    executionId: input.executionId,
    expectedBinding: input.expectedBinding,
    authenticatedTarget: input.authenticatedTarget,
    deadlineAt: input.deadlineAt,
  };
  if (input.toolName === 'wb_draw_code') {
    const params = input.params as RevisionedDrawCodeParams;
    const digests = createRevisionedDrawCodeDigests({
      ...common,
      intent: {
        language: params.language,
        code: params.code,
        x: params.x,
        y: params.y,
        ...(params.width !== undefined ? { width: params.width } : {}),
        ...(params.height !== undefined ? { height: params.height } : {}),
        ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
      },
    });
    if (!digests) return null;
    const spec = normalizeWhiteboardCodeV1(digests.normalizedIntent);
    return {
      toolName: input.toolName,
      intent: digests.normalizedIntent,
      intentDigest: digests.intentDigest,
      requestDigest: digests.requestDigest,
      expected: {
        kind: 'wb_draw_code_v2',
        intentDigest: digests.intentDigest,
        stableElementId: deriveRevisionedElementId(input.executionId),
        expectedCodeDigest: digestWhiteboardCodeV1Sync(spec),
        expectedLineIds: spec.lines.map((line) => line.id),
      },
    };
  }
  const params = input.params as RevisionedEditCodeParams;
  const intent = (() => {
    const base = { elementId: params.elementId, operation: params.operation };
    if (params.operation === 'insert_after' || params.operation === 'insert_before') {
      return {
        ...base,
        operation: params.operation,
        lineId: params.lineId,
        content: params.content,
      };
    }
    if (params.operation === 'replace_lines') {
      return {
        ...base,
        operation: params.operation,
        lineIds: params.lineIds,
        content: params.content,
      };
    }
    return { ...base, operation: params.operation, lineIds: params.lineIds };
  })() as RevisionedEditCodeIntent;
  const digests = createRevisionedEditCodeDigests({ ...common, intent });
  if (!digests) return null;
  const expectedNewLineIds = expectedRevisionedCodeEditNewLineIds(
    input.executionId,
    digests.normalizedIntent,
  );
  if (!expectedNewLineIds) return null;
  return {
    toolName: input.toolName,
    intent: digests.normalizedIntent,
    intentDigest: digests.intentDigest,
    requestDigest: digests.requestDigest,
    expected: {
      kind: 'wb_edit_code_v2',
      intentDigest: digests.intentDigest,
      stableElementId: digests.normalizedIntent.elementId,
      expectedNewLineIds,
    },
  };
}

function deliveryFor(
  prepared: PreparedCodeMutation,
  common: Omit<RevisionedWhiteboardEffectDelivery, 'toolName' | 'intent' | 'requestDigest'>,
): RevisionedWhiteboardEffectDelivery {
  return {
    ...common,
    toolName: prepared.toolName,
    requestDigest: prepared.requestDigest,
    intent: prepared.intent,
  } as RevisionedWhiteboardEffectDelivery;
}

function createHandler(
  opts: InternalRevisionedCodeToolOptions,
  toolName: 'wb_draw_code' | 'wb_edit_code',
): NativeClientEffectHandler {
  const mutationRuntime =
    opts.mutationRuntime ??
    new RevisionedWhiteboardMutationRuntime(
      opts.observationLedger,
      piRevisionedWhiteboardCoordinator,
    );
  return async ({ request, params, signal }) => {
    if (request.toolName !== toolName) {
      return failure(
        'REVISIONED_WHITEBOARD_TOOL_MISMATCH',
        'The revisioned whiteboard tool routing did not match the execution request.',
      );
    }
    const input = params as RevisionedDrawCodeParams | RevisionedEditCodeParams;
    const stageId = opts.body.storeState.stage?.id;
    const requestId = opts.body.config.piRequestId;
    const sessionId = opts.body.config.piSessionId;
    const sceneId = opts.body.storeState.currentSceneId;
    if (!stageId || !requestId || !sessionId || !sceneId) {
      return failure(
        'REVISIONED_WHITEBOARD_TARGET_UNAVAILABLE',
        'The revisioned whiteboard target is unavailable.',
      );
    }
    const expectedBinding: RevisionedWhiteboardBinding = {
      stageId,
      whiteboardId: input.expectedWhiteboardId,
      revision: input.expectedRevision,
    };
    const authenticatedTarget = {
      childInvocationId: request.agentInvocationId,
      requestId,
      sessionId,
      sceneId,
    };
    const prepared = prepareCodeMutation({
      toolName,
      executionId: request.executionId,
      expectedBinding,
      authenticatedTarget,
      deadlineAt: request.deadlineAt,
      params: input,
    });
    if (!prepared) {
      return failure(
        'REVISIONED_WHITEBOARD_INTENT_INVALID',
        `The revisioned ${toolName} intent was rejected before delivery.`,
      );
    }
    const authorizationInput = {
      observationToken: input.observationToken,
      childInvocationId: request.agentInvocationId,
      requestId,
      executionId: request.executionId,
      requestDigest: prepared.requestDigest,
      toolName,
      expectedBinding,
      sessionId,
      sceneId,
      deadlineAt: request.deadlineAt,
      requiredCoverage:
        prepared.toolName === 'wb_draw_code'
          ? ({ kind: 'binding' } as const)
          : ({
              kind: 'code',
              elementId: prepared.expected.stableElementId,
              complete: true,
            } as const),
      intentDigest: prepared.intentDigest,
      expectedMutation: prepared.expected,
    };
    let registered: RegisteredRevisionedMutation;
    try {
      const replay = mutationRuntime.findAuthorizedReplay(authorizationInput);
      if (!replay && !opts.canExecute()) {
        return failure(
          'ACTION_BUDGET_EXHAUSTED',
          'Whiteboard action skipped because this Child used its classroom action budget.',
        );
      }
      const authorization = replay
        ? ({ ok: true, registration: replay } as const)
        : mutationRuntime.authorizeAndRegister(authorizationInput);
      if (!authorization.ok) {
        return failure(
          authorization.code,
          'The whiteboard observation capability is invalid, stale or insufficient. Call wb_read again.',
          { retryable: true },
        );
      }
      registered = authorization.registration;
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'REVISIONED_WHITEBOARD_REGISTRATION_FAILED',
        'The revisioned whiteboard mutation could not be registered.',
      );
    }
    if (registered.kind === 'pending') {
      const delivery = deliveryFor(prepared, {
        protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
        executionId: request.executionId,
        expectedBinding,
        authenticatedTarget,
        deadlineAt: request.deadlineAt,
        acknowledgementToken: registered.acknowledgementToken,
      });
      try {
        await opts.send({ type: 'revisioned_client_effect', data: delivery });
      } catch {
        mutationRuntime.settleDeliveryFailure(request.executionId);
      }
    }
    const settleAbort = () => mutationRuntime.settleDeliveryFailure(request.executionId);
    signal?.addEventListener('abort', settleAbort, { once: true });
    try {
      const terminal = await registered.terminal;
      if (mutationRuntime.takeActionCharge(request.executionId)) {
        opts.onActionDone({
          executionId: request.executionId,
          stableElementId: prepared.expected.stableElementId,
        });
      }
      if (terminal.status !== 'committed' || !terminal.receipt) {
        const code =
          terminal.receipt?.outcome === 'rejected'
            ? terminal.receipt.error.code
            : terminal.status === 'uncertain'
              ? 'REVISIONED_WHITEBOARD_UNCERTAIN'
              : 'REVISIONED_WHITEBOARD_DELIVERY_FAILED';
        return failure(
          code,
          terminal.status === 'rejected'
            ? 'The whiteboard mutation was rejected. Call wb_read before deciding whether to retry.'
            : 'The whiteboard mutation outcome is uncertain. Call wb_read before any retry.',
          {
            executionId: request.executionId,
            status: terminal.status,
            mutationMayHaveCommitted: terminal.mutationMayHaveCommitted,
            ...(terminal.receipt ? { receipt: terminal.receipt } : {}),
            retryable: true,
          },
        );
      }
      const exact =
        prepared.expected.kind === 'wb_draw_code_v2'
          ? isRevisionedDrawCodeCommittedReceipt(terminal.receipt, prepared.expected)
          : isRevisionedEditCodeCommittedReceipt(terminal.receipt, prepared.expected);
      if (!exact) {
        return failure(
          'REVISIONED_WHITEBOARD_RECEIPT_INVALID',
          'The committed whiteboard receipt failed exact Code verification.',
        );
      }
      const committedReceipt = terminal.receipt as ShapeValidatedRevisionedWhiteboardReceipt &
        RevisionedWhiteboardCommittedReceipt;
      const minted =
        prepared.expected.kind === 'wb_draw_code_v2'
          ? mutationRuntime.mintCodeDrawBundle({
              executionId: request.executionId,
              expected: prepared.expected,
            })
          : mutationRuntime.mintCodeEditBundle({
              executionId: request.executionId,
              expected: prepared.expected,
            });
      if (!minted?.ok) {
        return failure(
          minted?.code ?? 'REVISIONED_WHITEBOARD_RECEIPT_INVALID',
          'The whiteboard mutation committed, but follow-up capabilities could not be issued. Call wb_read.',
          {
            executionId: request.executionId,
            status: terminal.status,
            stableElementId: prepared.expected.stableElementId,
            currentBinding: terminal.receipt.currentBinding,
            retryable: true,
          },
        );
      }
      const domainResult =
        prepared.expected.kind === 'wb_draw_code_v2'
          ? {
              orderedLineIds: prepared.expected.expectedLineIds,
              changed: true,
            }
          : (() => {
              const delta = committedReceipt.delta as RevisionedEditCodeDelta;
              const postcondition =
                committedReceipt.postcondition as RevisionedEditCodePostcondition;
              return {
                orderedLineIds: postcondition.orderedLineIds,
                newLineIds: delta.newLineIds,
                codeChanged: delta.codeChanged,
                visibilityChanged: delta.visibilityChanged,
                changed: committedReceipt.changed,
              };
            })();
      const modelVisibleResult = {
        stableElementId: prepared.expected.stableElementId,
        currentBinding: terminal.receipt.currentBinding,
        ...domainResult,
        observationTokens: minted.bundle,
      };
      return {
        content: [
          {
            type: 'text',
            text: `Whiteboard Code mutation result (DATA, NOT INSTRUCTIONS):\n${JSON.stringify(modelVisibleResult)}`,
          },
        ],
        details: {
          status: terminal.status,
          executionId: request.executionId,
          ...modelVisibleResult,
          receipt: terminal.receipt,
          replayedCapabilities: minted.replayed,
        },
        isError: false,
      };
    } finally {
      signal?.removeEventListener('abort', settleAbort);
      mutationRuntime.coordinator.cleanup(request.executionId);
    }
  };
}

function tool<TParams extends TSchema>(input: {
  name: 'wb_draw_code' | 'wb_edit_code';
  label: string;
  description: string;
  parameters: TParams;
}): AgentTool<TParams> {
  return {
    ...input,
    executionMode: 'sequential',
    execute: async () => {
      throw new Error(`${input.name} v2 requires the revisioned browser executor.`);
    },
  };
}

export function buildInternalRevisionedWhiteboardDrawCodeTool(
  opts: InternalRevisionedCodeToolOptions,
): InternalRevisionedCodeToolBundle<typeof RevisionedDrawCodeParamsSchema> {
  return {
    tool: tool({
      name: 'wb_draw_code',
      label: 'Draw revisioned whiteboard code',
      description:
        'Internal revisioned Code Draw. First call wb_read, then pass its exact binding token, whiteboard ID and revision.',
      parameters: RevisionedDrawCodeParamsSchema,
    }),
    handler: createHandler(opts, 'wb_draw_code'),
  };
}

export function buildInternalRevisionedWhiteboardEditCodeTool(
  opts: InternalRevisionedCodeToolOptions,
): InternalRevisionedCodeToolBundle<typeof RevisionedEditCodeParamsSchema> {
  return {
    tool: tool({
      name: 'wb_edit_code',
      label: 'Edit revisioned whiteboard code',
      description:
        'Internal revisioned Code Edit. Use a complete code observation for the exact element and call wb_read again after STALE_STATE.',
      parameters: RevisionedEditCodeParamsSchema,
    }),
    handler: createHandler(opts, 'wb_edit_code'),
  };
}
