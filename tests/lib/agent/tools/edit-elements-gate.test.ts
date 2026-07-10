import { describe, expect, it } from 'vitest';
import {
  buildElementInventory,
  clampUpdateProps,
  mapProposalsToEditIntents,
  normalizeRotate,
  type ElementInventoryItem,
} from '@/lib/agent/tools/edit-elements-gate';
import type { PPTElement } from '@openmaic/dsl';

function textEl(overrides: Partial<PPTElement> & { id: string }): ElementInventoryItem {
  return {
    id: overrides.id,
    type: 'text',
    left: 100,
    top: 80,
    width: 400,
    height: 60,
    rotate: 0,
    lock: false,
    label: 'Title',
    style: { defaultColor: '#333333' },
    ...('lock' in overrides ? { lock: !!overrides.lock } : {}),
  };
}

const inventory: ElementInventoryItem[] = [
  textEl({ id: 'title-1' }),
  {
    id: 'fig-1',
    type: 'shape',
    left: 200,
    top: 200,
    width: 120,
    height: 120,
    rotate: 0,
    lock: false,
    label: 'figure',
    style: { fill: '#eeeeee' },
  },
  {
    id: 'locked-1',
    type: 'text',
    left: 10,
    top: 10,
    width: 100,
    height: 40,
    rotate: 0,
    lock: true,
    label: 'locked',
    style: {},
  },
];

describe('edit-elements-gate', () => {
  it('maps a single color+position update to element.update', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { defaultColor: '#0000ff', top: 40 } }],
      inventory,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toEqual([
      {
        type: 'element.update',
        id: 'title-1',
        props: { defaultColor: '#0000ff', top: 40 },
      },
    ]);
  });

  it('maps mixed-target updates to one element.updateMany', () => {
    const result = mapProposalsToEditIntents(
      [
        { id: 'title-1', props: { defaultColor: '#0000ff' } },
        { id: 'fig-1', props: { left: 200, top: 260 } },
      ],
      inventory,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].type).toBe('element.updateMany');
  });

  it('refuses unknown element ids (nothing partial)', () => {
    const result = mapProposalsToEditIntents([{ id: 'nope', props: { top: 10 } }], inventory);
    expect(result).toEqual({
      ok: false,
      reason: 'unknown element id "nope"',
    });
  });

  it('refuses locked elements', () => {
    const result = mapProposalsToEditIntents([{ id: 'locked-1', props: { top: 20 } }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/locked/);
  });

  it('refuses content props like content/src', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { content: '<p>hi</p>' } }],
      inventory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not editable/);
  });

  it('refuses out-of-contract props', () => {
    const result = mapProposalsToEditIntents([{ id: 'title-1', props: { mystery: 1 } }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/out of contract/);
  });

  it('refuses the whole batch when one update is bad', () => {
    const result = mapProposalsToEditIntents(
      [
        { id: 'title-1', props: { top: 10 } },
        { id: 'nope', props: { top: 10 } },
      ],
      inventory,
    );
    expect(result.ok).toBe(false);
  });

  it('clamps width to MIN_SIZE for text (40)', () => {
    expect(clampUpdateProps('text', { width: 5 }, { width: 400, height: 60 })).toEqual({
      width: 40,
    });
  });

  it('normalizes rotate into (-180, 180]', () => {
    expect(normalizeRotate(270)).toBe(-90);
    expect(normalizeRotate(-270)).toBe(90);
    expect(normalizeRotate(180)).toBe(180);
  });

  it('builds inventory labels from text content', () => {
    const els = [
      {
        id: 't1',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<p>Hello <b>World</b></p>',
        defaultFontName: 'Arial',
        defaultColor: '#111',
      },
    ] as unknown as PPTElement[];
    const inv = buildElementInventory(els);
    expect(inv[0].label).toBe('Hello World');
    expect(inv[0].style.defaultColor).toBe('#111');
  });
});
