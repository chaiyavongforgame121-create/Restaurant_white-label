import { describe, expect, it } from 'vitest';
import {
  comboLineSignature,
  consolidateOrderLines,
  defaultSelections,
  distinctOptionIds,
  flattenSelections,
  lineSignature,
  MAX_LINE_QUANTITY,
  mergeIdenticalLines,
  modifierDelta,
  normalizeLineNotes,
  optionLineSignature,
  toggleOption,
  validateSelections,
  type ModifierGroup,
} from './modifiers';

const opt = (id: string, name: string, delta = 0, isDefault = false) => ({
  id,
  name,
  price_delta: delta,
  is_default: isDefault,
  is_active: true,
});

const size: ModifierGroup = {
  id: 'g-size',
  name: 'Size',
  min_select: 1,
  max_select: 1,
  is_required: true,
  selection_type: 'single',
  display_order: 0,
  options: [opt('o-reg', 'Regular', 0, true), opt('o-big', 'Large', 2.5)],
};

const extras: ModifierGroup = {
  id: 'g-extras',
  name: 'Extras',
  min_select: 0,
  max_select: 2,
  is_required: false,
  selection_type: 'multiple',
  display_order: 1,
  options: [opt('o-cheese', 'Extra cheese', 1.25), opt('o-bacon', 'Bacon', 2), opt('o-egg', 'Egg', 1.5)],
};

const groups = [size, extras];

describe('defaultSelections', () => {
  it('starts a group on its defaults', () => {
    expect(defaultSelections(groups)).toEqual({ 'g-size': ['o-reg'], 'g-extras': [] });
  });

  it('never opens a group already over its own limit', () => {
    const misconfigured: ModifierGroup = {
      ...size,
      options: [opt('a', 'A', 0, true), opt('b', 'B', 0, true), opt('c', 'C', 0, true)],
    };
    expect(defaultSelections([misconfigured])['g-size']).toEqual(['a']);
  });

  it('ignores a default that is no longer on sale', () => {
    const withRetired: ModifierGroup = {
      ...extras,
      options: [{ ...opt('o-old', 'Discontinued', 1, true), is_active: false }, opt('o-bacon', 'Bacon', 2)],
    };
    expect(defaultSelections([withRetired])['g-extras']).toEqual([]);
  });
});

describe('modifierDelta', () => {
  it('is zero with nothing picked', () => {
    expect(modifierDelta(groups, {})).toBe(0);
  });

  it('adds up what was picked, across groups', () => {
    expect(modifierDelta(groups, { 'g-size': ['o-big'], 'g-extras': ['o-cheese', 'o-bacon'] })).toBe(5.75);
  });

  it('reads a Set the same as an array', () => {
    const asSet = { 'g-size': new Set(['o-big']) };
    expect(modifierDelta(groups, asSet)).toBe(2.5);
  });

  it('ignores an option id that is not in the group', () => {
    expect(modifierDelta(groups, { 'g-size': ['o-ghost'] })).toBe(0);
  });

  it('handles a negative delta without leaving float dust', () => {
    const discounted: ModifierGroup = {
      ...extras,
      options: [opt('a', 'No sauce', -0.33), opt('b', 'No pickle', -0.33), opt('c', 'No onion', -0.33)],
    };
    expect(modifierDelta([{ ...discounted, max_select: 3 }], { 'g-extras': ['a', 'b', 'c'] })).toBe(-0.99);
  });
});

describe('validateSelections', () => {
  it('refuses a required group with nothing picked', () => {
    expect(validateSelections(groups, { 'g-size': [] })).toBe('Pick at least 1 option for Size');
  });

  it('passes once the required group is satisfied', () => {
    expect(validateSelections(groups, { 'g-size': ['o-reg'] })).toBeNull();
  });

  it('refuses more than a group allows', () => {
    expect(
      validateSelections(groups, { 'g-size': ['o-reg'], 'g-extras': ['o-cheese', 'o-bacon', 'o-egg'] }),
    ).toBe('Pick at most 2 options for Extras');
  });

  it('leaves an optional group alone when it is empty', () => {
    expect(validateSelections([extras], {})).toBeNull();
  });

  it('pluralises the minimum correctly', () => {
    const two: ModifierGroup = { ...size, min_select: 2, max_select: 3, selection_type: 'multiple' };
    expect(validateSelections([two], { 'g-size': [] })).toBe('Pick at least 2 options for Size');
  });
});

describe('flattenSelections', () => {
  it('names the group and the option, so a kitchen ticket reads on its own', () => {
    expect(flattenSelections(groups, { 'g-size': ['o-big'], 'g-extras': ['o-bacon'] })).toEqual([
      { group_id: 'g-size', group_name: 'Size', option_id: 'o-big', option_name: 'Large', price_delta: 2.5 },
      { group_id: 'g-extras', group_name: 'Extras', option_id: 'o-bacon', option_name: 'Bacon', price_delta: 2 },
    ]);
  });

  it('is empty when nothing is picked', () => {
    expect(flattenSelections(groups, {})).toEqual([]);
  });
});

describe('toggleOption', () => {
  it('swaps within a single-select group', () => {
    expect(toggleOption(size, { 'g-size': ['o-reg'] }, 'o-big')).toEqual(['o-big']);
  });

  it('un-picks when the same single-select option is tapped again', () => {
    expect(toggleOption(size, { 'g-size': ['o-big'] }, 'o-big')).toEqual([]);
  });

  it('accumulates in a multi-select group', () => {
    expect(toggleOption(extras, { 'g-extras': ['o-cheese'] }, 'o-bacon')).toEqual(['o-cheese', 'o-bacon']);
  });

  it('removes a picked option in a multi-select group', () => {
    expect(toggleOption(extras, { 'g-extras': ['o-cheese', 'o-bacon'] }, 'o-cheese')).toEqual(['o-bacon']);
  });

  it('refuses to exceed max_select rather than dropping an earlier pick', () => {
    const full = { 'g-extras': ['o-cheese', 'o-bacon'] };
    expect(toggleOption(extras, full, 'o-egg')).toEqual(['o-cheese', 'o-bacon']);
  });

  it('treats a multiple group capped at one as single-select', () => {
    const capped: ModifierGroup = { ...extras, selection_type: 'multiple', max_select: 1 };
    expect(toggleOption(capped, { 'g-extras': ['o-cheese'] }, 'o-bacon')).toEqual(['o-bacon']);
  });
});

describe('lineSignature', () => {
  const mods = (...ids: string[]) =>
    ids.map((id) => ({ group_id: 'g', group_name: 'G', option_id: id, option_name: id, price_delta: 0 }));

  it('matches the same item configured the same way', () => {
    expect(lineSignature('i1', mods('a', 'b'))).toBe(lineSignature('i1', mods('a', 'b')));
  });

  it('does not care what order the options were tapped in', () => {
    expect(lineSignature('i1', mods('b', 'a'))).toBe(lineSignature('i1', mods('a', 'b')));
  });

  it('separates two burgers with different options', () => {
    expect(lineSignature('i1', mods('a'))).not.toBe(lineSignature('i1', mods('b')));
  });

  it('separates the same options with a different note', () => {
    expect(lineSignature('i1', mods('a'), 'no salt')).not.toBe(lineSignature('i1', mods('a')));
  });

  it('treats a blank or whitespace note as no note', () => {
    expect(lineSignature('i1', mods('a'), '  ')).toBe(lineSignature('i1', mods('a')));
    expect(lineSignature('i1', mods('a'), null)).toBe(lineSignature('i1', mods('a')));
  });

  it('separates different items', () => {
    expect(lineSignature('i1', [])).not.toBe(lineSignature('i2', []));
  });

  it('counts a repeated option once', () => {
    expect(lineSignature('i1', mods('a', 'a'))).toBe(lineSignature('i1', mods('a')));
  });

  it('is the key place-order consolidates on, built from option ids alone', () => {
    expect(optionLineSignature('i1', ['b', 'a'], ' no salt ')).toBe(lineSignature('i1', mods('a', 'b'), 'no salt'));
    expect(optionLineSignature('i1', undefined)).toBe(lineSignature('i1', []));
  });
});

describe('normalizeLineNotes', () => {
  it('trims, and reads blank or missing as no note', () => {
    expect(normalizeLineNotes('  extra rice ')).toBe('extra rice');
    expect(normalizeLineNotes('   ')).toBeUndefined();
    expect(normalizeLineNotes('')).toBeUndefined();
    expect(normalizeLineNotes(undefined)).toBeUndefined();
    expect(normalizeLineNotes(null)).toBeUndefined();
    // Not a string: nothing a kitchen can read.
    expect(normalizeLineNotes(42)).toBeUndefined();
  });
});

describe('distinctOptionIds', () => {
  it('drops repeats and keeps the order they were first chosen in', () => {
    expect(distinctOptionIds(['b', 'a', 'b'])).toEqual(['b', 'a']);
    expect(distinctOptionIds(undefined)).toEqual([]);
  });
});

describe('comboLineSignature', () => {
  it('is the combo and its trimmed note', () => {
    expect(comboLineSignature('c1')).toBe(comboLineSignature('c1', '  '));
    expect(comboLineSignature('c1', 'no ice')).toBe(comboLineSignature('c1', ' no ice '));
    expect(comboLineSignature('c1', 'no ice')).not.toBe(comboLineSignature('c1'));
    expect(comboLineSignature('c1')).not.toBe(comboLineSignature('c2'));
  });

  it('never matches a dish line, even one with the same id', () => {
    expect(comboLineSignature('x')).not.toBe(lineSignature('x', []));
  });
});

describe('mergeIdenticalLines', () => {
  const line = (id: string, key: string, quantity: number) => ({ id, key, quantity });

  it('folds later lines into the first of their key, which keeps its place and its fields', () => {
    const merged = mergeIdenticalLines(
      [line('1', 'a', 7), line('2', 'b', 1), line('3', 'a', 1), line('4', 'a', 2)],
      (l) => l.key,
    );
    expect(merged).toEqual([line('1', 'a', 10), line('2', 'b', 1)]);
  });

  it('hands back the same array when nothing was folded', () => {
    const lines = [line('1', 'a', 1), line('2', 'b', 1)];
    expect(mergeIdenticalLines(lines, (l) => l.key)).toBe(lines);
  });
});

describe('consolidateOrderLines', () => {
  it('bills SET A added from the Happy Hour strip and from the menu as one line', () => {
    const { items } = consolidateOrderLines([
      { menu_item_id: 'set-a', quantity: 7, modifier_option_ids: ['no-egg'] },
      { menu_item_id: 'tom-yum', quantity: 1 },
      { menu_item_id: 'set-a', quantity: 1, notes: '   ', modifier_option_ids: ['no-egg'] },
    ]);
    expect(items).toEqual([
      { menu_item_id: 'set-a', quantity: 8, notes: undefined, modifier_option_ids: ['no-egg'] },
      { menu_item_id: 'tom-yum', quantity: 1, notes: undefined, modifier_option_ids: [] },
    ]);
  });

  it('keeps different options, and different notes, on lines of their own', () => {
    // The bill the owner showed: seven with No Egg and one with the default fried egg (+$2.00).
    const { items } = consolidateOrderLines([
      { menu_item_id: 'set-a', quantity: 7, modifier_option_ids: ['no-egg'] },
      { menu_item_id: 'set-a', quantity: 1, modifier_option_ids: ['runny-egg'] },
      { menu_item_id: 'set-a', quantity: 1, notes: 'extra spicy', modifier_option_ids: ['no-egg'] },
    ]);
    expect(items.map((l) => [l.quantity, l.modifier_option_ids, l.notes])).toEqual([
      [7, ['no-egg'], undefined],
      [1, ['runny-egg'], undefined],
      [1, ['no-egg'], 'extra spicy'],
    ]);
  });

  it('ignores the order options were chosen in and drops a repeated option', () => {
    const { items } = consolidateOrderLines([
      { menu_item_id: 'pad-thai', quantity: 1, modifier_option_ids: ['chicken', 'medium'] },
      { menu_item_id: 'pad-thai', quantity: 2, modifier_option_ids: ['medium', 'chicken', 'medium'] },
    ]);
    expect(items).toEqual([
      { menu_item_id: 'pad-thai', quantity: 3, notes: undefined, modifier_option_ids: ['chicken', 'medium'] },
    ]);
  });

  it('merges identical combos, keeps combos with other notes apart, and trims notes', () => {
    const { combos } = consolidateOrderLines(
      [],
      [
        { combo_id: 'lunch', quantity: 1 },
        { combo_id: 'lunch', quantity: 2, notes: '' },
        { combo_id: 'lunch', quantity: 1, notes: ' no ice ' },
        { combo_id: 'dinner', quantity: 1 },
      ],
    );
    expect(combos).toEqual([
      { combo_id: 'lunch', quantity: 3, notes: undefined },
      { combo_id: 'lunch', quantity: 1, notes: 'no ice' },
      { combo_id: 'dinner', quantity: 1, notes: undefined },
    ]);
  });

  it('never merges a combo into a dish line', () => {
    const merged = consolidateOrderLines([{ menu_item_id: 'x', quantity: 1 }], [{ combo_id: 'x', quantity: 1 }]);
    expect(merged.items).toHaveLength(1);
    expect(merged.combos).toHaveLength(1);
  });

  it('adds up past MAX_LINE_QUANTITY rather than dropping units, and leaves the refusal to place-order', () => {
    // 60 + 50 of one combo is 110 of one selection. Clamping here would bill 99 for 110 ordered;
    // place-order refuses the folded line instead (invalid_quantity), and the carts never send one.
    const { items, combos } = consolidateOrderLines(
      [
        { menu_item_id: 'set-a', quantity: 60 },
        { menu_item_id: 'set-a', quantity: 50, notes: ' ' },
      ],
      [
        { combo_id: 'lunch', quantity: 60 },
        { combo_id: 'lunch', quantity: 50 },
      ],
    );
    expect(MAX_LINE_QUANTITY).toBe(99);
    expect(items.map((l) => l.quantity)).toEqual([110]);
    expect(combos.map((c) => c.quantity)).toEqual([110]);
  });
});
