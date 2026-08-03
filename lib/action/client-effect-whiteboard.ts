import { createStageAPI, type StageStore } from '@/lib/api/stage-api';
import {
  CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
  CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_RENDER_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
  CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
  CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
  CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
  CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
  assertWhiteboardChartSpecV1,
  assertWhiteboardCodeSpecV1,
  assertWhiteboardEditableCodeStateV1,
  assertWhiteboardTableSpecV1,
  digestWhiteboardChartV1,
  digestWhiteboardCodeV1,
  digestWhiteboardEditableCodeStateV1,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardLatexV1,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  digestWhiteboardTableV1,
  digestVisibleTextV1,
  canonicalizeWhiteboardContentV1,
  digestWhiteboardMembershipV1,
  isPromptSafeWhiteboardIdentifier,
  isWhiteboardElementType,
  normalizeWhiteboardChartV1,
  normalizeWhiteboardCodeV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeWhiteboardTableV1,
  normalizeVisibleTextV1,
  whiteboardChartSpecsEqual,
  whiteboardCodeSpecsEqual,
  whiteboardEditableCodeStatesEqual,
  whiteboardTableSpecsEqual,
  type AcceptedTargetBinding,
  type ClientEffectTarget,
  type WhiteboardLatexSpec,
  type WhiteboardChartSpec,
  type WhiteboardCodeSpec,
  type WhiteboardEditableCodeState,
  type WhiteboardLineMarker,
  type WhiteboardLineSpec,
  type WhiteboardLineStyle,
  type WhiteboardShapeKind,
  type WhiteboardShapeSpec,
  type WhiteboardTableOutline,
  type WhiteboardTableSpec,
  type WhiteboardOpenCommittedObservation,
  type WhiteboardCloseCommittedObservation,
  type WhiteboardVisibilityTarget,
  type WhiteboardClearCommittedObservation,
  type WhiteboardDeleteCommittedObservation,
  type WhiteboardElementType,
} from '@/lib/agent/runtime/client-effect-contract';
import type { WhiteboardSnapshotReceipt } from '@/lib/store/whiteboard-history';
import { getActiveWhiteboardForStore } from '@/lib/store/whiteboard-environment-authority';
import type {
  ChartData,
  ChartType,
  PPTChartElement,
  PPTCodeElement,
  PPTElement,
  PPTLatexElement,
  PPTLineElement,
  PPTTableElement,
} from '@openmaic/dsl';
import { createWhiteboardChartElement } from './whiteboard-charts';
import { createWhiteboardCodeElement } from './whiteboard-code';
import {
  createWhiteboardLineElement,
  readAbsoluteWhiteboardLineEndpoints,
} from './whiteboard-lines';
import {
  createWhiteboardLatexElement,
  renderNativeWhiteboardLatexHtmlV1,
} from './whiteboard-latex';
import { WHITEBOARD_SHAPE_PATHS } from './whiteboard-shapes';
import { createWhiteboardTableElement } from './whiteboard-tables';

export interface NativeWbDrawTextInput {
  executionId: string;
  stableElementId: string;
  content: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
  color?: string;
}

export interface NativeWhiteboardTextPostconditionResult {
  stableElementId: string;
  elementType: 'text';
  normalizationVersion: typeof CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION;
  observedContentDigest: string;
  matchingElementCount: 1;
}

export interface NativeWhiteboardShapePostconditionResult extends WhiteboardShapeSpec {
  stableElementId: string;
  elementType: 'shape';
  normalizationVersion: typeof CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION;
  observedShapeDigest: string;
  matchingElementCount: 1;
}

export interface NativeWhiteboardLinePostconditionResult extends WhiteboardLineSpec {
  stableElementId: string;
  elementType: 'line';
  normalizationVersion: typeof CLIENT_EFFECT_LINE_NORMALIZATION_VERSION;
  observedLineDigest: string;
  matchingElementCount: 1;
}

export interface NativeWhiteboardLatexPostconditionResult extends WhiteboardLatexSpec {
  stableElementId: string;
  elementType: 'latex';
  normalizationVersion: typeof CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION;
  observedFormulaDigest: string;
  observedHtmlDigest: string;
  matchingElementCount: 1;
}

export interface NativeWhiteboardExecutionResult<
  TPostcondition = NativeWhiteboardTextPostconditionResult,
> {
  replayed: boolean;
  postcondition: TPostcondition;
}

type NativeTextElement = PPTElement & {
  clientEffectExecutionId?: string;
  clientEffectContentDigest?: string;
  clientEffectNormalizationVersion?: string;
};

type NativeShapeElement = PPTElement & {
  clientEffectExecutionId?: string;
  clientEffectShapeDigest?: string;
  clientEffectShapeKind?: WhiteboardShapeKind;
  clientEffectNormalizationVersion?: string;
};

type NativeLineElement = PPTLineElement & {
  clientEffectExecutionId?: string;
  clientEffectLineDigest?: string;
  clientEffectNormalizationVersion?: string;
};

type NativeLatexElement = PPTLatexElement & {
  clientEffectExecutionId?: string;
  clientEffectFormulaDigest?: string;
  clientEffectHtmlDigest?: string;
  clientEffectNormalizationVersion?: string;
  clientEffectRenderVersion?: string;
};

type NativeTableElement = PPTTableElement & {
  clientEffectExecutionId?: string;
  clientEffectTableDigest?: string;
  clientEffectNormalizationVersion?: string;
};

type NativeChartElement = PPTChartElement & {
  clientEffectExecutionId?: string;
  clientEffectChartDigest?: string;
  clientEffectNormalizationVersion?: string;
};

type NativeCodeElement = PPTCodeElement & {
  clientEffectExecutionId?: string;
  clientEffectCodeDigest?: string;
  clientEffectNormalizationVersion?: string;
  clientEffectLastEditExecutionId?: string;
  clientEffectLastEditBeforeDigest?: string;
  clientEffectLastEditAfterDigest?: string;
  clientEffectEditNormalizationVersion?: string;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
}

function assertStageAndScene(
  store: StageStore,
  target: Pick<ClientEffectTarget, 'stageId' | 'sceneId'>,
): void {
  const state = store.getState();
  if (
    state.stage?.id !== target.stageId ||
    state.currentSceneId !== target.sceneId ||
    !state.scenes.some((scene) => scene.id === target.sceneId)
  ) {
    throw new Error('CLIENT_EFFECT_TARGET_CHANGED');
  }
}

export function escapeNativeWhiteboardText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeNativeWhiteboardText(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function visibleTextFromNativeWhiteboardHtml(html: string): string {
  const match = /^<p style="font-size: \d+(?:\.\d+)?px;">((?:(?!<\/?p(?:\s|>))[\s\S])*)<\/p>$/.exec(
    html,
  );
  if (!match) throw new Error('CLIENT_EFFECT_TEXT_HTML_INVALID');
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  }
  return decodeNativeWhiteboardText(match[1]);
}

export function prepareNativeWhiteboardTarget(
  store: StageStore,
  target: ClientEffectTarget,
  bindingVersion = 1,
): AcceptedTargetBinding {
  assertStageAndScene(store, target);
  const whiteboard = createStageAPI(store).whiteboard.get();
  if (!whiteboard.success || !whiteboard.data) {
    throw new Error(whiteboard.error || 'CLIENT_EFFECT_WHITEBOARD_PREPARE_FAILED');
  }
  return {
    requestId: target.requestId,
    sessionId: target.sessionId,
    stageId: target.stageId,
    sceneId: target.sceneId,
    whiteboardId: whiteboard.data.id,
    bindingVersion,
  };
}

export function prepareNativeWhiteboardOpenTarget(
  store: StageStore,
  target: ClientEffectTarget,
  bindingVersion = 1,
): { targetBinding: AcceptedTargetBinding; created: boolean } {
  assertStageAndScene(store, target);
  const created = !getActiveWhiteboardForStore(store);
  const targetBinding = prepareNativeWhiteboardTarget(store, target, bindingVersion);
  return { targetBinding, created };
}

export function prepareNativeWhiteboardCloseTarget(
  store: StageStore,
  target: ClientEffectTarget,
  bindingVersion = 1,
): WhiteboardVisibilityTarget {
  assertStageAndScene(store, target);
  return {
    requestId: target.requestId,
    sessionId: target.sessionId,
    stageId: target.stageId,
    sceneId: target.sceneId,
    bindingVersion,
  };
}

export function verifyNativeWhiteboardCloseEffect(opts: {
  store: StageStore;
  visibilityTarget: WhiteboardVisibilityTarget;
  visibilityChanged: boolean;
  observedOpen: boolean;
  signal?: AbortSignal;
}): WhiteboardCloseCommittedObservation {
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.visibilityTarget);
  if (opts.observedOpen) throw new Error('CLIENT_EFFECT_WHITEBOARD_NOT_CLOSED');
  return {
    kind: 'whiteboard_closed',
    normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
    desiredOpen: false,
    observedOpen: false,
    visibilityChanged: opts.visibilityChanged,
  };
}

export function verifyNativeWhiteboardOpenEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  created: boolean;
  visibilityChanged: boolean;
  observedOpen: boolean;
  signal?: AbortSignal;
}): WhiteboardOpenCommittedObservation {
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const latestWhiteboard = getActiveWhiteboardForStore(opts.store);
  if (!latestWhiteboard || latestWhiteboard.id !== opts.targetBinding.whiteboardId) {
    throw new Error('CLIENT_EFFECT_WHITEBOARD_MISMATCH');
  }
  if (!opts.observedOpen) throw new Error('CLIENT_EFFECT_WHITEBOARD_NOT_OPEN');
  return {
    kind: 'whiteboard_open',
    normalizationVersion: CLIENT_EFFECT_WHITEBOARD_VISIBILITY_VERSION,
    whiteboardId: opts.targetBinding.whiteboardId,
    desiredOpen: true,
    observedOpen: true,
    created: opts.created,
    visibilityChanged: opts.visibilityChanged,
  };
}

export function prepareNativeExistingWhiteboardTarget(
  store: StageStore,
  target: ClientEffectTarget,
  expectedWhiteboardId: string,
  bindingVersion = 1,
): AcceptedTargetBinding {
  assertStageAndScene(store, target);
  if (typeof expectedWhiteboardId !== 'string' || !expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_ID_INVALID');
  }
  const latestWhiteboard = getActiveWhiteboardForStore(store);
  if (!latestWhiteboard || latestWhiteboard.id !== expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_MISMATCH');
  }
  return {
    requestId: target.requestId,
    sessionId: target.sessionId,
    stageId: target.stageId,
    sceneId: target.sceneId,
    whiteboardId: expectedWhiteboardId,
    bindingVersion,
  };
}

export function prepareNativeWhiteboardDeleteTarget(
  store: StageStore,
  target: ClientEffectTarget,
  expectedWhiteboardId: string,
  bindingVersion = 1,
): AcceptedTargetBinding {
  assertStageAndScene(store, target);
  if (typeof expectedWhiteboardId !== 'string' || !expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_DELETE_WHITEBOARD_ID_INVALID');
  }
  const latestWhiteboard = getActiveWhiteboardForStore(store);
  if (!latestWhiteboard || latestWhiteboard.id !== expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_DELETE_WHITEBOARD_MISMATCH');
  }
  return {
    requestId: target.requestId,
    sessionId: target.sessionId,
    stageId: target.stageId,
    sceneId: target.sceneId,
    whiteboardId: expectedWhiteboardId,
    bindingVersion,
  };
}

export function prepareNativeWhiteboardClearTarget(
  store: StageStore,
  target: ClientEffectTarget,
  expectedWhiteboardId: string,
  bindingVersion = 1,
): AcceptedTargetBinding {
  assertStageAndScene(store, target);
  if (!isPromptSafeWhiteboardIdentifier(expectedWhiteboardId)) {
    throw new Error('CLIENT_EFFECT_CLEAR_WHITEBOARD_ID_INVALID');
  }
  const latestWhiteboard = getActiveWhiteboardForStore(store);
  if (!latestWhiteboard || latestWhiteboard.id !== expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_CLEAR_WHITEBOARD_MISMATCH');
  }
  return {
    requestId: target.requestId,
    sessionId: target.sessionId,
    stageId: target.stageId,
    sceneId: target.sceneId,
    whiteboardId: expectedWhiteboardId,
    bindingVersion,
  };
}

export interface NativeWhiteboardClearCapture {
  elements: PPTElement[];
  canonicalContent: string;
  elementCount: number;
  membershipDigest: string;
}

export function verifyNativeWhiteboardClearNoOp(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  observedOpen: boolean;
  signal?: AbortSignal;
}): WhiteboardClearCommittedObservation {
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const latest = getActiveWhiteboardForStore(opts.store);
  if (
    !latest ||
    latest.id !== opts.targetBinding.whiteboardId ||
    (latest.elements ?? []).length !== 0
  ) {
    throw new Error('CLIENT_EFFECT_CLEAR_EMPTY_STATE_CHANGED');
  }
  return {
    kind: 'whiteboard_empty',
    normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
    membershipNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
    boardContentNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
    whiteboardId: opts.targetBinding.whiteboardId,
    cleared: false,
    elementCountBefore: 0,
    elementCountAfter: 0,
    observedMembershipDigestBefore: CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
    verifiedEmptyBoardContentDigest: CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
    observedOpen: opts.observedOpen,
    visibilityChanged: false,
  };
}

export async function captureNativeWhiteboardClearState(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardClearCapture> {
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const latest = getActiveWhiteboardForStore(opts.store);
  if (!latest || latest.id !== opts.targetBinding.whiteboardId) {
    throw new Error('CLIENT_EFFECT_CLEAR_WHITEBOARD_MISMATCH');
  }
  const elements = latest.elements ?? [];
  const membership = elements.map((element) => {
    if (!isPromptSafeWhiteboardIdentifier(element.id) || !isWhiteboardElementType(element.type)) {
      throw new Error('CLIENT_EFFECT_CLEAR_MEMBERSHIP_UNTRUSTED');
    }
    return { id: element.id, type: element.type };
  });
  if (new Set(membership.map(({ id }) => id)).size !== membership.length) {
    throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  }
  const canonicalContent = canonicalizeWhiteboardContentV1(elements);
  const membershipDigest = await digestWhiteboardMembershipV1(membership);
  throwIfAborted(opts.signal);
  return {
    elements: JSON.parse(JSON.stringify(elements)) as PPTElement[],
    canonicalContent,
    elementCount: elements.length,
    membershipDigest,
  };
}

/**
 * Exact clear commit. Call only after the final asynchronous digest gate. This
 * function is intentionally synchronous from the final capture through history,
 * mutation, and postcondition verification.
 */
export function commitNativeWhiteboardClearEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  expectedCanonicalContent: string;
  boardContentDigestAtAccepted: string;
  boardContentDigestBeforeMutation: string;
  membershipDigestBefore: string;
  pushExactSnapshot: (elements: PPTElement[], digest: string) => WhiteboardSnapshotReceipt;
  observedOpen: boolean;
  visibilityChanged: boolean;
  signal?: AbortSignal;
}): WhiteboardClearCommittedObservation {
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const latest = getActiveWhiteboardForStore(opts.store);
  if (!latest || latest.id !== opts.targetBinding.whiteboardId) {
    throw new Error('CLIENT_EFFECT_CLEAR_WHITEBOARD_MISMATCH');
  }
  const elements = latest.elements ?? [];
  if (!opts.observedOpen) throw new Error('CLIENT_EFFECT_WHITEBOARD_NOT_OPEN');
  if (elements.length === 0) throw new Error('CLIENT_EFFECT_CLEAR_ALREADY_EMPTY');
  if (canonicalizeWhiteboardContentV1(elements) !== opts.expectedCanonicalContent) {
    throw new Error('CLIENT_EFFECT_CLEAR_CONTENT_CHANGED');
  }
  const receipt = opts.pushExactSnapshot(elements, opts.boardContentDigestBeforeMutation);
  if (receipt.boardContentDigest !== opts.boardContentDigestBeforeMutation) {
    throw new Error('CLIENT_EFFECT_CLEAR_HISTORY_RECEIPT_MISMATCH');
  }
  const updated = createStageAPI(opts.store).whiteboard.update(
    { elements: [] },
    opts.targetBinding.whiteboardId,
  );
  if (!updated.success)
    throw new Error(updated.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  const after = getActiveWhiteboardForStore(opts.store);
  if (
    !after ||
    after.id !== opts.targetBinding.whiteboardId ||
    (after.elements ?? []).length !== 0
  ) {
    throw new Error('CLIENT_EFFECT_CLEAR_POSTCONDITION_FAILED');
  }
  return {
    kind: 'whiteboard_empty',
    normalizationVersion: CLIENT_EFFECT_CLEAR_NORMALIZATION_VERSION,
    membershipNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_MEMBERSHIP_VERSION,
    boardContentNormalizationVersion: CLIENT_EFFECT_WHITEBOARD_CONTENT_VERSION,
    whiteboardId: opts.targetBinding.whiteboardId,
    cleared: true,
    elementCountBefore: elements.length,
    elementCountAfter: 0,
    observedMembershipDigestBefore: opts.membershipDigestBefore,
    boardContentDigestAtAccepted: opts.boardContentDigestAtAccepted,
    boardContentDigestBeforeMutation: opts.boardContentDigestBeforeMutation,
    observedBoardContentDigestAfter: CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
    historySnapshotDigest: receipt.boardContentDigest,
    observedOpen: true,
    visibilityChanged: opts.visibilityChanged,
  };
}

export function executeNativeWhiteboardDeleteEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  stableElementId: string;
  expectedWhiteboardId: string;
  expectedElementType: WhiteboardElementType;
  signal?: AbortSignal;
}): NativeWhiteboardExecutionResult<WhiteboardDeleteCommittedObservation> {
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  if (opts.targetBinding.whiteboardId !== opts.expectedWhiteboardId || !opts.stableElementId) {
    throw new Error('CLIENT_EFFECT_DELETE_TARGET_INVALID');
  }

  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const beforeResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!beforeResult.success || !beforeResult.data) {
    throw new Error(beforeResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const before = beforeResult.data;
  const matchesBefore = before.filter((element) => element.id === opts.stableElementId);
  if (matchesBefore.length !== 1) {
    throw new Error(
      matchesBefore.length === 0
        ? 'CLIENT_EFFECT_DELETE_ELEMENT_NOT_FOUND'
        : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
    );
  }
  if (matchesBefore[0].type !== opts.expectedElementType) {
    throw new Error('CLIENT_EFFECT_DELETE_ELEMENT_TYPE_MISMATCH');
  }

  // The final target check, mutation, and postcondition read are intentionally
  // synchronous. No await may separate them, otherwise a later binding could
  // be deleted after the accepted target changes.
  assertStageAndScene(opts.store, opts.targetBinding);
  const latestWhiteboard = getActiveWhiteboardForStore(opts.store);
  if (!latestWhiteboard || latestWhiteboard.id !== opts.expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_DELETE_WHITEBOARD_MISMATCH');
  }
  const deleteResult = whiteboardApi.deleteElement(
    opts.stableElementId,
    opts.targetBinding.whiteboardId,
  );
  if (!deleteResult.success) {
    throw new Error(deleteResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  const afterResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!afterResult.success || !afterResult.data) {
    throw new Error(afterResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const matchingElementCountAfter = afterResult.data.filter(
    (element) => element.id === opts.stableElementId,
  ).length;
  if (matchingElementCountAfter !== 0 || afterResult.data.length !== before.length - 1) {
    throw new Error('CLIENT_EFFECT_DELETE_POSTCONDITION_FAILED');
  }

  return {
    replayed: false,
    postcondition: {
      kind: 'whiteboard_element_absent',
      normalizationVersion: CLIENT_EFFECT_DELETE_NORMALIZATION_VERSION,
      stableElementId: opts.stableElementId,
      whiteboardId: opts.targetBinding.whiteboardId,
      observedElementType: opts.expectedElementType,
      matchingElementCountBefore: 1,
      matchingElementCountAfter: 0,
      elementCountBefore: before.length,
      elementCountAfter: afterResult.data.length,
      deleted: true,
    },
  };
}

export async function verifyNativeWhiteboardTextEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedContentDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardTextPostconditionResult> {
  const readVerifiedElement = (): { element: NativeTextElement; visibleText: string } => {
    throwIfAborted(opts.signal);
    assertStageAndScene(opts.store, opts.targetBinding);
    const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
      opts.targetBinding.whiteboardId,
    );
    if (!elementsResult.success || !elementsResult.data) {
      throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
    }
    const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'CLIENT_EFFECT_ELEMENT_NOT_FOUND'
          : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
      );
    }

    const element = matches[0] as NativeTextElement;
    if (element.type !== 'text' || typeof element.content !== 'string') {
      throw new Error('CLIENT_EFFECT_ELEMENT_TYPE_MISMATCH');
    }
    if (
      element.clientEffectExecutionId !== opts.executionId ||
      element.clientEffectNormalizationVersion !== CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION
    ) {
      throw new Error('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
    }
    return {
      element,
      visibleText: normalizeVisibleTextV1(visibleTextFromNativeWhiteboardHtml(element.content)),
    };
  };

  const beforeDigest = readVerifiedElement();
  const observedContentDigest = await digestVisibleTextV1(beforeDigest.visibleText);
  throwIfAborted(opts.signal);
  const afterDigest = readVerifiedElement();
  if (
    afterDigest.visibleText !== beforeDigest.visibleText ||
    observedContentDigest !== opts.expectedContentDigest ||
    afterDigest.element.clientEffectContentDigest !== opts.expectedContentDigest
  ) {
    throw new Error('CLIENT_EFFECT_CONTENT_MISMATCH');
  }

  return {
    stableElementId: opts.stableElementId,
    elementType: 'text',
    normalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
    observedContentDigest,
    matchingElementCount: 1,
  };
}

export async function executeNativeWhiteboardTextEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  input: NativeWbDrawTextInput;
  expectedContentDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.input.executionId !== 'string' ||
    typeof opts.input.stableElementId !== 'string' ||
    typeof opts.input.content !== 'string'
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  const normalizedContent = normalizeVisibleTextV1(opts.input.content);
  if (
    !opts.input.executionId.trim() ||
    !opts.input.stableElementId.trim() ||
    !normalizedContent ||
    !Number.isFinite(opts.input.x) ||
    !Number.isFinite(opts.input.y) ||
    (opts.input.width !== undefined &&
      (!Number.isFinite(opts.input.width) || opts.input.width <= 0)) ||
    (opts.input.height !== undefined &&
      (!Number.isFinite(opts.input.height) || opts.input.height <= 0)) ||
    (opts.input.fontSize !== undefined &&
      (!Number.isFinite(opts.input.fontSize) ||
        opts.input.fontSize < 1 ||
        opts.input.fontSize > 512))
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  assertStageAndScene(opts.store, opts.targetBinding);
  const expectedContentDigest = await digestVisibleTextV1(opts.input.content);
  throwIfAborted(opts.signal);
  if (expectedContentDigest !== opts.expectedContentDigest) {
    throw new Error('CLIENT_EFFECT_REQUEST_CONTENT_MISMATCH');
  }
  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const elementsResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }

  const existing = elementsResult.data.filter(
    (element) => element.id === opts.input.stableElementId,
  );
  if (existing.length > 1) throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  if (existing.length === 1) {
    const postcondition = await verifyNativeWhiteboardTextEffect({
      store: opts.store,
      targetBinding: opts.targetBinding,
      executionId: opts.input.executionId,
      stableElementId: opts.input.stableElementId,
      expectedContentDigest,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { replayed: true, postcondition };
  }

  // Revalidate immediately before the only mutating call.
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const fontSize = opts.input.fontSize ?? 18;
  const addResult = whiteboardApi.addElement(
    {
      id: opts.input.stableElementId,
      type: 'text',
      content: `<p style="font-size: ${fontSize}px;">${escapeNativeWhiteboardText(opts.input.content)}</p>`,
      left: opts.input.x,
      top: opts.input.y,
      width: opts.input.width ?? 400,
      height: opts.input.height ?? 100,
      rotate: 0,
      defaultFontName: 'Microsoft YaHei',
      defaultColor: opts.input.color ?? '#333333',
      clientEffectExecutionId: opts.input.executionId,
      clientEffectContentDigest: expectedContentDigest,
      clientEffectNormalizationVersion: CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
    } as NativeTextElement,
    opts.targetBinding.whiteboardId,
  );
  if (!addResult.success) {
    throw new Error(addResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  throwIfAborted(opts.signal);

  const postcondition = await verifyNativeWhiteboardTextEffect({
    store: opts.store,
    targetBinding: opts.targetBinding,
    executionId: opts.input.executionId,
    stableElementId: opts.input.stableElementId,
    expectedContentDigest,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  return { replayed: false, postcondition };
}

export interface NativeWbDrawShapeInput {
  executionId: string;
  stableElementId: string;
  shape: WhiteboardShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
}

function shapeSpecFromElement(element: NativeShapeElement): WhiteboardShapeSpec {
  if (
    element.type !== 'shape' ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    typeof element.height !== 'number' ||
    typeof element.fill !== 'string' ||
    (element.clientEffectShapeKind !== 'rectangle' &&
      element.clientEffectShapeKind !== 'circle' &&
      element.clientEffectShapeKind !== 'triangle') ||
    element.path !== WHITEBOARD_SHAPE_PATHS[element.clientEffectShapeKind]
  ) {
    throw new Error('CLIENT_EFFECT_SHAPE_ELEMENT_MISMATCH');
  }
  return normalizeWhiteboardShapeV1({
    shape: element.clientEffectShapeKind,
    x: element.left,
    y: element.top,
    width: element.width,
    height: element.height,
    fillColor: element.fill,
  });
}

function shapeSpecsEqual(left: WhiteboardShapeSpec, right: WhiteboardShapeSpec): boolean {
  return (
    left.shape === right.shape &&
    left.bounds.x === right.bounds.x &&
    left.bounds.y === right.bounds.y &&
    left.bounds.width === right.bounds.width &&
    left.bounds.height === right.bounds.height &&
    left.fillColor === right.fillColor
  );
}

export async function verifyNativeWhiteboardShapeEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedShape: WhiteboardShapeSpec;
  expectedShapeDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardShapePostconditionResult> {
  const readVerifiedElement = (): { element: NativeShapeElement; spec: WhiteboardShapeSpec } => {
    throwIfAborted(opts.signal);
    assertStageAndScene(opts.store, opts.targetBinding);
    const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
      opts.targetBinding.whiteboardId,
    );
    if (!elementsResult.success || !elementsResult.data) {
      throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
    }
    const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'CLIENT_EFFECT_ELEMENT_NOT_FOUND'
          : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
      );
    }
    const element = matches[0] as NativeShapeElement;
    if (
      element.clientEffectExecutionId !== opts.executionId ||
      element.clientEffectNormalizationVersion !== CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION
    ) {
      throw new Error('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
    }
    return { element, spec: shapeSpecFromElement(element) };
  };

  const beforeDigest = readVerifiedElement();
  const observedShapeDigest = await digestWhiteboardShapeV1(beforeDigest.spec);
  throwIfAborted(opts.signal);
  const afterDigest = readVerifiedElement();
  if (
    !shapeSpecsEqual(beforeDigest.spec, afterDigest.spec) ||
    !shapeSpecsEqual(beforeDigest.spec, opts.expectedShape) ||
    observedShapeDigest !== opts.expectedShapeDigest ||
    afterDigest.element.clientEffectShapeDigest !== opts.expectedShapeDigest
  ) {
    throw new Error('CLIENT_EFFECT_SHAPE_MISMATCH');
  }

  return {
    stableElementId: opts.stableElementId,
    elementType: 'shape',
    normalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
    observedShapeDigest,
    matchingElementCount: 1,
    ...beforeDigest.spec,
  };
}

export async function executeNativeWhiteboardShapeEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  input: NativeWbDrawShapeInput;
  expectedShape: WhiteboardShapeSpec;
  expectedShapeDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult<NativeWhiteboardShapePostconditionResult>> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.input.executionId !== 'string' ||
    !opts.input.executionId.trim() ||
    typeof opts.input.stableElementId !== 'string' ||
    !opts.input.stableElementId.trim()
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  const inputShape = normalizeWhiteboardShapeV1(opts.input);
  const requestShape = normalizeWhiteboardShapeV1({
    shape: opts.expectedShape.shape,
    ...opts.expectedShape.bounds,
    fillColor: opts.expectedShape.fillColor,
  });
  const inputDigest = await digestWhiteboardShapeV1(inputShape);
  throwIfAborted(opts.signal);
  if (
    !shapeSpecsEqual(inputShape, requestShape) ||
    inputDigest !== opts.expectedShapeDigest ||
    (await digestWhiteboardShapeV1(requestShape)) !== opts.expectedShapeDigest
  ) {
    throw new Error('CLIENT_EFFECT_REQUEST_SHAPE_MISMATCH');
  }

  assertStageAndScene(opts.store, opts.targetBinding);
  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const elementsResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const existing = elementsResult.data.filter(
    (element) => element.id === opts.input.stableElementId,
  );
  if (existing.length > 1) throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  if (existing.length === 1) {
    const postcondition = await verifyNativeWhiteboardShapeEffect({
      store: opts.store,
      targetBinding: opts.targetBinding,
      executionId: opts.input.executionId,
      stableElementId: opts.input.stableElementId,
      expectedShape: requestShape,
      expectedShapeDigest: opts.expectedShapeDigest,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { replayed: true, postcondition };
  }

  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const addResult = whiteboardApi.addElement(
    {
      id: opts.input.stableElementId,
      type: 'shape',
      viewBox: [1000, 1000] as [number, number],
      path: WHITEBOARD_SHAPE_PATHS[inputShape.shape],
      left: inputShape.bounds.x,
      top: inputShape.bounds.y,
      width: inputShape.bounds.width,
      height: inputShape.bounds.height,
      rotate: 0,
      fill: inputShape.fillColor,
      fixedRatio: false,
      clientEffectExecutionId: opts.input.executionId,
      clientEffectShapeDigest: opts.expectedShapeDigest,
      clientEffectShapeKind: inputShape.shape,
      clientEffectNormalizationVersion: CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
    } as NativeShapeElement,
    opts.targetBinding.whiteboardId,
  );
  if (!addResult.success) {
    throw new Error(addResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  throwIfAborted(opts.signal);

  const postcondition = await verifyNativeWhiteboardShapeEffect({
    store: opts.store,
    targetBinding: opts.targetBinding,
    executionId: opts.input.executionId,
    stableElementId: opts.input.stableElementId,
    expectedShape: requestShape,
    expectedShapeDigest: opts.expectedShapeDigest,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  return { replayed: false, postcondition };
}

export interface NativeWbDrawLineInput {
  executionId: string;
  stableElementId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color?: string;
  width?: number;
  style?: WhiteboardLineStyle;
  points?: [WhiteboardLineMarker, WhiteboardLineMarker];
}

function lineSpecFromElement(element: NativeLineElement): WhiteboardLineSpec {
  if (
    element.type !== 'line' ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    !Array.isArray(element.start) ||
    element.start.length !== 2 ||
    !Array.isArray(element.end) ||
    element.end.length !== 2 ||
    typeof element.color !== 'string' ||
    (element.style !== 'solid' && element.style !== 'dashed') ||
    !Array.isArray(element.points) ||
    element.points.length !== 2
  ) {
    throw new Error('CLIENT_EFFECT_LINE_ELEMENT_MISMATCH');
  }
  const endpoints = readAbsoluteWhiteboardLineEndpoints(element);
  return normalizeWhiteboardLineV1({
    ...endpoints,
    color: element.color,
    width: element.width,
    style: element.style,
    points: element.points,
  });
}

function lineSpecsEqual(left: WhiteboardLineSpec, right: WhiteboardLineSpec): boolean {
  return (
    left.start.x === right.start.x &&
    left.start.y === right.start.y &&
    left.end.x === right.end.x &&
    left.end.y === right.end.y &&
    left.strokeColor === right.strokeColor &&
    left.strokeWidth === right.strokeWidth &&
    left.strokeStyle === right.strokeStyle &&
    left.markers[0] === right.markers[0] &&
    left.markers[1] === right.markers[1]
  );
}

export async function verifyNativeWhiteboardLineEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedLine: WhiteboardLineSpec;
  expectedLineDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardLinePostconditionResult> {
  const readVerifiedElement = (): { element: NativeLineElement; spec: WhiteboardLineSpec } => {
    throwIfAborted(opts.signal);
    assertStageAndScene(opts.store, opts.targetBinding);
    const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
      opts.targetBinding.whiteboardId,
    );
    if (!elementsResult.success || !elementsResult.data) {
      throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
    }
    const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'CLIENT_EFFECT_ELEMENT_NOT_FOUND'
          : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
      );
    }
    const element = matches[0] as NativeLineElement;
    if (
      element.clientEffectExecutionId !== opts.executionId ||
      element.clientEffectNormalizationVersion !== CLIENT_EFFECT_LINE_NORMALIZATION_VERSION
    ) {
      throw new Error('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
    }
    return { element, spec: lineSpecFromElement(element) };
  };

  const beforeDigest = readVerifiedElement();
  const observedLineDigest = await digestWhiteboardLineV1(beforeDigest.spec);
  throwIfAborted(opts.signal);
  const afterDigest = readVerifiedElement();
  if (
    !lineSpecsEqual(beforeDigest.spec, afterDigest.spec) ||
    !lineSpecsEqual(beforeDigest.spec, opts.expectedLine) ||
    observedLineDigest !== opts.expectedLineDigest ||
    afterDigest.element.clientEffectLineDigest !== opts.expectedLineDigest
  ) {
    throw new Error('CLIENT_EFFECT_LINE_MISMATCH');
  }

  return {
    stableElementId: opts.stableElementId,
    elementType: 'line',
    normalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
    observedLineDigest,
    matchingElementCount: 1,
    ...beforeDigest.spec,
  };
}

export async function executeNativeWhiteboardLineEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  input: NativeWbDrawLineInput;
  expectedLine: WhiteboardLineSpec;
  expectedLineDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult<NativeWhiteboardLinePostconditionResult>> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.input.executionId !== 'string' ||
    !opts.input.executionId.trim() ||
    typeof opts.input.stableElementId !== 'string' ||
    !opts.input.stableElementId.trim()
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  const inputLine = normalizeWhiteboardLineV1(opts.input);
  const requestLine = normalizeWhiteboardLineV1({
    startX: opts.expectedLine.start.x,
    startY: opts.expectedLine.start.y,
    endX: opts.expectedLine.end.x,
    endY: opts.expectedLine.end.y,
    color: opts.expectedLine.strokeColor,
    width: opts.expectedLine.strokeWidth,
    style: opts.expectedLine.strokeStyle,
    points: opts.expectedLine.markers,
  });
  const inputDigest = await digestWhiteboardLineV1(inputLine);
  throwIfAborted(opts.signal);
  if (
    !lineSpecsEqual(inputLine, requestLine) ||
    inputDigest !== opts.expectedLineDigest ||
    (await digestWhiteboardLineV1(requestLine)) !== opts.expectedLineDigest
  ) {
    throw new Error('CLIENT_EFFECT_REQUEST_LINE_MISMATCH');
  }

  assertStageAndScene(opts.store, opts.targetBinding);
  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const elementsResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const existing = elementsResult.data.filter(
    (element) => element.id === opts.input.stableElementId,
  );
  if (existing.length > 1) throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  if (existing.length === 1) {
    const postcondition = await verifyNativeWhiteboardLineEffect({
      store: opts.store,
      targetBinding: opts.targetBinding,
      executionId: opts.input.executionId,
      stableElementId: opts.input.stableElementId,
      expectedLine: requestLine,
      expectedLineDigest: opts.expectedLineDigest,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { replayed: true, postcondition };
  }

  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const addResult = whiteboardApi.addElement(
    {
      ...createWhiteboardLineElement({
        id: opts.input.stableElementId,
        startX: inputLine.start.x,
        startY: inputLine.start.y,
        endX: inputLine.end.x,
        endY: inputLine.end.y,
        color: inputLine.strokeColor,
        width: inputLine.strokeWidth,
        style: inputLine.strokeStyle,
        points: inputLine.markers,
      }),
      clientEffectExecutionId: opts.input.executionId,
      clientEffectLineDigest: opts.expectedLineDigest,
      clientEffectNormalizationVersion: CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
    } as NativeLineElement,
    opts.targetBinding.whiteboardId,
  );
  if (!addResult.success) {
    throw new Error(addResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  throwIfAborted(opts.signal);

  const postcondition = await verifyNativeWhiteboardLineEffect({
    store: opts.store,
    targetBinding: opts.targetBinding,
    executionId: opts.input.executionId,
    stableElementId: opts.input.stableElementId,
    expectedLine: requestLine,
    expectedLineDigest: opts.expectedLineDigest,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  return { replayed: false, postcondition };
}

export interface NativeWbDrawLatexInput {
  executionId: string;
  stableElementId: string;
  latex: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
}

function latexSpecFromElement(element: NativeLatexElement): {
  spec: WhiteboardLatexSpec;
  html: string;
} {
  if (
    element.type !== 'latex' ||
    typeof element.latex !== 'string' ||
    typeof element.html !== 'string' ||
    !element.html ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    typeof element.height !== 'number' ||
    typeof element.color !== 'string' ||
    element.rotate !== 0 ||
    element.fixedRatio !== true ||
    element.clientEffectRenderVersion !== CLIENT_EFFECT_LATEX_RENDER_VERSION
  ) {
    throw new Error('CLIENT_EFFECT_LATEX_ELEMENT_MISMATCH');
  }
  return {
    spec: normalizeWhiteboardLatexV1({
      latex: element.latex,
      x: element.left,
      y: element.top,
      width: element.width,
      height: element.height,
      color: element.color,
    }),
    html: element.html,
  };
}

function latexSpecsEqual(left: WhiteboardLatexSpec, right: WhiteboardLatexSpec): boolean {
  return (
    left.latex === right.latex &&
    left.bounds.x === right.bounds.x &&
    left.bounds.y === right.bounds.y &&
    left.bounds.width === right.bounds.width &&
    left.bounds.height === right.bounds.height &&
    left.color === right.color &&
    left.renderVersion === right.renderVersion
  );
}

export async function verifyNativeWhiteboardLatexEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedLatex: WhiteboardLatexSpec;
  expectedFormulaDigest: string;
  expectedHtmlDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardLatexPostconditionResult> {
  const readVerifiedElement = (): {
    element: NativeLatexElement;
    spec: WhiteboardLatexSpec;
    html: string;
  } => {
    throwIfAborted(opts.signal);
    assertStageAndScene(opts.store, opts.targetBinding);
    const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
      opts.targetBinding.whiteboardId,
    );
    if (!elementsResult.success || !elementsResult.data) {
      throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
    }
    const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'CLIENT_EFFECT_ELEMENT_NOT_FOUND'
          : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
      );
    }
    const element = matches[0] as NativeLatexElement;
    if (
      element.clientEffectExecutionId !== opts.executionId ||
      element.clientEffectNormalizationVersion !== CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION
    ) {
      throw new Error('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
    }
    return { element, ...latexSpecFromElement(element) };
  };

  const beforeDigest = readVerifiedElement();
  const observedFormulaDigest = await digestWhiteboardLatexV1(beforeDigest.spec);
  const observedHtmlDigest = await digestWhiteboardLatexHtmlV1(beforeDigest.html);
  throwIfAborted(opts.signal);
  const afterDigest = readVerifiedElement();
  if (
    !latexSpecsEqual(beforeDigest.spec, afterDigest.spec) ||
    beforeDigest.html !== afterDigest.html ||
    !latexSpecsEqual(beforeDigest.spec, opts.expectedLatex) ||
    beforeDigest.html !== renderNativeWhiteboardLatexHtmlV1(beforeDigest.spec.latex) ||
    observedFormulaDigest !== opts.expectedFormulaDigest ||
    observedHtmlDigest !== opts.expectedHtmlDigest ||
    afterDigest.element.clientEffectFormulaDigest !== opts.expectedFormulaDigest ||
    afterDigest.element.clientEffectHtmlDigest !== opts.expectedHtmlDigest
  ) {
    throw new Error('CLIENT_EFFECT_LATEX_MISMATCH');
  }

  return {
    stableElementId: opts.stableElementId,
    elementType: 'latex',
    normalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
    observedFormulaDigest,
    observedHtmlDigest,
    matchingElementCount: 1,
    ...beforeDigest.spec,
  };
}

export async function executeNativeWhiteboardLatexEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  input: NativeWbDrawLatexInput;
  expectedLatex: WhiteboardLatexSpec;
  expectedFormulaDigest: string;
  expectedHtmlDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult<NativeWhiteboardLatexPostconditionResult>> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.input.executionId !== 'string' ||
    !opts.input.executionId.trim() ||
    typeof opts.input.stableElementId !== 'string' ||
    !opts.input.stableElementId.trim()
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  const inputLatex = normalizeWhiteboardLatexV1(opts.input);
  const requestLatex = normalizeWhiteboardLatexV1({
    latex: opts.expectedLatex.latex,
    ...opts.expectedLatex.bounds,
    color: opts.expectedLatex.color,
  });
  const inputHtml = renderNativeWhiteboardLatexHtmlV1(inputLatex.latex);
  const inputFormulaDigest = await digestWhiteboardLatexV1(inputLatex);
  const inputHtmlDigest = await digestWhiteboardLatexHtmlV1(inputHtml);
  throwIfAborted(opts.signal);
  if (
    !latexSpecsEqual(inputLatex, requestLatex) ||
    inputFormulaDigest !== opts.expectedFormulaDigest ||
    inputHtmlDigest !== opts.expectedHtmlDigest ||
    (await digestWhiteboardLatexV1(requestLatex)) !== opts.expectedFormulaDigest ||
    (await digestWhiteboardLatexHtmlV1(renderNativeWhiteboardLatexHtmlV1(requestLatex.latex))) !==
      opts.expectedHtmlDigest
  ) {
    throw new Error('CLIENT_EFFECT_REQUEST_LATEX_MISMATCH');
  }

  assertStageAndScene(opts.store, opts.targetBinding);
  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const elementsResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const existing = elementsResult.data.filter(
    (element) => element.id === opts.input.stableElementId,
  );
  if (existing.length > 1) throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  if (existing.length === 1) {
    const postcondition = await verifyNativeWhiteboardLatexEffect({
      store: opts.store,
      targetBinding: opts.targetBinding,
      executionId: opts.input.executionId,
      stableElementId: opts.input.stableElementId,
      expectedLatex: requestLatex,
      expectedFormulaDigest: opts.expectedFormulaDigest,
      expectedHtmlDigest: opts.expectedHtmlDigest,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { replayed: true, postcondition };
  }

  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const addResult = whiteboardApi.addElement(
    {
      ...createWhiteboardLatexElement({
        id: opts.input.stableElementId,
        latex: inputLatex.latex,
        x: inputLatex.bounds.x,
        y: inputLatex.bounds.y,
        width: inputLatex.bounds.width,
        height: inputLatex.bounds.height,
        color: inputLatex.color,
        html: inputHtml,
      }),
      clientEffectExecutionId: opts.input.executionId,
      clientEffectFormulaDigest: opts.expectedFormulaDigest,
      clientEffectHtmlDigest: opts.expectedHtmlDigest,
      clientEffectNormalizationVersion: CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
      clientEffectRenderVersion: CLIENT_EFFECT_LATEX_RENDER_VERSION,
    } as NativeLatexElement,
    opts.targetBinding.whiteboardId,
  );
  if (!addResult.success) {
    throw new Error(addResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  throwIfAborted(opts.signal);

  const postcondition = await verifyNativeWhiteboardLatexEffect({
    store: opts.store,
    targetBinding: opts.targetBinding,
    executionId: opts.input.executionId,
    stableElementId: opts.input.stableElementId,
    expectedLatex: requestLatex,
    expectedFormulaDigest: opts.expectedFormulaDigest,
    expectedHtmlDigest: opts.expectedHtmlDigest,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  return { replayed: false, postcondition };
}

export interface NativeWbDrawTableInput {
  executionId: string;
  stableElementId: string;
  data: string[][];
  x: number;
  y: number;
  width: number;
  height: number;
  outline?: WhiteboardTableOutline;
  theme?: { color: string };
}

export interface NativeWhiteboardTablePostconditionResult {
  stableElementId: string;
  elementType: 'table';
  normalizationVersion: typeof CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION;
  observedTableDigest: string;
  matchingElementCount: 1;
}

function tableSpecFromElement(element: NativeTableElement): WhiteboardTableSpec {
  if (
    element.type !== 'table' ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    typeof element.height !== 'number' ||
    element.rotate !== 0 ||
    element.rowHeights !== undefined ||
    !Array.isArray(element.data) ||
    element.data.length === 0 ||
    !Array.isArray(element.data[0]) ||
    element.data[0].length === 0 ||
    !Array.isArray(element.colWidths) ||
    element.cellMinHeight !== 36 ||
    !element.outline ||
    typeof element.outline.width !== 'number' ||
    (element.outline.style !== 'solid' && element.outline.style !== 'dashed') ||
    typeof element.outline.color !== 'string'
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_ELEMENT_MISMATCH');
  }
  let cellId = 0;
  const data = element.data.map((row) =>
    row.map((cell) => {
      if (
        cell.id !== `cell_${cellId++}` ||
        cell.colspan !== 1 ||
        cell.rowspan !== 1 ||
        typeof cell.text !== 'string' ||
        cell.style !== undefined ||
        cell.padding !== undefined ||
        cell.vAlign !== undefined ||
        cell.borders !== undefined
      ) {
        throw new Error('CLIENT_EFFECT_TABLE_ELEMENT_MISMATCH');
      }
      return cell.text;
    }),
  );
  return assertWhiteboardTableSpecV1({
    data,
    bounds: {
      x: element.left,
      y: element.top,
      width: element.width,
      height: element.height,
    },
    outline: {
      width: element.outline.width,
      style: element.outline.style,
      color: element.outline.color,
    },
    ...(element.theme
      ? {
          theme: {
            color: element.theme.color,
            rowHeader: element.theme.rowHeader as true,
            rowFooter: element.theme.rowFooter as false,
            colHeader: element.theme.colHeader as false,
            colFooter: element.theme.colFooter as false,
          },
        }
      : {}),
    colWidths: [...element.colWidths],
    cellMinHeight: 36,
  });
}

export async function verifyNativeWhiteboardTableEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedTable: WhiteboardTableSpec;
  expectedTableDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardTablePostconditionResult> {
  const readVerifiedElement = (): { element: NativeTableElement; spec: WhiteboardTableSpec } => {
    throwIfAborted(opts.signal);
    assertStageAndScene(opts.store, opts.targetBinding);
    const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
      opts.targetBinding.whiteboardId,
    );
    if (!elementsResult.success || !elementsResult.data) {
      throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
    }
    const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'CLIENT_EFFECT_ELEMENT_NOT_FOUND'
          : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
      );
    }
    const element = matches[0] as NativeTableElement;
    if (
      element.clientEffectExecutionId !== opts.executionId ||
      element.clientEffectNormalizationVersion !== CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION
    ) {
      throw new Error('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
    }
    return { element, spec: tableSpecFromElement(element) };
  };

  const beforeDigest = readVerifiedElement();
  const observedTableDigest = await digestWhiteboardTableV1(beforeDigest.spec);
  throwIfAborted(opts.signal);
  const afterDigest = readVerifiedElement();
  if (
    !whiteboardTableSpecsEqual(beforeDigest.spec, afterDigest.spec) ||
    !whiteboardTableSpecsEqual(beforeDigest.spec, opts.expectedTable) ||
    observedTableDigest !== opts.expectedTableDigest ||
    afterDigest.element.clientEffectTableDigest !== opts.expectedTableDigest
  ) {
    throw new Error('CLIENT_EFFECT_TABLE_MISMATCH');
  }

  return {
    stableElementId: opts.stableElementId,
    elementType: 'table',
    normalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
    observedTableDigest,
    matchingElementCount: 1,
  };
}

export async function executeNativeWhiteboardTableEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  input: NativeWbDrawTableInput;
  expectedTable: WhiteboardTableSpec;
  expectedTableDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult<NativeWhiteboardTablePostconditionResult>> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.input.executionId !== 'string' ||
    !opts.input.executionId.trim() ||
    typeof opts.input.stableElementId !== 'string' ||
    !opts.input.stableElementId.trim()
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  const inputTable = normalizeWhiteboardTableV1(opts.input);
  const requestTable = assertWhiteboardTableSpecV1(opts.expectedTable);
  const inputDigest = await digestWhiteboardTableV1(inputTable);
  throwIfAborted(opts.signal);
  if (
    !whiteboardTableSpecsEqual(inputTable, requestTable) ||
    inputDigest !== opts.expectedTableDigest ||
    (await digestWhiteboardTableV1(requestTable)) !== opts.expectedTableDigest
  ) {
    throw new Error('CLIENT_EFFECT_REQUEST_TABLE_MISMATCH');
  }

  assertStageAndScene(opts.store, opts.targetBinding);
  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const elementsResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const existing = elementsResult.data.filter(
    (element) => element.id === opts.input.stableElementId,
  );
  if (existing.length > 1) throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  if (existing.length === 1) {
    const postcondition = await verifyNativeWhiteboardTableEffect({
      store: opts.store,
      targetBinding: opts.targetBinding,
      executionId: opts.input.executionId,
      stableElementId: opts.input.stableElementId,
      expectedTable: requestTable,
      expectedTableDigest: opts.expectedTableDigest,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { replayed: true, postcondition };
  }

  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const element = createWhiteboardTableElement({
    id: opts.input.stableElementId,
    x: inputTable.bounds.x,
    y: inputTable.bounds.y,
    width: inputTable.bounds.width,
    height: inputTable.bounds.height,
    data: inputTable.data,
    outline: inputTable.outline,
    theme: inputTable.theme ? { color: inputTable.theme.color } : undefined,
  });
  if (!element) throw new Error('CLIENT_EFFECT_TABLE_INPUT_INVALID');
  const addResult = whiteboardApi.addElement(
    {
      ...element,
      clientEffectExecutionId: opts.input.executionId,
      clientEffectTableDigest: opts.expectedTableDigest,
      clientEffectNormalizationVersion: CLIENT_EFFECT_TABLE_NORMALIZATION_VERSION,
    } as NativeTableElement,
    opts.targetBinding.whiteboardId,
  );
  if (!addResult.success) {
    throw new Error(addResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  throwIfAborted(opts.signal);

  const postcondition = await verifyNativeWhiteboardTableEffect({
    store: opts.store,
    targetBinding: opts.targetBinding,
    executionId: opts.input.executionId,
    stableElementId: opts.input.stableElementId,
    expectedTable: requestTable,
    expectedTableDigest: opts.expectedTableDigest,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  return { replayed: false, postcondition };
}

export interface NativeWbDrawChartInput {
  executionId: string;
  stableElementId: string;
  chartType: ChartType;
  x: number;
  y: number;
  width: number;
  height: number;
  data: ChartData;
  themeColors?: string[];
}

export interface NativeWhiteboardChartPostconditionResult {
  stableElementId: string;
  elementType: 'chart';
  normalizationVersion: typeof CLIENT_EFFECT_CHART_NORMALIZATION_VERSION;
  observedChartDigest: string;
  matchingElementCount: 1;
}

function chartSpecFromElement(element: NativeChartElement): WhiteboardChartSpec {
  if (
    element.type !== 'chart' ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    typeof element.height !== 'number' ||
    element.rotate !== 0 ||
    element.fill !== undefined ||
    element.options !== undefined ||
    element.outline !== undefined ||
    element.textColor !== undefined ||
    element.lineColor !== undefined
  ) {
    throw new Error('CLIENT_EFFECT_CHART_ELEMENT_MISMATCH');
  }
  return assertWhiteboardChartSpecV1({
    chartType: element.chartType,
    data: element.data,
    bounds: {
      x: element.left,
      y: element.top,
      width: element.width,
      height: element.height,
    },
    themeColors: element.themeColors,
    rotate: 0,
  });
}

export async function verifyNativeWhiteboardChartEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedChart: WhiteboardChartSpec;
  expectedChartDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardChartPostconditionResult> {
  const readVerifiedElement = (): { element: NativeChartElement; spec: WhiteboardChartSpec } => {
    throwIfAborted(opts.signal);
    assertStageAndScene(opts.store, opts.targetBinding);
    const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
      opts.targetBinding.whiteboardId,
    );
    if (!elementsResult.success || !elementsResult.data) {
      throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
    }
    const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'CLIENT_EFFECT_ELEMENT_NOT_FOUND'
          : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
      );
    }
    const element = matches[0] as NativeChartElement;
    if (
      element.clientEffectExecutionId !== opts.executionId ||
      element.clientEffectNormalizationVersion !== CLIENT_EFFECT_CHART_NORMALIZATION_VERSION
    ) {
      throw new Error('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
    }
    return { element, spec: chartSpecFromElement(element) };
  };

  const beforeDigest = readVerifiedElement();
  const observedChartDigest = await digestWhiteboardChartV1(beforeDigest.spec);
  throwIfAborted(opts.signal);
  const afterDigest = readVerifiedElement();
  if (
    !whiteboardChartSpecsEqual(beforeDigest.spec, afterDigest.spec) ||
    !whiteboardChartSpecsEqual(beforeDigest.spec, opts.expectedChart) ||
    observedChartDigest !== opts.expectedChartDigest ||
    afterDigest.element.clientEffectChartDigest !== opts.expectedChartDigest
  ) {
    throw new Error('CLIENT_EFFECT_CHART_MISMATCH');
  }

  return {
    stableElementId: opts.stableElementId,
    elementType: 'chart',
    normalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
    observedChartDigest,
    matchingElementCount: 1,
  };
}

export async function executeNativeWhiteboardChartEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  input: NativeWbDrawChartInput;
  expectedChart: WhiteboardChartSpec;
  expectedChartDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult<NativeWhiteboardChartPostconditionResult>> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.input.executionId !== 'string' ||
    !opts.input.executionId.trim() ||
    typeof opts.input.stableElementId !== 'string' ||
    !opts.input.stableElementId.trim()
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  const inputChart = normalizeWhiteboardChartV1(opts.input);
  const requestChart = assertWhiteboardChartSpecV1(opts.expectedChart);
  const inputDigest = await digestWhiteboardChartV1(inputChart);
  throwIfAborted(opts.signal);
  if (
    !whiteboardChartSpecsEqual(inputChart, requestChart) ||
    inputDigest !== opts.expectedChartDigest ||
    (await digestWhiteboardChartV1(requestChart)) !== opts.expectedChartDigest
  ) {
    throw new Error('CLIENT_EFFECT_REQUEST_CHART_MISMATCH');
  }

  assertStageAndScene(opts.store, opts.targetBinding);
  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const elementsResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const existing = elementsResult.data.filter(
    (element) => element.id === opts.input.stableElementId,
  );
  if (existing.length > 1) throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  if (existing.length === 1) {
    const postcondition = await verifyNativeWhiteboardChartEffect({
      store: opts.store,
      targetBinding: opts.targetBinding,
      executionId: opts.input.executionId,
      stableElementId: opts.input.stableElementId,
      expectedChart: requestChart,
      expectedChartDigest: opts.expectedChartDigest,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { replayed: true, postcondition };
  }

  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const element = createWhiteboardChartElement({
    id: opts.input.stableElementId,
    chartType: inputChart.chartType,
    x: inputChart.bounds.x,
    y: inputChart.bounds.y,
    width: inputChart.bounds.width,
    height: inputChart.bounds.height,
    data: inputChart.data,
    themeColors: inputChart.themeColors,
  });
  const addResult = whiteboardApi.addElement(
    {
      ...element,
      clientEffectExecutionId: opts.input.executionId,
      clientEffectChartDigest: opts.expectedChartDigest,
      clientEffectNormalizationVersion: CLIENT_EFFECT_CHART_NORMALIZATION_VERSION,
    } as NativeChartElement,
    opts.targetBinding.whiteboardId,
  );
  if (!addResult.success) {
    throw new Error(addResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  throwIfAborted(opts.signal);

  const postcondition = await verifyNativeWhiteboardChartEffect({
    store: opts.store,
    targetBinding: opts.targetBinding,
    executionId: opts.input.executionId,
    stableElementId: opts.input.stableElementId,
    expectedChart: requestChart,
    expectedChartDigest: opts.expectedChartDigest,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  return { replayed: false, postcondition };
}

export interface NativeWbDrawCodeInput {
  executionId: string;
  stableElementId: string;
  language: string;
  code: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fileName?: string;
}

export interface NativeWhiteboardCodePostconditionResult {
  stableElementId: string;
  elementType: 'code';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_NORMALIZATION_VERSION;
  observedCodeDigest: string;
  matchingElementCount: 1;
}

function codeSpecFromElement(element: NativeCodeElement): WhiteboardCodeSpec {
  if (
    element.type !== 'code' ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    typeof element.height !== 'number' ||
    element.rotate !== 0 ||
    element.showLineNumbers !== true ||
    element.fontSize !== 14 ||
    !Array.isArray(element.lines)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_ELEMENT_MISMATCH');
  }
  return assertWhiteboardCodeSpecV1({
    language: element.language,
    lines: element.lines,
    ...(element.fileName !== undefined ? { fileName: element.fileName } : {}),
    bounds: {
      x: element.left,
      y: element.top,
      width: element.width,
      height: element.height,
    },
    showLineNumbers: true,
    fontSize: 14,
    rotate: 0,
  });
}

export async function verifyNativeWhiteboardCodeEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedCode: WhiteboardCodeSpec;
  expectedCodeDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardCodePostconditionResult> {
  const readVerifiedElement = (): { element: NativeCodeElement; spec: WhiteboardCodeSpec } => {
    throwIfAborted(opts.signal);
    assertStageAndScene(opts.store, opts.targetBinding);
    const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
      opts.targetBinding.whiteboardId,
    );
    if (!elementsResult.success || !elementsResult.data) {
      throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
    }
    const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'CLIENT_EFFECT_ELEMENT_NOT_FOUND'
          : 'CLIENT_EFFECT_DUPLICATE_ELEMENT_ID',
      );
    }
    const element = matches[0] as NativeCodeElement;
    if (
      element.clientEffectExecutionId !== opts.executionId ||
      element.clientEffectNormalizationVersion !== CLIENT_EFFECT_CODE_NORMALIZATION_VERSION
    ) {
      throw new Error('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
    }
    return { element, spec: codeSpecFromElement(element) };
  };

  const beforeDigest = readVerifiedElement();
  const observedCodeDigest = await digestWhiteboardCodeV1(beforeDigest.spec);
  throwIfAborted(opts.signal);
  const afterDigest = readVerifiedElement();
  if (
    !whiteboardCodeSpecsEqual(beforeDigest.spec, afterDigest.spec) ||
    !whiteboardCodeSpecsEqual(beforeDigest.spec, opts.expectedCode) ||
    observedCodeDigest !== opts.expectedCodeDigest ||
    afterDigest.element.clientEffectCodeDigest !== opts.expectedCodeDigest
  ) {
    throw new Error('CLIENT_EFFECT_CODE_MISMATCH');
  }

  return {
    stableElementId: opts.stableElementId,
    elementType: 'code',
    normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
    observedCodeDigest,
    matchingElementCount: 1,
  };
}

export async function executeNativeWhiteboardCodeEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  input: NativeWbDrawCodeInput;
  expectedCode: WhiteboardCodeSpec;
  expectedCodeDigest: string;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult<NativeWhiteboardCodePostconditionResult>> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.input.executionId !== 'string' ||
    !opts.input.executionId.trim() ||
    typeof opts.input.stableElementId !== 'string' ||
    !opts.input.stableElementId.trim()
  ) {
    throw new Error('CLIENT_EFFECT_INPUT_INVALID');
  }
  const inputCode = normalizeWhiteboardCodeV1(opts.input);
  const requestCode = assertWhiteboardCodeSpecV1(opts.expectedCode);
  const inputDigest = await digestWhiteboardCodeV1(inputCode);
  throwIfAborted(opts.signal);
  if (
    !whiteboardCodeSpecsEqual(inputCode, requestCode) ||
    inputDigest !== opts.expectedCodeDigest ||
    (await digestWhiteboardCodeV1(requestCode)) !== opts.expectedCodeDigest
  ) {
    throw new Error('CLIENT_EFFECT_REQUEST_CODE_MISMATCH');
  }

  assertStageAndScene(opts.store, opts.targetBinding);
  const whiteboardApi = createStageAPI(opts.store).whiteboard;
  const elementsResult = whiteboardApi.listElements(opts.targetBinding.whiteboardId);
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_WHITEBOARD_NOT_FOUND');
  }
  const existing = elementsResult.data.filter(
    (element) => element.id === opts.input.stableElementId,
  );
  if (existing.length > 1) throw new Error('CLIENT_EFFECT_DUPLICATE_ELEMENT_ID');
  if (existing.length === 1) {
    const postcondition = await verifyNativeWhiteboardCodeEffect({
      store: opts.store,
      targetBinding: opts.targetBinding,
      executionId: opts.input.executionId,
      stableElementId: opts.input.stableElementId,
      expectedCode: requestCode,
      expectedCodeDigest: opts.expectedCodeDigest,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    return { replayed: true, postcondition };
  }

  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  const element = createWhiteboardCodeElement({
    id: opts.input.stableElementId,
    language: inputCode.language,
    code: inputCode.lines.map((line) => line.content).join('\n'),
    lineIds: inputCode.lines.map((line) => line.id),
    x: inputCode.bounds.x,
    y: inputCode.bounds.y,
    width: inputCode.bounds.width,
    height: inputCode.bounds.height,
    fileName: inputCode.fileName,
  });
  const addResult = whiteboardApi.addElement(
    {
      ...element,
      clientEffectExecutionId: opts.input.executionId,
      clientEffectCodeDigest: opts.expectedCodeDigest,
      clientEffectNormalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
    } as NativeCodeElement,
    opts.targetBinding.whiteboardId,
  );
  if (!addResult.success) {
    throw new Error(addResult.error || 'CLIENT_EFFECT_WHITEBOARD_MUTATION_FAILED');
  }
  throwIfAborted(opts.signal);

  const postcondition = await verifyNativeWhiteboardCodeEffect({
    store: opts.store,
    targetBinding: opts.targetBinding,
    executionId: opts.input.executionId,
    stableElementId: opts.input.stableElementId,
    expectedCode: requestCode,
    expectedCodeDigest: opts.expectedCodeDigest,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  return { replayed: false, postcondition };
}

export interface NativeWhiteboardCodeEditPostconditionResult {
  stableElementId: string;
  elementType: 'code';
  normalizationVersion: typeof CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION;
  expectedWhiteboardId: string;
  observedBeforeCodeDigest: string;
  observedAfterCodeDigest: string;
  matchingElementCount: 1;
  noOp: boolean;
}

function editableCodeStateFromElement(element: NativeCodeElement): WhiteboardEditableCodeState {
  if (
    element.type !== 'code' ||
    typeof element.left !== 'number' ||
    typeof element.top !== 'number' ||
    typeof element.width !== 'number' ||
    typeof element.height !== 'number' ||
    !Array.isArray(element.lines)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_ELEMENT_MISMATCH');
  }
  return assertWhiteboardEditableCodeStateV1({
    language: element.language,
    lines: element.lines,
    ...(element.fileName !== undefined ? { fileName: element.fileName } : {}),
    bounds: {
      x: element.left,
      y: element.top,
      width: element.width,
      height: element.height,
    },
    showLineNumbers: element.showLineNumbers ?? true,
    fontSize: element.fontSize ?? 14,
    rotate: element.rotate,
  });
}

function readEditableCodeElement(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  stableElementId: string;
  expectedWhiteboardId: string;
  signal?: AbortSignal;
}): { element: NativeCodeElement; state: WhiteboardEditableCodeState } {
  throwIfAborted(opts.signal);
  assertStageAndScene(opts.store, opts.targetBinding);
  if (opts.targetBinding.whiteboardId !== opts.expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_MISMATCH');
  }
  const latestWhiteboard = getActiveWhiteboardForStore(opts.store);
  if (!latestWhiteboard || latestWhiteboard.id !== opts.expectedWhiteboardId) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_MISMATCH');
  }
  const elementsResult = createStageAPI(opts.store).whiteboard.listElements(
    opts.expectedWhiteboardId,
  );
  if (!elementsResult.success || !elementsResult.data) {
    throw new Error(elementsResult.error || 'CLIENT_EFFECT_CODE_EDIT_WHITEBOARD_NOT_FOUND');
  }
  const matches = elementsResult.data.filter((element) => element.id === opts.stableElementId);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'CLIENT_EFFECT_CODE_EDIT_ELEMENT_NOT_FOUND'
        : 'CLIENT_EFFECT_CODE_EDIT_DUPLICATE_ELEMENT_ID',
    );
  }
  const element = matches[0] as NativeCodeElement;
  if (element.type !== 'code') throw new Error('CLIENT_EFFECT_CODE_EDIT_ELEMENT_TYPE_MISMATCH');
  return { element, state: editableCodeStateFromElement(element) };
}

export async function executeNativeWhiteboardCodeEditEffect(opts: {
  store: StageStore;
  targetBinding: AcceptedTargetBinding;
  executionId: string;
  stableElementId: string;
  expectedWhiteboardId: string;
  expectedBeforeCodeDigest: string;
  expectedAfterCodeState: WhiteboardEditableCodeState;
  expectedAfterCodeDigest: string;
  noOp: boolean;
  signal?: AbortSignal;
}): Promise<NativeWhiteboardExecutionResult<NativeWhiteboardCodeEditPostconditionResult>> {
  throwIfAborted(opts.signal);
  if (
    typeof opts.executionId !== 'string' ||
    !opts.executionId ||
    typeof opts.stableElementId !== 'string' ||
    !opts.stableElementId ||
    typeof opts.expectedWhiteboardId !== 'string' ||
    !opts.expectedWhiteboardId ||
    typeof opts.expectedBeforeCodeDigest !== 'string' ||
    !opts.expectedBeforeCodeDigest ||
    typeof opts.expectedAfterCodeDigest !== 'string' ||
    !opts.expectedAfterCodeDigest
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_INPUT_INVALID');
  }
  const expectedAfter = assertWhiteboardEditableCodeStateV1(opts.expectedAfterCodeState);
  if (
    (await digestWhiteboardEditableCodeStateV1(expectedAfter)) !== opts.expectedAfterCodeDigest ||
    opts.noOp !== (opts.expectedBeforeCodeDigest === opts.expectedAfterCodeDigest)
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_AFTER_STATE_MISMATCH');
  }

  const first = readEditableCodeElement(opts);
  const firstDigest = await digestWhiteboardEditableCodeStateV1(first.state);
  throwIfAborted(opts.signal);
  const second = readEditableCodeElement(opts);
  if (!whiteboardEditableCodeStatesEqual(first.state, second.state)) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_CONCURRENT_CHANGE');
  }

  const replayed =
    firstDigest === opts.expectedAfterCodeDigest &&
    second.element.clientEffectLastEditExecutionId === opts.executionId &&
    second.element.clientEffectLastEditBeforeDigest === opts.expectedBeforeCodeDigest &&
    second.element.clientEffectLastEditAfterDigest === opts.expectedAfterCodeDigest &&
    second.element.clientEffectEditNormalizationVersion ===
      CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION;

  if (!replayed) {
    if (
      firstDigest === opts.expectedAfterCodeDigest &&
      second.element.clientEffectLastEditExecutionId &&
      second.element.clientEffectLastEditExecutionId !== opts.executionId
    ) {
      throw new Error('CLIENT_EFFECT_CODE_EDIT_STALE_BEFORE_STATE');
    }
    if (firstDigest !== opts.expectedBeforeCodeDigest) {
      throw new Error('CLIENT_EFFECT_CODE_EDIT_STALE_BEFORE_STATE');
    }
    throwIfAborted(opts.signal);
    const updatedElement: NativeCodeElement = {
      ...second.element,
      language: expectedAfter.language,
      lines: expectedAfter.lines.map((line) => ({ ...line })),
      ...(expectedAfter.fileName !== undefined
        ? { fileName: expectedAfter.fileName }
        : { fileName: undefined }),
      left: expectedAfter.bounds.x,
      top: expectedAfter.bounds.y,
      width: expectedAfter.bounds.width,
      height: expectedAfter.bounds.height,
      showLineNumbers: expectedAfter.showLineNumbers,
      fontSize: expectedAfter.fontSize,
      rotate: expectedAfter.rotate,
      clientEffectLastEditExecutionId: opts.executionId,
      clientEffectLastEditBeforeDigest: opts.expectedBeforeCodeDigest,
      clientEffectLastEditAfterDigest: opts.expectedAfterCodeDigest,
      clientEffectEditNormalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
    };
    const updateResult = createStageAPI(opts.store).whiteboard.updateElement(
      updatedElement,
      opts.expectedWhiteboardId,
    );
    if (!updateResult.success) {
      throw new Error(updateResult.error || 'CLIENT_EFFECT_CODE_EDIT_MUTATION_FAILED');
    }
  }

  throwIfAborted(opts.signal);
  const afterFirst = readEditableCodeElement(opts);
  const observedAfterCodeDigest = await digestWhiteboardEditableCodeStateV1(afterFirst.state);
  throwIfAborted(opts.signal);
  const afterSecond = readEditableCodeElement(opts);
  if (
    !whiteboardEditableCodeStatesEqual(afterFirst.state, afterSecond.state) ||
    !whiteboardEditableCodeStatesEqual(afterFirst.state, expectedAfter) ||
    observedAfterCodeDigest !== opts.expectedAfterCodeDigest ||
    afterSecond.element.clientEffectLastEditExecutionId !== opts.executionId ||
    afterSecond.element.clientEffectLastEditBeforeDigest !== opts.expectedBeforeCodeDigest ||
    afterSecond.element.clientEffectLastEditAfterDigest !== opts.expectedAfterCodeDigest ||
    afterSecond.element.clientEffectEditNormalizationVersion !==
      CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION
  ) {
    throw new Error('CLIENT_EFFECT_CODE_EDIT_POSTCONDITION_MISMATCH');
  }

  return {
    replayed,
    postcondition: {
      stableElementId: opts.stableElementId,
      elementType: 'code',
      normalizationVersion: CLIENT_EFFECT_CODE_EDIT_NORMALIZATION_VERSION,
      expectedWhiteboardId: opts.expectedWhiteboardId,
      observedBeforeCodeDigest: opts.expectedBeforeCodeDigest,
      observedAfterCodeDigest,
      matchingElementCount: 1,
      noOp: opts.noOp,
    },
  };
}
