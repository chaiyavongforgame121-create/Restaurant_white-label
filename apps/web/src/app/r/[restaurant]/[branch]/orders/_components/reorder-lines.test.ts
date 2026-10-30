import { describe, expect, it } from 'vitest';
import {
  planReorder,
  reorderIds,
  type LiveCombo,
  type LiveDish,
  type LiveDishGroup,
  type LiveGroupOption,
  type LiveOption,
  type PastLine,
} from './reorder-lines';

const BRANCH = 'branch-1';
const CURRY = 'dish-curry';
const KRAPOW = 'dish-krapow';
/** The library's Spicy Level (Modifier groups page): required, pick one; on Curry and Pad Krapow. */
const SPICY = 'group-spicy';
/** Curry's own copy of it, made when the owner deleted Thai Hot in Curry's editor. */
const SPICY_CURRY = 'group-spicy-curry';

const dish = (id: string, name: string, over: Partial<LiveDish> = {}): LiveDish => ({
  id,
  branch_id: BRANCH,
  category_id: 'cat-mains',
  name,
  price: 100,
  image_url: null,
  is_active: true,
  ...over,
});

/** A library option of Spicy Level, as the modifier_options read returns it. */
const spicy = (id: string, name: string, over: Partial<LiveOption> = {}): LiveOption => ({
  id,
  group_id: SPICY,
  name,
  price_delta: 0,
  is_active: true,
  modifier_groups: { name: 'Spicy Level' },
  ...over,
});

const choice = (id: string, name: string, over: Partial<LiveGroupOption> = {}): LiveGroupOption => ({
  id,
  name,
  price_delta: 0,
  is_active: true,
  ...over,
});

/** A dish showing the library's Spicy Level itself. */
const showsLibrary = (dishId: string): LiveDishGroup => ({
  menu_item_id: dishId,
  modifier_group_id: SPICY,
  modifier_groups: {
    name: 'Spicy Level',
    source_group_id: null,
    is_required: true,
    min_select: 1,
    modifier_options: [
      choice('mild', 'Mild'),
      choice('medium', 'Medium'),
      choice('hot', 'Hot'),
      choice('thai-hot', 'Thai Hot'),
    ],
  },
});

type CopyGroup = Exclude<NonNullable<LiveDishGroup['modifier_groups']>, readonly unknown[]>;

/** Curry showing its own copy of Spicy Level: every option has a new id, Thai Hot is gone. */
const curryCopy = (
  over: Partial<CopyGroup> = {},
  options: LiveGroupOption[] = [
    choice('copy-mild', 'Mild', { price_delta: 5 }),
    choice('copy-medium', 'Medium'),
    choice('copy-hot', 'Hot'),
  ],
): LiveDishGroup => ({
  menu_item_id: CURRY,
  modifier_group_id: SPICY_CURRY,
  modifier_groups: {
    name: 'Spicy Level',
    source_group_id: SPICY,
    is_required: true,
    min_select: 1,
    modifier_options: options,
    ...over,
  },
});

/** A past line of a dish with Spicy Level options, as place-order stored them. */
const ordered = (menuItemId: string, picks: Array<[string, string]>, over: Partial<PastLine> = {}): PastLine => ({
  menu_item_id: menuItemId,
  combo_id: null,
  quantity: 1,
  notes: null,
  modifiers: picks.map(([option_id, name]) => ({ group_id: SPICY, option_id, name, price_delta: 0 })),
  ...over,
});

const LIBRARY_OPTIONS = [spicy('mild', 'Mild'), spicy('medium', 'Medium'), spicy('hot', 'Hot'), spicy('thai-hot', 'Thai Hot')];

const live = (over: {
  dishes?: LiveDish[];
  combos?: LiveCombo[];
  options?: LiveOption[];
  dishGroups?: LiveDishGroup[];
}) => ({
  dishes: over.dishes ?? [dish(CURRY, 'Curry'), dish(KRAPOW, 'Pad Krapow')],
  combos: over.combos ?? [],
  options: over.options ?? LIBRARY_OPTIONS,
  dishGroups: over.dishGroups ?? [curryCopy(), showsLibrary(KRAPOW)],
});

describe('planReorder', () => {
  it('puts a dish back with the options it still shows, priced and named as they are now', () => {
    const plan = planReorder(
      [ordered(KRAPOW, [['medium', 'Medium']], { quantity: 3, notes: 'no onions' })],
      live({
        dishes: [dish(KRAPOW, 'Pad Krapow', { price: '89.5' as unknown as number })],
        options: [spicy('medium', 'Medium (new)', { price_delta: '2' as unknown as number })],
        dishGroups: [showsLibrary(KRAPOW)],
      }),
    );
    expect(plan).toEqual({
      adds: [
        {
          kind: 'item',
          dish: { id: KRAPOW, branchId: BRANCH, categoryId: 'cat-mains', name: 'Pad Krapow', price: 89.5, imageUrl: null },
          quantity: 3,
          notes: 'no onions',
          modifiers: [
            { group_id: SPICY, group_name: 'Spicy Level', option_id: 'medium', option_name: 'Medium (new)', price_delta: 2 },
          ],
        },
      ],
      dropped: 0,
    });
  });

  it("carries an old choice over to the dish's own copy of the library group, by group and name", () => {
    // The scenario of the review: Curry + Mild, then Thai Hot deleted in Curry's editor, which gave
    // Curry its own Spicy Level with a new id for every option, Mild included. Curry still offers Mild.
    const plan = planReorder([ordered(CURRY, [['mild', 'Mild']]), ordered(KRAPOW, [['mild', 'Mild']])], live({}));
    expect(plan.dropped).toBe(0);
    expect(plan.adds.map((a) => (a.kind === 'item' ? [a.dish.id, a.modifiers] : null))).toEqual([
      [CURRY, [{ group_id: SPICY_CURRY, group_name: 'Spicy Level', option_id: 'copy-mild', option_name: 'Mild', price_delta: 5 }]],
      // Pad Krapow still shows the library group, so its Mild stays the library's.
      [KRAPOW, [{ group_id: SPICY, group_name: 'Spicy Level', option_id: 'mild', option_name: 'Mild', price_delta: 0 }]],
    ]);
  });

  it('names the carried choice the way the copy is named now', () => {
    const plan = planReorder([ordered(CURRY, [['mild', 'Mild']])], live({ dishGroups: [curryCopy({ name: 'Spice' })] }));
    const add = plan.adds[0];
    expect(add?.kind === 'item' && add.modifiers?.[0]?.group_name).toBe('Spice');
  });

  it("finds the copy by the order's own group and name once the library option is deleted", () => {
    // Mild deleted from the library group after Curry's copy was made: the copy still has its own.
    const plan = planReorder(
      [ordered(CURRY, [['mild', 'Mild']])],
      live({ options: LIBRARY_OPTIONS.filter((o) => o.id !== 'mild') }),
    );
    expect(plan.dropped).toBe(0);
    const add = plan.adds[0];
    expect(add?.kind === 'item' && add.modifiers?.map((m) => m.option_id)).toEqual(['copy-mild']);
  });

  it('finds the twin by the library name of today when the option was renamed before the copy', () => {
    const plan = planReorder(
      [ordered(CURRY, [['mild', 'Mild']])],
      live({
        options: [spicy('mild', 'Mild 🌶')],
        dishGroups: [curryCopy({}, [choice('copy-mild', 'Mild 🌶'), choice('copy-hot', 'Hot')])],
      }),
    );
    expect(plan.dropped).toBe(0);
    const add = plan.adds[0];
    expect(add?.kind === 'item' && add.modifiers?.map((m) => m.option_name)).toEqual(['Mild 🌶']);
  });

  it('keeps a choice made on the copy itself as it is', () => {
    const plan = planReorder(
      [{ ...ordered(CURRY, []), modifiers: [{ group_id: SPICY_CURRY, option_id: 'copy-hot', name: 'Hot', price_delta: 0 }] }],
      live({ options: [{ ...spicy('copy-hot', 'Hot'), group_id: SPICY_CURRY }] }),
    );
    expect(plan.dropped).toBe(0);
    const add = plan.adds[0];
    expect(add?.kind === 'item' && add.modifiers?.map((m) => [m.group_id, m.option_id])).toEqual([[SPICY_CURRY, 'copy-hot']]);
  });

  it('does not put a dish back without a required choice its copy no longer has', () => {
    // Thai Hot is gone from Curry's copy. Re-added bare, the curry would reach the kitchen with no
    // spice level: the cart and place-order do not check required groups.
    const plan = planReorder(
      [ordered(CURRY, [['thai-hot', 'Thai Hot']]), ordered(KRAPOW, [['thai-hot', 'Thai Hot']])],
      live({}),
    );
    expect(plan.adds.map((a) => (a.kind === 'item' ? a.dish.id : a.combo.comboId))).toEqual([KRAPOW]);
    expect(plan.dropped).toBe(1);
  });

  it('leaves out only the option when the copy does not need a choice', () => {
    const plan = planReorder(
      [ordered(CURRY, [['thai-hot', 'Thai Hot']])],
      live({ dishGroups: [curryCopy({ is_required: false, min_select: 0 })] }),
    );
    expect(plan.dropped).toBe(1);
    expect(plan.adds).toHaveLength(1);
    const add = plan.adds[0];
    expect(add?.kind === 'item' && add.modifiers).toBeUndefined();
  });

  it('puts a dish back when its copy keeps as many choices as it needs, and not when it keeps fewer', () => {
    const toppings = (options: LiveGroupOption[]) =>
      curryCopy({ name: 'Toppings', is_required: true, min_select: 2 }, options);
    const line = ordered(CURRY, [
      ['egg', 'Egg'],
      ['cheese', 'Cheese'],
      ['bacon', 'Bacon'],
    ]);
    const lib = [spicy('egg', 'Egg'), spicy('cheese', 'Cheese'), spicy('bacon', 'Bacon')];

    const keptTwo = planReorder(
      [line],
      live({ options: lib, dishGroups: [toppings([choice('c-egg', 'Egg'), choice('c-cheese', 'Cheese')])] }),
    );
    expect(keptTwo.dropped).toBe(1);
    const add = keptTwo.adds[0];
    expect(add?.kind === 'item' && add.modifiers?.map((m) => m.option_id)).toEqual(['c-egg', 'c-cheese']);

    const keptOne = planReorder([line], live({ options: lib, dishGroups: [toppings([choice('c-egg', 'Egg')])] }));
    expect(keptOne.adds).toEqual([]);
    expect(keptOne.dropped).toBe(2);
  });

  it('needs one choice in a required copy whose minimum is 0, and its minimum in one not marked required', () => {
    const lost = [ordered(CURRY, [['thai-hot', 'Thai Hot']])];
    expect(planReorder(lost, live({ dishGroups: [curryCopy({ is_required: true, min_select: 0 })] })).adds).toEqual([]);
    expect(planReorder(lost, live({ dishGroups: [curryCopy({ is_required: false, min_select: 1 })] })).adds).toEqual([]);
  });

  it("does not carry a choice over to a switched-off option of the copy", () => {
    const plan = planReorder(
      [ordered(CURRY, [['mild', 'Mild']])],
      live({ dishGroups: [curryCopy({}, [choice('copy-mild', 'Mild', { is_active: false }), choice('copy-hot', 'Hot')])] }),
    );
    expect(plan.adds).toEqual([]);
    expect(plan.dropped).toBe(1);
  });

  it('leaves out an option whose group is no longer on the dish at all, and puts the dish back', () => {
    const plan = planReorder([ordered(CURRY, [['mild', 'Mild']])], live({ dishGroups: [] }));
    expect(plan.dropped).toBe(1);
    expect(plan.adds).toHaveLength(1);
    const add = plan.adds[0];
    expect(add?.kind === 'item' && add.modifiers).toBeUndefined();
  });

  it('leaves out an option switched off in a group the dish still shows, as before, and puts the dish back', () => {
    const plan = planReorder(
      [ordered(KRAPOW, [['mild', 'Mild'], ['hot', 'Hot']])],
      live({ options: [spicy('mild', 'Mild', { is_active: false }), spicy('hot', 'Hot')] }),
    );
    expect(plan.dropped).toBe(1);
    const add = plan.adds[0];
    expect(add?.kind === 'item' && add.modifiers?.map((m) => m.option_id)).toEqual(['hot']);
  });

  it('reads embedded rows sent as one-row arrays', () => {
    const copy = curryCopy();
    const plan = planReorder(
      [ordered(CURRY, [['mild', 'Mild']]), ordered(KRAPOW, [['hot', 'Hot']])],
      live({
        options: [{ ...spicy('hot', 'Hot'), modifier_groups: [{ name: 'Spicy Level' }] }, spicy('mild', 'Mild')],
        dishGroups: [{ ...copy, modifier_groups: [copy.modifier_groups as CopyGroup] }, showsLibrary(KRAPOW)],
      }),
    );
    expect(plan.dropped).toBe(0);
    expect(plan.adds.map((a) => (a.kind === 'item' ? a.modifiers?.map((m) => [m.group_name, m.option_id]) : null))).toEqual([
      [['Spicy Level', 'copy-mild']],
      [['Spicy Level', 'hot']],
    ]);
  });

  it('leaves out a dish or combo that is gone or switched off, and puts a combo back with its contents', () => {
    const combo = (id: string, over: Partial<LiveCombo> = {}): LiveCombo => ({
      id,
      branch_id: BRANCH,
      name: `Combo ${id}`,
      image_url: null,
      total_price: '199' as unknown as number,
      is_active: true,
      combo_items: [
        { quantity: 1, menu_items: { name: 'Curry' } },
        { quantity: 2, menu_items: [{ name: 'Rice' }] },
        { quantity: 1, menu_items: null },
      ],
      ...over,
    });
    const plan = planReorder(
      [
        ordered(CURRY, []),
        ordered('dish-gone', []),
        ordered(KRAPOW, []),
        { menu_item_id: null, combo_id: 'combo-a', quantity: 2 },
        { menu_item_id: null, combo_id: 'combo-off', quantity: 1 },
        { menu_item_id: null, combo_id: 'combo-gone', quantity: 1 },
      ],
      live({
        dishes: [dish(CURRY, 'Curry'), dish(KRAPOW, 'Pad Krapow', { is_active: false })],
        combos: [combo('combo-a'), combo('combo-off', { is_active: false })],
      }),
    );
    expect(plan.dropped).toBe(4);
    expect(plan.adds).toEqual([
      {
        kind: 'item',
        dish: { id: CURRY, branchId: BRANCH, categoryId: 'cat-mains', name: 'Curry', price: 100, imageUrl: null },
        quantity: 1,
        notes: undefined,
        modifiers: undefined,
      },
      {
        kind: 'combo',
        combo: {
          comboId: 'combo-a',
          name: 'Combo combo-a',
          imageUrl: null,
          totalPrice: 199,
          branchId: BRANCH,
          contents: [
            { item_name: 'Curry', quantity: 1 },
            { item_name: 'Rice', quantity: 2 },
            { item_name: '', quantity: 1 },
          ],
        },
        quantity: 2,
      },
    ]);
  });
});

describe('reorderIds', () => {
  it("names each dish, combo and option once, and the dishes options were chosen on", () => {
    expect(
      reorderIds([
        ordered(CURRY, [['mild', 'Mild']]),
        ordered(CURRY, [['hot', 'Hot'], ['mild', 'Mild']]),
        ordered(KRAPOW, []),
        { menu_item_id: null, combo_id: 'combo-a', quantity: 1 },
        // A combo id on a dish line is not a combo line.
        { menu_item_id: KRAPOW, combo_id: 'combo-b', quantity: 1 },
      ]),
    ).toEqual({
      menuIds: [CURRY, KRAPOW],
      comboIds: ['combo-a'],
      optionIds: ['mild', 'hot'],
      optionMenuIds: [CURRY],
    });
  });
});
