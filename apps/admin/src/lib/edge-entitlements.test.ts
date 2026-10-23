import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DENIED,
  edgeHasFeature,
  edgeOwnsFeature,
  loadEntitlements,
} from '../../../../supabase/functions/_shared/entitlements';

/**
 * The edge's copy of "does this branch deliver today" (docs/PACKAGING-2026-10-24.md §3), pinned
 * from here for the same reason as stripe-billing-edge.test.ts: a Deno function cannot run under
 * this app's test runner, but supabase/functions/_shared/entitlements.ts imports nothing.
 *
 * What is at stake: place-order refuses a delivery order with 403 feature_not_entitled:delivery
 * when this answers no. Delivery is part of the one plan now, so every branch of a paid-up or
 * trialling restaurant delivers unless its merchant switched it off; and the same rule as SQL
 * private.branch_feature_granted, or the up-front answer and the deliveries trigger disagree.
 */

const RID = '22222222-2222-4222-8222-222222222222';
const BRANCH = '44444444-4444-4444-8444-444444444441';
const OTHER_BRANCH = '44444444-4444-4444-8444-444444444442';
const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';

/** The plan's and the trial's feature map (§2): exactly these two. */
const PLAN_FEATURES = { card_payment: true, delivery: true };

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/**
 * A service-role client that answers `from(t).select(..).eq(..)...maybeSingle()` from in-memory
 * rows, and records every query so a test can pin which tables were read and with what filters.
 */
function fakeAdmin(tables: Tables, failing: string[] = []) {
  const queries: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      queries.push({ table, filters });
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          if (failing.includes(table)) {
            return { data: null, error: { message: `relation "${table}" is unreadable` } };
          }
          const rows = (tables[table] ?? []).filter((r) =>
            Object.entries(filters).every(([k, v]) => r[k] === v),
          );
          if (rows.length > 1) return { data: null, error: { message: 'more than one row' } };
          return { data: rows[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
  const reads = (table: string) => queries.filter((q) => q.table === table);
  return { admin, queries, reads };
}

function entitlementsRow(over: Row = {}): Row {
  return {
    restaurant_id: RID,
    plan_code: 'base',
    status: 'active',
    entitled_through: FUTURE,
    trial_ends_at: null,
    branch_seats: 2,
    monthly_total: 98,
    features: PLAN_FEATURES,
    addons: [],
    ...over,
  };
}

function setup(
  ent: Row = {},
  switches: Array<{ branch_id: string; active: boolean }> = [],
  failing: string[] = [],
) {
  return fakeAdmin(
    {
      branches: [
        { id: BRANCH, restaurant_id: RID },
        { id: OTHER_BRANCH, restaurant_id: RID },
      ],
      billing_entitlements: [entitlementsRow(ent)],
      branch_addons: switches.map((s) => ({ ...s, code: 'delivery' })),
    },
    failing,
  );
}

/** What place-order asks: this branch, with its delivery answer. */
async function delivers(fake: ReturnType<typeof setup>, branchId = BRANCH) {
  const ent = await loadEntitlements(
    fake.admin,
    { restaurantId: RID, branchId },
    { delivery: true },
  );
  return edgeHasFeature(ent, 'delivery');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('every branch delivers on the plan and on the trial', () => {
  it('a FavorNoms Plan branch with no switch row delivers (a new branch included)', async () => {
    expect(await delivers(setup())).toBe(true);
  });

  it('a trial branch with no switch row delivers', async () => {
    const fake = setup({ plan_code: 'trial', status: 'trialing', branch_seats: 1 });
    expect(await delivers(fake)).toBe(true);
  });

  it('a switch row left on (active = true) delivers', async () => {
    expect(await delivers(setup({}, [{ branch_id: BRANCH, active: true }]))).toBe(true);
  });

  it('resolves the restaurant from the branch when only the branch is given', async () => {
    const fake = setup();
    const ent = await loadEntitlements(fake.admin, { branchId: BRANCH }, { delivery: true });
    expect(ent.restaurantId).toBe(RID);
    expect(ent.branchId).toBe(BRANCH);
    expect(edgeHasFeature(ent, 'delivery')).toBe(true);
  });
});

describe('a branch whose merchant switched delivery off does not deliver', () => {
  it('on the plan', async () => {
    expect(await delivers(setup({}, [{ branch_id: BRANCH, active: false }]))).toBe(false);
  });

  it('on the trial too: there is no trial exception any more', async () => {
    const fake = setup({ plan_code: 'trial', status: 'trialing' }, [
      { branch_id: BRANCH, active: false },
    ]);
    expect(await delivers(fake)).toBe(false);
  });

  it('only that branch: the other branches still deliver', async () => {
    const fake = setup({}, [{ branch_id: OTHER_BRANCH, active: false }]);
    expect(await delivers(fake, BRANCH)).toBe(true);
    expect(await delivers(fake, OTHER_BRANCH)).toBe(false);
  });

  it('asks in ONE query, for this branch and the delivery code', async () => {
    const fake = setup({}, [{ branch_id: BRANCH, active: false }]);
    await delivers(fake);
    expect(fake.reads('branch_addons')).toEqual([
      { table: 'branch_addons', filters: { branch_id: BRANCH, code: 'delivery' } },
    ]);
  });
});

describe('nothing delivers where the restaurant may not sell it', () => {
  it('lapsed (deadline passed): no new deliveries, and no switch read is spent', async () => {
    const fake = setup({ status: 'past_due', entitled_through: PAST });
    const ent = await loadEntitlements(
      fake.admin,
      { restaurantId: RID, branchId: BRANCH },
      { delivery: true },
    );
    expect(ent.entitled).toBe(false);
    expect(ent.features.delivery).toBe(false);
    expect(edgeHasFeature(ent, 'delivery')).toBe(false);
    expect(fake.reads('branch_addons')).toEqual([]);
  });

  it('features.delivery false (platform override): no branch delivers', async () => {
    const fake = setup({ features: { card_payment: true, delivery: false } });
    expect(await delivers(fake)).toBe(false);
    // Missing altogether reads the same.
    expect(await delivers(setup({ features: { card_payment: true } }))).toBe(false);
    expect(fake.reads('branch_addons')).toEqual([]);
  });

  it('a switch it cannot read is a "no" (fail closed), and is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await delivers(setup({}, [], ['branch_addons']))).toBe(false);
    expect(error).toHaveBeenCalledWith(
      'branch_addons_unreadable',
      expect.objectContaining({ branch_id: BRANCH }),
    );
  });

  it('no entitlements row, or no such branch, is DENIED', async () => {
    const empty = fakeAdmin({ branches: [], billing_entitlements: [], branch_addons: [] });
    expect(await loadEntitlements(empty.admin, { branchId: BRANCH })).toBe(DENIED);
    expect(await loadEntitlements(empty.admin, { restaurantId: RID })).toBe(DENIED);
    expect(await loadEntitlements(empty.admin, {})).toBe(DENIED);
  });
});

describe('the delivery answer is spent only where it is asked for', () => {
  it('a branch load without the option reads no switch and has no delivery key', async () => {
    const fake = setup();
    const ent = await loadEntitlements(fake.admin, { restaurantId: RID, branchId: BRANCH });
    expect(fake.reads('branch_addons')).toEqual([]);
    expect('delivery' in ent.features).toBe(false);
    // Fail closed: a delivery check that forgot to ask is a "no", never the restaurant's "yes".
    expect(edgeHasFeature(ent, 'delivery')).toBe(false);
    // The restaurant-wide answers are untouched.
    expect(edgeHasFeature(ent, 'card_payment')).toBe(true);
    expect(ent.entitled).toBe(true);
  });

  it('a restaurant-wide load keeps the restaurant-wide grant and reads no switch', async () => {
    const fake = setup({}, [{ branch_id: BRANCH, active: false }]);
    const ent = await loadEntitlements(fake.admin, { restaurantId: RID }, { delivery: true });
    expect(ent.branchId).toBeNull();
    expect(ent.features.delivery).toBe(true);
    expect(fake.reads('branch_addons')).toEqual([]);
  });
});

describe('the plan grants exactly card_payment and delivery (§2)', () => {
  it('no withdrawn feature is on for the plan or the trial (import-menu: 403)', async () => {
    for (const plan of [{}, { plan_code: 'trial', status: 'trialing' }]) {
      const ent = await loadEntitlements(
        setup(plan).admin,
        { restaurantId: RID, branchId: BRANCH },
        { delivery: true },
      );
      expect(edgeHasFeature(ent, 'card_payment')).toBe(true);
      expect(edgeHasFeature(ent, 'delivery')).toBe(true);
      expect(edgeHasFeature(ent, 'ai_menu_import')).toBe(false);
      expect(edgeHasFeature(ent, 'ai_suite')).toBe(false);
      expect(edgeHasFeature(ent, 'ai_voice')).toBe(false);
      expect(edgeHasFeature(ent, 'digital_signage')).toBe(false);
    }
  });

  it('a lapsed restaurant still owns card_payment for orders taken while it was live', async () => {
    const ent = await loadEntitlements(setup({ entitled_through: PAST }).admin, {
      branchId: BRANCH,
    });
    expect(edgeHasFeature(ent, 'card_payment')).toBe(false);
    expect(edgeOwnsFeature(ent, 'card_payment')).toBe(true);
  });
});
