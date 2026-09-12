import { describe, expect, it } from 'vitest';
import {
  defaultSelections,
  flattenSelections,
  lineSignature,
  modifierDelta,
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
});
