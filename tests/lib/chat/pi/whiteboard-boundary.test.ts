import { describe, expect, it } from 'vitest';
import { getActiveWhiteboardFingerprint } from '@/lib/chat/pi/whiteboard-boundary';

function stageWith(elements: unknown[]) {
  return {
    id: 'stage-1',
    whiteboard: [{ id: 'wb-1', elements }],
  } as never;
}

describe('getActiveWhiteboardFingerprint', () => {
  it('is stable across element and object-key ordering', () => {
    const first = getActiveWhiteboardFingerprint(
      stageWith([
        { id: 'b', type: 'text', content: 'B', left: 100.0001 },
        { id: 'a', type: 'code', lines: [{ content: 'x', id: 'L1' }] },
      ]),
    );
    const second = getActiveWhiteboardFingerprint(
      stageWith([
        { lines: [{ id: 'L1', content: 'x' }], type: 'code', id: 'a' },
        { left: 100.00009, content: 'B', type: 'text', id: 'b' },
      ]),
    );

    expect(first).toEqual(second);
  });

  it('changes for semantic content while ignoring transient rendering fields', () => {
    const baseline = getActiveWhiteboardFingerprint(
      stageWith([{ id: 'note', type: 'text', content: 'old', selected: false }]),
    );
    const transientOnly = getActiveWhiteboardFingerprint(
      stageWith([{ id: 'note', type: 'text', content: 'old', selected: true }]),
    );
    const changed = getActiveWhiteboardFingerprint(
      stageWith([{ id: 'note', type: 'text', content: 'new', selected: false }]),
    );

    expect(transientOnly?.fingerprint).toBe(baseline?.fingerprint);
    expect(changed?.fingerprint).not.toBe(baseline?.fingerprint);
  });

  it('keeps content numbers exact while applying tolerance only to geometry', () => {
    const first = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'chart',
          type: 'chart',
          left: 100.0001,
          data: { series: [[0.0001]] },
        },
      ]),
    );
    const geometricNoise = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'chart',
          type: 'chart',
          left: 100.00009,
          data: { series: [[0.0001]] },
        },
      ]),
    );
    const contentChange = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'chart',
          type: 'chart',
          left: 100.00009,
          data: { series: [[0.0002]] },
        },
      ]),
    );

    expect(geometricNoise?.fingerprint).toBe(first?.fingerprint);
    expect(contentChange?.fingerprint).not.toBe(first?.fingerprint);
  });

  it('keeps nested style widths exact', () => {
    const first = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'table',
          type: 'table',
          width: 500.0001,
          outline: { width: 0.0001, style: 'solid', color: '#000000' },
        },
      ]),
    );
    const topLevelNoise = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'table',
          type: 'table',
          width: 500.00009,
          outline: { width: 0.0001, style: 'solid', color: '#000000' },
        },
      ]),
    );
    const nestedStyleChange = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'table',
          type: 'table',
          width: 500.00009,
          outline: { width: 0.0002, style: 'solid', color: '#000000' },
        },
      ]),
    );

    expect(topLevelNoise?.fingerprint).toBe(first?.fingerprint);
    expect(nestedStyleChange?.fingerprint).not.toBe(first?.fingerprint);
  });

  it('applies geometry tolerance to top-level line coordinates only', () => {
    const first = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'line',
          type: 'line',
          start: [0.0001, 10.0001],
          end: [100.0001, 10.0001],
          metadata: { start: 0.0001 },
        },
      ]),
    );
    const coordinateNoise = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'line',
          type: 'line',
          start: [0.00009, 10.00009],
          end: [100.00009, 10.00009],
          metadata: { start: 0.0001 },
        },
      ]),
    );
    const nestedContentChange = getActiveWhiteboardFingerprint(
      stageWith([
        {
          id: 'line',
          type: 'line',
          start: [0.00009, 10.00009],
          end: [100.00009, 10.00009],
          metadata: { start: 0.0002 },
        },
      ]),
    );

    expect(coordinateNoise?.fingerprint).toBe(first?.fingerprint);
    expect(nestedContentChange?.fingerprint).not.toBe(first?.fingerprint);
  });

  it('ignores transient fields at nested levels', () => {
    const first = getActiveWhiteboardFingerprint(
      stageWith([{ id: 'group', type: 'group', children: [{ id: 'child', selected: false }] }]),
    );
    const second = getActiveWhiteboardFingerprint(
      stageWith([{ id: 'group', type: 'group', children: [{ id: 'child', selected: true }] }]),
    );

    expect(second?.fingerprint).toBe(first?.fingerprint);
  });
});
