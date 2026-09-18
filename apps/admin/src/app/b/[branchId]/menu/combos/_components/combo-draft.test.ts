import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT,
  dishState,
  draftAfterRefetch,
  draftFromCombo,
  draftProblems,
  listPriceTotal,
  moveEntry,
  normalizeDraft,
  parsePrice,
  sameDraft,
  saveComboArgs,
  type ComboMenuItem,
} from './combo-draft';
import { comboErrorKey, type ComboErrorKey } from './combo-errors';

const dish = (over: Partial<ComboMenuItem> = {}): ComboMenuItem => ({
  id: 'a',
  name: 'Green Curry',
  price: '14.95',
  image_url: null,
  is_active: true,
  track_stock: false,
  stock_quantity: null,
  sold_out_until: null,
  ...over,
});

describe('parsePrice', () => {
  it('accepts positive amounts with up to two decimals, comma or point', () => {
    expect(parsePrice('25.99')).toBe(25.99);
    expect(parsePrice(' 17 ')).toBe(17);
    expect(parsePrice('12.')).toBe(12);
    expect(parsePrice('.5')).toBe(0.5);
    expect(parsePrice('9,5')).toBe(9.5);
  });

  it('refuses empty, zero, negative and malformed input', () => {
    for (const raw of ['', ' ', '0', '0.00', '-3', 'abc', '1.234', '1e3', '1.2.3']) {
      expect(parsePrice(raw)).toBeNull();
    }
  });
});

describe('draftProblems', () => {
  it('needs a name and a price above zero', () => {
    expect(draftProblems(EMPTY_DRAFT)).toEqual(['nameRequired', 'priceInvalid']);
    expect(draftProblems({ ...EMPTY_DRAFT, name: 'Family Meal', price: '25.99' })).toEqual([]);
  });

  it('refuses an empty combo on sale, but not an empty one off sale', () => {
    const base = { ...EMPTY_DRAFT, name: 'Family Meal', price: '25.99' };
    expect(draftProblems({ ...base, isActive: true })).toEqual(['emptyActive']);
    expect(draftProblems({ ...base, isActive: true, items: [{ menu_item_id: 'a', quantity: 1 }] })).toEqual([]);
  });
});

describe('sameDraft', () => {
  it('notices quantity and order changes', () => {
    const a = { ...EMPTY_DRAFT, items: [{ menu_item_id: 'a', quantity: 1 }, { menu_item_id: 'b', quantity: 1 }] };
    expect(sameDraft(a, { ...a, items: [...a.items] })).toBe(true);
    expect(sameDraft(a, { ...a, items: [a.items[1]!, a.items[0]!] })).toBe(false);
    expect(sameDraft(a, { ...a, items: [{ menu_item_id: 'a', quantity: 2 }, a.items[1]!] })).toBe(false);
    expect(sameDraft(a, { ...a, imageUrl: 'https://x/y.png' })).toBe(false);
  });
});

describe('listPriceTotal', () => {
  it('sums list prices times quantity in cents, ignoring unknown dishes', () => {
    const menu = new Map([
      ['a', dish({ id: 'a', price: '13.95' })],
      ['b', dish({ id: 'b', price: 14.95 })],
    ]);
    expect(
      listPriceTotal(
        [
          { menu_item_id: 'a', quantity: 1 },
          { menu_item_id: 'b', quantity: 1 },
          { menu_item_id: 'gone', quantity: 3 },
        ],
        menu,
      ),
    ).toBe(28.9);
    expect(listPriceTotal([{ menu_item_id: 'a', quantity: 3 }], menu)).toBe(41.85);
  });
});

describe('dishState', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  it('matches the view: hidden, 86, short stock, missing', () => {
    expect(dishState(dish(), 1, now)).toBe('ok');
    expect(dishState(undefined, 1, now)).toBe('missing');
    expect(dishState(dish({ is_active: false }), 1, now)).toBe('hidden');
    expect(dishState(dish({ sold_out_until: '2026-09-18T13:00:00Z' }), 1, now)).toBe('soldOut');
    expect(dishState(dish({ sold_out_until: '2026-09-18T11:00:00Z' }), 1, now)).toBe('ok');
    expect(dishState(dish({ track_stock: true, stock_quantity: 1 }), 2, now)).toBe('soldOut');
    expect(dishState(dish({ track_stock: true, stock_quantity: 2 }), 2, now)).toBe('ok');
    expect(dishState(dish({ track_stock: true, stock_quantity: null }), 1, now)).toBe('soldOut');
  });
});

describe('draftFromCombo / saveComboArgs', () => {
  const record = {
    id: 'c1',
    name: 'Family Meal',
    description: null,
    total_price: '17.00',
    image_url: null,
    is_active: true,
    archived_at: null,
    display_order: 0,
    created_at: '2026-09-18T00:00:00Z',
    combo_items: [
      { menu_item_id: 'b', quantity: 2, position: 1 },
      { menu_item_id: 'a', quantity: 1, position: 0 },
    ],
  };

  it('opens a saved combo with its dishes in their saved order and the price as typed', () => {
    const draft = draftFromCombo(record);
    expect(draft).toEqual({
      name: 'Family Meal',
      description: '',
      price: '17.00',
      imageUrl: null,
      isActive: true,
      items: [
        { menu_item_id: 'a', quantity: 1 },
        { menu_item_id: 'b', quantity: 2 },
      ],
    });
    // An untouched card is not "unsaved".
    expect(sameDraft(draft, draftFromCombo({ ...record }))).toBe(true);
  });

  it('normalises a draft the way the server stores it', () => {
    const typed = { ...draftFromCombo(record), name: '  RV Test  ', description: ' two dishes ', price: '259' };
    expect(normalizeDraft(typed)).toEqual({ ...typed, name: 'RV Test', description: 'two dishes', price: '259.00' });
    expect(normalizeDraft({ ...typed, price: '12,5' }).price).toBe('12.50');
    // An unparsable price is left as typed; validation reports it.
    expect(normalizeDraft({ ...typed, price: 'abc' }).price).toBe('abc');
  });

  it('takes the refetched row after its own save, whatever format was typed', () => {
    const before = draftFromCombo(record);
    const typed = { ...before, name: ' Family Meal 2 ', price: '259' };
    const after = { ...before, name: 'Family Meal 2', price: '259.00' };
    // Right after the save: the card is clean again.
    expect(draftAfterRefetch(typed, before, after, normalizeDraft(typed))).toBe(after);
    expect(sameDraft(draftAfterRefetch(typed, before, after, normalizeDraft(typed)), after)).toBe(true);
    // An edit typed while the save was in flight survives the refetch, still unsaved.
    const edited = { ...typed, description: 'with rice' };
    expect(draftAfterRefetch(edited, before, after, normalizeDraft(typed))).toBe(edited);
    // Someone else's save: an untouched card follows it, an edited card keeps its edits.
    expect(draftAfterRefetch(before, before, after, null)).toBe(after);
    expect(draftAfterRefetch(typed, before, after, null)).toBe(typed);
  });

  it('sends the whole card, trimmed, with a null id for a new combo', () => {
    const draft = { ...draftFromCombo(record), name: '  Thai Duo ', description: ' ', price: '19,5' };
    expect(saveComboArgs('br', null, draft)).toEqual({
      p_branch_id: 'br',
      p_combo_id: null,
      p_name: 'Thai Duo',
      p_description: '',
      p_total_price: 19.5,
      p_image_url: '',
      p_is_active: true,
      p_items: [
        { menu_item_id: 'a', quantity: 1 },
        { menu_item_id: 'b', quantity: 2 },
      ],
    });
    expect(saveComboArgs('br', 'c1', draft).p_combo_id).toBe('c1');
  });
});

describe('moveEntry', () => {
  it('moves one place and stays put at the ends', () => {
    expect(moveEntry(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveEntry(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveEntry(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveEntry(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('comboErrorKey', () => {
  it('names the refusals save_combo raises', () => {
    expect(comboErrorKey({ code: '23514', message: 'combo_item_branch_mismatch' })).toBe('combos.errors.itemOtherBranch');
    expect(comboErrorKey({ code: '23514', message: 'combo_empty' })).toBe('combos.errors.emptyActive');
    expect(comboErrorKey({ code: '23514', message: 'combo_price_invalid' })).toBe('combos.errors.priceInvalid');
    expect(comboErrorKey({ code: '23514', message: 'combo_name_required' })).toBe('combos.errors.nameRequired');
    expect(comboErrorKey({ code: '23514', message: 'combo_quantity_invalid' })).toBe('combos.errors.quantityInvalid');
    expect(comboErrorKey({ code: '23505', message: 'combo_item_duplicate' })).toBe('combos.errors.itemDuplicate');
    expect(comboErrorKey({ code: '22023', message: 'combo_image_invalid' })).toBe('combos.errors.imageInvalid');
    expect(comboErrorKey({ code: 'P0002', message: 'combo_not_found' })).toBe('combos.errors.notFound');
    expect(comboErrorKey({ code: '55000', message: 'combo_archived' })).toBe('combos.errors.archived');
  });

  it('maps permission, network and generic failures', () => {
    expect(comboErrorKey({ code: '42501', message: 'not_authorized' })).toBe('errors.permissionDenied');
    expect(comboErrorKey({ message: 'new row violates row-level security policy' })).toBe('errors.permissionDenied');
    expect(comboErrorKey(new TypeError('Failed to fetch'))).toBe('errors.network');
    expect(comboErrorKey({ code: '23503', message: 'violates foreign key constraint' })).toBe('errors.inUse');
    expect(comboErrorKey({ code: '22P02', message: 'invalid input syntax for type uuid' })).toBe('errors.invalidValue');
    expect(comboErrorKey({ code: 'XX000', message: 'boom' })).toBe('errors.generic');
    expect(comboErrorKey(null)).toBe('errors.generic');
  });

  it('every key it can return exists in all four locales', () => {
    const keys: ComboErrorKey[] = [
      'combos.errors.nameRequired',
      'combos.errors.priceInvalid',
      'combos.errors.quantityInvalid',
      'combos.errors.emptyActive',
      'combos.errors.itemOtherBranch',
      'combos.errors.itemDuplicate',
      'combos.errors.imageInvalid',
      'combos.errors.notFound',
      'combos.errors.archived',
      'errors.permissionDenied',
      'errors.network',
      'errors.duplicate',
      'errors.inUse',
      'errors.invalidValue',
      'errors.generic',
    ];
    for (const locale of ['en', 'th', 'es', 'vi']) {
      const file = path.resolve(__dirname, `../../../../../../../messages/${locale}/menuExtras.json`);
      const messages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const key of keys) {
        const value = key.split('.').reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          messages,
        );
        expect(typeof value, `${locale} menuExtras.${key}`).toBe('string');
      }
    }
  });
});
