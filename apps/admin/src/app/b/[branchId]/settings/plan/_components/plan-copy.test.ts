// What the plan page is allowed to SAY, as opposed to what it works out.
//
// Each case here is a sentence a merchant read on screen that was not true, so the test is
// written as "the page must not claim X" rather than as an assertion about a return value.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discountReasonMessage } from '@favornoms/shared';
import {
  codeNeedsApplying,
  discountAfterTyping,
  filedFacts,
  filedRequest,
  payOnceView,
  requestErrorMessage,
  showsFiledRequest,
  type FiledRequest,
} from './plan-copy';
import { selectionKey, submittableCode, type AppliedDiscount } from './plan-model';

const LOCALES = ['en', 'th', 'es', 'vi'] as const;

/** The shipped message file, read from disk so the test cannot drift from what is deployed. */
const messages = (locale: string, file: string): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../../../messages', locale, `${file}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>;

const BRANCH = 'a43b1f08-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

// The row request_package_change writes for a trialing tenant converting to Base with delivery
// on its only branch: $228 + $59 once, priced against what was PAID — nothing, on a trial.
const ROW = {
  id: 'req-1',
  plan_code: 'base',
  branch_seats: 1,
  delivery_branch_ids: [BRANCH],
  one_time_total: 287,
  discount_code: null,
  discount_amount: 0,
  monthly_total: 58,
  created_at: '2026-09-23T08:00:00Z',
};

const selection = { planCode: 'base', branchSeats: 1, deliveryBranchIds: [BRANCH] };

// --- the Pay-once box after a request is filed -------------------------------

describe('the Pay-once box never says "already paid" for money nobody has taken', () => {
  it('shows the filed request’s own total while it waits, whatever the page would quote', () => {
    // Bought means paid: the request's charges are pending, so the ledger still owes the
    // $287 and the page's own quote has lines. The box repeats the request, not the quote.
    const filed = filedRequest(ROW);
    const view = payOnceView({
      filed,
      showingFiled: showsFiledRequest(selection, filed, null),
      quoteLines: 2,
    });
    expect(view).toEqual({ kind: 'filed', list: 287, discount: 0, code: null, total: 287 });
  });

  it('shows it even when the ledger has hidden every line', () => {
    // The state the live trialing tenants were left in while pending charges still counted
    // as bought: no lines, and the box said "Nothing. Everything … is already paid for."
    const filed = filedRequest(ROW);
    expect(payOnceView({ filed, showingFiled: true, quoteLines: 0 }).kind).toBe('filed');
  });

  it('shows the list price, the code and what is left when the request carried a discount', () => {
    const filed = filedRequest({
      ...ROW,
      one_time_total: 237,
      discount_code: 'welcome50',
      discount_amount: 50,
    });
    expect(payOnceView({ filed, showingFiled: true, quoteLines: 2 })).toEqual({
      kind: 'filed',
      list: 287,
      discount: 50,
      code: 'WELCOME50',
      total: 237,
    });
  });

  it('keeps "nothing" for a merchant who really owes nothing once', () => {
    expect(payOnceView({ filed: null, showingFiled: false, quoteLines: 0 })).toEqual({
      kind: 'nothing',
    });
    // A request that only turns delivery off at a branch: $0 once, priced against what was paid.
    const filed = filedRequest({ ...ROW, one_time_total: 0, delivery_branch_ids: [] });
    expect(payOnceView({ filed, showingFiled: true, quoteLines: 0 })).toEqual({ kind: 'nothing' });
  });

  it('quotes a DIFFERENT selection afresh: sending it replaces the waiting request', () => {
    // request_package_change withdraws the waiting request before pricing the new one, so
    // the page's quote is what the replacement will cost.
    const filed = filedRequest(ROW);
    const other = { ...selection, branchSeats: 2 };
    expect(showsFiledRequest(other, filed, null)).toBe(false);
    expect(payOnceView({ filed, showingFiled: false, quoteLines: 3 })).toEqual({ kind: 'quote' });
  });

  it('does not mistake a refusal for a filed request', () => {
    // request_package_change answers a refused code with {ok:false, error:…} rather than
    // raising; read as a request row that is a row with no id and no plan. Showing it as
    // "waiting for the Favornoms team" would tell the merchant a request exists that does not.
    const refusal = { id: '', plan_code: '', branch_seats: 1, delivery_branch_ids: [] };
    expect(filedRequest(refusal)).toBeNull();
  });

  it('never invents a negative or a stray total from a malformed row', () => {
    const filed = filedRequest({ ...ROW, one_time_total: -5, discount_amount: Number.NaN });
    expect(filed?.oneTimeTotal).toBe(0);
    expect(filed?.discountAmount).toBe(0);
    expect(filedRequest({ ...ROW, plan_code: '' })).toBeNull();
    expect(filedRequest(null)).toBeNull();
  });
});

describe('the request on screen is the request that was sent', () => {
  const filed = filedRequest({ ...ROW, discount_code: 'WELCOME50', discount_amount: 50 });

  it('is the same request with the same selection, with or without its code re-applied', () => {
    expect(showsFiledRequest(selection, filed, null)).toBe(true);
    expect(showsFiledRequest(selection, filed, 'welcome50')).toBe(true);
  });

  it('is a new request once a code it does not carry is applied', () => {
    // A merchant who forgot their code types it in: the button must offer to replace the
    // waiting request instead of staying on "Request pending".
    expect(showsFiledRequest(selection, filed, 'SAVE99')).toBe(false);
    const noCode = filedRequest(ROW);
    expect(showsFiledRequest(selection, noCode, 'WELCOME50')).toBe(false);
  });

  it('matches whatever order the delivery ids come back in', () => {
    const two = filedRequest({ ...ROW, branch_seats: 2, delivery_branch_ids: [OTHER, BRANCH] });
    expect(
      showsFiledRequest({ planCode: 'base', branchSeats: 2, deliveryBranchIds: [BRANCH, OTHER] }, two, null),
    ).toBe(true);
  });
});

describe('the waiting request is summarised in its own figures', () => {
  it('repeats the stored monthly total, not the catalog’s', () => {
    const filed = filedRequest({ ...ROW, monthly_total: 58 }) as FiledRequest;
    const facts = filedFacts(filed, [
      { id: BRANCH, name: 'Main', deliveryActive: true, deliveryUnlocked: false },
      { id: OTHER, name: 'Riverside', deliveryActive: false, deliveryUnlocked: false },
    ]);
    expect(facts).toEqual({ branches: 1, deliveryNames: ['Main'], monthlyTotal: 58 });
  });
});

// --- the discount code -------------------------------------------------------

const two = { planCode: 'base', branchSeats: 2, deliveryBranchIds: ['b1'] };
const three = { planCode: 'base', branchSeats: 3, deliveryBranchIds: ['b1'] };
const quote = (code: string, key: string): AppliedDiscount => ({
  code,
  label: 'Launch offer',
  amountOff: 50,
  netTotal: 237,
  key,
});

describe('a typed discount code is never dropped in silence', () => {
  it('blocks the request when the merchant typed a code and never pressed Apply', () => {
    expect(codeNeedsApplying('WELCOME50', submittableCode(two, null))).toBe(true);
  });

  it('blocks it when the quote belongs to another selection', () => {
    const applied = quote('WELCOME50', selectionKey(three));
    expect(submittableCode(two, applied)).toBeNull();
    expect(codeNeedsApplying('WELCOME50', submittableCode(two, applied))).toBe(true);
  });

  it('lets an applied code through', () => {
    const applied = quote('WELCOME50', selectionKey(two));
    expect(codeNeedsApplying('WELCOME50', submittableCode(two, applied))).toBe(false);
  });

  it('lets an empty box through — most merchants have no code', () => {
    expect(codeNeedsApplying('', null)).toBe(false);
    expect(codeNeedsApplying('   ', null)).toBe(false);
  });
});

describe('the code in the box is the code that is applied', () => {
  const applied = quote('WELCOME50', selectionKey(two));

  it('drops the quote once the typed code no longer matches it', () => {
    // Applying WELCOME50 and then typing SAVE99 over it used to leave WELCOME50 discounting
    // the total and going out with the request.
    expect(discountAfterTyping(applied, 'SAVE99')).toBeNull();
    expect(discountAfterTyping(applied, 'WELCOME5')).toBeNull();
    expect(discountAfterTyping(applied, '')).toBeNull();
  });

  it('keeps it while the box still holds that code, however it was typed', () => {
    expect(discountAfterTyping(applied, 'WELCOME50')).toBe(applied);
    expect(discountAfterTyping(applied, ' welcome50 ')).toBe(applied);
  });

  it('is a no-op when nothing was applied', () => {
    expect(discountAfterTyping(null, 'SAVE99')).toBeNull();
  });
});

// --- a refused request -------------------------------------------------------

describe('a refused request says why in the shared words', () => {
  // A stand-in translator: it only has to prove WHICH key the page reached for.
  const t = (key: string) => `[${key}]`;

  it('routes every discount refusal through discountReasonMessage, never its own copy', () => {
    for (const locale of LOCALES) {
      for (const reason of ['invalid_code', 'code_expired', 'rate_limited']) {
        expect(requestErrorMessage(`discount_invalid:${reason}`, t, locale)).toBe(
          discountReasonMessage(reason, locale),
        );
      }
    }
  });

  it('treats the guessing limit as a discount refusal however the server words it', () => {
    // request_package_change and validate_billing_discount share one budget of failed code
    // checks; the refusal is about the code, not about the package.
    for (const raw of ['rate_limited:discount', 'rate_limited']) {
      expect(requestErrorMessage(raw, t, 'th')).toBe(discountReasonMessage('rate_limited', 'th'));
    }
  });

  it('keeps its own sentences for everything that is not a code', () => {
    expect(requestErrorMessage('forbidden', t, 'en')).toBe('[errors.forbidden]');
    expect(requestErrorMessage('unknown_plan:gold', t, 'en')).toBe('[errors.planUnavailable]');
    expect(requestErrorMessage(undefined, t, 'en')).toBe('[errors.sendFailed]');
    expect(requestErrorMessage('something odd', t, 'en')).toBe('[errors.sendFailed]');
  });
});

// --- the copy itself ---------------------------------------------------------

describe('the withdrawn AI Suite is not sold anywhere a merchant can read it', () => {
  // docs/PACKAGING-2026-09-23.md §1: the add-on is withdrawn and its product row deactivated.
  // The signup page is the first screen a new merchant sees; it promised it in four languages.
  for (const locale of LOCALES) {
    it(`has no AI Suite copy in ${locale}`, () => {
      for (const file of ['auth', 'shell', 'misc', 'settings']) {
        const json = JSON.stringify(messages(locale, file));
        expect(json, `${locale}/${file}`).not.toContain('AI Suite');
        expect(json, `${locale}/${file}`).not.toContain('aiSuite');
      }
    });
  }

  it('has no page left that sells or promises the AI Voice or Signage placeholders', () => {
    // Both were "sold, not built" under the AI Suite and nothing links to them any more. A
    // page that is not there cannot quote a price for a product nobody can buy.
    // _components -> plan -> settings -> [branchId], where the two pages used to live.
    const app = path.resolve(__dirname, '../../..');
    expect(fs.existsSync(path.join(app, 'ai-voice', 'page.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(app, 'signage', 'page.tsx'))).toBe(false);
    for (const locale of LOCALES) {
      const locked = (messages(locale, 'misc') as { lockedFeature: Record<string, string> })
        .lockedFeature;
      for (const key of ['aiVoiceLocked', 'aiVoiceIncluded', 'signageLocked', 'signageIncluded']) {
        expect(locked[key], `${locale}: misc.lockedFeature.${key}`).toBeUndefined();
      }
    }
  });
});
