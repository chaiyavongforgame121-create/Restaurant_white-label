import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import { FEATURE_KEYS, type BillingProduct } from '@favornoms/shared';
import {
  SOLD_FEATURES,
  WITHDRAWN_FEATURES,
  billingErrorOf,
  decisionErrorKey,
  formatMoney,
  isWithdrawnFeature,
  requestOneTime,
  requestSeats,
  sellableCatalog,
  sellableMonthlyTotal,
} from './platform-billing';

// Money and refusals. Both are places where a plausible-looking wrong answer is
// worse than a crash: a blended total or a swallowed "that code is gone" reads as
// success to the operator approving it.

const product = (over: Partial<BillingProduct> & { code: string }): BillingProduct => ({
  name: over.code,
  kind: 'addon',
  monthly_price: 0,
  one_time_price: 0,
  included_seats: 0,
  seats_per_unit: 0,
  trial_days: 0,
  is_quantity: false,
  features: {},
  stripe_price_id: null,
  is_active: true,
  sort_order: 0,
  description: null,
  ...over,
});

// The catalog of docs/PACKAGING-2026-10-24.md §4.1, read the way the requests page reads it:
// withdrawn rows included. The withdrawn Delivery row keeps an old price on purpose, so a
// screen that priced from it would show.
const CATALOG: BillingProduct[] = [
  product({
    code: 'base',
    name: 'FavorNoms Plan',
    kind: 'plan',
    one_time_price: 199,
    monthly_price: 49,
    included_seats: 1,
    features: { card_payment: true, delivery: true },
  }),
  product({
    code: 'extra_branch',
    name: 'Additional branch',
    one_time_price: 89,
    monthly_price: 49,
    seats_per_unit: 1,
    is_quantity: true,
  }),
  product({
    code: 'trial',
    name: 'Free trial',
    kind: 'plan',
    included_seats: 1,
    trial_days: 14,
    features: { card_payment: true, delivery: true },
  }),
  product({ code: 'delivery', name: 'Delivery (withdrawn)', monthly_price: 30, one_time_price: 59, is_active: false }),
  product({ code: 'ai_suite', name: 'AI Suite (withdrawn)', monthly_price: 99, is_active: false }),
];

describe('formatMoney', () => {
  it('shows whole catalog prices without cents', () => {
    expect(formatMoney(199)).toBe('$199');
    expect(formatMoney(49)).toBe('$49');
    expect(formatMoney(0)).toBe('$0');
  });

  it('keeps the cents a percentage code creates', () => {
    // 20% off 198 is 158.40 — rounding that to $158 would not match the ledger.
    expect(formatMoney(158.4)).toBe('$158.40');
    expect(formatMoney(39.6)).toBe('$39.60');
  });

  it('groups thousands exactly as the merchant’s plan page does', () => {
    expect(formatMoney(1990)).toBe('$1,990');
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(999)).toBe('$999');
  });

  it('never renders NaN at an operator', () => {
    expect(formatMoney(Number.NaN)).toBe('$0');
  });
});

describe('requestSeats', () => {
  it('is the branch count a request pays for', () => {
    expect(requestSeats(3)).toBe(3);
  });

  it('never reports fewer than one seat, nor a fraction of one', () => {
    expect(requestSeats(0)).toBe(1);
    expect(requestSeats(Number.NaN)).toBe(1);
    expect(requestSeats(2.7)).toBe(2);
  });
});

describe('withdrawn features', () => {
  it('are exactly the four the contract withdraws', () => {
    // docs/PACKAGING-2026-10-24.md §2: no product grants these.
    expect([...WITHDRAWN_FEATURES].sort()).toEqual(['ai_menu_import', 'ai_suite', 'ai_voice', 'digital_signage']);
    for (const key of WITHDRAWN_FEATURES) expect(isWithdrawnFeature(key)).toBe(true);
  });

  it('leave the plan its two features, and classify every key there is', () => {
    expect([...SOLD_FEATURES].sort()).toEqual(['card_payment', 'delivery']);
    // A new FEATURE_KEY must be decided one way or the other, not slip through as sellable.
    expect([...SOLD_FEATURES, ...WITHDRAWN_FEATURES].sort()).toEqual([...FEATURE_KEYS].sort());
    expect(isWithdrawnFeature('card_payment')).toBe(false);
    expect(isWithdrawnFeature('delivery')).toBe(false);
    expect(isWithdrawnFeature('no_such_key')).toBe(false);
  });
});

describe('sellableCatalog / sellableMonthlyTotal', () => {
  it('drops every withdrawn product', () => {
    expect(sellableCatalog(CATALOG).map((p) => p.code)).toEqual(['base', 'extra_branch', 'trial']);
  });

  it('prices $49 a branch from the full catalog, withdrawn prices never added', () => {
    expect(sellableMonthlyTotal({ planCode: 'base', branchSeats: 1 }, CATALOG)).toBe(49);
    expect(sellableMonthlyTotal({ planCode: 'base', branchSeats: 2 }, CATALOG)).toBe(98);
    expect(sellableMonthlyTotal({ planCode: 'base', branchSeats: 3 }, CATALOG)).toBe(147);
    expect(sellableMonthlyTotal({ planCode: 'trial', branchSeats: 2 }, CATALOG)).toBe(0);
  });

  it('never puts money on a withdrawn product, even one named as the plan', () => {
    // An old request naming the withdrawn add-on, or an extra-branch product retired from the
    // catalog: nothing inactive contributes a cent.
    expect(sellableMonthlyTotal({ planCode: 'delivery', branchSeats: 1 }, CATALOG)).toBe(0);
    const retiredSeat = CATALOG.map((p) => (p.code === 'extra_branch' ? { ...p, is_active: false } : p));
    expect(sellableMonthlyTotal({ planCode: 'base', branchSeats: 3 }, retiredSeat)).toBe(49);
    const retiredPlan = CATALOG.map((p) => (p.code === 'base' ? { ...p, is_active: false } : p));
    expect(sellableMonthlyTotal({ planCode: 'base', branchSeats: 3 }, retiredPlan)).toBe(0);
  });

  it('has no figure at all without an active product, rather than $0', () => {
    expect(sellableMonthlyTotal({ planCode: 'base', branchSeats: 1 }, [])).toBeNull();
    expect(
      sellableMonthlyTotal(
        { planCode: 'base', branchSeats: 1 },
        CATALOG.map((p) => ({ ...p, is_active: false })),
      ),
    ).toBeNull();
  });
});

describe('requestOneTime', () => {
  it('adds the discount back to reach the list price', () => {
    // one_time_total is stored NET of the discount.
    const money = requestOneTime({
      one_time_total: 158,
      discount_amount: 40,
      discount_code: 'SUMMER',
    });
    expect(money.net).toBe(158);
    expect(money.discount).toBe(40);
    expect(money.gross).toBe(198);
    expect(money.code).toBe('SUMMER');
  });

  it('does not name a code that took nothing off', () => {
    const money = requestOneTime({
      one_time_total: 198,
      discount_amount: 0,
      discount_code: 'EXPIRED',
    });
    expect(money.gross).toBe(198);
    expect(money.code).toBeNull();
  });

  it('treats a fully bought package as nothing to pay once', () => {
    const money = requestOneTime({ one_time_total: 0, discount_amount: 0, discount_code: null });
    expect(money.gross).toBe(0);
    expect(money.net).toBe(0);
  });
});

describe('billingErrorOf', () => {
  it('decodes a seat count the branches no longer fit into', () => {
    expect(billingErrorOf('plan_limit_exceeded:branches:3/2')).toEqual({
      kind: 'seats',
      current: 3,
      limit: 2,
    });
  });

  it('returns null for a refusal with no contract code', () => {
    expect(billingErrorOf('request_already_decided')).toBeNull();
  });
});

describe('decisionErrorKey', () => {
  it('names the refusals the RPC raises by hand', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(decisionErrorKey('request_already_decided')).toBe('errors.alreadyDecided');
    expect(decisionErrorKey('request_not_found')).toBe('errors.requestNotFound');
    expect(decisionErrorKey('permission denied for table')).toBe('errors.permission');
    expect(decisionErrorKey('TypeError: Failed to fetch')).toBe('errors.network');
    expect(decisionErrorKey('something nobody has seen')).toBe('errors.decisionFailed');
    expect(decisionErrorKey(undefined)).toBe('errors.decisionFailed');
    spy.mockRestore();
  });

  it('has a message for every key it can return, in every language', () => {
    const keys = [
      'alreadyDecided',
      'requestNotFound',
      'permission',
      'network',
      'decisionFailed',
      'saveFailed',
    ];
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const file = path.resolve(__dirname, '../../../../messages', locale, 'platformBilling.json');
      const tree = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        errors: Record<string, string>;
      };
      for (const key of keys) {
        expect(tree.errors[key], `${locale}.errors.${key}`).toBeTruthy();
      }
    }
  });
});

describe('the one-plan console messages', () => {
  // docs/PACKAGING-2026-10-24.md §5: no delivery picker, badge, request diff or delivery error
  // on the platform console. These render every message the one-plan screens use, in every
  // language, with exactly the values the screens pass, and prove the delivery ones are gone.
  type Tree = { [key: string]: string | Tree };
  const LOCALES = ['en', 'es', 'th', 'vi'];
  const catalogue = (locale: string, ns: string): Tree =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../messages', locale, `${ns}.json`), 'utf8')) as Tree;
  const lookup = (tree: Tree, key: string): unknown =>
    key.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Tree)[k] : undefined), tree);
  const strong = (chunks: string) => chunks;

  function render(ns: string, locale: string, key: string, values: Record<string, unknown> = {}): string {
    const t = createTranslator({
      locale,
      messages: { [ns]: catalogue(locale, ns) },
      namespace: ns,
      // A missing value or key throws instead of printing the key.
      onError: (error) => {
        throw error;
      },
    });
    return (t as unknown as { markup: (k: string, v: Record<string, unknown>) => string }).markup(key, values);
  }

  const USED: Array<[string, string, Record<string, unknown>]> = [
    ['platformBilling', 'subscriptions.subtitle', {}],
    ['platformBilling', 'requests.asking', { seats: 2 }],
    ['platformBilling', 'requests.confirm.blindBody', {}],
    ['platformBilling', 'discounts.oneTimeOnly', { strong }],
    ['platformBilling', 'plans.featureWithdrawn', { feature: 'AI Suite' }],
    ['platformBilling', 'plans.featureWithdrawnHint', {}],
    ['platformBilling', 'plans.withdrawnFeatureOn', {}],
    ['platformBilling', 'switches.withdrawnHint', {}],
    ['platformBilling', 'switches.grantWithdrawn.title', { feature: 'AI Suite', restaurant: 'Pho Corner' }],
    ['platformBilling', 'switches.grantWithdrawn.body', { feature: 'AI Suite' }],
    ['platformBilling', 'switches.grantWithdrawn.confirm', {}],
    ['platformBilling', 'stripe.setup.switch.errors.catalogIncomplete', {}],
    ['platform', 'plans.base', {}],
    ['platform', 'health.action.convert', { plan: 'FavorNoms Plan' }],
    ['platform', 'health.action.convertPriced', { plan: 'FavorNoms Plan', price: '$98' }],
    ['platform', 'drawer.package.deliveryOff', {}],
  ];

  for (const locale of LOCALES) {
    it(`renders every one-plan message in ${locale}`, () => {
      for (const [ns, key, values] of USED) {
        expect(render(ns, locale, key, values).trim(), `${locale} ${ns}.${key}`).not.toBe('');
      }
    });

    it(`has dropped the delivery picker, badge, diff and errors in ${locale}`, () => {
      const billing = catalogue(locale, 'platformBilling');
      const platform = catalogue(locale, 'platform');
      for (const key of [
        'subscriptions.delivery',
        'subscriptions.deliveringCount',
        'subscriptions.deliveringNone',
        'switches.deliveryNote',
        'requests.deliveryNone',
        'requests.deliveryAt',
        'requests.deliveryOn',
        'requests.deliveryOff',
        'requests.deliveryLossItem',
        'requests.unnamedBranches',
        'stripe.errors.deliveryActive',
      ]) {
        expect(lookup(billing, key), `${locale} platformBilling.${key}`).toBeUndefined();
      }
      expect(lookup(platform, 'stripe.errors.deliveryActive')).toBeUndefined();
      expect(lookup(platform, 'drawer.package.noDelivery')).toBeUndefined();
      // A request is a plan and a branch count: the sentence takes no delivery value any more.
      expect(String(lookup(billing, 'requests.asking'))).not.toContain('{delivery}');
    });

    it(`hardcodes no price in ${locale}`, () => {
      // Prices come from billing_products and reach a message as a {price}-style value.
      for (const ns of ['platform', 'platformBilling']) {
        const raw = fs.readFileSync(path.resolve(__dirname, '../../../../messages', locale, `${ns}.json`), 'utf8');
        expect(raw, `${locale}/${ns}.json`).not.toMatch(/\$\s?\d/);
      }
    });
  }

  it('reads the English the console shows', () => {
    expect(render('platformBilling', 'en', 'requests.asking', { seats: 3 })).toBe('3 branches');
    expect(render('platform', 'en', 'health.action.convertPriced', { plan: 'FavorNoms Plan', price: '$49' })).toBe(
      'Convert to FavorNoms Plan · $49/mo',
    );
  });
});
