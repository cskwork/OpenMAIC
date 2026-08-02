import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
  CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
  CLIENT_EFFECT_ELEMENT_METADATA_KEYS,
  canonicalizeWhiteboardContentV1,
  canonicalizeWhiteboardMembershipV1,
  digestWhiteboardContentV1,
  digestWhiteboardMembershipV1,
  isClientEffectAck,
} from '@/lib/agent/runtime/client-effect-contract';
import type { PPTElement } from '@openmaic/dsl';

const element: PPTElement = {
  id: 'text-1',
  type: 'text' as const,
  content: '<p>visible</p>',
  defaultFontName: 'Microsoft YaHei',
  defaultColor: '#333',
  left: 0,
  top: 0,
  width: 100,
  height: 50,
  rotate: 0,
};

describe('wb_clear exact contract', () => {
  it('pins the canonical empty digest domains', async () => {
    await expect(digestWhiteboardContentV1([])).resolves.toBe(
      CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
    );
    await expect(digestWhiteboardMembershipV1([])).resolves.toBe(
      CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
    );
  });

  it('excludes only the frozen execution metadata allowlist', async () => {
    const withKnownMetadata = Object.fromEntries(
      CLIENT_EFFECT_ELEMENT_METADATA_KEYS.map((key) => [key, 'ignored']),
    );
    await expect(digestWhiteboardContentV1([{ ...element, ...withKnownMetadata }])).resolves.toBe(
      await digestWhiteboardContentV1([element]),
    );
    expect(
      canonicalizeWhiteboardContentV1([
        { ...element, clientEffectFutureField: 'visible-state' } as PPTElement,
      ]),
    ).not.toBe(canonicalizeWhiteboardContentV1([element]));
  });

  it('keeps the digest exclusion allowlist equal to production execution metadata', () => {
    const actionSource = readFileSync(
      resolve(process.cwd(), 'lib/action/client-effect-whiteboard.ts'),
      'utf8',
    );
    const writtenMetadataKeys = [
      ...new Set(
        [...actionSource.matchAll(/\b(clientEffect[A-Za-z]+)\s*[:?]/g)].map((match) => match[1]),
      ),
    ].sort();
    expect(writtenMetadataKeys).toEqual([...CLIENT_EFFECT_ELEMENT_METADATA_KEYS].sort());
  });

  it('preserves array order while sorting object keys deterministically', () => {
    expect(canonicalizeWhiteboardContentV1([element, { ...element, id: 'text-2' }])).not.toBe(
      canonicalizeWhiteboardContentV1([{ ...element, id: 'text-2' }, element]),
    );
    expect(
      canonicalizeWhiteboardContentV1([
        Object.fromEntries(Object.entries(element).reverse()) as PPTElement,
      ]),
    ).toBe(canonicalizeWhiteboardContentV1([element]));
  });

  it('uses locale-independent code-unit ordering for cross-runtime canonicalization', () => {
    expect(
      canonicalizeWhiteboardMembershipV1([
        { id: 'ää-1', type: 'text' },
        { id: 'zz-1', type: 'text' },
        { id: 'aa-1', type: 'text' },
        { id: 'az-1', type: 'text' },
      ]),
    ).toContain('[["aa-1","text"],["az-1","text"],["zz-1","text"],["ää-1","text"]]');
  });

  it('fails closed instead of collapsing unsupported object prototypes', () => {
    class FutureVisibleValue {
      constructor(readonly value: string) {}
    }

    for (const futureValue of [new Date(0), new Map([['value', 1]]), new FutureVisibleValue('x')]) {
      expect(() =>
        canonicalizeWhiteboardContentV1([{ ...element, futureValue } as unknown as PPTElement]),
      ).toThrow('CLIENT_EFFECT_BOARD_CONTENT_OBJECT_INVALID');
    }
  });

  it('uses explicit JSON equivalence for undefined fields and array gaps', () => {
    const absentOptional = canonicalizeWhiteboardContentV1([element]);
    const undefinedOptional = canonicalizeWhiteboardContentV1([
      { ...element, optionalFutureField: undefined } as unknown as PPTElement,
    ]);
    expect(undefinedOptional).toBe(absentOptional);

    const withArray = (futureArray: unknown[]) =>
      canonicalizeWhiteboardContentV1([{ ...element, futureArray } as unknown as PPTElement]);
    expect(withArray([undefined])).toBe(withArray([null]));
    expect(withArray(new Array(1))).toBe(withArray([null]));
  });

  it('accepts null-prototype JSON objects while preserving their visible keys', () => {
    const futureValue = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: 2,
      a: 1,
    });
    const canonical = canonicalizeWhiteboardContentV1([
      { ...element, futureValue } as unknown as PPTElement,
    ]);
    expect(canonical).toContain('"futureValue":{"a":1,"z":2}');
  });

  it('continues to reject cycles and non-finite numbers', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      canonicalizeWhiteboardContentV1([
        { ...element, futureValue: cyclic } as unknown as PPTElement,
      ]),
    ).toThrow('CLIENT_EFFECT_BOARD_CONTENT_CYCLE');

    for (const futureValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        canonicalizeWhiteboardContentV1([{ ...element, futureValue } as unknown as PPTElement]),
      ).toThrow('CLIENT_EFFECT_BOARD_CONTENT_NUMBER_INVALID');
    }
  });

  it('accepts only the exact discriminated clear ACK observation', () => {
    const ack = {
      protocolVersion: 'maic.tool-execution.v1',
      executionId: 'execution-clear',
      idempotencyKey: 'run:message:tool',
      clientEventId: 'committed',
      observedAt: 1,
      status: 'effect_committed',
      targetBinding: {
        requestId: 'request-1',
        sessionId: 'session-1',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        whiteboardId: 'whiteboard-1',
        bindingVersion: 1,
      },
      postcondition: {
        kind: 'whiteboard_empty',
        normalizationVersion: 'maic.whiteboard-clear.v1',
        membershipNormalizationVersion: 'maic.whiteboard-membership.v1',
        boardContentNormalizationVersion: 'maic.whiteboard-content.v1',
        whiteboardId: 'whiteboard-1',
        cleared: false,
        elementCountBefore: 0,
        elementCountAfter: 0,
        observedMembershipDigestBefore: CANONICAL_EMPTY_WHITEBOARD_MEMBERSHIP_DIGEST,
        verifiedEmptyBoardContentDigest: CANONICAL_EMPTY_WHITEBOARD_CONTENT_DIGEST,
        observedOpen: false,
        visibilityChanged: false,
      },
    };
    expect(isClientEffectAck(ack)).toBe(true);
    expect(
      isClientEffectAck({ ...ack, postcondition: { ...ack.postcondition, extra: true } }),
    ).toBe(false);
  });
});
