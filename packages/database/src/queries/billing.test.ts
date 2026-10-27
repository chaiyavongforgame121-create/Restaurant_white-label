// The billing queries against the single plan (docs/PACKAGING-2026-10-24.md §4.5): what each one
// sends to its RPC and how it reads the answer. A hand-rolled client stands in for supabase-js; the
// SQL itself is pinned by supabase/tests/single_plan.sql.
import { describe, expect, it } from 'vitest';
import type { FavornomsClient } from '../client-type';
import {
  getBillingOverview,
  getBranchDeliveryEnabled,
  requestPackageChange,
  setBranchDelivery,
  setRestaurantPackage,
  validateBillingDiscount,
} from './billing';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';

type Answer = { data: unknown; error: { message: string } | null };

/** Records every rpc call and answers each function from `answers`. */
function rpcClient(answers: Record<string, Answer>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return answers[fn] ?? { data: null, error: { message: 'unexpected rpc ' + fn } };
    },
  };
  return { client: client as unknown as FavornomsClient, calls };
}

/** A client whose branch_addons read answers `answer`, recording the filters it was given. */
function tableClient(answer: Answer) {
  const filters: Array<[string, unknown]> = [];
  let table = '';
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    },
    maybeSingle: async () => answer,
  };
  const client = {
    from: (name: string) => {
      table = name;
      return query;
    },
  };
  return { client: client as unknown as FavornomsClient, filters, table: () => table };
}

describe('getBillingOverview', () => {
  it('reads each branch as { id, name, deliveryOn } and the paid state without delivery', async () => {
    const { client } = rpcClient({
      get_billing_overview: {
        data: {
          entitlements: { plan_code: 'base', status: 'active', entitled: true },
          branches: [
            { id: BRANCH_A, name: 'Main', delivery_active: true, delivery_unlocked: true },
            { id: BRANCH_B, name: 'Riverside', delivery_active: false, delivery_unlocked: true },
          ],
          paid: { base_paid: true, seats_paid: 2, delivery_unlocked_branch_ids: [] },
          pending_request: null,
          charges: [],
          billing: { rail: 'manual' },
        },
        error: null,
      },
    });
    const overview = await getBillingOverview(client, 'restaurant-1');
    expect(overview.branches).toEqual([
      { id: BRANCH_A, name: 'Main', deliveryOn: true },
      { id: BRANCH_B, name: 'Riverside', deliveryOn: false },
    ]);
    expect(overview.paid).toEqual({ basePaid: true, seatsPaid: 2 });
  });

  it('fails closed: no branches and nothing paid', async () => {
    const { client } = rpcClient({ get_billing_overview: { data: null, error: { message: 'forbidden' } } });
    const overview = await getBillingOverview(client, 'restaurant-1');
    expect(overview.branches).toEqual([]);
    expect(overview.paid).toEqual({ basePaid: false, seatsPaid: 0 });
  });
});

describe('the pricing writers send no delivery branches', () => {
  it('requestPackageChange sends p_delivery_branch_ids: []', async () => {
    const { client, calls } = rpcClient({
      request_package_change: { data: { ok: true, id: 'req-1', plan_code: 'base', branch_seats: 3 }, error: null },
    });
    await requestPackageChange(client, {
      restaurantId: 'restaurant-1',
      selection: { planCode: 'base', branchSeats: 3 },
      discountCode: ' save10 ',
    });
    expect(calls).toEqual([
      {
        fn: 'request_package_change',
        args: {
          p_restaurant_id: 'restaurant-1',
          p_plan_code: 'base',
          p_branch_seats: 3,
          p_delivery_branch_ids: [],
          p_discount_code: 'save10',
          p_note: null,
        },
      },
    ]);
  });

  it('requestPackageChange sends the confirmed totals, and throws the server\'s own on quote_changed', async () => {
    const { client, calls } = rpcClient({
      request_package_change: {
        data: {
          ok: false,
          reason: 'quote_changed',
          error: 'quote_changed',
          one_time_total: '179.10',
          monthly_total: 49,
          expected_one_time: 99.5,
          expected_monthly: 49,
        },
        error: null,
      },
    });
    await expect(
      requestPackageChange(client, {
        restaurantId: 'restaurant-1',
        selection: { planCode: 'base', branchSeats: 1 },
        discountCode: 'TEST50',
        expectedOneTime: 99.5,
        expectedMonthly: 49,
      }),
    ).rejects.toThrow(/^quote_changed:179\.1:49$/);
    expect(calls[0]?.args).toMatchObject({ p_expected_one_time: 99.5, p_expected_monthly: 49 });
  });

  it('requestPackageChange still answers a refused code as discount_invalid:<reason>', async () => {
    const { client } = rpcClient({
      request_package_change: {
        data: { ok: false, reason: 'code_expired', error: 'discount_invalid:code_expired' },
        error: null,
      },
    });
    await expect(
      requestPackageChange(client, {
        restaurantId: 'restaurant-1',
        selection: { planCode: 'base', branchSeats: 1 },
        discountCode: 'OLD',
      }),
    ).rejects.toThrow('discount_invalid:code_expired');
  });

  it('setRestaurantPackage sends p_delivery_branch_ids: []', async () => {
    const { client, calls } = rpcClient({ billing_set_package: { data: {}, error: null } });
    await setRestaurantPackage(client, 'restaurant-1', { planCode: 'base', branchSeats: 2 });
    expect(calls[0]?.args).toMatchObject({ p_plan_code: 'base', p_branch_seats: 2, p_delivery_branch_ids: [] });
  });

  it('validateBillingDiscount sends p_delivery_branch_ids: [] and never fewer than one seat', async () => {
    const { client, calls } = rpcClient({
      validate_billing_discount: {
        data: { valid: true, one_time_total: 199, amount_off: 19.9, net_total: 179.1 },
        error: null,
      },
    });
    const quote = await validateBillingDiscount(client, {
      restaurantId: 'restaurant-1',
      code: 'SAVE10',
      selection: { planCode: 'base', branchSeats: 0 },
    });
    expect(calls[0]?.args).toMatchObject({ p_branch_seats: 1, p_delivery_branch_ids: [] });
    expect(quote).toMatchObject({ valid: true, oneTimeTotal: 199, amountOff: 19.9, netTotal: 179.1 });
  });
});

describe('getBranchDeliveryEnabled', () => {
  it('reads the branch\'s delivery row', async () => {
    const t = tableClient({ data: null, error: null });
    await getBranchDeliveryEnabled(t.client, BRANCH_A);
    expect(t.table()).toBe('branch_addons');
    expect(t.filters).toEqual([
      ['branch_id', BRANCH_A],
      ['code', 'delivery'],
    ]);
  });

  it('no row is on: a branch delivers unless its merchant switched it off', async () => {
    expect(await getBranchDeliveryEnabled(tableClient({ data: null, error: null }).client, BRANCH_A)).toBe(true);
  });

  it('a row with active = false is off; active = true (an old row) is on', async () => {
    expect(await getBranchDeliveryEnabled(tableClient({ data: { active: false }, error: null }).client, BRANCH_A)).toBe(false);
    expect(await getBranchDeliveryEnabled(tableClient({ data: { active: true }, error: null }).client, BRANCH_A)).toBe(true);
  });

  it('throws on a failed read instead of guessing the switch', async () => {
    await expect(
      getBranchDeliveryEnabled(tableClient({ data: null, error: { message: 'timeout' } }).client, BRANCH_A),
    ).rejects.toThrow('branch_delivery_unreadable:timeout');
  });
});

describe('setBranchDelivery', () => {
  it('calls set_branch_delivery and returns the switch as it now stands', async () => {
    const off = rpcClient({ set_branch_delivery: { data: false, error: null } });
    expect(await setBranchDelivery(off.client, BRANCH_A, false)).toBe(false);
    expect(off.calls).toEqual([{ fn: 'set_branch_delivery', args: { p_branch_id: BRANCH_A, p_enabled: false } }]);

    const on = rpcClient({ set_branch_delivery: { data: true, error: null } });
    expect(await setBranchDelivery(on.client, BRANCH_A, true)).toBe(true);
  });

  it('throws the server\'s refusal', async () => {
    const { client } = rpcClient({ set_branch_delivery: { data: null, error: { message: 'forbidden' } } });
    await expect(setBranchDelivery(client, BRANCH_A, false)).rejects.toThrow('forbidden');
  });
});
