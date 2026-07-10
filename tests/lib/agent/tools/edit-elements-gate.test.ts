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

  it('refuses malformed prop values (outline/shadow/color)', () => {
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { outline: 17 } }], inventory).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { shadow: 'big' } }], inventory).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { defaultColor: 12 } }], inventory).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [{ id: 'title-1', props: { rotate: '45' as unknown as number } }],
        inventory,
      ).ok,
    ).toBe(false);
  });

  it('refuses junk nested inside gradient', () => {
    const result = mapProposalsToEditIntents(
      [
        {
          id: 'fig-1',
          props: {
            gradient: { type: 'linear', colors: ['#f00', '#00f'], rotate: 0 },
          },
        },
      ],
      inventory,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a well-formed gradient on shapes', () => {
    const result = mapProposalsToEditIntents(
      [
        {
          id: 'fig-1',
          props: {
            gradient: {
              type: 'linear',
              colors: [
                { pos: 0, color: '#f00' },
                { pos: 1, color: '#00f' },
              ],
              rotate: 90,
            },
          },
        },
      ],
      inventory,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses defaultColor on image elements', () => {
    const inv: ElementInventoryItem[] = [
      {
        id: 'img-1',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'pic',
        style: {},
      },
    ];
    expect(
      mapProposalsToEditIntents([{ id: 'img-1', props: { defaultColor: '#f00' } }], inv).ok,
    ).toBe(false);
  });

  it('clamps line stroke width with min 1, not box MIN_SIZE', () => {
    expect(clampUpdateProps('line', { width: 0.5 }, { width: 2 })).toEqual({ width: 1 });
    expect(clampUpdateProps('line', { width: 4 }, { width: 2 })).toEqual({ width: 4 });
  });

  it('refuses partial group updates', () => {
    const grouped: ElementInventoryItem[] = [
      { ...textEl({ id: 'g1' }), groupId: 'grp' },
      {
        id: 'g2',
        type: 'shape',
        left: 0,
        top: 0,
        width: 50,
        height: 50,
        rotate: 0,
        lock: false,
        label: 'icon',
        style: {},
        groupId: 'grp',
      },
    ];
    const result = mapProposalsToEditIntents([{ id: 'g1', props: { left: 10 } }], grouped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/group/i);
  });

  it('allows updating every member of a group together', () => {
    const grouped: ElementInventoryItem[] = [
      { ...textEl({ id: 'g1' }), groupId: 'grp' },
      {
        id: 'g2',
        type: 'shape',
        left: 0,
        top: 0,
        width: 50,
        height: 50,
        rotate: 0,
        lock: false,
        label: 'icon',
        style: {},
        groupId: 'grp',
      },
    ];
    const result = mapProposalsToEditIntents(
      [
        { id: 'g1', props: { left: 10 } },
        { id: 'g2', props: { left: 20 } },
      ],
      grouped,
    );
    expect(result.ok).toBe(true);
  });

  it('surfaces groupId on inventory items', () => {
    const els = [
      {
        id: 't1',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        groupId: 'g',
        content: 'x',
        defaultFontName: 'Arial',
        defaultColor: '#111',
      },
    ] as unknown as PPTElement[];
    expect(buildElementInventory(els)[0].groupId).toBe('g');
  });
});
