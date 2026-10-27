import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DiscountCode } from '@favornoms/database/queries';
import type { BillingProduct } from '@favornoms/shared';
import {
  EMPTY_DRAFT,
  codeState,
  dateInputValue,
  draftFrom,
  draftToInput,
  draftToPatch,
  endsAtIso,
  normalizeCode,
  isReservedUse,
  oneTimeChargeKey,
  remainingRedemptions,
  reservationWait,
  splitRedemptions,
  startsAtIso,
  unsoldProducts,
  validateDraft,
  writeErrorKey,
  type DraftCode,
} from './discount-codes';

// A discount code is money the owner gives away, so the rules that decide whether
// one is worth sending are tested rather than eyeballed on the form.

const NOW = Date.parse('2026-09-23T12:00:00Z');

function code(over: Partial<DiscountCode> = {}): DiscountCode {
  return {
    id: 'c1',
    code: 'SUMMER20',
    description: '20% off to start',
    kind: 'percent',
    value: 20,
    product_codes: [],
    max_redemptions: null,
    redemption_count: 0,
    per_restaurant_limit: 1,
    starts_at: '2026-09-01T00:00:00.000Z',
    ends_at: null,
    is_active: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function draft(over: Partial<DraftCode> = {}): DraftCode {
  return { ...EMPTY_DRAFT, code: 'WELCOME', value: '20', ...over };
}

function product(over: Partial<BillingProduct> & { code: string }): BillingProduct {
  return {
    name: over.code,
    kind: 'addon',
    monthly_price: 0,
    one_time_price: 0,
    included_seats: 0,
    seats_per_unit: 1,
    trial_days: 0,
    is_quantity: false,
    features: {},
    stripe_price_id: null,
    is_active: true,
    sort_order: 0,
    description: null,
    ...over,
  };
}

describe('normalizeCode', () => {
  it('upper-cases and trims, exactly as the SQL compares', () => {
    expect(normalizeCode('  summer-20 ')).toBe('SUMMER-20');
  });
});

describe('validateDraft', () => {
  it('accepts a plain code', () => {
    expect(validateDraft(draft(), [])).toEqual([]);
  });

  it('refuses an empty code', () => {
    expect(validateDraft(draft({ code: '   ' }), [])).toContain('codeRequired');
  });

  it('refuses characters a merchant cannot retype', () => {
    expect(validateDraft(draft({ code: 'SUMMER 20' }), [])).toContain('codeCharset');
    expect(validateDraft(draft({ code: 'SUMMER_20' }), [])).toContain('codeCharset');
    expect(validateDraft(draft({ code: '-LEADING' }), [])).toContain('codeCharset');
    expect(validateDraft(draft({ code: 'A' }), [])).not.toContain('codeCharset');
    expect(validateDraft(draft({ code: 'A-1' }), [])).not.toContain('codeCharset');
  });

  it('caps a code at 40 characters, the most a Stripe line names', () => {
    const forty = 'GRAND-OPENING-2026-PARTNER-WELCOME-OFF50';
    expect(forty).toHaveLength(40);
    expect(validateDraft(draft({ code: forty }), [])).not.toContain('codeTooLong');
    expect(validateDraft(draft({ code: `${forty}X` }), [])).toContain('codeTooLong');
    // An existing code is never changed, so an older long one can still be edited.
    expect(validateDraft(draft({ code: `${forty}X` }), [`${forty}X`], `${forty}X`)).toEqual([]);
    // platform_create_discount_code's own refusal, for whatever reached it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeErrorKey('code_too_long')).toBe('discounts.errors.codeTooLong');
    spy.mockRestore();
  });

  it('refuses a duplicate, whatever case it was typed in', () => {
    expect(validateDraft(draft({ code: 'summer20' }), ['SUMMER20'])).toContain('codeDuplicate');
  });

  it('does not call a code a duplicate of itself while editing it', () => {
    expect(validateDraft(draft({ code: 'SUMMER20' }), ['SUMMER20'], 'SUMMER20')).toEqual([]);
  });

  it('insists on a value above zero', () => {
    expect(validateDraft(draft({ value: '' }), [])).toContain('valueRequired');
    expect(validateDraft(draft({ value: '0' }), [])).toContain('valueRequired');
    expect(validateDraft(draft({ value: '-5' }), [])).toContain('valueRequired');
  });

  it('caps a percentage at 100 but lets a fixed amount be large', () => {
    expect(validateDraft(draft({ kind: 'percent', value: '120' }), [])).toContain('percentRange');
    expect(validateDraft(draft({ kind: 'fixed', value: '120' }), [])).not.toContain('percentRange');
  });

  it('refuses a fractional or zero cap', () => {
    expect(validateDraft(draft({ maxRedemptions: '2.5' }), [])).toContain('maxRedemptions');
    expect(validateDraft(draft({ maxRedemptions: '0' }), [])).toContain('maxRedemptions');
    expect(validateDraft(draft({ maxRedemptions: '' }), [])).not.toContain('maxRedemptions');
  });

  it('refuses a per-restaurant limit below one', () => {
    expect(validateDraft(draft({ perRestaurantLimit: '0' }), [])).toContain('perRestaurantLimit');
    expect(validateDraft(draft({ perRestaurantLimit: '' }), [])).toContain('perRestaurantLimit');
  });

  it('refuses a window that ends before it starts', () => {
    const bad = draft({ startsAt: '2026-10-01', endsAt: '2026-09-30' });
    expect(validateDraft(bad, [])).toContain('datesBackwards');
  });

  it('allows a one-day window, because the end is the end of that day', () => {
    const sameDay = draft({ startsAt: '2026-10-01', endsAt: '2026-10-01' });
    expect(validateDraft(sameDay, [])).not.toContain('datesBackwards');
  });

  it('has a message for every problem it can report, in every language', () => {
    const problems = [
      'codeRequired',
      'codeCharset',
      'codeDuplicate',
      'valueRequired',
      'percentRange',
      'maxRedemptions',
      'perRestaurantLimit',
      'datesBackwards',
      'kindInvalid',
      'notFound',
    ];
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const file = path.resolve(__dirname, '../../../../../messages', locale, 'platformBilling.json');
      const tree = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        discounts: { errors: Record<string, string> };
      };
      for (const key of problems) {
        expect(tree.discounts.errors[key], `${locale}.discounts.errors.${key}`).toBeTruthy();
      }
    }
  });
});

describe('the window a picked day means', () => {
  it('starts at the beginning of the day, in UTC', () => {
    expect(startsAtIso('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('ends at the END of the day, so the last day still works', () => {
    // billing_discount_quote refuses once now() > ends_at; midnight would kill the
    // code on the morning of the day the operator picked as its last.
    expect(endsAtIso('2026-10-31')).toBe('2026-10-31T23:59:59.999Z');
  });

  it('reads blanks as no bound', () => {
    expect(startsAtIso('')).toBeNull();
    expect(endsAtIso('   ')).toBeNull();
  });

  it('round-trips an instant back into the date input', () => {
    expect(dateInputValue('2026-10-31T23:59:59.999Z')).toBe('2026-10-31');
    expect(dateInputValue(null)).toBe('');
    expect(dateInputValue('not a date')).toBe('');
  });
});

describe('draftToInput', () => {
  it('sends every key, so a cleared end date is actually cleared', () => {
    // platform_update_discount_code leaves an ABSENT key alone, so a deleted end
    // date has to arrive as an explicit null.
    const input = draftToInput(draft({ endsAt: '', maxRedemptions: '' }));
    expect(input.ends_at).toBeNull();
    expect(input.max_redemptions).toBeNull();
    expect('ends_at' in input).toBe(true);
    expect('max_redemptions' in input).toBe(true);
  });

  it('upper-cases the code and drops an empty description', () => {
    const input = draftToInput(draft({ code: ' welcome ', description: '  ' }));
    expect(input.code).toBe('WELCOME');
    expect(input.description).toBeNull();
  });

  it('defaults the start to now when none was picked', () => {
    const input = draftToInput(draft({ startsAt: '' }));
    expect(Number.isFinite(Date.parse(input.starts_at as string))).toBe(true);
  });

  it('never sends a per-restaurant limit below one', () => {
    expect(draftToInput(draft({ perRestaurantLimit: '0' })).per_restaurant_limit).toBe(1);
  });

  it('leaves the code out of an edit, which cannot rename it', () => {
    const opened = draft({ code: 'WELCOME' });
    const patch = draftToPatch({ ...opened, code: 'RENAMED', value: '25' }, opened);
    expect('code' in patch).toBe(false);
    expect(patch.value).toBe(25);
  });
});

describe('draftToPatch', () => {
  // An edit sends only what the operator changed: platform_update_discount_code leaves an absent
  // key alone, so nothing the form did not touch can be overwritten.
  const original = code({
    starts_at: '2026-09-23T15:17:32.312Z',
    ends_at: '2026-10-31T23:59:59.999Z',
    max_redemptions: 10,
    product_codes: ['base', 'extra_branch'],
  });

  it('sends nothing when nothing changed', () => {
    expect(draftToPatch(draftFrom(original), draftFrom(original))).toEqual({});
  });

  it('keeps the start time: a save does not move it to midnight', () => {
    const opened = draftFrom(original);
    const patch = draftToPatch({ ...opened, description: 'Autumn promo' }, opened);
    expect(patch).toEqual({ description: 'Autumn promo' });
    expect('starts_at' in patch).toBe(false);
  });

  it('does not send the switch back unless the operator flipped it', () => {
    // Operator A opened the form while the code was on; B switched it off meanwhile. A's save
    // of a new end date must not switch it on again.
    const opened = draftFrom(original);
    const patch = draftToPatch({ ...opened, endsAt: '2026-11-30' }, opened);
    expect('is_active' in patch).toBe(false);
    expect(patch.ends_at).toBe('2026-11-30T23:59:59.999Z');
    expect(draftToPatch({ ...opened, isActive: false }, opened)).toEqual({ is_active: false });
  });

  it('clears an end date with an explicit null', () => {
    const opened = draftFrom(original);
    const patch = draftToPatch({ ...opened, endsAt: '' }, opened);
    expect(patch).toEqual({ ends_at: null });
  });

  it('moves the start only when another day is picked, and blank means now', () => {
    const opened = draftFrom(original);
    expect(draftToPatch({ ...opened, startsAt: '2026-10-01' }, opened)).toEqual({
      starts_at: '2026-10-01T00:00:00.000Z',
    });
    const cleared = draftToPatch({ ...opened, startsAt: '' }, opened);
    expect(Number.isFinite(Date.parse(cleared.starts_at as string))).toBe(true);
  });

  it('sends kind and value together, since one means nothing without the other', () => {
    const opened = draftFrom(original);
    expect(draftToPatch({ ...opened, kind: 'fixed' }, opened)).toEqual({ kind: 'fixed', value: 20 });
    expect(draftToPatch({ ...opened, value: '30' }, opened)).toEqual({ kind: 'percent', value: 30 });
  });

  it('reads the product list as a set, and clears the cap with a null', () => {
    const opened = draftFrom(original);
    expect(draftToPatch({ ...opened, productCodes: ['extra_branch', 'base'] }, opened)).toEqual({});
    expect(draftToPatch({ ...opened, productCodes: ['base'] }, opened)).toEqual({
      product_codes: ['base'],
    });
    expect(draftToPatch({ ...opened, maxRedemptions: '' }, opened)).toEqual({
      max_redemptions: null,
    });
    expect(draftToPatch({ ...opened, perRestaurantLimit: '2' }, opened)).toEqual({
      per_restaurant_limit: 2,
    });
  });

  it('round-trips an existing code through the form', () => {
    const original = code({
      max_redemptions: 50,
      ends_at: '2026-12-31T23:59:59.999Z',
      product_codes: ['base', 'extra_branch'],
    });
    const input = draftToInput(draftFrom(original));
    expect(input.code).toBe('SUMMER20');
    expect(input.kind).toBe('percent');
    expect(input.value).toBe(20);
    expect(input.product_codes).toEqual(['base', 'extra_branch']);
    expect(input.max_redemptions).toBe(50);
    expect(input.ends_at).toBe('2026-12-31T23:59:59.999Z');
  });
});

describe('codeState', () => {
  it('is live inside its window', () => {
    expect(codeState(code(), NOW)).toBe('live');
  });

  it('reports the same refusal the server would, in the same order', () => {
    expect(codeState(code({ is_active: false }), NOW)).toBe('inactive');
    expect(codeState(code({ starts_at: '2026-10-01T00:00:00Z' }), NOW)).toBe('scheduled');
    expect(codeState(code({ ends_at: '2026-09-01T00:00:00Z' }), NOW)).toBe('expired');
    expect(codeState(code({ max_redemptions: 2, redemption_count: 2 }), NOW)).toBe('exhausted');
  });

  it('calls a deactivated, expired code inactive: that is the one an operator can undo', () => {
    expect(codeState(code({ is_active: false, ends_at: '2026-09-01T00:00:00Z' }), NOW)).toBe(
      'inactive',
    );
  });
});

describe('remainingRedemptions', () => {
  it('is null when there is no cap', () => {
    expect(remainingRedemptions(code())).toBeNull();
  });

  it('never goes below zero', () => {
    expect(remainingRedemptions(code({ max_redemptions: 5, redemption_count: 2 }))).toBe(3);
    expect(remainingRedemptions(code({ max_redemptions: 5, redemption_count: 9 }))).toBe(0);
  });
});

describe('splitRedemptions', () => {
  // A use is reserved when the merchant SENDS a request with the code, kept on approval and
  // given back on rejection or replacement. Until the request is decided the money has not
  // been given away, and the card must not say it has.
  const rows = [
    { request_id: 'approved-1', amount_off: 50 },
    { request_id: 'pending-1', amount_off: 25 },
    { request_id: null, amount_off: 10 },
  ];

  it('counts a use on a pending request as reserved, not given away', () => {
    expect(splitRedemptions(rows, new Set(['pending-1']))).toEqual({ given: 60, reserved: 25 });
  });

  it('counts every use as given once nothing is pending', () => {
    expect(splitRedemptions(rows, new Set())).toEqual({ given: 85, reserved: 0 });
  });

  it('takes the server’s own mark over the pending queue when the row carries one', () => {
    const marked = [
      { request_id: 'pending-1', amount_off: 25, status: 'redeemed' },
      { request_id: 'approved-1', amount_off: 50, status: 'reserved' },
    ];
    expect(splitRedemptions(marked, new Set(['pending-1']))).toEqual({ given: 25, reserved: 50 });
    expect(isReservedUse({ request_id: null, amount_off: 5, status: 'reserved' }, new Set())).toBe(
      true,
    );
  });

  it('never lets a malformed amount move either total', () => {
    expect(
      splitRedemptions(
        [
          { request_id: 'pending-1', amount_off: Number.NaN },
          { request_id: 'x', amount_off: -5 },
        ],
        new Set(['pending-1']),
      ),
    ).toEqual({ given: 0, reserved: 0 });
  });

  it('has the words for a reservation in every language', () => {
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const tree = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../../../../messages', locale, 'platformBilling.json'),
          'utf8',
        ),
      ) as {
        discounts: Record<string, unknown>;
        requests: Record<string, unknown>;
      };
      expect(tree.discounts.reserved, `${locale}.discounts.reserved`).toBeTruthy();
      expect(tree.discounts.reservedNote, `${locale}.discounts.reservedNote`).toContain('{amount}');
      expect(tree.requests.keepsCode, `${locale}.requests.keepsCode`).toContain('{code}');
    }
  });
});

describe('writeErrorKey', () => {
  it('turns the unique index into a sentence about the code', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeErrorKey('duplicate key value violates unique constraint "billing_discount_codes_code_key"'),
    ).toBe('discounts.errors.codeDuplicate');
    expect(writeErrorKey('code_not_found')).toBe('discounts.errors.notFound');
    expect(writeErrorKey('kind_invalid')).toBe('discounts.errors.kindInvalid');
    expect(writeErrorKey('permission denied for function')).toBe('errors.permission');
    expect(writeErrorKey('Failed to fetch')).toBe('errors.network');
    expect(writeErrorKey('unheard of')).toBe('errors.saveFailed');
    spy.mockRestore();
  });

  it('turns the server’s own validation codes into the form’s sentences', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeErrorKey('code_invalid_chars')).toBe('discounts.errors.codeCharset');
    expect(writeErrorKey('product_not_one_time:delivery')).toBe('discounts.errors.productNotOneTime');
    expect(writeErrorKey('ends_before_start')).toBe('discounts.errors.datesBackwards');
    expect(writeErrorKey('per_restaurant_limit_invalid')).toBe('discounts.errors.perRestaurantLimit');
    expect(
      writeErrorKey(
        'new row for relation "billing_discount_codes" violates check constraint "billing_discount_codes_percent_range"',
      ),
    ).toBe('discounts.errors.percentRange');
    expect(
      writeErrorKey(
        'new row for relation "billing_discount_codes" violates check constraint "billing_discount_codes_value_check"',
      ),
    ).toBe('discounts.errors.valueRequired');
    spy.mockRestore();
  });

  it('only ever answers with a key every language has', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raws = [
      undefined,
      'duplicate key',
      'kind_invalid',
      'code_required',
      'code_invalid_chars',
      'product_not_one_time',
      'ends_before_start',
      'per_restaurant_limit_invalid',
      'billing_discount_codes_percent_range',
      'billing_discount_codes_value_check',
      'billing_discount_codes_max_redemptions_check',
      'code_not_found',
      'forbidden',
      'Failed to fetch',
      'unheard of',
    ];
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const tree = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../../../../messages', locale, 'platformBilling.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      for (const raw of raws) {
        const key = writeErrorKey(raw);
        const value = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], tree);
        expect(typeof value, `${locale}.${key}`).toBe('string');
      }
    }
    spy.mockRestore();
  });
});

describe('unsoldProducts', () => {
  const catalog = [
    product({ code: 'base', kind: 'plan', one_time_price: 199 }),
    product({ code: 'extra_branch', kind: 'addon', one_time_price: 89 }),
    product({ code: 'delivery', kind: 'addon', one_time_price: 0, is_active: false }),
    product({ code: 'old_setup', kind: 'addon', one_time_price: 50, is_active: false }),
  ];

  it('finds the products a code names that are not sold one-time any more', () => {
    expect(unsoldProducts(['base', 'delivery'], catalog)).toEqual(['delivery']);
    expect(unsoldProducts(['old_setup', 'gone'], catalog)).toEqual(['old_setup', 'gone']);
  });

  it('is empty for a code on today’s charges, or on every charge', () => {
    expect(unsoldProducts(['base', 'extra_branch'], catalog)).toEqual([]);
    expect(unsoldProducts([], catalog)).toEqual([]);
  });

  it('calls nothing unsold when the catalog could not be read', () => {
    // listBillingProducts answers a failed read with []; the real catalog always holds the plan.
    expect(unsoldProducts(['extra_branch'], [])).toEqual([]);
  });
});

describe('oneTimeChargeKey', () => {
  it('names the charge a code comes off, as the plan page does', () => {
    expect(oneTimeChargeKey({ code: 'base', kind: 'plan', one_time_price: 199 })).toBe('firstSetup');
    expect(oneTimeChargeKey({ code: 'extra_branch', kind: 'addon', one_time_price: 89 })).toBe(
      'extraBranch',
    );
  });

  it('keeps the catalog’s name for anything else', () => {
    expect(oneTimeChargeKey({ code: 'trial', kind: 'plan', one_time_price: 0 })).toBeNull();
    expect(oneTimeChargeKey({ code: 'delivery', kind: 'addon', one_time_price: 0 })).toBeNull();
  });

  it('has both names in every language', () => {
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const tree = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../../../../messages', locale, 'platformBilling.json'),
          'utf8',
        ),
      ) as { discounts: { charge: Record<string, string> } };
      expect(tree.discounts.charge.firstSetup, locale).toBeTruthy();
      expect(tree.discounts.charge.extraBranch, locale).toBeTruthy();
    }
  });
});

describe('reservationWait', () => {
  const pending = new Set(['manual-1', 'card-1']);
  const card = new Set(['card-1']);

  it('says a card request waits for its payment, not for anyone’s approval', () => {
    expect(reservationWait({ request_id: 'card-1' }, pending, card)).toBe('payment');
    expect(reservationWait({ request_id: 'manual-1' }, pending, card)).toBe('approval');
  });

  it('does not guess for a request the page did not read', () => {
    expect(reservationWait({ request_id: 'elsewhere' }, pending, card)).toBe('open');
    expect(reservationWait({ request_id: null }, pending, card)).toBe('open');
  });

  it('has a badge for each in every language', () => {
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const tree = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../../../../messages', locale, 'platformBilling.json'),
          'utf8',
        ),
      ) as { discounts: Record<string, string> };
      for (const key of ['reserved', 'reservedPayment', 'reservedOpen']) {
        expect(tree.discounts[key], `${locale}.discounts.${key}`).toBeTruthy();
      }
    }
  });
});
