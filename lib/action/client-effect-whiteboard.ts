import { createStageAPI, type StageStore } from '@/lib/api/stage-api';
import {
  CLIENT_EFFECT_LINE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_NORMALIZATION_VERSION,
  CLIENT_EFFECT_LATEX_RENDER_VERSION,
  CLIENT_EFFECT_SHAPE_NORMALIZATION_VERSION,
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestWhiteboardLatexHtmlV1,
  digestWhiteboardLatexV1,
  digestWhiteboardLineV1,
  digestWhiteboardShapeV1,
  digestVisibleTextV1,
  normalizeWhiteboardLatexV1,
  normalizeWhiteboardLineV1,
  normalizeWhiteboardShapeV1,
  normalizeVisibleTextV1,
  type AcceptedTargetBinding,
  type ClientEffectTarget,
  type WhiteboardLatexSpec,
  type WhiteboardLineMarker,
  type WhiteboardLineSpec,
  type WhiteboardLineStyle,
  type WhiteboardShapeKind,
  type WhiteboardShapeSpec,
} from '@/lib/agent/runtime/client-effect-contract';
import type { PPTElement, PPTLatexElement, PPTLineElement } from '@openmaic/dsl';
import {
  createWhiteboardLineElement,
  readAbsoluteWhiteboardLineEndpoints,
} from './whiteboard-lines';
import {
  createWhiteboardLatexElement,
  renderNativeWhiteboardLatexHtmlV1,
} from './whiteboard-latex';
import { WHITEBOARD_SHAPE_PATHS } from './whiteboard-shapes';

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
