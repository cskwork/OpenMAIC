import { describe, expect, it } from 'vitest';
import type { PPTCodeElement } from '@openmaic/dsl';
import {
  executeNativeWhiteboardCodeEffect,
  prepareNativeWhiteboardTarget,
  verifyNativeWhiteboardCodeEffect,
  type NativeWbDrawCodeInput,
} from '@/lib/action/client-effect-whiteboard';
import { createWhiteboardCodeElement } from '@/lib/action/whiteboard-code';
import {
  CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
  digestWhiteboardCodeV1,
  normalizeWhiteboardCodeV1,
} from '@/lib/agent/runtime/client-effect-contract';
import type { StageStore } from '@/lib/api/stage-api';

function createStore(): StageStore {
  let state = {
    stage: {
      id: 'stage-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [],
    },
    scenes: [{ id: 'scene-1' }, { id: 'scene-2' }],
    currentSceneId: 'scene-1',
    mode: 'playback' as const,
  };
  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
  } as unknown as StageStore;
}

const target = {
  requestId: 'request-1',
  sessionId: 'session-1',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  messageId: 'message-1',
};

const input: NativeWbDrawCodeInput = {
  executionId: 'execution-code-1',
  stableElementId: 'code-1',
  language: 'ts',
  code: 'const slope = 2;\r\n\r\nconsole.log(slope);\r\n',
  x: 80,
  y: 60,
  width: 600,
  height: 300,
  fileName: '  example.ts  ',
};

async function expectedCode(codeInput: NativeWbDrawCodeInput = input) {
  const code = normalizeWhiteboardCodeV1(codeInput);
  return { code, digest: await digestWhiteboardCodeV1(code) };
}

describe('native wb_draw_code client effect', () => {
  it('creates the exact Legacy code element shape with stable supplied line IDs', () => {
    expect(
      createWhiteboardCodeElement({
        id: 'legacy-code',
        language: 'python',
        code: 'def f():\n    return 1',
        lineIds: ['A1', 'A2'],
        x: 10,
        y: 20,
        fileName: 'main.py',
      }),
    ).toEqual({
      id: 'legacy-code',
      type: 'code',
      language: 'python',
      lines: [
        { id: 'A1', content: 'def f():' },
        { id: 'A2', content: '    return 1' },
      ],
      fileName: 'main.py',
      showLineNumbers: true,
      fontSize: 14,
      left: 10,
      top: 20,
      width: 500,
      height: 300,
      rotate: 0,
    });
  });

  it('normalizes aliases and newlines while preserving indentation and trailing blank lines', async () => {
    const first = normalizeWhiteboardCodeV1(input);
    const second = normalizeWhiteboardCodeV1({
      ...input,
      language: 'typescript',
      code: 'const slope = 2;\n\nconsole.log(slope);\n',
      fileName: 'example.ts',
    });

    expect(first).toEqual({
      language: 'typescript',
      lines: [
        { id: 'L1', content: 'const slope = 2;' },
        { id: 'L2', content: '' },
        { id: 'L3', content: 'console.log(slope);' },
        { id: 'L4', content: '' },
      ],
      fileName: 'example.ts',
      bounds: { x: 80, y: 60, width: 600, height: 300 },
      showLineNumbers: true,
      fontSize: 14,
      rotate: 0,
    });
    await expect(digestWhiteboardCodeV1(first)).resolves.toBe(await digestWhiteboardCodeV1(second));
  });

  it.each([
    ['js', 'javascript'],
    ['py', 'python'],
    ['sh', 'bash'],
    ['yml', 'yaml'],
    ['md', 'markdown'],
    ['c++', 'cpp'],
    ['cobol', 'cobol'],
  ])('canonicalizes language %s to %s while preserving safe unknown IDs', (language, expected) => {
    expect(normalizeWhiteboardCodeV1({ ...input, language }).language).toBe(expected);
  });

  it('renders one deterministic code element and verifies the complete trusted spec', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedCode();
    const result = await executeNativeWhiteboardCodeEffect({
      store,
      targetBinding: binding,
      input,
      expectedCode: expected.code,
      expectedCodeDigest: expected.digest,
    });

    expect(result).toEqual({
      replayed: false,
      postcondition: {
        stableElementId: input.stableElementId,
        elementType: 'code',
        normalizationVersion: CLIENT_EFFECT_CODE_NORMALIZATION_VERSION,
        observedCodeDigest: expected.digest,
        matchingElementCount: 1,
      },
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTCodeElement & {
      clientEffectExecutionId?: string;
      clientEffectCodeDigest?: string;
    };
    expect(element).toMatchObject({
      id: input.stableElementId,
      type: 'code',
      language: 'typescript',
      lines: expected.code.lines,
      fileName: 'example.ts',
      showLineNumbers: true,
      fontSize: 14,
      left: 80,
      top: 60,
      width: 600,
      height: 300,
      rotate: 0,
      clientEffectExecutionId: input.executionId,
      clientEffectCodeDigest: expected.digest,
    });
  });

  it('replays the same execution without adding a second code element', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedCode();
    await executeNativeWhiteboardCodeEffect({
      store,
      targetBinding: binding,
      input,
      expectedCode: expected.code,
      expectedCodeDigest: expected.digest,
    });
    const replay = await executeNativeWhiteboardCodeEffect({
      store,
      targetBinding: binding,
      input,
      expectedCode: expected.code,
      expectedCodeDigest: expected.digest,
    });

    expect(replay.replayed).toBe(true);
    expect(store.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);
  });

  it('fails closed when code content, line identity, element shape, or ownership changes', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedCode();
    await executeNativeWhiteboardCodeEffect({
      store,
      targetBinding: binding,
      input,
      expectedCode: expected.code,
      expectedCodeDigest: expected.digest,
    });
    const element = store.getState().stage?.whiteboard?.[0]?.elements[0] as PPTCodeElement & {
      clientEffectExecutionId?: string;
    };

    element.lines[0].content = 'tampered';
    await expect(
      verifyNativeWhiteboardCodeEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedCode: expected.code,
        expectedCodeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CODE_MISMATCH');

    element.lines[0].content = expected.code.lines[0].content;
    element.lines[0].id = 'wrong-line';
    await expect(
      verifyNativeWhiteboardCodeEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedCode: expected.code,
        expectedCodeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CODE_SPEC_INVALID');

    element.lines[0].id = 'L1';
    element.fontSize = 16;
    await expect(
      verifyNativeWhiteboardCodeEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedCode: expected.code,
        expectedCodeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_CODE_ELEMENT_MISMATCH');

    element.fontSize = 14;
    element.clientEffectExecutionId = 'other-execution';
    await expect(
      verifyNativeWhiteboardCodeEffect({
        store,
        targetBinding: binding,
        executionId: input.executionId,
        stableElementId: input.stableElementId,
        expectedCode: expected.code,
        expectedCodeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_ELEMENT_OWNERSHIP_MISMATCH');
  });

  it.each([
    [{ ...input, language: 'bad language' }, 'CLIENT_EFFECT_CODE_LANGUAGE_INVALID'],
    [{ ...input, code: '   \n\t' }, 'CLIENT_EFFECT_CODE_CONTENT_INVALID'],
    [{ ...input, code: 'ok\u0000bad' }, 'CLIENT_EFFECT_CODE_CONTENT_INVALID'],
    [{ ...input, code: 'x'.repeat(1_001) }, 'CLIENT_EFFECT_CODE_CONTENT_INVALID'],
    [
      { ...input, code: Array.from({ length: 201 }, () => 'x').join('\n') },
      'CLIENT_EFFECT_CODE_CONTENT_INVALID',
    ],
    [{ ...input, x: 900, width: 200 }, 'CLIENT_EFFECT_CODE_BOUNDS_INVALID'],
    [{ ...input, fileName: 'bad\u0000name.ts' }, 'CLIENT_EFFECT_CODE_FILE_NAME_INVALID'],
    [{ ...input, code: '汉'.repeat(6_000) }, 'CLIENT_EFFECT_CODE_PAYLOAD_INVALID'],
  ])('rejects invalid code state before mutation', async (invalid, code) => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedCode();
    await expect(
      executeNativeWhiteboardCodeEffect({
        store,
        targetBinding: binding,
        input: invalid,
        expectedCode: expected.code,
        expectedCodeDigest: expected.digest,
      }),
    ).rejects.toThrow(code);
    expect(store.getState().stage?.whiteboard?.[0]?.elements ?? []).toHaveLength(0);
  });

  it('rejects request/input drift and scene changes before mutation', async () => {
    const store = createStore();
    const binding = prepareNativeWhiteboardTarget(store, target);
    const expected = await expectedCode();
    await expect(
      executeNativeWhiteboardCodeEffect({
        store,
        targetBinding: binding,
        input: { ...input, code: 'different()' },
        expectedCode: expected.code,
        expectedCodeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_REQUEST_CODE_MISMATCH');

    store.setState({ currentSceneId: 'scene-2' });
    await expect(
      executeNativeWhiteboardCodeEffect({
        store,
        targetBinding: binding,
        input,
        expectedCode: expected.code,
        expectedCodeDigest: expected.digest,
      }),
    ).rejects.toThrow('CLIENT_EFFECT_TARGET_CHANGED');
  });
});
