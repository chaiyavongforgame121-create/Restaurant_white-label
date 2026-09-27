import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { DENIED_ENTITLEMENTS, type Entitlements } from '@favornoms/shared';
import { MANUAL_RAIL, type BillingRailInfo } from '@favornoms/database/queries';
import {
  branchVerdict,
  deadlineFact,
  fmtDate,
  resolvePrimaryAction,
  tenantHealth,
  type BranchLite,
  type Msg,
  type TenantRow,
} from './tenant-health';

// tenant-health.ts decides and returns message keys; nothing in it is worded. These
// tests pin the decisions to their keys and prove every key exists in each language,
// so a typo shows up here rather than as "platform.health…" on the console.

const NOW = Date.parse('2026-09-17T12:00:00Z');
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

type Tree = { [key: string]: string | Tree };
const catalogue = (locale: string): Tree =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../../messages', locale, 'platform.json'), 'utf8'),
  ) as Tree;

// The same engine the pages use, told to throw instead of printing the key.
function render(tree: Tree, locale: string, m: Msg): string {
  const t = createTranslator({
    locale,
    messages: { platform: tree },
    namespace: 'platform',
    onError: (error) => {
      throw error;
    },
  });
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.values ?? {})) {
    values[k] = typeof v === 'object' ? fmtDate(v.date) : v;
  }
  return (t as unknown as (key: string, values?: Record<string, string | number>) => string)(m.key, values);
}

function ent(over: Partial<Entitlements> = {}): Entitlements {
  return {
    ...DENIED_ENTITLEMENTS,
    restaurantId: 'r1',
    planCode: 'base',
    status: 'active',
    entitled: true,
    entitledThrough: inDays(20),
    branchSeats: 1,
    branchesUsed: 1,
    monthlyTotal: 199,
    features: {},
    addons: [],
    ...over,
  };
}

function row(over: Partial<TenantRow> = {}): TenantRow {
  return {
    id: 'r1',
    name: 'Pho Corner',
    slug: 'pho-corner',
    createdAt: '2026-01-02T00:00:00Z',
    ent: ent(),
    franchise: false,
    loyaltyScope: 'branch',
    cancelAtPeriodEnd: false,
    billing: MANUAL_RAIL,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    openInvoice: null,
    ...over,
  };
}

/** A restaurant paying by card through Stripe (billing_is_stripe_managed). */
function card(over: Partial<BillingRailInfo> = {}): BillingRailInfo {
  return {
    ...MANUAL_RAIL,
    stripeEnabled: true,
    rail: 'stripe',
    status: 'active',
    hasStripeCustomer: true,
    nextChargeAt: inDays(3),
    nextChargeAmount: 59,
    card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
    ...over,
  };
}

function stripeRow(over: Partial<TenantRow> = {}, rail: Partial<BillingRailInfo> = {}): TenantRow {
  return row({
    billing: card(rail),
    stripeCustomerId: 'cus_A1',
    stripeSubscriptionId: 'sub_B2',
    ...over,
  });
}

function branch(over: Partial<BranchLite> = {}): BranchLite {
  return {
    id: 'b1',
    restaurant_id: 'r1',
    name: 'Downtown',
    slug: 'downtown',
    is_active: true,
    orders_paused: false,
    entitled_through: inDays(20),
    timezone: 'America/Chicago',
    custom_domain: null,
    has_hours: true,
    closure: null,
    ...over,
  };
}

describe('tenantHealth', () => {
  it('reads a healthy paying tenant as live', () => {
    const h = tenantHealth(row(), [branch()], NOW);
    expect(h.lamps.map((l) => l.label.key)).toEqual(['health.chip.live']);
    expect(h.clause).toEqual({ key: 'health.clause.paidThrough', values: { date: { date: inDays(20) } } });
    expect(h.branchCount).toEqual({ key: 'health.branchCount', values: { count: 1 } });
    expect(h.branchQualifier.key).toBe('health.qualifier.allLive');
    expect(h.reason).toBeNull();
    expect(h.severity).toBe(0);
  });

  it('shows both lamps, worst first, when billing lapsed and access is off', () => {
    const r = row({ ent: ent({ status: 'expired', entitledThrough: inDays(-3) }) });
    const h = tenantHealth(r, [branch({ is_active: false, entitled_through: inDays(-3) })], NOW);
    expect(h.lamps.map((l) => l.label.key)).toEqual(['health.chip.suspended', 'health.chip.expired']);
    expect(h.clause.key).toBe('health.clause.bothOff');
    expect(h.reason?.map((m) => m.key)).toEqual([
      'health.reason.allSuspended',
      'health.reason.lapsedStorefront',
    ]);
    expect(resolvePrimaryAction(r, h, null)?.label.key).toBe('health.action.restore');
  });

  it('warns a paid store about to go dark and offers Extend', () => {
    const r = row({ ent: ent({ entitledThrough: inDays(3) }) });
    const h = tenantHealth(r, [branch({ entitled_through: inDays(3) })], NOW);
    expect(h.expiringSoon).toBe(true);
    expect(h.billing.label).toEqual({ key: 'health.chip.expiresIn', values: { days: 3 } });
    expect(h.clause.key).toBe('health.clause.goesDark');
    expect(resolvePrimaryAction(r, h, null)?.label.key).toBe('health.action.extend');
  });

  it('prices the conversion of a lapsed trial', () => {
    const r = row({ ent: ent({ planCode: 'trial', status: 'expired', entitledThrough: inDays(-1) }) });
    const h = tenantHealth(r, [branch({ entitled_through: inDays(-1) })], NOW);
    expect(resolvePrimaryAction(r, h, 249)?.label).toEqual({
      key: 'health.action.convertPriced',
      values: { price: '$249' },
    });
    expect(resolvePrimaryAction(r, h, null)?.label.key).toBe('health.action.convert');
  });

  it('says no storefront for a tenant with no branches', () => {
    const h = tenantHealth(row({ ent: ent({ entitledThrough: null, status: 'none' }) }), [], NOW);
    expect(h.clause.key).toBe('health.clause.noStorefrontUnpaid');
    expect(h.branchCount).toEqual({ key: 'health.branchCount', values: { count: 0 } });
    expect(h.reason?.map((m) => m.key)).toEqual(['health.reason.noSubscriptionNoBranches']);
  });
});

describe('tenantHealth on the Stripe rail', () => {
  it('renews by itself: no warning, no Extend, "renews" on the next charge date', () => {
    // Three days left would warn a manual store and offer Extend.
    const r = stripeRow({ ent: ent({ entitledThrough: inDays(3) }) });
    const h = tenantHealth(r, [branch({ entitled_through: inDays(3) })], NOW);
    expect(h.expiringSoon).toBe(false);
    expect(h.billing.label.key).toBe('health.chip.live');
    expect(h.clause).toEqual({ key: 'stripe.clause.renewsOn', values: { date: { date: inDays(3) } } });
    expect(h.severity).toBe(0);
    expect(h.reason).toBeNull();
    expect(resolvePrimaryAction(r, h, 59)).toBeNull();
  });

  it('does not promise a renewal when Stripe has no next charge scheduled', () => {
    // Its paid-through date carries the 7-day grace after the period end, so it is no
    // stand-in for the day Stripe charges: the row says what is true, "paid through".
    const r = stripeRow({ ent: ent({ entitledThrough: inDays(20) }) }, { nextChargeAt: null });
    expect(tenantHealth(r, [branch()], NOW).clause).toEqual({
      key: 'health.clause.paidThrough',
      values: { date: { date: inDays(20) } },
    });
  });

  it('a card store cancelled on a custom date (cancel_at only) ends on that date, not "renews"', () => {
    // The Stripe Dashboard's "cancel on a custom date" sets cancel_at and leaves
    // cancel_at_period_end false; billing_rail_json then leaves no next charge. The
    // paid-through date is a week later (the renewal grace), but Stripe ends it on cancel_at.
    const r = stripeRow({ ent: ent({ entitledThrough: inDays(10) }) }, { cancelAt: inDays(3), nextChargeAt: null });
    const h = tenantHealth(r, [branch({ entitled_through: inDays(10) })], NOW);
    expect(h.billing.label).toEqual({ key: 'health.chip.cancelling', values: { days: 3 } });
    expect(h.clause).toEqual({ key: 'health.clause.ends', values: { date: { date: inDays(3) } } });
    expect(h.expiringSoon).toBe(true);
    expect(h.reason).toBeNull();
    expect(resolvePrimaryAction(r, h, 59)).toBeNull();
    expect(deadlineFact(r, true)).toEqual({ label: { key: 'stripe.drawer.endsOn' }, date: inDays(3) });
  });

  it('a cancel_at after the next renewal still renews once', () => {
    const r = stripeRow({}, { cancelAt: inDays(40), nextChargeAt: inDays(3) });
    const h = tenantHealth(r, [branch()], NOW);
    expect(h.clause).toEqual({ key: 'stripe.clause.renewsOn', values: { date: { date: inDays(3) } } });
    expect(h.expiringSoon).toBe(false);
  });

  it('a failed renewal names its grace date and still offers no manual repair', () => {
    const r = stripeRow(
      { ent: ent({ status: 'past_due', entitledThrough: inDays(5) }) },
      { status: 'past_due', graceUntil: inDays(5) },
    );
    const h = tenantHealth(r, [branch({ entitled_through: inDays(5) })], NOW);
    expect(h.billing.label.key).toBe('health.chip.pastDue');
    expect(h.clause).toEqual({ key: 'stripe.clause.graceUntil', values: { date: { date: inDays(5) } } });
    expect(h.reason).toEqual([{ key: 'stripe.reason.pastDue', values: { date: { date: inDays(5) } } }]);
    // It DOES go dark on that date unless the card is paid, so it is in the expiring cohort.
    expect(h.expiringSoon).toBe(true);
    expect(resolvePrimaryAction(r, h, 59)).toBeNull();
  });

  it('a manual past-due store keeps the countdown', () => {
    const r = row({ ent: ent({ status: 'past_due', entitledThrough: inDays(4) }) });
    const h = tenantHealth(r, [branch({ entitled_through: inDays(4) })], NOW);
    expect(h.clause).toEqual({ key: 'health.clause.graceLeft', values: { days: 4 } });
    expect(h.reason?.[0]?.key).toBe('health.reason.pastDue');
  });

  it('a card store set to cancel ends on its date, with nothing to click', () => {
    const r = stripeRow({ ent: ent({ entitledThrough: inDays(4) }) }, { cancelAtPeriodEnd: true });
    const h = tenantHealth(r, [branch({ entitled_through: inDays(4) })], NOW);
    expect(h.billing.label.key).toBe('health.chip.cancelling');
    expect(h.clause.key).toBe('health.clause.ends');
    expect(h.expiringSoon).toBe(true);
    expect(resolvePrimaryAction(r, h, 59)).toBeNull();
  });

  it('a lapsed card store says where the repair is instead of offering Extend', () => {
    const r = stripeRow({ ent: ent({ status: 'active', entitledThrough: inDays(-1) }) });
    const h = tenantHealth(r, [branch({ entitled_through: inDays(-1) })], NOW);
    expect(h.entitled).toBe(false);
    expect(h.reason?.map((m) => m.key)).toEqual([
      'health.reason.lapsedStorefront',
      'stripe.reason.lapsed',
      'health.reason.accessFine',
    ]);
    expect(resolvePrimaryAction(r, h, 59)).toBeNull();
    // The same store on the manual rail is offered Extend.
    const manual = row({ ent: r.ent });
    expect(resolvePrimaryAction(manual, tenantHealth(manual, [branch({ entitled_through: inDays(-1) })], NOW), 59)?.kind).toBe(
      'extend',
    );
  });

  it('still offers Restore: platform access is ours, whatever the rail', () => {
    const r = stripeRow();
    const h = tenantHealth(r, [branch({ is_active: false })], NOW);
    expect(resolvePrimaryAction(r, h, 59)?.kind).toBe('restore');
  });
});

describe('deadlineFact', () => {
  it('reads "Paid through" on the manual rail and "Lapsed" once it has passed', () => {
    expect(deadlineFact(row(), true)).toEqual({ label: { key: 'drawer.package.paidThrough' }, date: inDays(20) });
    const lapsed = row({ ent: ent({ entitledThrough: inDays(-2) }) });
    expect(deadlineFact(lapsed, false)).toEqual({ label: { key: 'drawer.package.lapsed' }, date: inDays(-2) });
  });

  it('reads "Renews", "Grace until" or "Ends" for a card store', () => {
    expect(deadlineFact(stripeRow(), true)).toEqual({ label: { key: 'stripe.drawer.renewsOn' }, date: inDays(3) });
    expect(
      deadlineFact(stripeRow({ ent: ent({ status: 'past_due' }) }, { graceUntil: inDays(6) }), true),
    ).toEqual({ label: { key: 'stripe.drawer.graceUntil' }, date: inDays(6) });
    expect(
      deadlineFact(stripeRow({}, { cancelAtPeriodEnd: true, cancelAt: inDays(9) }), true),
    ).toEqual({ label: { key: 'stripe.drawer.endsOn' }, date: inDays(9) });
    // Without Stripe's own date, the store's deadline stands in.
    expect(deadlineFact(stripeRow({}, { cancelAtPeriodEnd: true }), true).date).toBe(inDays(20));
    // No charge scheduled and no cancellation: the paid-through date, called what it is.
    expect(deadlineFact(stripeRow({}, { nextChargeAt: null }), true)).toEqual({
      label: { key: 'drawer.package.paidThrough' },
      date: inDays(20),
    });
  });
});

describe('branchVerdict', () => {
  it('passes a closure reason through untranslated', () => {
    const v = branchVerdict(
      branch({ closure: { starts_at: inDays(-1), ends_at: inDays(2), reason: 'Renovation' } }),
      NOW,
      null,
    );
    expect(v?.why).toEqual({
      key: 'health.verdict.why.closureWithReason',
      values: { date: { date: inDays(2) }, reason: 'Renovation' },
    });
  });

  it('reports a failed hours probe as unknown, not closed', () => {
    expect(branchVerdict(branch(), NOW, 'unknown')?.label.key).toBe('health.verdict.label.unknown');
    expect(branchVerdict(branch(), NOW, null)).toBeNull();
  });
});

describe('platform messages', () => {
  // Every message the module can produce, gathered from scenarios that reach each branch.
  const produced: Msg[] = [];
  const collect = (r: TenantRow, bs: BranchLite[]) => {
    const h = tenantHealth(r, bs, NOW);
    produced.push(...h.lamps.map((l) => l.label), h.billing.label, h.clause, h.branchCount, h.branchQualifier);
    produced.push(...(h.reason ?? []));
    const a = resolvePrimaryAction(r, h, 199);
    if (a) produced.push(a.label);
    const c = resolvePrimaryAction(r, h, null);
    if (c) produced.push(c.label);
    for (const b of bs) {
      for (const open of [true, false, 'unknown', null] as const) {
        const v = branchVerdict(b, NOW, open);
        if (v) produced.push(v.label, v.hint, v.why);
      }
    }
  };
  collect(row(), [branch(), branch({ id: 'b2', has_hours: false })]);
  collect(row({ ent: ent({ status: 'trialing', planCode: 'trial', entitledThrough: inDays(2) }) }), [branch()]);
  collect(row({ ent: ent({ status: 'trialing', planCode: 'trial', entitledThrough: inDays(0.2) }) }), [branch()]);
  collect(row({ ent: ent({ status: 'past_due', entitledThrough: inDays(4) }) }), [branch({ orders_paused: true })]);
  collect(row({ cancelAtPeriodEnd: true, ent: ent({ entitledThrough: inDays(5) }) }), [branch()]);
  collect(row({ ent: ent({ entitledThrough: inDays(3) }) }), [
    branch(),
    branch({ id: 'b2', is_active: false }),
    branch({ id: 'b3', orders_paused: true }),
  ]);
  collect(row({ ent: ent({ status: 'expired', entitledThrough: inDays(-2) }) }), [
    branch({ entitled_through: null }),
    branch({ id: 'b2', entitled_through: inDays(-2), is_active: false }),
  ]);
  collect(row({ ent: ent({ status: 'none', planCode: 'none', entitledThrough: null }) }), []);
  collect(row({ ent: ent({ status: 'expired', entitledThrough: inDays(-2) }) }), []);
  collect(row(), [
    branch({ closure: { starts_at: inDays(-1), ends_at: inDays(1), reason: null } }),
    branch({ id: 'b2', closure: { starts_at: inDays(-1), ends_at: inDays(1), reason: 'Holiday' } }),
    branch({ id: 'b3', orders_paused: true }),
  ]);
  collect(row({ ent: ent({ status: 'expired', entitledThrough: inDays(-2) }) }), [
    branch({ is_active: false }),
    branch({ id: 'b2', is_active: false }),
  ]);
  collect(stripeRow(), [branch()]);
  collect(stripeRow({ ent: ent({ status: 'past_due', entitledThrough: inDays(5) }) }, { graceUntil: inDays(5) }), [
    branch(),
  ]);
  collect(stripeRow({ ent: ent({ entitledThrough: inDays(-1) }) }), [branch({ entitled_through: inDays(-1) })]);
  collect(stripeRow({ ent: ent({ entitledThrough: inDays(10) }) }, { cancelAt: inDays(3), nextChargeAt: null }), [branch()]);
  collect(stripeRow({ ent: ent({ entitledThrough: inDays(5) }) }, { nextChargeAt: null }), [branch()]);
  for (const r of [
    row(),
    row({ ent: ent({ entitledThrough: inDays(-1) }) }),
    stripeRow(),
    stripeRow({ ent: ent({ status: 'past_due' }) }),
    stripeRow({}, { cancelAtPeriodEnd: true }),
    stripeRow({}, { cancelAt: inDays(3), nextChargeAt: null }),
    stripeRow({}, { nextChargeAt: null }),
  ]) {
    produced.push(deadlineFact(r, true).label, deadlineFact(r, false).label);
  }

  for (const locale of ['en', 'es', 'vi', 'th']) {
    it(`renders every produced message in ${locale}`, () => {
      const tree = catalogue(locale);
      for (const m of produced) {
        expect(render(tree, locale, m).trim(), `${locale} ${m.key}`).not.toBe('');
      }
    });
  }

  it('renders English the way the console always read', () => {
    const en = catalogue('en');
    expect(render(en, 'en', { key: 'health.branchCount', values: { count: 0 } })).toBe('No branches');
    expect(render(en, 'en', { key: 'health.branchCount', values: { count: 3 } })).toBe('3 branches');
    expect(render(en, 'en', { key: 'health.chip.trial', values: { days: 2 } })).toBe('Trial · 2d left');
    expect(
      render(en, 'en', { key: 'health.clause.paidThrough', values: { date: { date: '2026-10-07T00:00:00Z' } } }),
    ).toBe('paid through Oct 7, 2026');
  });
});

describe('fmtDate', () => {
  it('pins the day to UTC and follows the interface language', () => {
    expect(fmtDate('2026-10-07T00:00:00Z')).toBe('Oct 7, 2026');
    expect(fmtDate('2026-10-07T00:00:00Z', 'th')).toContain('2026');
    expect(fmtDate(null, 'es')).toBe('—');
  });
});
