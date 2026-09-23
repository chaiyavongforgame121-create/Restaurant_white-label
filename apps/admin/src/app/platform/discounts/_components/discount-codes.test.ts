import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DiscountCode } from '@favornoms/database/queries';
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
  remainingRedemptions,
  splitRedemptions,
  startsAtIso,
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
    const patch = draftToPatch(draft({ code: 'WELCOME' }));
    expect('code' in patch).toBe(false);
    // Everything else still travels, nulls included.
    expect('ends_at' in patch).toBe(true);
    expect(patch.value).toBe(20);
  });

  it('round-trips an existing code through the form', () => {
    const original = code({
      max_redemptions: 50,
      ends_at: '2026-12-31T23:59:59.999Z',
      product_codes: ['base', 'delivery'],
    });
    const input = draftToInput(draftFrom(original));
    expect(input.code).toBe('SUMMER20');
    expect(input.kind).toBe('percent');
    expect(input.value).toBe(20);
    expect(input.product_codes).toEqual(['base', 'delivery']);
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
});
