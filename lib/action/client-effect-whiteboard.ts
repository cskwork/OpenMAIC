import { createStageAPI, type StageStore } from '@/lib/api/stage-api';
import {
  CLIENT_EFFECT_TEXT_NORMALIZATION_VERSION,
  digestVisibleTextV1,
  normalizeVisibleTextV1,
  type AcceptedTargetBinding,
  type ClientEffectTarget,
} from '@/lib/agent/runtime/client-effect-contract';
import type { PPTElement } from '@openmaic/dsl';

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

export interface NativeWhiteboardExecutionResult {
  replayed: boolean;
  postcondition: NativeWhiteboardTextPostconditionResult;
}

type NativeTextElement = PPTElement & {
  clientEffectExecutionId?: string;
  clientEffectContentDigest?: string;
  clientEffectNormalizationVersion?: string;
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
