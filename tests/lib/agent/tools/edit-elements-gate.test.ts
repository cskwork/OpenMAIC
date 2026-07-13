import { describe, expect, it } from 'vitest';
import * as editElementsGate from '@/lib/agent/tools/edit-elements-gate';
import {
  ALLOWED_EDIT_PROPS,
  buildElementInventory,
  clampUpdateProps,
  getEditablePropSchema,
  mapProposalsToEditIntents,
  normalizeRotate,
  type ElementInventoryItem,
} from '@/lib/agent/tools/edit-elements-gate';
import type { PPTElement } from '@openmaic/dsl';

type SubsetValidator = (
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
) => string | null;

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
  it('refuses an empty update batch', () => {
    expect(mapProposalsToEditIntents([], inventory)).toEqual({
      ok: false,
      reason: 'no element updates proposed',
    });
  });

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

  it('refuses defaultColor when inline text color would override it', () => {
    const [inlineColored] = buildElementInventory([
      {
        id: 'imported-title',
        type: 'text',
        left: 100,
        top: 80,
        width: 400,
        height: 60,
        rotate: 0,
        content: '<p><span style="font-size: 28px; color: #123456">Title</span></p>',
        defaultColor: '#333333',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);

    const result = mapProposalsToEditIntents(
      [{ id: 'imported-title', props: { defaultColor: '#0000ff' } }],
      [inlineColored],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/inline text color/i);
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

  it('refuses empty props', () => {
    const result = mapProposalsToEditIntents([{ id: 'title-1', props: {} }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/empty props/i);
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
    expect(clampUpdateProps('text', { width: 5 })).toEqual({
      width: 40,
    });
  });

  it('normalizes rotate into (-180, 180]', () => {
    expect(normalizeRotate(270)).toBe(-90);
    expect(normalizeRotate(-270)).toBe(90);
    expect(normalizeRotate(180)).toBe(180);
  });

  it('refuses coordinates outside the canvas sanity bounds', () => {
    const result = mapProposalsToEditIntents([{ id: 'title-1', props: { left: 1e15 } }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/left out of bounds/i);
  });

  it('refuses non-finite rotate values', () => {
    for (const rotate of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = mapProposalsToEditIntents([{ id: 'title-1', props: { rotate } }], inventory);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/rotate must be a finite number/i);
    }
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
                { pos: 100, color: '#00f' },
              ],
              rotate: 0,
            },
          },
        },
      ],
      inventory,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses color on text and shape elements because the DSL has no top-level color there', () => {
    const textResult = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { color: '#f00' } }],
      inventory,
    );
    expect(textResult.ok).toBe(false);
    if (textResult.ok) return;
    expect(textResult.reason).toMatch(/color is not valid on text elements/i);

    const shapeResult = mapProposalsToEditIntents(
      [{ id: 'fig-1', props: { color: '#f00' } }],
      inventory,
    );
    expect(shapeResult.ok).toBe(false);
    if (shapeResult.ok) return;
    expect(shapeResult.reason).toMatch(/color is not valid on shape elements/i);
  });

  it('allows fill on chart elements because the DSL chart schema owns it', () => {
    const chartInventory: ElementInventoryItem[] = [
      {
        id: 'chart-1',
        type: 'chart',
        left: 0,
        top: 0,
        width: 320,
        height: 180,
        rotate: 0,
        lock: false,
        label: 'chart',
        style: { themeColors: ['#f00'] },
      },
    ];
    const result = mapProposalsToEditIntents(
      [{ id: 'chart-1', props: { fill: '#ffffff' } }],
      chartInventory,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses vertical on shapes because ShapeText has no vertical prop', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'fig-1', props: { vertical: true } }],
      inventory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/vertical is not valid on shape elements/i);
  });

  it('accepts the full DSL textType enum and refuses old non-DSL values', () => {
    const allowed = [
      'title',
      'subtitle',
      'content',
      'item',
      'itemTitle',
      'notes',
      'header',
      'footer',
      'partNumber',
      'itemNumber',
    ];
    for (const textType of allowed) {
      expect(
        mapProposalsToEditIntents([{ id: 'title-1', props: { textType } }], inventory).ok,
      ).toBe(true);
    }

    for (const textType of ['caption', '']) {
      const result = mapProposalsToEditIntents([{ id: 'title-1', props: { textType } }], inventory);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/textType/i);
    }
  });

  it('derives editable prop schemas from the DSL schema', () => {
    for (const key of ALLOWED_EDIT_PROPS) {
      const owningTypes = [
        'text',
        'image',
        'shape',
        'line',
        'chart',
        'table',
        'latex',
        'video',
        'audio',
        'code',
      ].filter((type) => getEditablePropSchema(type, key));
      expect(owningTypes, `${key} should resolve for at least one element type`).not.toHaveLength(
        0,
      );
    }

    expect(getEditablePropSchema('text', 'notARealProp')).toBeNull();
    expect(getEditablePropSchema('shape', 'notARealProp')).toBeNull();
  });

  it('keeps layered policy on top of schema-derived object validation', () => {
    const tooManyStops = Array.from({ length: 11 }, (_, i) => ({
      pos: i * 10,
      color: '#f00',
    }));
    const gradientResult = mapProposalsToEditIntents(
      [
        {
          id: 'fig-1',
          props: {
            gradient: { type: 'linear', colors: tooManyStops, rotate: 0 },
          },
        },
      ],
      inventory,
    );
    expect(gradientResult.ok).toBe(false);
    if (gradientResult.ok) return;
    expect(gradientResult.reason).toMatch(/gradient.colors/i);

    const imageInventory: ElementInventoryItem[] = [
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
    const filterResult = mapProposalsToEditIntents(
      [{ id: 'img-1', props: { filters: { blur: 'x'.repeat(41) } } }],
      imageInventory,
    );
    expect(filterResult.ok).toBe(false);
    if (filterResult.ok) return;
    expect(filterResult.reason).toMatch(/filters.blur/i);
  });

  it('keeps themeColors non-empty', () => {
    const chartInventory: ElementInventoryItem[] = [
      {
        id: 'chart-1',
        type: 'chart',
        left: 0,
        top: 0,
        width: 320,
        height: 180,
        rotate: 0,
        lock: false,
        label: 'chart',
        style: { themeColors: ['#f00'] },
      },
    ];
    const result = mapProposalsToEditIntents(
      [{ id: 'chart-1', props: { themeColors: [] } }],
      chartInventory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/themeColors/i);
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
    expect(clampUpdateProps('line', { width: 0.5 })).toEqual({ width: 1 });
    expect(clampUpdateProps('line', { width: 4 })).toEqual({ width: 4 });
  });

  it('clamps opacity overshoot on valid opacity props', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { opacity: 1.5 } }],
      inventory,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toEqual([
      {
        type: 'element.update',
        id: 'title-1',
        props: { opacity: 1 },
      },
    ]);
    expect(clampUpdateProps('text', { opacity: -0.25 })).toEqual({
      opacity: 0,
    });
  });

  it('fails closed for schema refs and constructs the subset checker cannot validate', () => {
    const validateJsonSchemaSubset = (
      editElementsGate as typeof editElementsGate & {
        validateJsonSchemaSubset?: SubsetValidator;
      }
    ).validateJsonSchemaSubset;

    expect(
      validateJsonSchemaSubset?.(
        'anything',
        { $ref: '#/definitions/DefinitelyMissing' },
        'prop fill',
      ),
    ).toBe('prop fill uses a schema construct the gate cannot validate');
    expect(
      validateJsonSchemaSubset?.('anything', { oneOf: [{ type: 'string' }] }, 'prop fill'),
    ).toBe('prop fill uses a schema construct the gate cannot validate');
    expect(validateJsonSchemaSubset?.('anything', {}, 'prop fill')).toBeNull();
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
