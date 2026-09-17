import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { DENIED_ENTITLEMENTS, type Entitlements } from '@favornoms/shared';
import {
  branchVerdict,
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
    ...over,
  };
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
