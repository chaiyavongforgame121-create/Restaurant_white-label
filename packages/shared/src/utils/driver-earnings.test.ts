import { describe, expect, it } from 'vitest';
import {
  branchSubtitle,
  restaurantLabel,
  summariseDriverEarnings,
  UNKNOWN_RESTAURANT_LABEL,
  type DriverLedgerEntry,
} from './driver-earnings';

const COASTAL = { name: 'Hamburger', restaurant: { name: 'Coastal Grill' } };
const SOMTAM = { name: 'Silom Flagship', restaurant: { name: 'Somtam Zab' } };

function entry(over: Partial<DriverLedgerEntry> = {}): DriverLedgerEntry {
  return {
    branch_id: 'branch-a',
    base_pay: 3,
    distance_pay: 1,
    tip_net: 1,
    total: 5,
    status: 'accrued',
    withdrawal_id: null,
    branch: COASTAL,
    ...over,
  };
}

describe('restaurantLabel', () => {
  it('leads with the brand and keeps the shop underneath', () => {
    expect(restaurantLabel(COASTAL)).toEqual({
      restaurantName: 'Coastal Grill',
      branchName: 'Hamburger',
    });
  });

  it('falls back to the branch name when the restaurant embed is missing', () => {
    expect(restaurantLabel({ name: 'Hamburger', restaurant: null })).toEqual({
      restaurantName: 'Hamburger',
      branchName: 'Hamburger',
    });
  });

  // branches_public_read hides deactivated branches, so the embed can legitimately be null.
  it('names a branch it can no longer read', () => {
    expect(restaurantLabel(null).restaurantName).toBe(UNKNOWN_RESTAURANT_LABEL);
  });
});

describe('branchSubtitle', () => {
  it('prints the shop when it differs from the brand', () => {
    expect(branchSubtitle({ restaurantName: 'Coastal Grill', branchName: 'Hamburger' })).toBe(
      'Hamburger',
    );
  });

  it('says nothing when it would repeat the brand', () => {
    expect(branchSubtitle({ restaurantName: 'Hamburger', branchName: 'Hamburger' })).toBeNull();
    expect(branchSubtitle({ restaurantName: 'Coastal Grill', branchName: '' })).toBeNull();
  });
});

describe('summariseDriverEarnings', () => {
  it('returns nothing to show for an empty ledger', () => {
    const s = summariseDriverEarnings([]);
    expect(s.restaurants).toEqual([]);
    expect(s.restaurantCount).toBe(0);
    expect(s.totals).toEqual({
      available: 0,
      requested: 0,
      paid: 0,
      lifetime: 0,
      deliveries: 0,
      availableDeliveries: 0,
      base: 0,
      distance: 0,
      tip: 0,
    });
  });

  // The RPC only moves rows that are accrued AND untagged, so money already inside a pending
  // request must not be offered a second time.
  it('splits accrued money into available and already-requested', () => {
    const s = summariseDriverEarnings([
      entry({ total: 10 }),
      entry({ total: 7, withdrawal_id: 'w-1' }),
      entry({ total: 4, status: 'paid', withdrawal_id: 'w-0' }),
    ]);
    const coastal = s.restaurants[0];
    expect(coastal?.available).toBe(10);
    expect(coastal?.requested).toBe(7);
    expect(coastal?.paid).toBe(4);
    expect(coastal?.lifetime).toBe(21);
    expect(coastal?.deliveries).toBe(3);
    // The sheet promises a delivery count; it has to be the one the RPC would tag.
    expect(coastal?.availableDeliveries).toBe(1);
  });

  // A restaurant that has settled everything still owes the rider a record of what it paid.
  it('keeps a fully-paid restaurant in the list', () => {
    const s = summariseDriverEarnings([entry({ total: 9, status: 'paid', withdrawal_id: 'w-0' })]);
    expect(s.restaurants).toHaveLength(1);
    expect(s.restaurants[0]?.available).toBe(0);
    expect(s.restaurants[0]?.paid).toBe(9);
  });

  it('never mixes two restaurants into one pile', () => {
    const s = summariseDriverEarnings([
      entry({ branch_id: 'a', total: 5 }),
      entry({ branch_id: 'b', total: 12, branch: SOMTAM }),
      entry({ branch_id: 'b', total: 3, branch: SOMTAM, status: 'paid', withdrawal_id: 'w-2' }),
    ]);
    expect(s.restaurantCount).toBe(2);
    expect(s.restaurants.map((r) => r.restaurantName)).toEqual(['Somtam Zab', 'Coastal Grill']);
    expect(s.restaurants[0]?.available).toBe(12);
    expect(s.restaurants[1]?.available).toBe(5);
    expect(s.totals.available).toBe(17);
    expect(s.totals.lifetime).toBe(20);
  });

  it('orders by what can be requested, then lifetime, then name', () => {
    const s = summariseDriverEarnings([
      entry({ branch_id: 'a', total: 4, status: 'paid', withdrawal_id: 'w-1' }),
      entry({ branch_id: 'b', total: 9, status: 'paid', withdrawal_id: 'w-2', branch: SOMTAM }),
      entry({ branch_id: 'c', total: 1, branch: { name: 'Zebra Cafe', restaurant: null } }),
    ]);
    expect(s.restaurants.map((r) => r.branchId)).toEqual(['c', 'b', 'a']);
  });

  it('reads numerics that arrive as strings', () => {
    const s = summariseDriverEarnings([
      entry({ base_pay: '3.33', distance_pay: '1.11', tip_net: '0.56', total: '5.00' }),
    ]);
    expect(s.totals.base).toBe(3.33);
    expect(s.totals.distance).toBe(1.11);
    expect(s.totals.tip).toBe(0.56);
    expect(s.totals.available).toBe(5);
  });

  // 0.1 + 0.2 must reach the rider as 0.30, not 0.30000000000000004.
  it('rounds each pile to cents once, at the end', () => {
    const s = summariseDriverEarnings([entry({ total: 0.1 }), entry({ total: 0.2 })]);
    expect(s.restaurants[0]?.available).toBe(0.3);
    expect(s.totals.available).toBe(0.3);
  });

  it('keeps a name it managed to read even if a later row lost the embed', () => {
    const s = summariseDriverEarnings([
      entry({ total: 5, branch: null }),
      entry({ total: 5, branch: COASTAL }),
    ]);
    expect(s.restaurants[0]?.restaurantName).toBe('Coastal Grill');
  });
});
