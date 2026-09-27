import { afterEach, describe, expect, it, vi } from 'vitest';
import * as billing from '../../../../supabase/functions/_shared/stripe-billing';
import * as connect from '../../../../supabase/functions/_shared/stripe-connect';

/**
 * The rules stripe-billing and stripe-webhook are built on (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md),
 * pinned from here because a Deno function cannot run under this app's test runner but a module
 * with no imports can: supabase/functions/_shared/stripe-billing.ts imports nothing for that reason.
 *
 * What is at stake: what a restaurant's card is charged, and when; which date it is paid through;
 * and that the package applied is the one that was paid for.
 */

const REQ = '11111111-1111-4111-8111-111111111111';
const RID = '22222222-2222-4222-8222-222222222222';
const CH_BASE = '33333333-3333-4333-8333-333333333331';
const CH_B2 = '33333333-3333-4333-8333-333333333332';
const CH_B3 = '33333333-3333-4333-8333-333333333333';
const BRANCH_2 = '44444444-4444-4444-8444-444444444442';
const BRANCH_3 = '44444444-4444-4444-8444-444444444443';

/** billing_checkout_context as the SQL answers it: amounts as numeric strings or numbers. */
function rawContext(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    request: {
      id: REQ,
      status: 'pending',
      rail: 'manual',
      stripe_checkout_session_id: null,
      stripe_invoice_id: null,
    },
    restaurant: {
      id: RID,
      name: 'Thai Garden',
      slug: 'thai-garden',
      stripe_customer_id: null,
      owner_email: 'owner@thaigarden.com',
    },
    charges: [
      { id: CH_BASE, code: 'base', branch_id: null, net_amount: '153.00' },
      { id: CH_B2, code: 'extra_branch', branch_id: BRANCH_2, net_amount: 70 },
    ],
    monthly_lines: [
      { code: 'base', quantity: 1, unit_amount_cents: 2900 },
      { code: 'extra_branch', quantity: 1, unit_amount_cents: 2900 },
      { code: 'delivery', quantity: 1, unit_amount_cents: 3000 },
    ],
    subscription: {
      status: 'trialing',
      plan_code: 'trial',
      stripe_subscription_id: null,
      stripe_customer_id: null,
      current_period_end: '2026-10-03T12:00:00Z',
      trial_ends_at: '2026-10-03T12:00:00Z',
      items: [],
    },
    stripe_managed: false,
    ...over,
  };
}

function ctxOf(over: Record<string, unknown> = {}) {
  const parsed = billing.parseCheckoutContext(rawContext(over));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.ctx;
}

const PRICES = { base: 'price_base', extra_branch: 'price_branch', delivery: 'price_delivery' };
const URLS = billing.checkoutUrls(
  'https://admin.favornoms.com',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
);

describe('versions', () => {
  it('pins the same v1 version as the Connect module, and expects dahlia events', () => {
    expect(billing.STRIPE_API_VERSION).toBe(connect.STRIPE_API_VERSION);
    expect(billing.STRIPE_API_VERSION).toBe('2025-08-27.basil');
    expect(billing.EVENT_API_VERSION).toBe('2026-08-26.dahlia');
  });
});

describe('catalog identity', () => {
  it('names every product with a stable explicit id and maps it back to its code', () => {
    expect(billing.MONTHLY_PRODUCT_IDS).toEqual({
      base: 'favornoms_base',
      extra_branch: 'favornoms_extra_branch',
      delivery: 'favornoms_delivery',
    });
    expect(billing.SETUP_PRODUCT_IDS).toEqual({
      base: 'favornoms_base_setup',
      extra_branch: 'favornoms_extra_branch_setup',
      delivery: 'favornoms_delivery_setup',
    });
    expect(billing.productCodeOf('favornoms_extra_branch')).toBe('extra_branch');
    expect(billing.productCodeOf('favornoms_delivery_setup')).toBe('delivery');
    expect(billing.productCodeOf({ id: 'favornoms_base', object: 'product' })).toBe('base');
    expect(billing.productKindOf('favornoms_base')).toBe('monthly');
    expect(billing.productKindOf('favornoms_base_setup')).toBe('setup');
    expect(billing.productCodeOf('prod_Other')).toBeNull();
    expect(billing.productKindOf('prod_Other')).toBeNull();
    expect(billing.productCodeOf(null)).toBeNull();
  });

  it('puts the amount in the lookup key, so a new catalog price is a new Stripe price', () => {
    expect(billing.priceLookupKey('base', 2900)).toBe('favornoms_base_monthly_2900');
    expect(billing.priceLookupKey('delivery', 3000)).toBe('favornoms_delivery_monthly_3000');
    expect(billing.parseLookupKey('favornoms_extra_branch_monthly_2900')).toEqual({
      code: 'extra_branch',
      cents: 2900,
    });
    expect(billing.parseLookupKey('favornoms_ai_suite_monthly_8900')).toBeNull();
    expect(billing.parseLookupKey('favornoms_base_monthly_29.00')).toBeNull();
  });

  it('creates products and prices with exactly these bodies', () => {
    expect(billing.productParams('favornoms_extra_branch_setup')).toEqual({
      id: 'favornoms_extra_branch_setup',
      name: 'Additional branch, one-time setup',
      'metadata[product_code]': 'extra_branch',
      'metadata[kind]': 'setup',
      'metadata[purpose]': 'platform_billing',
    });
    expect(() => billing.productParams('prod_Other')).toThrow('unknown_product');
    expect(billing.priceParams('delivery', 3000)).toEqual({
      product: 'favornoms_delivery',
      currency: 'usd',
      unit_amount: '3000',
      'recurring[interval]': 'month',
      lookup_key: 'favornoms_delivery_monthly_3000',
      transfer_lookup_key: 'true',
      'metadata[product_code]': 'delivery',
    });
    expect(() => billing.priceParams('base', 0)).toThrow('bad_amount');
  });

  it('uses a price found by key only if it is exactly that monthly amount on that product', () => {
    const good = {
      id: 'price_1',
      active: true,
      currency: 'usd',
      unit_amount: 2900,
      lookup_key: 'favornoms_base_monthly_2900',
      product: 'favornoms_base',
      recurring: { interval: 'month', interval_count: 1 },
    };
    expect(billing.priceMatches(good, 'base', 2900)).toBe(true);
    expect(billing.priceMatches({ ...good, product: { id: 'favornoms_base' } }, 'base', 2900)).toBe(
      true,
    );
    expect(billing.priceMatches({ ...good, active: false }, 'base', 2900)).toBe(false);
    expect(billing.priceMatches({ ...good, unit_amount: 2800 }, 'base', 2900)).toBe(false);
    expect(billing.priceMatches({ ...good, product: 'favornoms_delivery' }, 'base', 2900)).toBe(
      false,
    );
    expect(billing.priceMatches({ ...good, recurring: { interval: 'year' } }, 'base', 2900)).toBe(
      false,
    );
    expect(
      billing.priceMatches(
        { ...good, recurring: { interval: 'month', interval_count: 3 } },
        'base',
        2900,
      ),
    ).toBe(false);
    expect(billing.priceMatches({ ...good, recurring: null }, 'base', 2900)).toBe(false);
  });

  it('prepares prices only from a whole, active catalog', () => {
    const rows = [
      { code: 'base', monthly_price: '29.00', is_active: true },
      { code: 'extra_branch', monthly_price: 29, is_active: true },
      { code: 'delivery', monthly_price: '30', is_active: true },
      { code: 'trial', monthly_price: 0, is_active: true },
    ];
    expect(billing.catalogMonthlyCents(rows)).toEqual([
      { code: 'base', cents: 2900 },
      { code: 'extra_branch', cents: 2900 },
      { code: 'delivery', cents: 3000 },
    ]);
    expect(billing.catalogMonthlyCents(rows.slice(1))).toBeNull();
    expect(
      billing.catalogMonthlyCents([
        ...rows.slice(0, 2),
        { code: 'delivery', monthly_price: 30, is_active: false },
      ]),
    ).toBeNull();
    expect(
      billing.catalogMonthlyCents([
        ...rows.slice(0, 2),
        { code: 'delivery', monthly_price: 0, is_active: true },
      ]),
    ).toBeNull();
    expect(billing.catalogMonthlyCents(null)).toBeNull();
  });
});

describe('money', () => {
  it('turns numeric dollars into exact cents', () => {
    expect(billing.cents('70.00')).toBe(7000);
    expect(billing.cents(148.5)).toBe(14850);
    expect(billing.cents(0.29)).toBe(29);
    expect(billing.cents(19.99)).toBe(1999);
    expect(billing.cents('1.10')).toBe(110);
    expect(billing.cents(0)).toBe(0);
  });

  it('refuses what is not an amount instead of charging 0', () => {
    for (const bad of [null, undefined, '', 'abc', -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(Number.isNaN(billing.cents(bad))).toBe(true);
    }
    expect(billing.dollars(14850)).toBe(148.5);
    expect(billing.dollars(2900)).toBe(29);
  });
});

describe('the request context', () => {
  it('parses what billing_checkout_context answers', () => {
    const ctx = ctxOf();
    expect(ctx.request.id).toBe(REQ);
    expect(ctx.charges).toEqual([
      { id: CH_BASE, code: 'base', branch_id: null, net_cents: 15300 },
      { id: CH_B2, code: 'extra_branch', branch_id: BRANCH_2, net_cents: 7000 },
    ]);
    expect(ctx.subscription?.trial_ends_at).toBe('2026-10-03T12:00:00Z');
    expect(billing.oneTimeTotalCents(ctx)).toBe(22300);
  });

  it('passes the refusal through and fails closed on anything it cannot bill exactly', () => {
    expect(billing.parseCheckoutContext({ ok: false, error: 'forbidden' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(billing.parseCheckoutContext(null)).toEqual({ ok: false, error: 'bad_context' });
    const bad = (over: Record<string, unknown>) =>
      billing.parseCheckoutContext(rawContext(over)).ok;
    expect(bad({ request: { id: 'not-a-uuid' } })).toBe(false);
    expect(bad({ charges: [{ id: CH_BASE, code: 'ai_suite', net_amount: 10 }] })).toBe(false);
    expect(bad({ charges: [{ id: CH_BASE, code: 'base', net_amount: 'free' }] })).toBe(false);
    expect(
      bad({ monthly_lines: [{ code: 'extra_branch', quantity: 1, unit_amount_cents: 2900 }] }),
    ).toBe(false);
    expect(bad({ monthly_lines: [{ code: 'base', quantity: 2, unit_amount_cents: 2900 }] })).toBe(
      false,
    );
    expect(bad({ monthly_lines: [{ code: 'base', quantity: 1, unit_amount_cents: 29.5 }] })).toBe(
      false,
    );
    expect(
      bad({
        monthly_lines: [
          { code: 'base', quantity: 1, unit_amount_cents: 2900 },
          { code: 'delivery', quantity: 1.5, unit_amount_cents: 3000 },
        ],
      }),
    ).toBe(false);
    expect(
      bad({
        monthly_lines: [
          { code: 'base', quantity: 1, unit_amount_cents: 2900 },
          { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        ],
      }),
    ).toBe(false);
  });
});

describe('first purchase: the Checkout session', () => {
  it('sends the monthly lines, each one-time fee at its NET amount, and defers the monthly charge', () => {
    const params = billing.checkoutSessionParams(ctxOf(), 'cus_123', PRICES, URLS, 1_790_000_000);
    expect(params).toEqual({
      mode: 'subscription',
      customer: 'cus_123',
      client_reference_id: RID,
      success_url:
        'https://admin.favornoms.com/b/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/settings/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:
        'https://admin.favornoms.com/b/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/settings/plan?checkout=cancelled',
      'payment_method_types[0]': 'card',
      payment_method_collection: 'always',
      'metadata[billing_request_id]': REQ,
      'metadata[restaurant_id]': RID,
      'subscription_data[metadata][billing_request_id]': REQ,
      'subscription_data[metadata][restaurant_id]': RID,
      'subscription_data[trial_end]': '1790000000',
      'line_items[0][price]': 'price_base',
      'line_items[0][quantity]': '1',
      'line_items[1][price]': 'price_branch',
      'line_items[1][quantity]': '1',
      'line_items[2][price]': 'price_delivery',
      'line_items[2][quantity]': '1',
      'line_items[3][price_data][currency]': 'usd',
      'line_items[3][price_data][product]': 'favornoms_base_setup',
      'line_items[3][price_data][unit_amount]': '15300',
      'line_items[3][quantity]': '1',
      'line_items[4][price_data][currency]': 'usd',
      'line_items[4][price_data][product]': 'favornoms_extra_branch_setup',
      'line_items[4][price_data][unit_amount]': '7000',
      'line_items[4][quantity]': '1',
    });
    // Stripe promotion codes could discount the monthly price; the platform's codes are one-time only.
    expect(Object.keys(params).some((k) => k.includes('promotion') || k.includes('discount'))).toBe(
      false,
    );
  });

  it('starts billing now without a trial date, and leaves out quantity-0 lines and $0 fees', () => {
    const ctx = ctxOf({
      monthly_lines: [
        { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        { code: 'extra_branch', quantity: 0, unit_amount_cents: 2900 },
        { code: 'delivery', quantity: 0, unit_amount_cents: 3000 },
      ],
      charges: [
        { id: CH_BASE, code: 'base', branch_id: null, net_amount: '170.00' },
        { id: CH_B2, code: 'delivery', branch_id: BRANCH_2, net_amount: '0.00' },
      ],
    });
    const params = billing.checkoutSessionParams(
      ctx,
      'cus_123',
      { base: 'price_base' },
      URLS,
      null,
    );
    expect(params['subscription_data[trial_end]']).toBeUndefined();
    const lines = Object.fromEntries(
      Object.entries(params).filter(([k]) => k.startsWith('line_items')),
    );
    expect(lines).toEqual({
      'line_items[0][price]': 'price_base',
      'line_items[0][quantity]': '1',
      'line_items[1][price_data][currency]': 'usd',
      'line_items[1][price_data][product]': 'favornoms_base_setup',
      'line_items[1][price_data][unit_amount]': '17000',
      'line_items[1][quantity]': '1',
    });
  });

  it("folds identical fees into one line, so many new branches stay under Stripe's 20 lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
      code: 'extra_branch',
      branch_id: null,
      net_amount: i === 0 ? '63.00' : '70.00',
    }));
    const ctx = ctxOf({
      charges: many,
      monthly_lines: [
        { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        { code: 'extra_branch', quantity: 30, unit_amount_cents: 2900 },
      ],
    });
    const params = billing.checkoutSessionParams(ctx, 'cus_1', PRICES, URLS, null);
    expect(params['line_items[1][quantity]']).toBe('30');
    expect(params['line_items[2][price_data][unit_amount]']).toBe('7000');
    expect(params['line_items[2][quantity]']).toBe('29');
    expect(params['line_items[3][price_data][unit_amount]']).toBe('6300');
    expect(params['line_items[3][quantity]']).toBe('1');
    expect(params['line_items[4][price]']).toBeUndefined();
    expect(params['line_items[4][price_data][currency]']).toBeUndefined();
  });

  it('refuses rather than sends a line without its price', () => {
    expect(() =>
      billing.checkoutSessionParams(ctxOf(), 'cus_1', { base: 'price_base' }, URLS, null),
    ).toThrow('missing_price:extra_branch');
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      id: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
      code: 'extra_branch',
      branch_id: null,
      net_amount: 50 + i,
    }));
    expect(() =>
      billing.checkoutSessionParams(ctxOf({ charges: tooMany }), 'cus_1', PRICES, URLS, null),
    ).toThrow('too_many_one_time_lines');
  });

  it('counts a session as paid only when Checkout completed with the money in', () => {
    expect(
      billing.sessionIsPaid({ mode: 'subscription', status: 'complete', payment_status: 'paid' }),
    ).toBe(true);
    expect(
      billing.sessionIsPaid({
        mode: 'subscription',
        status: 'complete',
        payment_status: 'no_payment_required',
      }),
    ).toBe(true);
    expect(
      billing.sessionIsPaid({ mode: 'subscription', status: 'complete', payment_status: 'unpaid' }),
    ).toBe(false);
    expect(
      billing.sessionIsPaid({ mode: 'subscription', status: 'open', payment_status: 'paid' }),
    ).toBe(false);
    expect(
      billing.sessionIsPaid({ mode: 'payment', status: 'complete', payment_status: 'paid' }),
    ).toBe(false);
    expect(billing.sessionIsPaid(null)).toBe(false);
  });

  it('sends the merchant back to the branch plan page, and the portal too', () => {
    expect(billing.portalReturnUrl('https://admin.favornoms.com', 'b 1')).toBe(
      'https://admin.favornoms.com/b/b%201/settings/plan?portal=return',
    );
  });
});

describe('when the monthly charge starts (the 48 h rule)', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const hours = (h: number) => new Date(now + h * 3600 * 1000).toISOString();

  it('keeps the rest of the free trial when more than 48 hours are left', () => {
    const end = hours(24 * 7);
    expect(billing.billingAnchor(now, end, end, 'trialing')).toBe(
      Math.floor(Date.parse(end) / 1000),
    );
  });

  it('charges now when 48 hours or less are left (Stripe refuses a closer trial_end)', () => {
    expect(billing.billingAnchor(now, hours(48), hours(48), 'trialing')).toBeNull();
    expect(billing.billingAnchor(now, hours(10), hours(10), 'trialing')).toBeNull();
    // The margin: 48 h and 5 minutes could be under 48 h by the time Stripe reads it.
    expect(billing.billingAnchor(now, hours(48 + 5 / 60), null, 'trialing')).toBeNull();
    expect(billing.billingAnchor(now, hours(48 + 11 / 60), null, 'trialing')).toBe(
      Math.floor(Date.parse(hours(48 + 11 / 60)) / 1000),
    );
    expect(billing.billingAnchor(now, hours(-5), hours(-5), 'trialing')).toBeNull();
  });

  it('keeps what a manual-rail restaurant already paid for', () => {
    const end = hours(24 * 20);
    expect(billing.billingAnchor(now, null, end, 'active')).toBe(
      Math.floor(Date.parse(end) / 1000),
    );
    expect(billing.billingAnchor(now, null, end, 'cancelled')).toBe(
      Math.floor(Date.parse(end) / 1000),
    );
  });

  it('charges now when nothing is covered', () => {
    expect(billing.billingAnchor(now, null, hours(24 * 20), 'past_due')).toBeNull();
    expect(billing.billingAnchor(now, null, hours(24 * 20), 'expired')).toBeNull();
    expect(billing.billingAnchor(now, null, null, undefined)).toBeNull();
    expect(billing.billingAnchor(now, 'not a date', null, 'trialing')).toBeNull();
  });

  it('clamps a date years away to under two years', () => {
    const far = hours(24 * 365 * 5);
    expect(billing.billingAnchor(now, null, far, 'active')).toBe(
      Math.floor((now + billing.ANCHOR_MAX_LEAD_MS) / 1000),
    );
  });
});

describe("changing a paying restaurant's package: the subscription update", () => {
  const current = {
    base: { id: 'si_base', quantity: 1 },
    extra_branch: { id: 'si_branch', quantity: 1 },
    delivery: { id: 'si_delivery', quantity: 2 },
  };

  it('adds a branch: the FULL target (unchanged items too) and the $70 at net', () => {
    const ctx = ctxOf({
      stripe_managed: true,
      charges: [{ id: CH_B3, code: 'extra_branch', branch_id: BRANCH_3, net_amount: '70.00' }],
      monthly_lines: [
        { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        { code: 'extra_branch', quantity: 2, unit_amount_cents: 2900 },
        { code: 'delivery', quantity: 2, unit_amount_cents: 3000 },
      ],
    });
    expect(billing.subscriptionUpdateParams(ctx, current, {})).toEqual({
      'items[0][id]': 'si_base',
      'items[0][quantity]': '1',
      'items[1][id]': 'si_branch',
      'items[1][quantity]': '2',
      'items[2][id]': 'si_delivery',
      'items[2][quantity]': '2',
      'add_invoice_items[0][price_data][currency]': 'usd',
      'add_invoice_items[0][price_data][product]': 'favornoms_extra_branch_setup',
      'add_invoice_items[0][price_data][unit_amount]': '7000',
      'add_invoice_items[0][quantity]': '1',
      'add_invoice_items[0][metadata][billing_request_id]': REQ,
      'add_invoice_items[0][metadata][product_code]': 'extra_branch',
      'add_invoice_items[0][metadata][billing_charge_id]': CH_B3,
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
      'expand[0]': 'latest_invoice',
    });
  });

  it('SP-2: a retry after the first update applied sends the SAME body, so the key replays it', () => {
    const ctx = ctxOf({
      stripe_managed: true,
      charges: [{ id: CH_B3, code: 'extra_branch', branch_id: BRANCH_3, net_amount: '70.00' }],
      monthly_lines: [
        { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        { code: 'extra_branch', quantity: 2, unit_amount_cents: 2900 },
        { code: 'delivery', quantity: 2, unit_amount_cents: 3000 },
      ],
    });
    const before = billing.subscriptionUpdateParams(ctx, current, {});
    const applied = { ...current, extra_branch: { id: 'si_branch', quantity: 2 } };
    const after = billing.subscriptionUpdateParams(ctx, applied, {});
    // The old diff builder sent only the fees here, a new body and a second $70.
    expect(after).toEqual(before);
    expect(billing.changeIdempotencyKey(REQ)).toBe(`billing_change:${REQ}`);
  });

  it('deletes an item going to 0 and adds a product it lacks at the catalog price', () => {
    const ctx = ctxOf({
      stripe_managed: true,
      charges: [],
      monthly_lines: [
        { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        { code: 'extra_branch', quantity: 0, unit_amount_cents: 2900 },
        { code: 'delivery', quantity: 1, unit_amount_cents: 3000 },
      ],
    });
    const have = {
      base: { id: 'si_base', quantity: 1 },
      extra_branch: { id: 'si_branch', quantity: 1 },
    };
    const params = billing.subscriptionUpdateParams(ctx, have, { delivery: 'price_delivery' });
    expect(params).toEqual({
      'items[0][id]': 'si_base',
      'items[0][quantity]': '1',
      'items[1][id]': 'si_branch',
      'items[1][deleted]': 'true',
      'items[2][price]': 'price_delivery',
      'items[2][quantity]': '1',
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
      'expand[0]': 'latest_invoice',
    });
    expect(billing.itemsMatch(billing.targetQuantities(ctx), have)).toBe(false);
    expect(billing.updateAddsOneTimeFees(params)).toBe(false);
  });

  it('never sends subscription metadata: basil refuses it with pending_if_incomplete', () => {
    const params = billing.subscriptionUpdateParams(
      ctxOf({ stripe_managed: true }),
      current,
      PRICES,
    );
    expect(Object.keys(params).some((k) => k.startsWith('metadata'))).toBe(false);
  });

  it('knows when the same package is filed again (nothing to change at Stripe)', () => {
    const ctx = ctxOf({
      stripe_managed: true,
      charges: [],
      monthly_lines: [
        { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        { code: 'extra_branch', quantity: 1, unit_amount_cents: 2900 },
        { code: 'delivery', quantity: 2, unit_amount_cents: 3000 },
      ],
    });
    expect(billing.targetQuantities(ctx)).toEqual({ base: 1, extra_branch: 1, delivery: 2 });
    expect(billing.itemsMatch(billing.targetQuantities(ctx), current)).toBe(true);
    // A missing item counts as 0.
    expect(
      billing.itemsMatch(
        { base: 1, extra_branch: 0, delivery: 0 },
        { base: { id: 'si_base', quantity: 1 } },
      ),
    ).toBe(true);
    expect(
      billing.itemsMatch(
        { base: 1, extra_branch: 1, delivery: 0 },
        { base: { id: 'si_base', quantity: 1 } },
      ),
    ).toBe(false);
  });

  it('a one-time fee with no quantity change is recognised (Stripe makes no invoice for it)', () => {
    const ctx = ctxOf({
      stripe_managed: true,
      charges: [{ id: CH_B3, code: 'delivery', branch_id: BRANCH_3, net_amount: '15.00' }],
      monthly_lines: [
        { code: 'base', quantity: 1, unit_amount_cents: 2900 },
        { code: 'extra_branch', quantity: 1, unit_amount_cents: 2900 },
        { code: 'delivery', quantity: 2, unit_amount_cents: 3000 },
      ],
    });
    const params = billing.subscriptionUpdateParams(ctx, current, {});
    expect(billing.itemsMatch(billing.targetQuantities(ctx), current)).toBe(true);
    expect(billing.updateAddsOneTimeFees(params)).toBe(true);
  });

  it('refuses a change it cannot send exactly', () => {
    const ctx = ctxOf({ stripe_managed: true, charges: [] });
    expect(() =>
      billing.subscriptionUpdateParams(ctx, { base: { id: 'si_base', quantity: 1 } }, {}),
    ).toThrow('missing_price:extra_branch');
    expect(() =>
      billing.targetItemParams({ base: 0, extra_branch: 1, delivery: 0 }, current, {}),
    ).toThrow('base_removed');
  });

  it("reads the subscription's items by product, refusing one it does not understand", () => {
    const sub = {
      items: {
        data: [
          { id: 'si_base', quantity: 1, price: { id: 'price_a', product: 'favornoms_base' } },
          {
            id: 'si_branch',
            quantity: 3,
            price: { id: 'price_b', product: { id: 'favornoms_extra_branch' } },
          },
        ],
      },
    };
    expect(billing.subscriptionItemsByCode(sub)).toEqual({
      ok: true,
      items: {
        base: { id: 'si_base', quantity: 1 },
        extra_branch: { id: 'si_branch', quantity: 3 },
      },
    });
    expect(billing.settleItems(sub)).toEqual([
      { product_code: 'base', stripe_subscription_item_id: 'si_base' },
      { product_code: 'extra_branch', stripe_subscription_item_id: 'si_branch' },
    ]);
    const withForeign = {
      items: {
        data: [...sub.items.data, { id: 'si_x', quantity: 1, price: { product: 'prod_Other' } }],
      },
    };
    expect(billing.subscriptionItemsByCode(withForeign)).toEqual({
      ok: false,
      error: 'unknown_item',
    });
    const withSetup = {
      items: { data: [{ id: 'si_y', quantity: 1, price: { product: 'favornoms_base_setup' } }] },
    };
    expect(billing.subscriptionItemsByCode(withSetup)).toEqual({
      ok: false,
      error: 'unknown_item',
    });
    const twice = {
      items: { data: [sub.items.data[0], { ...sub.items.data[0], id: 'si_base2' }] },
    };
    expect(billing.subscriptionItemsByCode(twice)).toEqual({ ok: false, error: 'duplicate_item' });
    expect(billing.subscriptionItemsByCode({})).toEqual({ ok: true, items: {} });
  });
});

describe('paid-through and the next charge (only money moves the date)', () => {
  it('is the latest item period end on basil (the subscription has none of its own)', () => {
    const sub = {
      status: 'active',
      current_period_end: 1_999_999_999, // pre-basil field: must be ignored
      items: {
        data: [
          { current_period_end: 1_790_000_000 },
          { current_period_end: 1_790_500_000 },
          { current_period_end: 'x' },
        ],
      },
    };
    expect(billing.subscriptionPaidThrough(sub)).toBe(1_790_500_000);
  });

  it('is the trial end while the first monthly charge is deferred', () => {
    expect(
      billing.subscriptionPaidThrough({
        status: 'trialing',
        trial_end: 1_791_000_000,
        items: { data: [{ current_period_end: 1_790_000_000 }] },
      }),
    ).toBe(1_791_000_000);
    expect(
      billing.subscriptionPaidThrough({
        status: 'active',
        trial_end: 1_791_000_000,
        items: { data: [{ current_period_end: 1_790_000_000 }] },
      }),
    ).toBe(1_790_000_000);
    expect(billing.subscriptionPaidThrough({ status: 'active', items: { data: [] } })).toBeNull();
    expect(billing.subscriptionPaidThrough(null)).toBeNull();
  });

  it('has no next charge when cancelling or ended', () => {
    const items = { data: [{ current_period_end: 1_790_000_000 }] };
    expect(billing.nextChargeAt({ status: 'active', items })).toBe(1_790_000_000);
    expect(billing.nextChargeAt({ status: 'past_due', items })).toBe(1_790_000_000);
    expect(
      billing.nextChargeAt({ status: 'active', cancel_at_period_end: true, items }),
    ).toBeNull();
    expect(billing.nextChargeAt({ status: 'active', cancel_at: 1_790_000_000, items })).toBeNull();
    expect(billing.nextChargeAt({ status: 'active', cancel_at: 1_800_000_000, items })).toBe(
      1_790_000_000,
    );
    expect(billing.nextChargeAt({ status: 'canceled', items })).toBeNull();
    expect(billing.nextChargeAt({ status: 'incomplete', items })).toBeNull();
  });

  it('builds the status sync without a period date', () => {
    const args = billing.syncStatusArgs(
      {
        id: 'sub_1',
        status: 'past_due',
        cancel_at_period_end: false,
        cancel_at: null,
        items: { data: [{ current_period_end: 1_790_000_000 }] },
      },
      null,
    );
    expect(args).toEqual({
      p_stripe_subscription_id: 'sub_1',
      p_status: 'past_due',
      p_cancel_at_period_end: false,
      p_cancel_at: null,
      p_next_billing_at: new Date(1_790_000_000 * 1000).toISOString(),
      p_card: null,
      // The items carry no readable price here, so no monthly total is claimed.
      p_monthly_amount: null,
    });
    expect(
      args &&
        Object.keys(args).some((k) => k.includes('paid_through') || k.includes('current_period')),
    ).toBe(false);
    expect(billing.syncStatusArgs({ status: 'active' }, null)).toBeNull();
  });

  it('treats only a live subscription as the Stripe rail', () => {
    for (const s of ['trialing', 'active', 'past_due'])
      expect(billing.isStripeManagedStatus(s)).toBe(true);
    for (const s of [
      'incomplete',
      'incomplete_expired',
      'canceled',
      'unpaid',
      'paused',
      undefined,
    ]) {
      expect(billing.isStripeManagedStatus(s)).toBe(false);
    }
  });
});

describe('invoices', () => {
  it("finds the subscription on basil's parent and on the legacy field, id or object", () => {
    expect(
      billing.invoiceSubscriptionId({
        parent: { subscription_details: { subscription: 'sub_new' } },
      }),
    ).toBe('sub_new');
    expect(
      billing.invoiceSubscriptionId({
        parent: { subscription_details: { subscription: { id: 'sub_obj' } } },
      }),
    ).toBe('sub_obj');
    expect(billing.invoiceSubscriptionId({ subscription: 'sub_old' })).toBe('sub_old');
    expect(billing.invoiceSubscriptionId({ parent: null, subscription: null })).toBeNull();
    expect(billing.invoiceSubscriptionId(null)).toBeNull();
  });

  it('records an invoice in Stripe units (cents), with the period its subscription lines bill', () => {
    const inv = {
      id: 'in_1',
      customer: 'cus_1',
      parent: { subscription_details: { subscription: 'sub_1' } },
      billing_reason: 'subscription_update',
      status: 'paid',
      amount_due: 9900,
      amount_paid: 9900,
      currency: 'usd',
      period_start: 1_780_000_000,
      period_end: 1_780_000_000,
      hosted_invoice_url: 'https://invoice.stripe.com/i/1',
      status_transitions: { paid_at: 1_788_000_000 },
      attempt_count: 1,
      lines: {
        data: [
          {
            parent: { type: 'invoice_item_details' },
            period: { start: 1_788_000_000, end: 1_788_000_000 },
          },
          {
            parent: { type: 'subscription_item_details' },
            period: { start: 1_788_000_000, end: 1_790_000_000 },
          },
          {
            parent: { type: 'subscription_item_details' },
            period: { start: 1_787_000_000, end: 1_790_000_000 },
          },
        ],
      },
    };
    expect(billing.invoiceRecord(inv)).toEqual({
      id: 'in_1',
      subscription: 'sub_1',
      customer: 'cus_1',
      billing_reason: 'subscription_update',
      status: 'paid',
      amount_due: 9900,
      amount_paid: 9900,
      currency: 'usd',
      period_start: new Date(1_787_000_000 * 1000).toISOString(),
      period_end: new Date(1_790_000_000 * 1000).toISOString(),
      hosted_invoice_url: 'https://invoice.stripe.com/i/1',
      paid_at: new Date(1_788_000_000 * 1000).toISOString(),
      attempt_count: 1,
    });
    const noLines = billing.invoiceRecord({
      id: 'in_2',
      period_start: 1_780_000_000,
      period_end: 1_781_000_000,
      amount_due: 'x',
    });
    expect(noLines?.period_start).toBe(new Date(1_780_000_000 * 1000).toISOString());
    expect(noLines?.amount_due).toBe(0);
    expect(noLines?.status).toBe('open');
    expect(billing.invoiceRecord({})).toBeNull();
  });

  it("moves paid-through only for money paid for a period, and never past the invoice's own period", () => {
    const sub = { status: 'active', items: { data: [{ current_period_end: 1_792_000_000 }] } };
    const subLine = (end: number) => ({
      parent: { type: 'subscription_item_details' },
      period: { start: end - 2_600_000, end },
    });
    // A renewal: its period.
    expect(
      billing.invoicePaidThrough(
        { billing_reason: 'subscription_cycle', lines: { data: [subLine(1_792_000_000)] } },
        sub,
      ),
    ).toBe(1_792_000_000);
    // A renewal paid late, after the next period began: only through the period it paid for.
    expect(
      billing.invoicePaidThrough(
        { billing_reason: 'subscription_cycle', lines: { data: [subLine(1_789_400_000)] } },
        sub,
      ),
    ).toBe(1_789_400_000);
    // Never past what the subscription itself says.
    expect(
      billing.invoicePaidThrough(
        { billing_reason: 'subscription_cycle', lines: { data: [subLine(1_799_000_000)] } },
        sub,
      ),
    ).toBe(1_792_000_000);
    // The first invoice of a deferred start: through the trial end (its $0 subscription lines).
    const trialing = {
      status: 'trialing',
      trial_end: 1_791_000_000,
      items: { data: [{ current_period_end: 1_791_000_000 }] },
    };
    expect(
      billing.invoicePaidThrough(
        {
          billing_reason: 'subscription_create',
          lines: {
            data: [
              { parent: { type: 'invoice_item_details' }, period: { end: 1_788_000_000 } },
              subLine(1_791_000_000),
            ],
          },
        },
        trialing,
      ),
    ).toBe(1_791_000_000);
    // Lines not in the answer: the subscription's date.
    expect(
      billing.invoicePaidThrough(
        { billing_reason: 'subscription_create', lines: { data: [] } },
        sub,
      ),
    ).toBe(1_792_000_000);
    // A change's proration invoice or a one-off invoice pays for no period.
    expect(
      billing.invoicePaidThrough(
        { billing_reason: 'subscription_update', lines: { data: [subLine(1_792_000_000)] } },
        sub,
      ),
    ).toBeNull();
    expect(billing.invoicePaidThrough({ billing_reason: 'manual' }, sub)).toBeNull();
    expect(billing.invoicePaidThrough(null, sub)).toBeNull();
  });

  it('refunds a stale payment through its InvoicePayments, in full', () => {
    const list = {
      data: [
        { status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } },
        { status: 'paid', payment: { type: 'charge', charge: { id: 'ch_1' } } },
        { status: 'canceled', payment: { type: 'payment_intent', payment_intent: 'pi_2' } },
        { status: 'open', payment: { type: 'payment_intent', payment_intent: 'pi_3' } },
      ],
    };
    expect(billing.invoicePaymentTargets(list)).toEqual([
      { payment_intent: 'pi_1' },
      { charge: 'ch_1' },
    ]);
    expect(billing.invoicePaymentTargets(null)).toEqual([]);
    expect(billing.refundParams({ payment_intent: 'pi_1' })).toEqual({
      payment_intent: 'pi_1',
      reason: 'requested_by_customer',
      'metadata[purpose]': 'platform_billing_refund',
    });
    expect(billing.refundParams({ charge: 'ch_1' }).charge).toBe('ch_1');
    expect(billing.refundTargetId({ charge: 'ch_1' })).toBe('ch_1');
    expect(billing.refundTargetId({ payment_intent: 'pi_1' })).toBe('pi_1');
  });
});

describe('cards', () => {
  const pm = {
    id: 'pm_1',
    type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
  };

  it('maps an expanded card and nothing else', () => {
    expect(billing.mapCard(pm)).toEqual({
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: 2030,
    });
    expect(billing.mapCard('pm_1')).toBeNull();
    expect(billing.mapCard({ type: 'link', link: {} })).toBeNull();
    expect(billing.mapCard({ type: 'card', card: { brand: 'visa', last4: '42' } })).toBeNull();
    expect(
      billing.mapCard({ type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 13 } }),
    ).toEqual({
      brand: 'visa',
      last4: '4242',
      exp_month: null,
      exp_year: null,
    });
  });

  it('uses the subscription card first, then the customer default the portal writes', () => {
    expect(
      billing.cardOf({
        default_payment_method: pm,
        customer: { invoice_settings: { default_payment_method: null } },
      })?.last4,
    ).toBe('4242');
    const other = { ...pm, card: { ...pm.card, last4: '0005', brand: 'mastercard' } };
    expect(
      billing.cardOf({
        default_payment_method: null,
        customer: { invoice_settings: { default_payment_method: other } },
      })?.last4,
    ).toBe('0005');
    expect(billing.cardOf({ default_payment_method: 'pm_1', customer: 'cus_1' })).toBeNull();
  });
});

describe('settling a completed Checkout', () => {
  const sub = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'trialing',
    trial_end: 1_791_000_000,
    latest_invoice: 'in_first',
    default_payment_method: {
      type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2031 },
    },
    items: {
      data: [
        { id: 'si_base', current_period_end: 1_791_000_000, price: { product: 'favornoms_base' } },
        {
          id: 'si_delivery',
          current_period_end: 1_791_000_000,
          price: { product: 'favornoms_delivery' },
        },
      ],
    },
  };

  it('settles the request with the paid-through date, the items and the card', () => {
    expect(
      billing.checkoutSettleArgs({ customer: 'cus_1', invoice: 'in_first' }, sub, REQ),
    ).toEqual({
      p_request_id: REQ,
      p_stripe_customer_id: 'cus_1',
      p_stripe_subscription_id: 'sub_1',
      p_invoice_id: 'in_first',
      p_paid_through: new Date(1_791_000_000 * 1000).toISOString(),
      p_items: [
        { product_code: 'base', stripe_subscription_item_id: 'si_base' },
        { product_code: 'delivery', stripe_subscription_item_id: 'si_delivery' },
      ],
      p_card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2031 },
      p_monthly_amount: null,
    });
    expect(
      billing.checkoutSettleArgs({ customer: { id: 'cus_1' }, invoice: null }, sub, REQ)
        ?.p_invoice_id,
    ).toBe('in_first');
  });

  it('refuses without a subscription, a customer or a request id', () => {
    expect(
      billing.checkoutSettleArgs({ customer: 'cus_1' }, { ...sub, id: undefined }, REQ),
    ).toBeNull();
    expect(billing.checkoutSettleArgs({}, { ...sub, customer: null }, REQ)).toBeNull();
    expect(billing.checkoutSettleArgs({ customer: 'cus_1' }, sub, 'nope')).toBeNull();
  });
});

describe('customers', () => {
  it('creates the customer with the restaurant on it, and a real email only', () => {
    expect(
      billing.customerParams({
        id: RID,
        name: '  Thai   Garden ',
        slug: 'thai-garden',
        owner_email: 'owner@thaigarden.com',
      }),
    ).toEqual({
      'metadata[restaurant_id]': RID,
      'metadata[purpose]': 'platform_billing',
      name: 'Thai Garden',
      email: 'owner@thaigarden.com',
      'metadata[restaurant_slug]': 'thai-garden',
    });
    const demo = billing.customerParams({
      id: RID,
      name: 'Demo',
      slug: null,
      owner_email: 'demo-owner@favornoms.local',
    });
    expect(demo.email).toBeUndefined();
    expect(billing.customerEmail('a@example.com')).toBeNull();
    expect(billing.customerEmail('not an email')).toBeNull();
    expect(billing.customerEmail(' a@b.co ')).toBe('a@b.co');
  });

  it("trusts a stored customer id only when Stripe says it is this restaurant's", () => {
    expect(billing.customerBelongsTo({ id: 'cus_1', metadata: { restaurant_id: RID } }, RID)).toBe(
      true,
    );
    expect(
      billing.customerBelongsTo({ id: 'cus_1', metadata: { restaurant_id: 'someone-else' } }, RID),
    ).toBe(false);
    expect(
      billing.customerBelongsTo(
        { id: 'cus_1', deleted: true, metadata: { restaurant_id: RID } },
        RID,
      ),
    ).toBe(false);
    expect(billing.customerBelongsTo({ id: 'cus_1' }, RID)).toBe(false);
  });
});

describe('the customer portal (D10)', () => {
  it('offers card, invoices, details and cancel at period end; never plan switching', () => {
    expect(billing.portalConfigurationParams()).toEqual({
      'business_profile[headline]': 'Favornoms: your package, card and invoices',
      'features[payment_method_update][enabled]': 'true',
      'features[invoice_history][enabled]': 'true',
      'features[customer_update][enabled]': 'true',
      'features[customer_update][allowed_updates][0]': 'email',
      'features[customer_update][allowed_updates][1]': 'name',
      'features[customer_update][allowed_updates][2]': 'address',
      'features[customer_update][allowed_updates][3]': 'phone',
      'features[customer_update][allowed_updates][4]': 'tax_id',
      'features[subscription_cancel][enabled]': 'true',
      'features[subscription_cancel][mode]': 'at_period_end',
      'features[subscription_cancel][proration_behavior]': 'none',
      'features[subscription_update][enabled]': 'false',
      'metadata[favornoms]': 'platform_billing_v1',
    });
  });

  it('reuses a stored configuration only while it still says that', () => {
    const cfg = {
      id: 'bpc_1',
      active: true,
      metadata: { favornoms: 'platform_billing_v1' },
      features: {
        subscription_update: { enabled: false },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
    };
    expect(billing.isUsablePortalConfiguration(cfg)).toBe(true);
    expect(billing.isUsablePortalConfiguration({ ...cfg, active: false })).toBe(false);
    expect(billing.isUsablePortalConfiguration({ ...cfg, metadata: {} })).toBe(false);
    expect(
      billing.isUsablePortalConfiguration({
        ...cfg,
        features: { ...cfg.features, subscription_update: { enabled: true } },
      }),
    ).toBe(false);
    expect(
      billing.isUsablePortalConfiguration({
        ...cfg,
        features: { ...cfg.features, subscription_cancel: { enabled: true, mode: 'immediately' } },
      }),
    ).toBe(false);
  });
});

describe('the platform account (setup checklist)', () => {
  it("links to the account's own Dashboard, in test mode under test/", () => {
    expect(billing.stripeDashboardBase('acct_1UAaHOGJ7DLbSpMc', 'test')).toBe(
      'https://dashboard.stripe.com/acct_1UAaHOGJ7DLbSpMc/test/',
    );
    expect(billing.stripeDashboardBase('acct_1UAaHOGJ7DLbSpMc', 'live')).toBe(
      'https://dashboard.stripe.com/acct_1UAaHOGJ7DLbSpMc/',
    );
    expect(billing.stripeDashboardBase('../evil', 'live')).toBe('https://dashboard.stripe.com/');
  });

  it('reports what is due and whether payouts have a bank', () => {
    expect(
      billing.accountSummary({
        id: 'acct_1',
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        requirements: {
          currently_due: ['external_account', 'tos_acceptance.date'],
          past_due: ['external_account'],
        },
        external_accounts: { data: [], total_count: 0 },
      }),
    ).toEqual({
      id: 'acct_1',
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      currently_due: 2,
      has_bank: false,
    });
    expect(
      billing.accountSummary({ id: 'acct_1', external_accounts: { data: [{ id: 'ba_1' }] } })
        ?.has_bank,
    ).toBe(true);
    expect(billing.accountSummary({ id: 'acct_1', payouts_enabled: true })?.has_bank).toBe(true);
    expect(billing.accountSummary({ id: 'nope' })).toBeNull();
  });
});

describe('idempotency keys', () => {
  it('are the same for the same params in any order, and change with them', () => {
    const a = billing.idempotencyKey('billing_checkout', REQ, { a: '1', b: '2' });
    expect(a).toBe(billing.idempotencyKey('billing_checkout', REQ, { b: '2', a: '1' }));
    expect(a.startsWith(`billing_checkout:${REQ}:`)).toBe(true);
    expect(a).not.toBe(billing.idempotencyKey('billing_checkout', REQ, { a: '1', b: '3' }));
    expect(a).not.toBe(billing.idempotencyKey('billing_sub_update', REQ, { a: '1', b: '2' }));
    expect(a.length).toBeLessThan(255);
  });

  it('change when the trial date or the return page changes', () => {
    const one = billing.checkoutSessionParams(ctxOf(), 'cus_1', PRICES, URLS, 1_790_000_000);
    const two = billing.checkoutSessionParams(ctxOf(), 'cus_1', PRICES, URLS, null);
    const three = billing.checkoutSessionParams(
      ctxOf(),
      'cus_1',
      PRICES,
      billing.checkoutUrls('https://admin.favornoms.com', 'other'),
      1_790_000_000,
    );
    const key = (p: Record<string, string>) => billing.idempotencyKey('billing_checkout', REQ, p);
    expect(new Set([key(one), key(two), key(three)]).size).toBe(3);
    expect(key(one)).toBe(
      key(billing.checkoutSessionParams(ctxOf(), 'cus_1', PRICES, URLS, 1_790_000_000)),
    );
  });
});

describe('review fixes (spec §9): the request already being paid', () => {
  it('reads the invoice a change waits on, and nothing that is not an invoice id', () => {
    const withInvoice = ctxOf({
      request: {
        id: REQ,
        status: 'pending',
        rail: 'stripe',
        stripe_checkout_session_id: null,
        stripe_invoice_id: 'in_1Abc',
      },
    });
    expect(withInvoice.request.stripe_invoice_id).toBe('in_1Abc');
    for (const bad of ['cs_1Abc', 'in_../x', '', null, 42]) {
      const ctx = ctxOf({
        request: { id: REQ, status: 'pending', rail: 'stripe', stripe_invoice_id: bad },
      });
      expect(ctx.request.stripe_invoice_id).toBeNull();
    }
  });
});

describe('review fixes: putting a paid-but-unapplied change back (ME-6, WH-2)', () => {
  const rows = [
    { product_code: 'base', quantity: 1, unit_price: '29.00' },
    { product_code: 'extra_branch', quantity: 2, unit_price: 29 },
    // billing_compute keeps the delivery line at 1 x $0 when no branch delivers.
    { product_code: 'delivery', quantity: 1, unit_price: '0.00' },
  ];

  it('reads the granted package from subscription_items, a $0 line as none', () => {
    expect(billing.grantedLines(rows)).toEqual({
      quantities: { base: 1, extra_branch: 2, delivery: 0 },
      cents: { base: 2900, extra_branch: 2900 },
    });
    expect(
      billing.grantedLines([rows[0], { product_code: 'delivery', quantity: 3, unit_price: 30 }]),
    ).toEqual({
      quantities: { base: 1, extra_branch: 0, delivery: 3 },
      cents: { base: 2900, delivery: 3000 },
    });
  });

  it('refuses half a picture rather than revert from it', () => {
    expect(billing.grantedLines(rows.slice(1))).toBeNull();
    expect(billing.grantedLines(null)).toBeNull();
    expect(
      billing.grantedLines([
        rows[0],
        { product_code: 'extra_branch', quantity: 1.5, unit_price: 29 },
      ]),
    ).toBeNull();
    expect(
      billing.grantedLines([
        rows[0],
        { product_code: 'extra_branch', quantity: 1, unit_price: 'x' },
      ]),
    ).toBeNull();
    // A product Stripe does not bill (a withdrawn add-on) is not the revert's business.
    expect(
      billing.grantedLines([rows[0], { product_code: 'ai_suite', quantity: 1, unit_price: 89 }])
        ?.quantities,
    ).toEqual({ base: 1, extra_branch: 0, delivery: 0 });
  });

  it('sends the full granted package with no proration, re-adding a removed product', () => {
    const now = {
      base: { id: 'si_base', quantity: 1 },
      extra_branch: { id: 'si_branch', quantity: 3 },
    };
    expect(
      billing.revertParams({ base: 1, extra_branch: 2, delivery: 1 }, now, {
        delivery: 'price_delivery',
      }),
    ).toEqual({
      'items[0][id]': 'si_base',
      'items[0][quantity]': '1',
      'items[1][id]': 'si_branch',
      'items[1][quantity]': '2',
      'items[2][price]': 'price_delivery',
      'items[2][quantity]': '1',
      proration_behavior: 'none',
    });
    const reverted = billing.revertParams(
      { base: 1, extra_branch: 0, delivery: 0 },
      { ...now, delivery: { id: 'si_delivery', quantity: 1 } },
      {},
    );
    expect(reverted['items[1][deleted]']).toBe('true');
    expect(reverted['items[2][deleted]']).toBe('true');
    expect(Object.keys(reverted).some((k) => k.startsWith('add_invoice_items'))).toBe(false);
    expect(reverted.payment_behavior).toBeUndefined();
    expect(() => billing.revertParams({ base: 1, extra_branch: 0, delivery: 1 }, now, {})).toThrow(
      'missing_price:delivery',
    );
    expect(billing.revertIdempotencyKey(REQ, 'in_1')).toBe(`billing_revert:${REQ}:in_1`);
  });
});

describe("review fixes: Stripe's monthly total (§9.6)", () => {
  const item = (unit: unknown, quantity: unknown, recurring: unknown = { interval: 'month' }) => ({
    id: 'si',
    quantity,
    price: { unit_amount: unit, recurring, product: 'favornoms_base' },
  });

  it('sums unit_amount x quantity over the recurring items, in dollars', () => {
    expect(
      billing.subscriptionMonthlyAmount({
        items: { data: [item(2900, 1), item(2900, 2), item(3000, 3)] },
      }),
    ).toBe(177);
    expect(billing.subscriptionMonthlyAmount({ items: { data: [item(1999, 1)] } })).toBe(19.99);
    expect(
      billing.subscriptionMonthlyAmount({
        items: { data: [{ id: 'si', price: { unit_amount: 2900, type: 'recurring' } }] },
      }),
    ).toBe(29);
  });

  it('claims no total it cannot read exactly', () => {
    expect(billing.subscriptionMonthlyAmount({ items: { data: [] } })).toBeNull();
    expect(billing.subscriptionMonthlyAmount(null)).toBeNull();
    expect(
      billing.subscriptionMonthlyAmount({ items: { data: [item(2900, 1), item(null, 1)] } }),
    ).toBeNull();
    expect(billing.subscriptionMonthlyAmount({ items: { data: [item(29.5, 1)] } })).toBeNull();
    expect(
      billing.subscriptionMonthlyAmount({ items: { data: [item(2900, 1, null)] } }),
    ).toBeNull();
    expect(billing.subscriptionMonthlyAmount({ items: { data: [{ id: 'si' }] } })).toBeNull();
  });

  it('is passed to the settle of a change and the status sync, from the re-read subscription', () => {
    const sub = {
      id: 'sub_1',
      customer: { id: 'cus_1' },
      status: 'active',
      items: {
        data: [
          {
            id: 'si_base',
            quantity: 1,
            current_period_end: 1_790_000_000,
            price: {
              product: 'favornoms_base',
              unit_amount: 2900,
              recurring: { interval: 'month' },
            },
          },
          {
            id: 'si_branch',
            quantity: 2,
            current_period_end: 1_790_000_000,
            price: {
              product: 'favornoms_extra_branch',
              unit_amount: 2900,
              recurring: { interval: 'month' },
            },
          },
        ],
      },
    };
    expect(billing.changeSettleArgs(REQ, 'cus_1', sub, 'in_9')).toEqual({
      p_request_id: REQ,
      p_stripe_customer_id: 'cus_1',
      p_stripe_subscription_id: 'sub_1',
      p_invoice_id: 'in_9',
      p_paid_through: new Date(1_790_000_000 * 1000).toISOString(),
      p_items: [
        { product_code: 'base', stripe_subscription_item_id: 'si_base' },
        { product_code: 'extra_branch', stripe_subscription_item_id: 'si_branch' },
      ],
      p_card: null,
      p_monthly_amount: 87,
    });
    expect(billing.changeSettleArgs(REQ, '', sub, null)).toBeNull();
    expect(billing.changeSettleArgs('nope', 'cus_1', sub, null)).toBeNull();
    expect(billing.changeSettleArgs(REQ, 'cus_1', { ...sub, id: undefined }, null)).toBeNull();
    expect(billing.syncStatusArgs(sub, null)?.p_monthly_amount).toBe(87);
  });

  it('stores a changed card without touching status, flags or dates (WH-8)', () => {
    const card = { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2031 };
    expect(billing.cardOnlySyncArgs('sub_1', card, 58)).toEqual({
      p_stripe_subscription_id: 'sub_1',
      p_status: null,
      p_cancel_at_period_end: null,
      p_cancel_at: null,
      p_next_billing_at: null,
      p_card: card,
      p_monthly_amount: 58,
    });
  });
});

describe('review fixes: money taken but not applied (§9.5, WH-7)', () => {
  it('logs what the refund really did', () => {
    const o = (s: { amountPaidCents: number; read: boolean; refunded: number; failed: number }) =>
      billing.refundOutcome(s);
    expect(o({ amountPaidCents: 9900, read: true, refunded: 1, failed: 0 })).toEqual({
      outcome: 'refunded',
      complete: true,
    });
    expect(o({ amountPaidCents: 0, read: true, refunded: 0, failed: 0 })).toEqual({
      outcome: 'nothing_to_refund',
      complete: true,
    });
    // The payments could not be listed, or nothing refundable was found: the money was KEPT.
    expect(o({ amountPaidCents: 9900, read: false, refunded: 0, failed: 0 })).toEqual({
      outcome: 'not_refunded',
      complete: false,
    });
    expect(o({ amountPaidCents: 9900, read: true, refunded: 0, failed: 0 }).outcome).toBe(
      'not_refunded',
    );
    expect(o({ amountPaidCents: 9900, read: true, refunded: 0, failed: 1 }).outcome).toBe(
      'not_refunded',
    );
    expect(o({ amountPaidCents: 9900, read: true, refunded: 1, failed: 1 })).toEqual({
      outcome: 'partly_refunded',
      complete: false,
    });
  });

  it('says what happened to the money: refunded, not refunded, or never charged (edge-rr-4)', () => {
    // Charged and all of it on its way back.
    expect(billing.changeFailureCode(9900, true)).toBe('charged_refunded');
    expect(billing.changeFailureCode(1, true)).toBe('charged_refunded');
    // Charged and the refund failed or was partial: never "it is coming back".
    expect(billing.changeFailureCode(9900, false)).toBe('charged_not_applied');
    // Nothing reached the card (a downgrade's credit, a $0 invoice): never "your card was charged".
    expect(billing.changeFailureCode(0, true)).toBe('change_not_applied');
    expect(billing.changeFailureCode(0, false)).toBe('change_not_applied');
  });

  it("recognises Stripe's idempotency and already-refunded refusals", () => {
    const mismatch = {
      error: {
        type: 'idempotency_error',
        message: 'Keys for idempotent requests can only be used with the same parameters',
      },
    };
    expect(billing.isIdempotencyError(400, mismatch)).toBe(true);
    // Only Stripe's 400: a 409 "key in use" is a request still running, not a body mismatch.
    expect(billing.isIdempotencyError(409, mismatch)).toBe(false);
    expect(billing.isIdempotencyError(400, { error: { type: 'invalid_request_error' } })).toBe(
      false,
    );
    expect(billing.isIdempotencyError(400, null)).toBe(false);
    expect(billing.isAlreadyRefunded({ error: { code: 'charge_already_refunded' } })).toBe(true);
    expect(billing.isAlreadyRefunded({ error: { code: 'resource_missing' } })).toBe(false);
    expect(billing.isAlreadyRefunded(null)).toBe(false);
  });

  it('refunds each payment once, whoever issues it', () => {
    expect(billing.refundIdempotencyKey('pi_1')).toBe('billing_refund:pi_1');
    // The same body from the edge function and the webhook, or Stripe would refuse the shared key.
    expect(billing.refundParams({ payment_intent: 'pi_1' })).toEqual(
      billing.refundParams({ payment_intent: 'pi_1' }),
    );
    // Nothing request-specific in the body: a stale subscription's invoice is refunded with or
    // without its request, under the same key (money-rr-2).
    expect(JSON.stringify(billing.refundParams({ payment_intent: 'pi_1' }))).not.toContain(REQ);
  });
});

describe('review fixes: the invoice a change is paid through (§9.3, §9.4)', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const secs = (ms: number) => Math.floor(ms / 1000);

  it('finds the invoice of a request by its fee lines or its own metadata', () => {
    expect(
      billing.invoiceTiedToRequest(
        { metadata: { billing_request_id: REQ }, lines: { data: [] } },
        REQ,
      ),
    ).toBe(true);
    expect(
      billing.invoiceTiedToRequest(
        {
          metadata: {},
          lines: {
            data: [
              { metadata: {} },
              { metadata: { billing_request_id: REQ, product_code: 'extra_branch' } },
            ],
          },
        },
        REQ,
      ),
    ).toBe(true);
    expect(
      billing.invoiceTiedToRequest(
        { metadata: { billing_request_id: RID }, lines: { data: [{ metadata: {} }] } },
        REQ,
      ),
    ).toBe(false);
    expect(billing.invoiceTiedToRequest({ lines: { data: [] } }, REQ)).toBe(false);
    expect(billing.invoiceTiedToRequest('in_1', REQ)).toBe(false);
    expect(billing.invoiceTiedToRequest({ metadata: { billing_request_id: 'x' } }, 'x')).toBe(
      false,
    );
  });

  it('decides paid / open / draft / void / expired from the invoice as Stripe has it now', () => {
    const fresh = secs(now) - 60;
    expect(billing.changeInvoiceState({ status: 'paid' }, now)).toBe('paid');
    expect(billing.changeInvoiceState({ status: 'draft', created: fresh }, now)).toBe('draft');
    expect(billing.changeInvoiceState({ status: 'open', created: fresh }, now)).toBe('open');
    expect(billing.changeInvoiceState({ status: 'void' }, now)).toBe('void');
    expect(billing.changeInvoiceState(null, now)).toBe('void');
    // Uncollectible can still be paid at Stripe: it is voided before the request goes.
    expect(billing.changeInvoiceState({ status: 'uncollectible', created: fresh }, now)).toBe(
      'expired',
    );
    // A paid invoice is paid however old it is.
    expect(
      billing.changeInvoiceState({ status: 'paid', created: secs(now) - 9 * 86400 }, now),
    ).toBe('paid');
  });

  it("expires a pending update's invoice after the same window (money-rr-1, edge-rr-1)", () => {
    // Stripe discards the pending update after ~23 h but may leave its invoice open (and payable),
    // and pending_update_expired can be lost: start voids it and lets the request go.
    const update = (ageMs: number) => ({
      status: 'open',
      billing_reason: 'subscription_update',
      created: secs(now - ageMs),
    });
    expect(billing.changeInvoiceState(update(3600 * 1000), now)).toBe('open');
    expect(billing.changeInvoiceState(update(billing.CHANGE_INVOICE_TTL_MS + 60_000), now)).toBe(
      'expired',
    );
    expect(billing.changeInvoiceState(update(3 * 86400 * 1000), now)).toBe('expired');
  });

  it('gives a draft fee invoice the same window', () => {
    const draft = (ageMs: number) => ({
      status: 'draft',
      billing_reason: 'manual',
      created: secs(now - ageMs),
    });
    expect(billing.changeInvoiceState(draft(60_000), now)).toBe('draft');
    expect(billing.changeInvoiceState(draft(billing.CHANGE_INVOICE_TTL_MS + 60_000), now)).toBe(
      'expired',
    );
  });

  it('gives the standalone fee invoice the same ~23 h window, then expires it', () => {
    const fee = (ageMs: number) => ({
      status: 'open',
      billing_reason: 'manual',
      metadata: { billing_request_id: REQ },
      created: secs(now - ageMs),
    });
    expect(billing.changeInvoiceState(fee(3600 * 1000), now)).toBe('open');
    expect(billing.changeInvoiceState(fee(billing.CHANGE_INVOICE_TTL_MS - 60_000), now)).toBe(
      'open',
    );
    expect(billing.changeInvoiceState(fee(billing.CHANGE_INVOICE_TTL_MS + 60_000), now)).toBe(
      'expired',
    );
  });
});

describe('review fixes: one live subscription per restaurant (§9.2)', () => {
  it('cancels only a subscription of ours for this restaurant that Stripe has not ended', () => {
    const sub = (status: string, rid: unknown = RID) => ({
      id: 'sub_old',
      status,
      metadata: { restaurant_id: rid },
    });
    for (const s of ['active', 'past_due', 'unpaid', 'trialing', 'incomplete', 'paused'])
      expect(billing.shouldCancelOldSubscription(sub(s), RID)).toBe(true);
    expect(billing.shouldCancelOldSubscription(sub('canceled'), RID)).toBe(false);
    expect(billing.shouldCancelOldSubscription(sub('incomplete_expired'), RID)).toBe(false);
    expect(billing.shouldCancelOldSubscription(sub('active', 'someone-else'), RID)).toBe(false);
    expect(billing.shouldCancelOldSubscription({ status: 'active', metadata: {} }, RID)).toBe(
      false,
    );
    expect(billing.shouldCancelOldSubscription(null, RID)).toBe(false);
  });
});

describe('review fixes: the card renewals use (SP-1)', () => {
  it("makes the subscription's own card follow a new customer default, only when it has another", () => {
    expect(billing.subscriptionCardNeedsSync({ default_payment_method: 'pm_old' }, 'pm_new')).toBe(
      true,
    );
    expect(
      billing.subscriptionCardNeedsSync({ default_payment_method: { id: 'pm_old' } }, 'pm_new'),
    ).toBe(true);
    expect(billing.subscriptionCardNeedsSync({ default_payment_method: 'pm_new' }, 'pm_new')).toBe(
      false,
    );
    // None of its own: renewals already use the customer's default.
    expect(billing.subscriptionCardNeedsSync({ default_payment_method: null }, 'pm_new')).toBe(
      false,
    );
    expect(billing.subscriptionCardNeedsSync({ default_payment_method: 'pm_old' }, null)).toBe(
      false,
    );
    expect(billing.cardSyncIdempotencyKey('sub_1', 'pm_2', 'evt_1')).toBe(
      'billing_card_sync:sub_1:pm_2:evt_1',
    );
  });
});

describe('review fixes: idempotency keys (§9.4)', () => {
  const params = { a: '1', b: '2' };

  it('one change key and one fee-invoice key per request, with no fingerprint', () => {
    expect(billing.changeIdempotencyKey(REQ)).toBe(`billing_change:${REQ}`);
    expect(billing.changeInvoiceIdempotencyKey(REQ)).toBe(`billing_change_invoice:${REQ}`);
  });

  it('a Checkout key moves on with the stored session and a retry, not on a double click', () => {
    const first = billing.checkoutIdempotencyKey(REQ, null, params);
    expect(first.startsWith(`billing_checkout:${REQ}:none:`)).toBe(true);
    // Double click: same stored session, same body -> same key -> the same session back.
    expect(billing.checkoutIdempotencyKey(REQ, null, { b: '2', a: '1' })).toBe(first);
    // Continue to payment after a session was stored: a new session, not a replay (ME-7).
    const later = billing.checkoutIdempotencyKey(REQ, 'cs_test_1', params);
    expect(later).not.toBe(first);
    expect(later.startsWith(`billing_checkout:${REQ}:cs_test_1:`)).toBe(true);
    // A replayed session that is no longer open: retried under a key naming it.
    const retry = billing.checkoutIdempotencyKey(REQ, 'cs_test_1', params, 'cs_test_2');
    expect(retry.startsWith(`billing_checkout:${REQ}:cs_test_1:retry:cs_test_2:`)).toBe(true);
    // A different body (another branch's return page) is a different key.
    expect(billing.checkoutIdempotencyKey(REQ, null, { a: '1', b: '3' })).not.toBe(first);
    // Stripe caps keys at 255 characters, with real (long) session ids too.
    const long = `cs_test_${'a'.repeat(58)}`;
    expect(billing.checkoutIdempotencyKey(REQ, long, params, long).length).toBeLessThan(255);
  });
});

describe('second review fixes (spec §10)', () => {
  it('treats a key still in use (409) as busy, not as a conflict to resolve (edge-rr-3)', () => {
    const inUse = {
      error: { type: 'invalid_request_error', code: 'idempotency_key_in_use' },
    };
    expect(billing.isIdempotencyInUse(409, inUse)).toBe(true);
    expect(billing.isIdempotencyInUse(409, null)).toBe(true);
    expect(billing.isIdempotencyInUse(400, inUse)).toBe(true);
    expect(billing.isIdempotencyInUse(400, { error: { type: 'idempotency_error' } })).toBe(false);
    expect(billing.isIdempotencyInUse(402, { error: { code: 'card_declined' } })).toBe(false);
    // The two never overlap for Stripe's real answers.
    expect(billing.isIdempotencyError(409, inUse)).toBe(false);
  });

  it('makes the fee invoice first, empty, keyed per request (money-rr-5)', () => {
    const ctx = ctxOf({ stripe_managed: true });
    expect(billing.feeInvoiceParams(ctx, 'cus_1', 'sub_1')).toEqual({
      customer: 'cus_1',
      subscription: 'sub_1',
      // Nothing pending is swept in: the fees are created ON this invoice.
      pending_invoice_items_behavior: 'exclude',
      auto_advance: 'false',
      'metadata[billing_request_id]': REQ,
      'metadata[restaurant_id]': RID,
    });
  });

  it('creates each fee ON the fee invoice at its net amount, tied to the request', () => {
    const ctx = ctxOf({
      stripe_managed: true,
      charges: [
        { id: CH_B2, code: 'extra_branch', branch_id: BRANCH_2, net_amount: 70 },
        { id: CH_B3, code: 'extra_branch', branch_id: BRANCH_3, net_amount: '70.00' },
        { id: CH_BASE, code: 'delivery', branch_id: BRANCH_2, net_amount: '59.00' },
        // A free unlock is not an item at all.
        {
          id: '33333333-3333-4333-8333-333333333334',
          code: 'delivery',
          branch_id: BRANCH_3,
          net_amount: 0,
        },
      ],
    });
    expect(billing.feeInvoiceItemParams(ctx, 'cus_1', 'in_fee')).toEqual([
      {
        customer: 'cus_1',
        invoice: 'in_fee',
        'price_data[currency]': 'usd',
        'price_data[product]': 'favornoms_extra_branch_setup',
        'price_data[unit_amount]': '7000',
        quantity: '2',
        'metadata[billing_request_id]': REQ,
        'metadata[product_code]': 'extra_branch',
      },
      {
        customer: 'cus_1',
        invoice: 'in_fee',
        'price_data[currency]': 'usd',
        'price_data[product]': 'favornoms_delivery_setup',
        'price_data[unit_amount]': '5900',
        quantity: '1',
        'metadata[billing_request_id]': REQ,
        'metadata[product_code]': 'delivery',
        'metadata[billing_charge_id]': CH_BASE,
      },
    ]);
    expect(billing.feeInvoiceItemParams(ctxOf({ charges: [] }), 'cus_1', 'in_fee')).toEqual([]);
  });

  it("finds a request's fee items: on an invoice, or still pending (money-rr-5)", () => {
    const list = {
      data: [
        { id: 'ii_1', invoice: 'in_paid', metadata: { billing_request_id: REQ } },
        { id: 'ii_2', invoice: { id: 'in_paid' }, metadata: { billing_request_id: REQ } },
        { id: 'ii_3', invoice: null, metadata: { billing_request_id: REQ } },
        // Another request's, and one of nobody's.
        { id: 'ii_4', invoice: null, metadata: { billing_request_id: RID } },
        { id: 'ii_5', invoice: 'in_other', metadata: {} },
        { id: 'ii_6', invoice: null, metadata: null },
      ],
    };
    expect(billing.requestInvoiceItems(list, REQ)).toEqual({
      invoiceIds: ['in_paid'],
      pendingIds: ['ii_3'],
    });
    expect(billing.requestInvoiceItems(null, REQ)).toEqual({ invoiceIds: [], pendingIds: [] });
    expect(billing.requestInvoiceItems(list, 'not-a-uuid')).toEqual({
      invoiceIds: [],
      pendingIds: [],
    });
  });

  it('reads the request from a change invoice that never had it stored (money-rr-4)', () => {
    const line = (id: unknown) => ({ metadata: { billing_request_id: id } });
    // The fee invoice names it itself.
    expect(
      billing.invoiceRequestId({ billing_reason: 'manual', metadata: { billing_request_id: REQ } }),
    ).toBe(REQ);
    // A proration invoice: its fee lines do.
    expect(
      billing.invoiceRequestId({
        billing_reason: 'subscription_update',
        metadata: {},
        lines: { data: [{ metadata: {} }, line(REQ), line(REQ)] },
      }),
    ).toBe(REQ);
    // Two requests named: none is trusted.
    expect(
      billing.invoiceRequestId({
        billing_reason: 'subscription_update',
        lines: { data: [line(REQ), line(RID)] },
      }),
    ).toBeNull();
    // A renewal or a first invoice is never taken for a request's payment.
    for (const reason of ['subscription_cycle', 'subscription_create', null])
      expect(
        billing.invoiceRequestId({
          billing_reason: reason,
          metadata: { billing_request_id: REQ },
          lines: { data: [line(REQ)] },
        }),
      ).toBeNull();
    expect(
      billing.invoiceRequestId({ billing_reason: 'manual', metadata: { billing_request_id: 'x' } }),
    ).toBeNull();
    expect(billing.invoiceRequestId(null)).toBeNull();
  });

  it("measures what a change invoice did to the customer's balance (money-rr-8, edge-rr-2)", () => {
    // A mid-period downgrade: a negative invoice, credited to the balance.
    expect(billing.invoiceBalanceMovement({ starting_balance: 0, ending_balance: -2900 })).toBe(
      -2900,
    );
    // An upgrade paid partly with credit: the credit was used up.
    expect(billing.invoiceBalanceMovement({ starting_balance: -2900, ending_balance: 0 })).toBe(
      2900,
    );
    expect(billing.invoiceBalanceMovement({ starting_balance: 0, ending_balance: 0 })).toBe(0);
    // Not finalized (ending_balance null) or unreadable: nothing is reversed.
    expect(billing.invoiceBalanceMovement({ starting_balance: 0, ending_balance: null })).toBe(0);
    expect(billing.invoiceBalanceMovement({ starting_balance: '0', ending_balance: -1 })).toBe(0);
    expect(billing.invoiceBalanceMovement(null)).toBe(0);
  });

  it('reverses that movement exactly, once per request and invoice', () => {
    // The downgrade's $29 credit is taken back: a positive amount is a debit.
    expect(billing.balanceUndoParams(REQ, 'in_1', -2900)).toEqual({
      amount: '2900',
      currency: 'usd',
      description: 'Package change not applied: balance movement of its invoice reversed',
      'metadata[billing_request_id]': REQ,
      'metadata[invoice]': 'in_1',
      'metadata[purpose]': 'platform_billing_balance_undo',
    });
    // Credit spent on an upgrade is given back: a negative amount is a credit.
    expect(billing.balanceUndoParams(REQ, 'in_1', 2900)?.amount).toBe('-2900');
    expect(billing.balanceUndoParams(REQ, 'in_1', 0)).toBeNull();
    expect(billing.balanceUndoParams(REQ, 'in_1', 0.5)).toBeNull();
    expect(billing.balanceUndoIdempotencyKey(REQ, 'in_1')).toBe(`billing_balance_undo:${REQ}:in_1`);
  });

  it('refunds only renewals and changes of a subscription nobody holds (money-rr-2)', () => {
    expect(billing.isStaleRefundableReason('subscription_cycle')).toBe(true);
    expect(billing.isStaleRefundableReason('subscription_update')).toBe(true);
    // The first invoice is checkout.session.completed's to decide.
    expect(billing.isStaleRefundableReason('subscription_create')).toBe(false);
    expect(billing.isStaleRefundableReason('manual')).toBe(false);
    expect(billing.isStaleRefundableReason(undefined)).toBe(false);
  });

  it('acts on a subscription only when it and its customer both name the restaurant', () => {
    const customer = (rid: unknown, extra: Record<string, unknown> = {}) => ({
      id: 'cus_1',
      metadata: { restaurant_id: rid },
      ...extra,
    });
    expect(
      billing.subscriptionOwner({ metadata: { restaurant_id: RID }, customer: customer(RID) }),
    ).toBe(RID);
    // The customer is someone else's, deleted, or not expanded: not provably ours.
    expect(
      billing.subscriptionOwner({ metadata: { restaurant_id: RID }, customer: customer(REQ) }),
    ).toBeNull();
    expect(
      billing.subscriptionOwner({
        metadata: { restaurant_id: RID },
        customer: customer(RID, { deleted: true }),
      }),
    ).toBeNull();
    expect(
      billing.subscriptionOwner({ metadata: { restaurant_id: RID }, customer: 'cus_1' }),
    ).toBeNull();
    // Made by hand: no restaurant on it.
    expect(billing.subscriptionOwner({ metadata: {}, customer: customer(RID) })).toBeNull();
    expect(billing.subscriptionOwner(null)).toBeNull();
  });

  it('answers a claim by its three states; anything else is retried (SEC-R2-2)', () => {
    expect(billing.eventClaimState('claimed')).toBe('claimed');
    expect(billing.eventClaimState('handled')).toBe('handled');
    expect(billing.eventClaimState('in_flight')).toBe('in_flight');
    // The old boolean, or anything unreadable, is never taken as "handled".
    expect(billing.eventClaimState(true)).toBe('in_flight');
    expect(billing.eventClaimState(false)).toBe('in_flight');
    expect(billing.eventClaimState(null)).toBe('in_flight');
  });

  it('keys each fee item and each card sync so a retry replays and a new event does not', () => {
    expect(billing.feeInvoiceItemIdempotencyKey(REQ, 'in_1', 0)).toBe(
      `billing_change_fee:${REQ}:in_1:0`,
    );
    expect(billing.feeInvoiceItemIdempotencyKey(REQ, 'in_1', 1)).not.toBe(
      billing.feeInvoiceItemIdempotencyKey(REQ, 'in_1', 0),
    );
    // edge-rr-5: A -> B -> A -> B the same day is four requests, not a replay of the first.
    expect(billing.cardSyncIdempotencyKey('sub_1', 'pm_b', 'evt_1')).not.toBe(
      billing.cardSyncIdempotencyKey('sub_1', 'pm_b', 'evt_3'),
    );
    const long = billing.cardSyncIdempotencyKey(
      `sub_${'a'.repeat(60)}`,
      `pm_${'b'.repeat(60)}`,
      `evt_${'c'.repeat(60)}`,
    );
    expect(long.length).toBeLessThan(255);
  });
});

describe('Stripe calls give up after 20 s (SEC-R2-2, money-rr-6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends every v1 call with a 20 s timeout signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      seen = init.signal;
      return new Response(JSON.stringify({ id: 'cus_1' }), { status: 200 });
    });
    const res = await connect.stripeRequest('sk_test_x', 'GET', '/v1/customers/cus_1');
    expect(res).toEqual({ ok: true, status: 200, data: { id: 'cus_1' } });
    expect(connect.STRIPE_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('turns a timeout into a network failure (status 0) that every caller retries', async () => {
    const aborted = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(aborted);
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      if (init.signal?.aborted) throw init.signal.reason;
      return new Response('{}', { status: 200 });
    });
    const res = await connect.stripeRequest('sk_test_x', 'POST', '/v1/refunds', {
      params: { payment_intent: 'pi_1' },
    });
    expect(res).toEqual({ ok: false, status: 0, error: null });
    expect(connect.isRetryableStripeFailure(res.status)).toBe(true);
  });

  it('never reads a body cut off by the timeout as an empty success', async () => {
    const aborted = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(aborted);
    // The headers arrived in time; the body did not.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    }));
    const res = await connect.stripeRequest('sk_test_x', 'GET', '/v1/invoices/in_1');
    expect(res).toEqual({ ok: false, status: 0, error: null });
  });
});
