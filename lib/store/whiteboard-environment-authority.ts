import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  MAX_REVISIONED_WHITEBOARD_RECEIPT_BYTES,
  REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
  isRevisionedWhiteboardAuthorityReceipt,
  isRevisionedWhiteboardAuthenticatedTarget,
  isRevisionedWhiteboardMutationIdentity,
  createRevisionedDrawChartDigests,
  createRevisionedDrawLatexDigests,
  createRevisionedDrawLineDigests,
  createRevisionedDrawShapeDigests,
  createRevisionedDrawTableDigests,
  createRevisionedDrawTextDigests,
  revisionedWhiteboardWireBytes,
  verifyRevisionedWhiteboardAuthorityReceipt,
  type JsonValue,
  type RevisionedWhiteboardAuthenticatedTarget,
  type RevisionedWhiteboardAuthorityReceipt,
  type RevisionedWhiteboardBinding,
  type RevisionedWhiteboardEnvironmentBinding,
  type RevisionedWhiteboardCommittedReceipt,
  type RevisionedWhiteboardRejectedReceipt,
  type RevisionedWhiteboardMutationToolName,
  type RevisionedWhiteboardUncertainReceipt,
  type RevisionedDrawTextIntent,
  type RevisionedDrawTextDelta,
  type RevisionedDrawTextPostcondition,
  type RevisionedDrawShapeIntent,
  type RevisionedDrawShapeDelta,
  type RevisionedDrawShapePostcondition,
  type RevisionedDrawLineIntent,
  type RevisionedDrawLineDelta,
  type RevisionedDrawLinePostcondition,
  type RevisionedDrawLatexIntent,
  type RevisionedDrawLatexDelta,
  type RevisionedDrawLatexPostcondition,
  type RevisionedDrawTableIntent,
  type RevisionedDrawTableDelta,
  type RevisionedDrawTablePostcondition,
  type RevisionedDrawChartIntent,
  type RevisionedDrawChartDelta,
  type RevisionedDrawChartPostcondition,
} from '@/lib/agent/runtime/revisioned-whiteboard-contract';
import {
  deriveRevisionedElementId,
  deriveRevisionedWhiteboardId,
  digestRevisionedValue,
  digestRevisionedWhiteboardTableStateV2Sync,
  digestVisibleTextV1Sync,
  digestWhiteboardChartV1Sync,
  digestWhiteboardLatexHtmlV1Sync,
  digestWhiteboardLatexV1Sync,
  digestWhiteboardLineV1Sync,
  digestWhiteboardShapeV1Sync,
} from '@/lib/agent/runtime/revisioned-whiteboard-digest';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_RENDER_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  normalizeWhiteboardChartV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeWhiteboardTableV1,
  type WhiteboardChartSpec,
  type WhiteboardLatexSpec,
  type WhiteboardLineSpec,
  type WhiteboardShapeSpec,
  type WhiteboardTableSpec,
} from '@/lib/agent/runtime/client-effect-contract';
import { createWhiteboardChartElement } from '@/lib/action/whiteboard-charts';
import {
  createWhiteboardLatexElement,
  renderNativeWhiteboardLatexHtmlV1,
} from '@/lib/action/whiteboard-latex';
import { createWhiteboardLineElement } from '@/lib/action/whiteboard-lines';
import { WHITEBOARD_SHAPE_PATHS } from '@/lib/action/whiteboard-shapes';
import { createWhiteboardTableElement } from '@/lib/action/whiteboard-tables';
import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { StageStore } from '@/lib/api/stage-api-types';
import type { PPTChartElement, PPTElement, PPTLatexElement, PPTTableElement } from '@openmaic/dsl';

export const WHITEBOARD_AUTHORITY_RESOURCE_BUSY = 'CLIENT_EFFECT_RESOURCE_BUSY';
export const WHITEBOARD_AUTHORITY_UNCERTAIN = 'POSTCONDITION_UNCERTAIN';
export const WHITEBOARD_AUTHORITY_BYPASS = 'WHITEBOARD_AUTHORITY_BYPASS_DETECTED';
export const WHITEBOARD_AUTHORITY_STALE_STATE = 'STALE_STATE';
export const WHITEBOARD_AUTHORITY_TARGET_CHANGED = 'TARGET_CHANGED';
export const WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID = 'MUTATION_REQUEST_INVALID';
export const WHITEBOARD_AUTHORITY_JOURNAL_CAPACITY_EXCEEDED =
  'REVISIONED_JOURNAL_CAPACITY_EXCEEDED';
export const WHITEBOARD_AUTHORITY_DEADLINE_EXCEEDED = 'REVISIONED_WHITEBOARD_DEADLINE_EXCEEDED';

export interface WhiteboardAuthoritySnapshot {
  stageId: string | null;
  activeWhiteboardId: string | null;
  revision: number;
  open: boolean;
}

interface WhiteboardDomainSnapshot extends WhiteboardAuthoritySnapshot {
  whiteboardFingerprint: string;
}

export interface WhiteboardAuthorityWriteStep {
  label: string;
  write: () => void;
}

export interface WhiteboardAuthorityTransactionOptions {
  label: string;
  writes: readonly WhiteboardAuthorityWriteStep[];
  preferredActiveWhiteboardId?: string | null;
  expected?: Pick<WhiteboardAuthoritySnapshot, 'stageId' | 'activeWhiteboardId' | 'revision'>;
}

export type WhiteboardAuthorityQueryResult<T> =
  | { ok: true; value: T; snapshot: WhiteboardAuthoritySnapshot }
  | {
      ok: false;
      code: typeof WHITEBOARD_AUTHORITY_RESOURCE_BUSY | typeof WHITEBOARD_AUTHORITY_BYPASS;
      snapshot: WhiteboardAuthoritySnapshot;
      errors: readonly string[];
    };

export type WhiteboardAuthorityTransactionResult =
  | {
      ok: true;
      changed: boolean;
      snapshot: WhiteboardAuthoritySnapshot;
    }
  | {
      ok: false;
      code:
        | typeof WHITEBOARD_AUTHORITY_RESOURCE_BUSY
        | typeof WHITEBOARD_AUTHORITY_UNCERTAIN
        | typeof WHITEBOARD_AUTHORITY_BYPASS
        | typeof WHITEBOARD_AUTHORITY_STALE_STATE
        | typeof WHITEBOARD_AUTHORITY_TARGET_CHANGED;
      changed: boolean;
      mutationMayHaveCommitted: boolean;
      snapshot: WhiteboardAuthoritySnapshot;
      errors: readonly string[];
    };

interface WhiteboardAuthorityStore {
  getState(): Pick<ReturnType<StageStore['getState']>, 'stage'>;
  setState(partial: { stage: Stage | null }): void;
}

interface WhiteboardAuthorityOpenStore {
  getState(): { whiteboardOpen: boolean };
  setState(partial: { whiteboardOpen: boolean }): void;
}

export type WhiteboardAuthorityRevisionedPlan =
  | {
      ok: false;
      code: 'TARGET_PRECONDITION_FAILED';
    }
  | {
      ok: true;
      nextWhiteboards: readonly Whiteboard[];
      nextOpen: boolean;
      preferredActiveWhiteboardId?: string | null;
    };

export interface WhiteboardAuthorityRevisionedMutationOptions {
  executionId: string;
  requestDigest: string;
  toolName: RevisionedWhiteboardMutationToolName;
  label: string;
  expected: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  plan: WhiteboardAuthorityRevisionedPlan;
}

export interface RevisionedWhiteboardTargetValidation {
  executionId: string;
  requestDigest: string;
  intentDigest: string;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  expectedStageId: string;
  deadlineAt: number;
}

export interface RevisionedWhiteboardTargetRegistryLookup {
  validateAndConsume(target: RevisionedWhiteboardTargetValidation): boolean;
}

export interface WhiteboardAuthorityRevisionedDrawTextOptions {
  executionId: string;
  requestDigest: string;
  expected: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intentDigest: string;
  intent: RevisionedDrawTextIntent;
}

export interface WhiteboardAuthorityRevisionedDrawShapeOptions {
  executionId: string;
  requestDigest: string;
  expected: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intentDigest: string;
  intent: RevisionedDrawShapeIntent;
}

export interface WhiteboardAuthorityRevisionedDrawLineOptions {
  executionId: string;
  requestDigest: string;
  expected: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intentDigest: string;
  intent: RevisionedDrawLineIntent;
}

export interface WhiteboardAuthorityRevisionedDrawLatexOptions {
  executionId: string;
  requestDigest: string;
  expected: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intentDigest: string;
  intent: RevisionedDrawLatexIntent;
}

export interface WhiteboardAuthorityRevisionedDrawTableOptions {
  executionId: string;
  requestDigest: string;
  expected: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intentDigest: string;
  intent: RevisionedDrawTableIntent;
}

export interface WhiteboardAuthorityRevisionedDrawChartOptions {
  executionId: string;
  requestDigest: string;
  expected: RevisionedWhiteboardBinding;
  authenticatedTarget: RevisionedWhiteboardAuthenticatedTarget;
  deadlineAt: number;
  intentDigest: string;
  intent: RevisionedDrawChartIntent;
}

type WhiteboardAuthorityRevisionedDrawElementOptions =
  | (WhiteboardAuthorityRevisionedDrawTextOptions & { toolName: 'wb_draw_text' })
  | (WhiteboardAuthorityRevisionedDrawShapeOptions & { toolName: 'wb_draw_shape' })
  | (WhiteboardAuthorityRevisionedDrawLineOptions & { toolName: 'wb_draw_line' })
  | (WhiteboardAuthorityRevisionedDrawLatexOptions & { toolName: 'wb_draw_latex' })
  | (WhiteboardAuthorityRevisionedDrawTableOptions & { toolName: 'wb_draw_table' })
  | (WhiteboardAuthorityRevisionedDrawChartOptions & { toolName: 'wb_draw_chart' });

export type WhiteboardAuthorityRevisionedMutationResult =
  | {
      ok: true;
      replayed: boolean;
      receipt: RevisionedWhiteboardAuthorityReceipt;
    }
  | {
      ok: false;
      code:
        | typeof WHITEBOARD_AUTHORITY_RESOURCE_BUSY
        | typeof WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID
        | typeof WHITEBOARD_AUTHORITY_JOURNAL_CAPACITY_EXCEEDED
        | typeof WHITEBOARD_AUTHORITY_DEADLINE_EXCEEDED;
      errors: readonly string[];
    };

type RevisionedJournalEntry = {
  identity: RevisionedJournalIdentity;
  receipt: RevisionedWhiteboardAuthorityReceipt;
  expiresAt: number;
};

type RevisionedJournalIdentity = Pick<
  WhiteboardAuthorityRevisionedMutationOptions,
  'executionId' | 'requestDigest' | 'toolName' | 'expected' | 'authenticatedTarget' | 'deadlineAt'
>;

const MAX_REVISIONED_JOURNAL_ENTRIES = 256;
const REVISIONED_JOURNAL_REPLAY_GRACE_MS = 30_000;

function isRevisionedPlan(value: unknown): value is WhiteboardAuthorityRevisionedPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Partial<WhiteboardAuthorityRevisionedPlan>;
  if (plan.ok === false) {
    return (
      plan.code === 'TARGET_PRECONDITION_FAILED' &&
      Object.keys(value).every((key) => key === 'ok' || key === 'code')
    );
  }
  const allowedKeys = new Set(['ok', 'nextWhiteboards', 'nextOpen', 'preferredActiveWhiteboardId']);
  return (
    plan.ok === true &&
    isRevisionedWhiteboards(plan.nextWhiteboards) &&
    typeof plan.nextOpen === 'boolean' &&
    (plan.preferredActiveWhiteboardId === undefined ||
      plan.preferredActiveWhiteboardId === null ||
      (typeof plan.preferredActiveWhiteboardId === 'string' &&
        plan.preferredActiveWhiteboardId.length >= 1 &&
        plan.preferredActiveWhiteboardId.length <= 512 &&
        !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(plan.preferredActiveWhiteboardId))) &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function isRevisionedWhiteboards(value: unknown): value is readonly Whiteboard[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const candidate of value as Array<Partial<Whiteboard>>) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      candidate.id.length < 1 ||
      candidate.id.length > 512 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/u.test(candidate.id) ||
      ids.has(candidate.id) ||
      !Array.isArray(candidate.elements)
    ) {
      return false;
    }
    ids.add(candidate.id);
  }
  try {
    canonicalizeJsonValue(value, new Set());
    return true;
  } catch {
    return false;
  }
}

function canonicalizeJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('Whiteboard state must not contain cycles');
    ancestors.add(value);
    const normalized = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value) || value[index] === undefined) return null;
      return canonicalizeJsonValue(value[index], ancestors);
    });
    ancestors.delete(value);
    return normalized;
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('Whiteboard state must not contain cycles');
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error('Whiteboard state must contain only plain JSON objects');
    }
    ancestors.add(value);
    const normalized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalizeJsonValue(entry, ancestors)]),
    );
    ancestors.delete(value);
    return normalized;
  }
  throw new Error(`Whiteboard state contains a non-JSON value: ${typeof value}`);
}

function immutableCanonicalSnapshot<T>(value: T): T {
  const snapshot = canonicalizeJsonValue(value, new Set()) as T;
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  };
  freeze(snapshot);
  return snapshot;
}

function mutableCanonicalSnapshot<T>(value: unknown): T {
  return canonicalizeJsonValue(value, new Set()) as T;
}

function fingerprintJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalizeJsonValue(value, new Set()));
  return `sha256:${bytesToHex(sha256(utf8ToBytes(serialized)))}`;
}

function fingerprintWhiteboards(whiteboards: readonly Whiteboard[] | null | undefined): string {
  return fingerprintJson(whiteboards ?? []);
}

function fingerprintNonWhiteboardStage(stage: Stage): string {
  const { whiteboard: _whiteboard, ...rest } = stage;
  return fingerprintJson(rest);
}

function revisionedDomainDelta(
  before: WhiteboardDomainSnapshot,
  after: WhiteboardDomainSnapshot,
): JsonValue {
  return {
    kind: 'whiteboard_domain_transition',
    previousWhiteboardId: before.activeWhiteboardId,
    currentWhiteboardId: after.activeWhiteboardId,
    previousRevision: before.revision,
    currentRevision: after.revision,
    visibilityChanged: before.open !== after.open,
    whiteboardContentChanged: before.whiteboardFingerprint !== after.whiteboardFingerprint,
  };
}

function revisionedDomainPostcondition(domain: WhiteboardDomainSnapshot): JsonValue {
  return {
    kind: 'whiteboard_domain_state',
    stageId: domain.stageId,
    whiteboardId: domain.activeWhiteboardId,
    revision: domain.revision,
    open: domain.open,
    whiteboardFingerprint: domain.whiteboardFingerprint,
  };
}

function selectActiveId(
  stage: Stage | null,
  previous: WhiteboardAuthoritySnapshot | null,
  preferredActiveWhiteboardId?: string | null,
): string | null {
  const whiteboards = stage?.whiteboard ?? [];
  const previousActiveId = previous?.activeWhiteboardId ?? null;
  if (whiteboards.length === 0) return null;

  if (
    preferredActiveWhiteboardId !== undefined &&
    preferredActiveWhiteboardId !== null &&
    whiteboards.some(({ id }) => id === preferredActiveWhiteboardId)
  ) {
    return preferredActiveWhiteboardId;
  }

  if (
    previous?.stageId === stage?.id &&
    previousActiveId &&
    whiteboards.some(({ id }) => id === previousActiveId)
  ) {
    return previousActiveId;
  }

  return whiteboards[0]?.id ?? null;
}

function publicSnapshot(domain: WhiteboardDomainSnapshot): WhiteboardAuthoritySnapshot {
  return Object.freeze({
    stageId: domain.stageId,
    activeWhiteboardId: domain.activeWhiteboardId,
    revision: domain.revision,
    open: domain.open,
  });
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function revisionedBindingsEqual(
  left: RevisionedWhiteboardBinding,
  right: RevisionedWhiteboardBinding,
): boolean {
  return (
    left.stageId === right.stageId &&
    left.whiteboardId === right.whiteboardId &&
    left.revision === right.revision
  );
}

function authenticatedTargetsEqual(
  left: RevisionedWhiteboardAuthenticatedTarget,
  right: RevisionedWhiteboardAuthenticatedTarget,
): boolean {
  return (
    left.childInvocationId === right.childInvocationId &&
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.sceneId === right.sceneId
  );
}

function journalIdentitiesEqual(
  left: RevisionedJournalIdentity,
  right: RevisionedJournalIdentity,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.requestDigest === right.requestDigest &&
    left.toolName === right.toolName &&
    revisionedBindingsEqual(left.expected, right.expected) &&
    authenticatedTargetsEqual(left.authenticatedTarget, right.authenticatedTarget) &&
    left.deadlineAt === right.deadlineAt
  );
}

function escapeRevisionedWhiteboardText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createRevisionedTextElement(
  executionId: string,
  intent: Readonly<RevisionedDrawTextIntent>,
  contentDigest: string,
): PPTElement {
  const fontSize = intent.fontSize ?? 18;
  return {
    id: deriveRevisionedElementId(executionId),
    type: 'text',
    content: `<p style="font-size: ${fontSize}px;">${escapeRevisionedWhiteboardText(intent.content)}</p>`,
    left: intent.x,
    top: intent.y,
    width: intent.width ?? 400,
    height: intent.height ?? 100,
    rotate: 0,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: intent.color ?? '#333333',
    clientEffectExecutionId: executionId,
    clientEffectContentDigest: contentDigest,
    clientEffectNormalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  } as PPTElement;
}

type RevisionedDrawElementPlanBase = Readonly<{
  element: PPTElement;
  stableElementId: string;
}>;

type RevisionedDrawElementPlan =
  | (RevisionedDrawElementPlanBase & {
      toolName: 'wb_draw_text';
      elementType: 'text';
      normalizationVersion: typeof CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION;
      observedDigest: string;
    })
  | (RevisionedDrawElementPlanBase & {
      toolName: 'wb_draw_shape';
      elementType: 'shape';
      normalizationVersion: typeof CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION;
      observedDigest: string;
    })
  | (RevisionedDrawElementPlanBase & {
      toolName: 'wb_draw_line';
      elementType: 'line';
      normalizationVersion: typeof CLIENT_EFFECT_LINE_NORMALIZATION_VERSION;
      observedDigest: string;
    })
  | (RevisionedDrawElementPlanBase & {
      toolName: 'wb_draw_latex';
      elementType: 'latex';
      normalizationVersion: typeof CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION;
      renderVersion: typeof CLIENT_EFFECT_LATEX_RENDER_VERSION;
      observedFormulaDigest: string;
      observedHtmlDigest: string;
    })
  | (RevisionedDrawElementPlanBase & {
      toolName: 'wb_draw_table';
      elementType: 'table';
      normalizationVersion: typeof CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION;
      observedTableDigest: string;
    })
  | (RevisionedDrawElementPlanBase & {
      toolName: 'wb_draw_chart';
      elementType: 'chart';
      normalizationVersion: typeof CLIENT_EFFECT_CHART_NORMALIZATION_VERSION;
      observedChartDigest: string;
    });

function createRevisionedDrawElementPlan(
  opts: WhiteboardAuthorityRevisionedDrawElementOptions,
  normalizedIntent: Readonly<
    | RevisionedDrawTextIntent
    | RevisionedDrawShapeIntent
    | RevisionedDrawLineIntent
    | RevisionedDrawLatexIntent
    | RevisionedDrawTableIntent
    | RevisionedDrawChartIntent
  >,
): RevisionedDrawElementPlan {
  const stableElementId = deriveRevisionedElementId(opts.executionId);
  switch (opts.toolName) {
    case 'wb_draw_text': {
      const intent = normalizedIntent as Readonly<RevisionedDrawTextIntent>;
      const observedDigest = digestVisibleTextV1Sync(intent.content);
      return Object.freeze({
        toolName: opts.toolName,
        element: createRevisionedTextElement(opts.executionId, intent, observedDigest),
        stableElementId,
        elementType: 'text' as const,
        normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
        observedDigest,
      });
    }
    case 'wb_draw_shape': {
      const intent = normalizedIntent as Readonly<RevisionedDrawShapeIntent>;
      const spec: WhiteboardShapeSpec = normalizeWhiteboardShapeV1(intent);
      const observedDigest = digestWhiteboardShapeV1Sync(spec);
      return Object.freeze({
        toolName: opts.toolName,
        element: {
          id: stableElementId,
          type: 'shape',
          viewBox: [1000, 1000] as [number, number],
          path: WHITEBOARD_SHAPE_PATHS[spec.shape],
          left: spec.bounds.x,
          top: spec.bounds.y,
          width: spec.bounds.width,
          height: spec.bounds.height,
          rotate: 0,
          fill: spec.fillColor,
          fixedRatio: false,
          clientEffectExecutionId: opts.executionId,
          clientEffectShapeDigest: observedDigest,
          clientEffectShapeKind: spec.shape,
          clientEffectNormalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
        } as PPTElement,
        stableElementId,
        elementType: 'shape' as const,
        normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
        observedDigest,
      });
    }
    case 'wb_draw_line': {
      const intent = normalizedIntent as Readonly<RevisionedDrawLineIntent>;
      const spec: WhiteboardLineSpec = normalizeWhiteboardLineV1(intent);
      const observedDigest = digestWhiteboardLineV1Sync(spec);
      return Object.freeze({
        toolName: opts.toolName,
        element: {
          ...createWhiteboardLineElement({
            id: stableElementId,
            startX: spec.start.x,
            startY: spec.start.y,
            endX: spec.end.x,
            endY: spec.end.y,
            color: spec.strokeColor,
            width: spec.strokeWidth,
            style: spec.strokeStyle,
            points: spec.markers,
          }),
          clientEffectExecutionId: opts.executionId,
          clientEffectLineDigest: observedDigest,
          clientEffectNormalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
        } as PPTElement,
        stableElementId,
        elementType: 'line' as const,
        normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
        observedDigest,
      });
    }
    case 'wb_draw_latex': {
      const intent = normalizedIntent as Readonly<RevisionedDrawLatexIntent>;
      const spec: WhiteboardLatexSpec = normalizeWhiteboardLatexV1(intent);
      const html = renderNativeWhiteboardLatexHtmlV1(spec.latex);
      const observedFormulaDigest = digestWhiteboardLatexV1Sync(spec);
      const observedHtmlDigest = digestWhiteboardLatexHtmlV1Sync(html);
      return Object.freeze({
        toolName: opts.toolName,
        element: {
          ...createWhiteboardLatexElement({
            id: stableElementId,
            latex: spec.latex,
            x: spec.bounds.x,
            y: spec.bounds.y,
            width: spec.bounds.width,
            height: spec.bounds.height,
            color: spec.color,
            html,
          }),
          clientEffectExecutionId: opts.executionId,
          clientEffectFormulaDigest: observedFormulaDigest,
          clientEffectHtmlDigest: observedHtmlDigest,
          clientEffectNormalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
          clientEffectRenderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
        } as PPTElement,
        stableElementId,
        elementType: 'latex' as const,
        normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
        renderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
        observedFormulaDigest,
        observedHtmlDigest,
      });
    }
    case 'wb_draw_table': {
      const intent = normalizedIntent as Readonly<RevisionedDrawTableIntent>;
      const spec: WhiteboardTableSpec = normalizeWhiteboardTableV1(intent);
      const tableElement = createWhiteboardTableElement({
        id: stableElementId,
        x: spec.bounds.x,
        y: spec.bounds.y,
        width: spec.bounds.width,
        height: spec.bounds.height,
        data: spec.data,
        outline: spec.outline,
        theme: spec.theme ? { color: spec.theme.color } : undefined,
      });
      if (!tableElement) throw new Error('REVISIONED_WHITEBOARD_TABLE_INTENT_INVALID');
      const observedTableDigest = digestRevisionedWhiteboardTableStateV2Sync(tableElement);
      return Object.freeze({
        toolName: opts.toolName,
        element: {
          ...tableElement,
          clientEffectExecutionId: opts.executionId,
          clientEffectTableDigest: observedTableDigest,
          clientEffectNormalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
        } as PPTElement,
        stableElementId,
        elementType: 'table' as const,
        normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
        observedTableDigest,
      });
    }
    case 'wb_draw_chart': {
      const intent = normalizedIntent as Readonly<RevisionedDrawChartIntent>;
      const spec: WhiteboardChartSpec = normalizeWhiteboardChartV1(intent);
      const observedChartDigest = digestWhiteboardChartV1Sync(spec);
      return Object.freeze({
        toolName: opts.toolName,
        element: {
          ...createWhiteboardChartElement({
            id: stableElementId,
            chartType: spec.chartType,
            x: spec.bounds.x,
            y: spec.bounds.y,
            width: spec.bounds.width,
            height: spec.bounds.height,
            data: spec.data,
            themeColors: spec.themeColors,
          }),
          clientEffectExecutionId: opts.executionId,
          clientEffectChartDigest: observedChartDigest,
          clientEffectNormalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
        } as PPTElement,
        stableElementId,
        elementType: 'chart' as const,
        normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
        observedChartDigest,
      });
    }
  }
}

function revisionedDrawMetadataMatches(
  observed: PPTElement | undefined,
  opts: WhiteboardAuthorityRevisionedDrawElementOptions,
  plan: RevisionedDrawElementPlan,
): boolean {
  if (!observed || observed.type !== plan.elementType) return false;
  const metadata = observed as PPTElement & {
    clientEffectExecutionId?: string;
    clientEffectNormalizationVersion?: string;
    clientEffectContentDigest?: string;
    clientEffectShapeDigest?: string;
    clientEffectLineDigest?: string;
    clientEffectFormulaDigest?: string;
    clientEffectHtmlDigest?: string;
    clientEffectRenderVersion?: string;
    clientEffectTableDigest?: string;
    clientEffectChartDigest?: string;
  };
  if (
    metadata.clientEffectExecutionId !== opts.executionId ||
    metadata.clientEffectNormalizationVersion !== plan.normalizationVersion
  ) {
    return false;
  }
  switch (plan.toolName) {
    case 'wb_draw_text':
      return metadata.clientEffectContentDigest === plan.observedDigest;
    case 'wb_draw_shape':
      return metadata.clientEffectShapeDigest === plan.observedDigest;
    case 'wb_draw_line':
      return metadata.clientEffectLineDigest === plan.observedDigest;
    case 'wb_draw_latex': {
      const element = observed as PPTLatexElement;
      try {
        const spec = normalizeWhiteboardLatexV1({
          latex: element.latex,
          x: element.left,
          y: element.top,
          width: element.width,
          height: element.height,
          color: element.color,
        });
        return (
          element.rotate === 0 &&
          element.fixedRatio === true &&
          metadata.clientEffectRenderVersion === plan.renderVersion &&
          metadata.clientEffectFormulaDigest === plan.observedFormulaDigest &&
          metadata.clientEffectHtmlDigest === plan.observedHtmlDigest &&
          digestWhiteboardLatexV1Sync(spec) === plan.observedFormulaDigest &&
          element.html === renderNativeWhiteboardLatexHtmlV1(spec.latex) &&
          digestWhiteboardLatexHtmlV1Sync(element.html) === plan.observedHtmlDigest
        );
      } catch {
        return false;
      }
    }
    case 'wb_draw_table':
      try {
        return (
          metadata.clientEffectTableDigest === plan.observedTableDigest &&
          digestRevisionedWhiteboardTableStateV2Sync(observed as PPTTableElement) ===
            plan.observedTableDigest
        );
      } catch {
        return false;
      }
    case 'wb_draw_chart': {
      const element = observed as PPTChartElement;
      try {
        const spec = normalizeWhiteboardChartV1({
          chartType: element.chartType,
          x: element.left,
          y: element.top,
          width: element.width,
          height: element.height,
          data: element.data,
          themeColors: element.themeColors,
        });
        return (
          element.rotate === 0 &&
          element.fill === undefined &&
          element.options === undefined &&
          element.outline === undefined &&
          element.textColor === undefined &&
          element.lineColor === undefined &&
          metadata.clientEffectChartDigest === plan.observedChartDigest &&
          digestWhiteboardChartV1Sync(spec) === plan.observedChartDigest
        );
      } catch {
        return false;
      }
    }
  }
}

function revisionedDrawDelta(
  plan: RevisionedDrawElementPlan,
  whiteboardId: string,
  createdWhiteboard: boolean,
  visibilityChanged: boolean,
  elementCountBefore: number,
):
  | RevisionedDrawTextDelta
  | RevisionedDrawShapeDelta
  | RevisionedDrawLineDelta
  | RevisionedDrawLatexDelta
  | RevisionedDrawTableDelta
  | RevisionedDrawChartDelta {
  const common = {
    normalizationVersion: plan.normalizationVersion,
    whiteboardId,
    stableElementId: plan.stableElementId,
    createdWhiteboard,
    visibilityChanged,
    elementCountBefore,
    elementCountAfter: elementCountBefore + 1,
  };
  switch (plan.toolName) {
    case 'wb_draw_text':
      return { kind: 'whiteboard_text_created_v2', ...common } as RevisionedDrawTextDelta;
    case 'wb_draw_shape':
      return { kind: 'whiteboard_shape_created_v2', ...common } as RevisionedDrawShapeDelta;
    case 'wb_draw_line':
      return { kind: 'whiteboard_line_created_v2', ...common } as RevisionedDrawLineDelta;
    case 'wb_draw_latex':
      return { kind: 'whiteboard_latex_created_v2', ...common } as RevisionedDrawLatexDelta;
    case 'wb_draw_table':
      return { kind: 'whiteboard_table_created_v2', ...common } as RevisionedDrawTableDelta;
    case 'wb_draw_chart':
      return { kind: 'whiteboard_chart_created_v2', ...common } as RevisionedDrawChartDelta;
  }
}

function revisionedDrawPostcondition(
  plan: RevisionedDrawElementPlan,
  whiteboardId: string,
):
  | RevisionedDrawTextPostcondition
  | RevisionedDrawShapePostcondition
  | RevisionedDrawLinePostcondition
  | RevisionedDrawLatexPostcondition
  | RevisionedDrawTablePostcondition
  | RevisionedDrawChartPostcondition {
  const common = {
    normalizationVersion: plan.normalizationVersion,
    whiteboardId,
    stableElementId: plan.stableElementId,
    matchingElementCount: 1 as const,
  };
  switch (plan.toolName) {
    case 'wb_draw_text':
      return {
        kind: 'whiteboard_text_exists_v2',
        ...common,
        elementType: 'text',
        observedContentDigest: plan.observedDigest,
      } as RevisionedDrawTextPostcondition;
    case 'wb_draw_shape':
      return {
        kind: 'whiteboard_shape_exists_v2',
        ...common,
        elementType: 'shape',
        observedShapeDigest: plan.observedDigest,
      } as RevisionedDrawShapePostcondition;
    case 'wb_draw_line':
      return {
        kind: 'whiteboard_line_exists_v2',
        ...common,
        elementType: 'line',
        observedLineDigest: plan.observedDigest,
      } as RevisionedDrawLinePostcondition;
    case 'wb_draw_latex':
      return {
        kind: 'whiteboard_latex_exists_v2',
        ...common,
        renderVersion: plan.renderVersion,
        elementType: 'latex',
        observedFormulaDigest: plan.observedFormulaDigest,
        observedHtmlDigest: plan.observedHtmlDigest,
      } as RevisionedDrawLatexPostcondition;
    case 'wb_draw_table':
      return {
        kind: 'whiteboard_table_exists_v2',
        ...common,
        elementType: 'table',
        observedTableDigest: plan.observedTableDigest,
      } as RevisionedDrawTablePostcondition;
    case 'wb_draw_chart':
      return {
        kind: 'whiteboard_chart_exists_v2',
        ...common,
        elementType: 'chart',
        observedChartDigest: plan.observedChartDigest,
      } as RevisionedDrawChartPostcondition;
  }
}

function createRevisionedWhiteboard(executionId: string, element: PPTElement): Whiteboard {
  return {
    id: deriveRevisionedWhiteboardId(executionId),
    viewportSize: 1000,
    viewportRatio: 16 / 9,
    elements: [element],
    background: { type: 'solid', color: '#ffffff' },
    animations: [],
  };
}

/**
 * Browser-owned whiteboard transaction boundary.
 *
 * This class deliberately stores only binding/revision state. Whiteboard
 * elements and code remain owned by the Stage store. Only a bounded,
 * irreversible fingerprint is retained to detect unapproved writes.
 */
export class WhiteboardEnvironmentAuthority {
  private readonly store: WhiteboardAuthorityStore;
  private openStore: WhiteboardAuthorityOpenStore | null;
  private fallbackReadOpen: () => boolean;
  private domain: WhiteboardDomainSnapshot;
  private transactionActive = false;
  private readonly listeners = new Set<() => void>();
  private readonly revisionedJournal = new Map<string, RevisionedJournalEntry>();
  private authenticatedTargetRegistry: RevisionedWhiteboardTargetRegistryLookup | null = null;
  private readonly now: () => number;
  private readonly maxRevisionedJournalEntries: number;
  private readonly revisionedJournalReplayGraceMs: number;

  constructor(
    store: WhiteboardAuthorityStore,
    readOpen: () => boolean = () => false,
    opts: {
      now?: () => number;
      maxRevisionedJournalEntries?: number;
      revisionedJournalReplayGraceMs?: number;
    } = {},
  ) {
    this.store = store;
    this.openStore = null;
    this.fallbackReadOpen = readOpen;
    this.now = opts.now ?? Date.now;
    this.maxRevisionedJournalEntries =
      opts.maxRevisionedJournalEntries ?? MAX_REVISIONED_JOURNAL_ENTRIES;
    this.revisionedJournalReplayGraceMs =
      opts.revisionedJournalReplayGraceMs ?? REVISIONED_JOURNAL_REPLAY_GRACE_MS;
    const stage = store.getState().stage;
    this.domain = {
      stageId: stage?.id ?? null,
      activeWhiteboardId: stage?.whiteboard?.[0]?.id ?? null,
      revision: 0,
      open: this.readOpen(),
      whiteboardFingerprint: fingerprintWhiteboards(stage?.whiteboard),
    };
  }

  configureOpenReader(readOpen: () => boolean): void {
    this.fallbackReadOpen = readOpen;
    if (this.transactionActive) return;
    const open = readOpen();
    if (open === this.domain.open) return;
    // Configuration happens once while wiring the default stores. It is an
    // initial hydration, not a user-visible mutation.
    this.domain = { ...this.domain, open };
  }

  configureOpenStore(openStore: WhiteboardAuthorityOpenStore): void {
    this.openStore = openStore;
    this.configureOpenReader(() => openStore.getState().whiteboardOpen);
  }

  configureAuthenticatedTargetRegistry(registry: RevisionedWhiteboardTargetRegistryLookup): void {
    if (this.authenticatedTargetRegistry && this.authenticatedTargetRegistry !== registry) {
      throw new Error('REVISIONED_WHITEBOARD_TARGET_REGISTRY_CONFLICT');
    }
    this.authenticatedTargetRegistry = registry;
  }

  querySnapshot(): WhiteboardAuthorityQueryResult<WhiteboardAuthoritySnapshot> {
    const snapshot = publicSnapshot(this.domain);
    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        snapshot,
        errors: ['whiteboard query attempted while a transaction is active'],
      };
    }
    const actual = this.captureActualDomain(this.domain.revision, this.domain);
    if (!this.domainMatchesCommitted(actual)) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_BYPASS,
        snapshot,
        errors: ['whiteboard state changed outside the Authority'],
      };
    }
    return { ok: true, value: snapshot, snapshot };
  }

  queryActiveWhiteboard(): WhiteboardAuthorityQueryResult<Whiteboard | null> {
    const snapshot = publicSnapshot(this.domain);
    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        snapshot,
        errors: ['active whiteboard query attempted while a transaction is active'],
      };
    }
    const actual = this.captureActualDomain(this.domain.revision, this.domain);
    if (!this.domainMatchesCommitted(actual)) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_BYPASS,
        snapshot,
        errors: ['whiteboard state changed outside the Authority'],
      };
    }
    const stage = this.store.getState().stage;
    const value =
      stage && stage.id === this.domain.stageId && this.domain.activeWhiteboardId
        ? (stage.whiteboard?.find(({ id }) => id === this.domain.activeWhiteboardId) ?? null)
        : null;
    return { ok: true, value, snapshot };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isTransactionActive(): boolean {
    return this.transactionActive;
  }

  /**
   * Preserve the current active board on a same-stage whole-document
   * replacement by moving it to the canonical first position. A new Stage
   * hydrates its UI-visible first board as active.
   */
  canonicalizeStageReplacement(stage: Stage): Stage {
    const whiteboards = stage.whiteboard ?? [];
    if (
      stage.id !== this.domain.stageId ||
      !this.domain.activeWhiteboardId ||
      whiteboards[0]?.id === this.domain.activeWhiteboardId
    ) {
      return stage;
    }
    const activeIndex = whiteboards.findIndex(({ id }) => id === this.domain.activeWhiteboardId);
    if (activeIndex <= 0) return stage;
    return {
      ...stage,
      whiteboard: [
        whiteboards[activeIndex],
        ...whiteboards.slice(0, activeIndex),
        ...whiteboards.slice(activeIndex + 1),
      ],
    };
  }

  transact(opts: WhiteboardAuthorityTransactionOptions): WhiteboardAuthorityTransactionResult {
    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        changed: false,
        mutationMayHaveCommitted: false,
        snapshot: publicSnapshot(this.domain),
        errors: [`${opts.label}: whiteboard transaction already active`],
      };
    }

    const actualBefore = this.captureActualDomain(this.domain.revision, this.domain);
    if (!this.domainMatchesCommitted(actualBefore)) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_BYPASS,
        changed: false,
        mutationMayHaveCommitted: false,
        snapshot: publicSnapshot(this.domain),
        errors: [`${opts.label}: whiteboard state changed outside the Authority`],
      };
    }

    if (opts.expected && opts.expected.stageId !== this.domain.stageId) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_TARGET_CHANGED,
        changed: false,
        mutationMayHaveCommitted: false,
        snapshot: publicSnapshot(this.domain),
        errors: [`${opts.label}: expected stage is no longer active`],
      };
    }

    if (
      opts.expected &&
      (opts.expected.activeWhiteboardId !== this.domain.activeWhiteboardId ||
        opts.expected.revision !== this.domain.revision)
    ) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_STALE_STATE,
        changed: false,
        mutationMayHaveCommitted: false,
        snapshot: publicSnapshot(this.domain),
        errors: [`${opts.label}: expected whiteboard revision is stale`],
      };
    }

    this.transactionActive = true;
    const errors: string[] = [];
    let changed = false;
    let nextDomain = this.domain;
    try {
      for (const step of opts.writes) {
        try {
          step.write();
        } catch (error) {
          errors.push(`${step.label}: ${stringifyError(error)}`);
        }
      }

      const stage = this.store.getState().stage;
      const open = this.readOpen();
      const activeWhiteboardId = selectActiveId(
        stage,
        this.domain,
        opts.preferredActiveWhiteboardId,
      );
      const whiteboardFingerprint = fingerprintWhiteboards(stage?.whiteboard);
      changed =
        stage?.id !== this.domain.stageId ||
        activeWhiteboardId !== this.domain.activeWhiteboardId ||
        open !== this.domain.open ||
        whiteboardFingerprint !== this.domain.whiteboardFingerprint;

      nextDomain = {
        stageId: stage?.id ?? null,
        activeWhiteboardId,
        revision: changed ? this.domain.revision + 1 : this.domain.revision,
        open,
        whiteboardFingerprint,
      };
      this.domain = nextDomain;

      for (const listener of this.listeners) {
        try {
          listener();
        } catch (error) {
          errors.push(`authority-listener: ${stringifyError(error)}`);
        }
      }
    } finally {
      this.transactionActive = false;
    }

    if (errors.length > 0) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_UNCERTAIN,
        changed,
        mutationMayHaveCommitted: true,
        snapshot: publicSnapshot(nextDomain),
        errors,
      };
    }

    return { ok: true, changed, snapshot: publicSnapshot(nextDomain) };
  }

  /**
   * Internal v2 mutation seam. The observation capability has already been
   * consumed by the request-scoped Runtime before this browser-owned method is
   * called. Planning, CAS, writes, post-state verification, revisioning and the
   * bounded replay receipt all happen synchronously under one Authority lock.
   */
  transactRevisioned(
    opts: WhiteboardAuthorityRevisionedMutationOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    if (
      !isRevisionedWhiteboardMutationIdentity({
        executionId: opts.executionId,
        requestDigest: opts.requestDigest,
        toolName: opts.toolName,
        expectedBinding: opts.expected,
      }) ||
      !isRevisionedWhiteboardAuthenticatedTarget(opts.authenticatedTarget) ||
      !Number.isFinite(opts.deadlineAt) ||
      !isRevisionedPlan(opts.plan)
    ) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
        errors: [`${opts.label}: revisioned mutation identity is invalid`],
      };
    }
    const plan = immutableCanonicalSnapshot(opts.plan);
    const identity = immutableCanonicalSnapshot<RevisionedJournalIdentity>({
      executionId: opts.executionId,
      requestDigest: opts.requestDigest,
      toolName: opts.toolName,
      expected: opts.expected,
      authenticatedTarget: opts.authenticatedTarget,
      deadlineAt: opts.deadlineAt,
    });

    this.cleanupRevisionedJournal();
    const replay = this.revisionedJournal.get(identity.executionId);
    if (replay) {
      if (journalIdentitiesEqual(replay.identity, identity)) {
        return { ok: true, replayed: true, receipt: replay.receipt };
      }
      const current = this.binding(this.domain);
      return {
        ok: true,
        replayed: false,
        receipt: {
          protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
          outcome: 'rejected',
          executionId: identity.executionId,
          requestDigest: identity.requestDigest,
          toolName: identity.toolName,
          previousBinding: current,
          currentBinding: current,
          changed: false,
          mutationMayHaveCommitted: false,
          error: { code: 'EXECUTION_ID_CONFLICT' },
        },
      };
    }

    if (this.now() >= identity.deadlineAt) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_DEADLINE_EXCEEDED,
        errors: [`${opts.label}: revisioned mutation deadline has expired`],
      };
    }

    if (this.revisionedJournal.size >= this.maxRevisionedJournalEntries) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_JOURNAL_CAPACITY_EXCEEDED,
        errors: [`${opts.label}: revisioned mutation journal is at capacity`],
      };
    }

    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        errors: [`${opts.label}: whiteboard transaction already active`],
      };
    }

    const beforeDomain = this.domain;
    const beforeBinding = this.binding(beforeDomain);
    const actualBefore = this.captureActualDomain(beforeDomain.revision, beforeDomain);
    const authorityStateIsCurrent = this.domainMatchesCommitted(actualBefore);

    this.transactionActive = true;
    let receipt: RevisionedWhiteboardAuthorityReceipt;
    try {
      let targetIsCurrent = false;
      try {
        targetIsCurrent =
          this.authenticatedTargetRegistry?.validateAndConsume({
            executionId: identity.executionId,
            requestDigest: identity.requestDigest,
            intentDigest: digestRevisionedValue(plan),
            authenticatedTarget: identity.authenticatedTarget,
            expectedStageId: identity.expected.stageId,
            deadlineAt: identity.deadlineAt,
          }) === true;
      } catch {
        targetIsCurrent = false;
      }

      if (!authorityStateIsCurrent) {
        receipt = this.rejectedReceipt(
          identity,
          beforeBinding,
          beforeBinding,
          'WHITEBOARD_AUTHORITY_BYPASS_DETECTED',
        );
      } else if (identity.expected.stageId !== this.domain.stageId) {
        receipt = this.rejectedReceipt(identity, beforeBinding, beforeBinding, 'TARGET_CHANGED');
      } else if (!targetIsCurrent) {
        receipt = this.rejectedReceipt(
          identity,
          beforeBinding,
          beforeBinding,
          'AUTHENTICATED_TARGET_CHANGED',
        );
      } else if (
        identity.expected.whiteboardId !== this.domain.activeWhiteboardId ||
        identity.expected.revision !== this.domain.revision
      ) {
        receipt = this.rejectedReceipt(identity, beforeBinding, beforeBinding, 'STALE_STATE');
      } else if (!plan.ok) {
        receipt = this.rejectedReceipt(
          identity,
          beforeBinding,
          beforeBinding,
          'TARGET_PRECONDITION_FAILED',
        );
      } else {
        const errors: string[] = [];
        let plannedDomain: Omit<WhiteboardDomainSnapshot, 'revision'> | null = null;
        let nextStage: Stage | null = null;
        let nonWhiteboardFingerprint: string | null = null;
        try {
          const currentStage = this.store.getState().stage;
          if (!currentStage || currentStage.id !== beforeDomain.stageId) {
            throw new Error('Authoritative Stage is unavailable after CAS');
          }
          nonWhiteboardFingerprint = fingerprintNonWhiteboardStage(currentStage);
          const plannedStage: Stage = {
            ...currentStage,
            whiteboard: mutableCanonicalSnapshot<Whiteboard[]>(plan.nextWhiteboards),
          };
          nextStage = plannedStage;
          plannedDomain = {
            stageId: currentStage.id,
            activeWhiteboardId: selectActiveId(
              plannedStage,
              beforeDomain,
              plan.preferredActiveWhiteboardId,
            ),
            open: plan.nextOpen,
            whiteboardFingerprint: fingerprintWhiteboards(plannedStage.whiteboard),
          };
        } catch (error) {
          errors.push(`plan: ${stringifyError(error)}`);
        }

        if (plannedDomain && nextStage && nonWhiteboardFingerprint) {
          try {
            this.store.setState({ stage: nextStage });
          } catch (error) {
            errors.push(`stage-write: ${stringifyError(error)}`);
          }
          try {
            this.writeOpen(plan.nextOpen);
          } catch (error) {
            errors.push(`open-write: ${stringifyError(error)}`);
          }

          const stage = this.store.getState().stage;
          const activeWhiteboardId = selectActiveId(
            stage,
            this.domain,
            plan.preferredActiveWhiteboardId,
          );
          const nextFingerprint = fingerprintWhiteboards(stage?.whiteboard);
          const nextOpen = this.readOpen();
          const changed =
            stage?.id !== beforeDomain.stageId ||
            activeWhiteboardId !== beforeDomain.activeWhiteboardId ||
            nextOpen !== beforeDomain.open ||
            nextFingerprint !== beforeDomain.whiteboardFingerprint;
          const nextDomain: WhiteboardDomainSnapshot = {
            stageId: stage?.id ?? null,
            activeWhiteboardId,
            revision: changed ? beforeDomain.revision + 1 : beforeDomain.revision,
            open: nextOpen,
            whiteboardFingerprint: nextFingerprint,
          };
          this.domain = nextDomain;
          const currentBinding = this.binding(nextDomain);

          if (
            stage?.id !== plannedDomain.stageId ||
            !stage ||
            fingerprintNonWhiteboardStage(stage) !== nonWhiteboardFingerprint ||
            activeWhiteboardId !== plannedDomain.activeWhiteboardId ||
            nextOpen !== plannedDomain.open ||
            nextFingerprint !== plannedDomain.whiteboardFingerprint
          ) {
            errors.push('postcondition: applied state does not match the declarative plan');
          }

          for (const listener of this.listeners) {
            try {
              listener();
            } catch (error) {
              errors.push(`authority-listener: ${stringifyError(error)}`);
            }
          }

          if (errors.length > 0) {
            receipt = this.uncertainReceipt(identity, beforeBinding, currentBinding, changed);
          } else {
            const committedReceipt = {
              protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
              outcome: 'committed',
              executionId: identity.executionId,
              requestDigest: identity.requestDigest,
              toolName: identity.toolName,
              previousBinding: beforeBinding,
              currentBinding,
              changed,
              mutationMayHaveCommitted: false,
              delta: revisionedDomainDelta(beforeDomain, nextDomain),
              postcondition: revisionedDomainPostcondition(nextDomain),
            } satisfies RevisionedWhiteboardCommittedReceipt;
            const committedReceiptBytes = revisionedWhiteboardWireBytes(committedReceipt);
            receipt =
              committedReceiptBytes !== null &&
              committedReceiptBytes <= MAX_REVISIONED_WHITEBOARD_RECEIPT_BYTES &&
              isRevisionedWhiteboardAuthorityReceipt(committedReceipt)
                ? committedReceipt
                : this.uncertainReceipt(identity, beforeBinding, currentBinding, changed);
          }
        } else {
          receipt = this.rejectedReceipt(
            identity,
            beforeBinding,
            beforeBinding,
            'TARGET_PRECONDITION_FAILED',
          );
        }
      }

      receipt = this.rememberRevisioned(identity, receipt);
    } finally {
      this.transactionActive = false;
    }

    return { ok: true, replayed: false, receipt };
  }

  transactRevisionedDrawText(
    opts: WhiteboardAuthorityRevisionedDrawTextOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    return this.transactRevisionedDrawElement({ ...opts, toolName: 'wb_draw_text' });
  }

  transactRevisionedDrawShape(
    opts: WhiteboardAuthorityRevisionedDrawShapeOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    return this.transactRevisionedDrawElement({ ...opts, toolName: 'wb_draw_shape' });
  }

  transactRevisionedDrawLine(
    opts: WhiteboardAuthorityRevisionedDrawLineOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    return this.transactRevisionedDrawElement({ ...opts, toolName: 'wb_draw_line' });
  }

  transactRevisionedDrawLatex(
    opts: WhiteboardAuthorityRevisionedDrawLatexOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    return this.transactRevisionedDrawElement({ ...opts, toolName: 'wb_draw_latex' });
  }

  transactRevisionedDrawTable(
    opts: WhiteboardAuthorityRevisionedDrawTableOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    return this.transactRevisionedDrawElement({ ...opts, toolName: 'wb_draw_table' });
  }

  transactRevisionedDrawChart(
    opts: WhiteboardAuthorityRevisionedDrawChartOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    return this.transactRevisionedDrawElement({ ...opts, toolName: 'wb_draw_chart' });
  }

  private transactRevisionedDrawElement(
    opts: WhiteboardAuthorityRevisionedDrawElementOptions,
  ): WhiteboardAuthorityRevisionedMutationResult {
    const digestInput = {
      executionId: opts.executionId,
      expectedBinding: opts.expected,
      authenticatedTarget: opts.authenticatedTarget,
      deadlineAt: opts.deadlineAt,
    };
    const digests = (() => {
      switch (opts.toolName) {
        case 'wb_draw_text':
          return createRevisionedDrawTextDigests({ ...digestInput, intent: opts.intent });
        case 'wb_draw_shape':
          return createRevisionedDrawShapeDigests({ ...digestInput, intent: opts.intent });
        case 'wb_draw_line':
          return createRevisionedDrawLineDigests({ ...digestInput, intent: opts.intent });
        case 'wb_draw_latex':
          return createRevisionedDrawLatexDigests({ ...digestInput, intent: opts.intent });
        case 'wb_draw_table':
          return createRevisionedDrawTableDigests({ ...digestInput, intent: opts.intent });
        case 'wb_draw_chart':
          return createRevisionedDrawChartDigests({ ...digestInput, intent: opts.intent });
      }
    })();
    if (
      !digests ||
      digests.requestDigest !== opts.requestDigest ||
      digests.intentDigest !== opts.intentDigest ||
      !isRevisionedWhiteboardMutationIdentity({
        executionId: opts.executionId,
        requestDigest: opts.requestDigest,
        toolName: opts.toolName,
        expectedBinding: opts.expected,
      }) ||
      !isRevisionedWhiteboardAuthenticatedTarget(opts.authenticatedTarget) ||
      !Number.isFinite(opts.deadlineAt)
    ) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
        errors: [`${opts.toolName}.v2: revisioned draw request is invalid`],
      };
    }
    const normalizedIntent = digests.normalizedIntent;
    let drawPlan: RevisionedDrawElementPlan;
    try {
      drawPlan = createRevisionedDrawElementPlan(opts, normalizedIntent);
    } catch (error) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_MUTATION_REQUEST_INVALID,
        errors: [
          opts.toolName + '.v2: ' + (error instanceof Error ? error.message : 'draw plan invalid'),
        ],
      };
    }
    const identity = immutableCanonicalSnapshot<RevisionedJournalIdentity>({
      executionId: opts.executionId,
      requestDigest: opts.requestDigest,
      toolName: opts.toolName,
      expected: opts.expected,
      authenticatedTarget: opts.authenticatedTarget,
      deadlineAt: opts.deadlineAt,
    });

    this.cleanupRevisionedJournal();
    const replay = this.revisionedJournal.get(identity.executionId);
    if (replay) {
      if (journalIdentitiesEqual(replay.identity, identity)) {
        return { ok: true, replayed: true, receipt: replay.receipt };
      }
      const current = this.binding(this.domain);
      return {
        ok: true,
        replayed: false,
        receipt: this.rejectedReceipt(identity, current, current, 'EXECUTION_ID_CONFLICT'),
      };
    }
    if (this.now() >= identity.deadlineAt) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_DEADLINE_EXCEEDED,
        errors: [`${opts.toolName}.v2: revisioned mutation deadline has expired`],
      };
    }
    if (this.revisionedJournal.size >= this.maxRevisionedJournalEntries) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_JOURNAL_CAPACITY_EXCEEDED,
        errors: [`${opts.toolName}.v2: revisioned mutation journal is at capacity`],
      };
    }
    if (this.transactionActive) {
      return {
        ok: false,
        code: WHITEBOARD_AUTHORITY_RESOURCE_BUSY,
        errors: [`${opts.toolName}.v2: whiteboard transaction already active`],
      };
    }

    const beforeDomain = this.domain;
    const beforeBinding = this.binding(beforeDomain);
    const actualBefore = this.captureActualDomain(beforeDomain.revision, beforeDomain);
    const authorityStateIsCurrent = this.domainMatchesCommitted(actualBefore);

    this.transactionActive = true;
    let receipt: RevisionedWhiteboardAuthorityReceipt;
    try {
      let targetIsCurrent = false;
      try {
        targetIsCurrent =
          this.authenticatedTargetRegistry?.validateAndConsume({
            executionId: identity.executionId,
            requestDigest: identity.requestDigest,
            intentDigest: opts.intentDigest,
            authenticatedTarget: identity.authenticatedTarget,
            expectedStageId: identity.expected.stageId,
            deadlineAt: identity.deadlineAt,
          }) === true;
      } catch {
        targetIsCurrent = false;
      }

      if (!authorityStateIsCurrent) {
        receipt = this.rejectedReceipt(
          identity,
          beforeBinding,
          beforeBinding,
          'WHITEBOARD_AUTHORITY_BYPASS_DETECTED',
        );
      } else if (identity.expected.stageId !== this.domain.stageId) {
        receipt = this.rejectedReceipt(identity, beforeBinding, beforeBinding, 'TARGET_CHANGED');
      } else if (!targetIsCurrent) {
        receipt = this.rejectedReceipt(
          identity,
          beforeBinding,
          beforeBinding,
          'AUTHENTICATED_TARGET_CHANGED',
        );
      } else if (
        identity.expected.whiteboardId !== this.domain.activeWhiteboardId ||
        identity.expected.revision !== this.domain.revision
      ) {
        receipt = this.rejectedReceipt(identity, beforeBinding, beforeBinding, 'STALE_STATE');
      } else {
        const currentStage = this.store.getState().stage;
        const currentWhiteboards = currentStage?.whiteboard ?? [];
        const activeWhiteboard = identity.expected.whiteboardId
          ? currentWhiteboards.find(({ id }) => id === identity.expected.whiteboardId)
          : null;
        const invalidTarget =
          !currentStage ||
          currentStage.id !== beforeDomain.stageId ||
          (identity.expected.whiteboardId === null
            ? currentWhiteboards.length !== 0
            : !activeWhiteboard) ||
          Boolean(activeWhiteboard?.elements.some(({ id }) => id === drawPlan.stableElementId));
        if (invalidTarget) {
          receipt = this.rejectedReceipt(
            identity,
            beforeBinding,
            beforeBinding,
            'TARGET_PRECONDITION_FAILED',
          );
        } else {
          const errors: string[] = [];
          const createdWhiteboard = activeWhiteboard === null;
          const targetWhiteboard = activeWhiteboard
            ? {
                ...activeWhiteboard,
                elements: [...activeWhiteboard.elements, drawPlan.element],
              }
            : createRevisionedWhiteboard(identity.executionId, drawPlan.element);
          const beforeElementCount = activeWhiteboard?.elements.length ?? 0;
          const nextWhiteboards = activeWhiteboard
            ? currentWhiteboards.map((board) =>
                board.id === activeWhiteboard.id ? targetWhiteboard : board,
              )
            : [targetWhiteboard];
          const nonWhiteboardFingerprint = fingerprintNonWhiteboardStage(currentStage);
          const expectedWhiteboardFingerprint = fingerprintWhiteboards(nextWhiteboards);
          const expectedWhiteboardId = targetWhiteboard.id;
          const visibilityChanged = !beforeDomain.open;

          try {
            this.store.setState({
              stage: {
                ...currentStage,
                whiteboard: mutableCanonicalSnapshot<Whiteboard[]>(nextWhiteboards),
              },
            });
          } catch (error) {
            errors.push(`stage-write: ${stringifyError(error)}`);
          }
          try {
            this.writeOpen(true);
          } catch (error) {
            errors.push(`open-write: ${stringifyError(error)}`);
          }

          const stageAfter = this.store.getState().stage;
          const activeWhiteboardId = selectActiveId(stageAfter, beforeDomain, expectedWhiteboardId);
          const whiteboardFingerprint = fingerprintWhiteboards(stageAfter?.whiteboard);
          const openAfter = this.readOpen();
          const changed =
            stageAfter?.id !== beforeDomain.stageId ||
            activeWhiteboardId !== beforeDomain.activeWhiteboardId ||
            openAfter !== beforeDomain.open ||
            whiteboardFingerprint !== beforeDomain.whiteboardFingerprint;
          const nextDomain: WhiteboardDomainSnapshot = {
            stageId: stageAfter?.id ?? null,
            activeWhiteboardId,
            revision: changed ? beforeDomain.revision + 1 : beforeDomain.revision,
            open: openAfter,
            whiteboardFingerprint,
          };
          this.domain = nextDomain;
          const currentBinding = this.binding(nextDomain);
          const boardAfter = stageAfter?.whiteboard?.find(({ id }) => id === expectedWhiteboardId);
          const matches =
            boardAfter?.elements.filter(({ id }) => id === drawPlan.stableElementId) ?? [];
          const observed = matches[0];

          if (
            !stageAfter ||
            stageAfter.id !== currentStage.id ||
            fingerprintNonWhiteboardStage(stageAfter) !== nonWhiteboardFingerprint ||
            whiteboardFingerprint !== expectedWhiteboardFingerprint ||
            activeWhiteboardId !== expectedWhiteboardId ||
            !openAfter ||
            boardAfter?.elements.length !== beforeElementCount + 1 ||
            matches.length !== 1 ||
            !revisionedDrawMetadataMatches(observed, opts, drawPlan)
          ) {
            errors.push(
              `postcondition: ${opts.toolName} state does not match the Authority intent`,
            );
          }

          for (const listener of this.listeners) {
            try {
              listener();
            } catch (error) {
              errors.push(`authority-listener: ${stringifyError(error)}`);
            }
          }

          if (errors.length > 0) {
            receipt = this.uncertainReceipt(identity, beforeBinding, currentBinding, changed);
          } else {
            const delta = revisionedDrawDelta(
              drawPlan,
              expectedWhiteboardId,
              createdWhiteboard,
              visibilityChanged,
              beforeElementCount,
            );
            const postcondition = revisionedDrawPostcondition(drawPlan, expectedWhiteboardId);
            const committedReceipt = {
              protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
              outcome: 'committed',
              executionId: identity.executionId,
              requestDigest: identity.requestDigest,
              toolName: opts.toolName,
              previousBinding: beforeBinding,
              currentBinding,
              changed: true,
              mutationMayHaveCommitted: false,
              delta,
              postcondition,
            } satisfies RevisionedWhiteboardCommittedReceipt;
            const committedReceiptBytes = revisionedWhiteboardWireBytes(committedReceipt);
            receipt =
              changed &&
              committedReceiptBytes !== null &&
              committedReceiptBytes <= MAX_REVISIONED_WHITEBOARD_RECEIPT_BYTES &&
              isRevisionedWhiteboardAuthorityReceipt(committedReceipt)
                ? committedReceipt
                : this.uncertainReceipt(identity, beforeBinding, currentBinding, changed);
          }
        }
      }
      receipt = this.rememberRevisioned(identity, receipt);
    } finally {
      this.transactionActive = false;
    }
    return { ok: true, replayed: false, receipt };
  }

  getRevisionedJournalSizeForTests(): number {
    this.cleanupRevisionedJournal();
    return this.revisionedJournal.size;
  }

  private captureActualDomain(
    revision: number,
    previous: WhiteboardAuthoritySnapshot,
  ): WhiteboardDomainSnapshot {
    const stage = this.store.getState().stage;
    return {
      stageId: stage?.id ?? null,
      activeWhiteboardId: selectActiveId(stage, previous),
      revision,
      open: this.readOpen(),
      whiteboardFingerprint: fingerprintWhiteboards(stage?.whiteboard),
    };
  }

  private domainMatchesCommitted(actual: WhiteboardDomainSnapshot): boolean {
    return (
      actual.stageId === this.domain.stageId &&
      actual.activeWhiteboardId === this.domain.activeWhiteboardId &&
      actual.open === this.domain.open &&
      actual.whiteboardFingerprint === this.domain.whiteboardFingerprint
    );
  }

  private binding(domain: WhiteboardDomainSnapshot): RevisionedWhiteboardEnvironmentBinding {
    return {
      stageId: domain.stageId,
      whiteboardId: domain.activeWhiteboardId,
      revision: domain.revision,
    };
  }

  private rejectedReceipt(
    opts: Pick<
      WhiteboardAuthorityRevisionedMutationOptions,
      'executionId' | 'requestDigest' | 'toolName'
    >,
    previousBinding: RevisionedWhiteboardEnvironmentBinding,
    currentBinding: RevisionedWhiteboardEnvironmentBinding,
    code: RevisionedWhiteboardRejectedReceipt['error']['code'],
  ): RevisionedWhiteboardRejectedReceipt {
    return {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'rejected',
      executionId: opts.executionId,
      requestDigest: opts.requestDigest,
      toolName: opts.toolName,
      previousBinding,
      currentBinding,
      changed: false,
      mutationMayHaveCommitted: false,
      error: { code },
    };
  }

  private uncertainReceipt(
    opts: Pick<
      WhiteboardAuthorityRevisionedMutationOptions,
      'executionId' | 'requestDigest' | 'toolName'
    >,
    previousBinding: RevisionedWhiteboardEnvironmentBinding,
    currentBinding: RevisionedWhiteboardEnvironmentBinding,
    changed: boolean,
  ): RevisionedWhiteboardUncertainReceipt {
    return {
      protocolVersion: REVISIONED_WHITEBOARD_PROTOCOL_VERSION,
      outcome: 'uncertain',
      executionId: opts.executionId,
      requestDigest: opts.requestDigest,
      toolName: opts.toolName,
      previousBinding,
      currentBinding,
      changed,
      mutationMayHaveCommitted: true,
      error: { code: 'POSTCONDITION_UNCERTAIN' },
    };
  }

  private rememberRevisioned(
    identity: RevisionedJournalIdentity,
    receipt: RevisionedWhiteboardAuthorityReceipt,
  ): RevisionedWhiteboardAuthorityReceipt {
    const identitySnapshot = immutableCanonicalSnapshot(identity);
    const receiptSnapshot = verifyRevisionedWhiteboardAuthorityReceipt(receipt);
    if (!receiptSnapshot) {
      throw new Error('Revisioned whiteboard journal receipt is not wire-safe');
    }
    this.revisionedJournal.set(identitySnapshot.executionId, {
      identity: identitySnapshot,
      receipt: receiptSnapshot,
      expiresAt: identity.deadlineAt + this.revisionedJournalReplayGraceMs,
    });
    return receiptSnapshot;
  }

  private cleanupRevisionedJournal(): void {
    const current = this.now();
    for (const [executionId, entry] of this.revisionedJournal) {
      if (entry.expiresAt <= current) this.revisionedJournal.delete(executionId);
    }
  }

  private readOpen(): boolean {
    return this.openStore?.getState().whiteboardOpen ?? this.fallbackReadOpen();
  }

  private writeOpen(open: boolean): void {
    if (!this.openStore) {
      if (open !== this.readOpen()) {
        throw new Error('Whiteboard open store is not configured');
      }
      return;
    }
    this.openStore.setState({ whiteboardOpen: open });
  }
}

const authorities = new WeakMap<object, WhiteboardEnvironmentAuthority>();
let defaultAuthority: WhiteboardEnvironmentAuthority | null = null;

export function getWhiteboardEnvironmentAuthority(
  store: WhiteboardAuthorityStore,
): WhiteboardEnvironmentAuthority {
  const key = store as object;
  const existing = authorities.get(key);
  if (existing) return existing;
  const authority = new WhiteboardEnvironmentAuthority(store);
  authorities.set(key, authority);
  return authority;
}

export function registerDefaultWhiteboardEnvironmentAuthority(
  store: WhiteboardAuthorityStore,
  openStore: WhiteboardAuthorityOpenStore,
): WhiteboardEnvironmentAuthority {
  const authority = getWhiteboardEnvironmentAuthority(store);
  authority.configureOpenStore(openStore);
  defaultAuthority = authority;
  return authority;
}

export function getDefaultWhiteboardEnvironmentAuthority(): WhiteboardEnvironmentAuthority | null {
  return defaultAuthority;
}

export function getActiveWhiteboardForStore(store: WhiteboardAuthorityStore): Whiteboard | null {
  const result = getWhiteboardEnvironmentAuthority(store).queryActiveWhiteboard();
  return result.ok ? result.value : null;
}

export function canonicalActiveWhiteboard(
  stage: Pick<Stage, 'whiteboard'> | null | undefined,
): Whiteboard | null {
  return stage?.whiteboard?.[0] ?? null;
}
