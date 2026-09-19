import { describe, expect, it } from 'vitest';
import {
  ACCESS_NOTICE_MAX_AGE_MS,
  RELOAD_MAX_DEFER_MS,
  RELOAD_MODAL_POLL_MS,
  RELOAD_QUIET_MS,
  accessNoticeApplies,
  encodeAccessNotice,
  nextReloadDelay,
  reloadWait,
  rowChangesAccess,
  rowReachesBranch,
  rowsInScope,
  staffAccessFingerprint,
  type StaffAccessRow,
} from './staff-access';

const HAM = '44444444-4444-4444-4444-444444444444';
const FTT = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';

const cashier: StaffAccessRow = { id: 'a', role: 'cashier', status: 'active', branch_id: HAM };
const everywhere: StaffAccessRow = { id: 'b', role: 'staff', status: 'active', branch_id: null };

describe('staffAccessFingerprint', () => {
  it('does not depend on the order rows come back in', () => {
    expect(staffAccessFingerprint([cashier, everywhere])).toBe(
      staffAccessFingerprint([everywhere, cashier]),
    );
  });

  it('changes with the role, the status, the branch and the set of rows', () => {
    const base = staffAccessFingerprint([cashier]);
    expect(staffAccessFingerprint([{ ...cashier, role: 'kitchen' }])).not.toBe(base);
    expect(staffAccessFingerprint([{ ...cashier, status: 'suspended' }])).not.toBe(base);
    expect(staffAccessFingerprint([{ ...cashier, branch_id: FTT }])).not.toBe(base);
    expect(staffAccessFingerprint([{ ...cashier, branch_id: null }])).not.toBe(base);
    expect(staffAccessFingerprint([cashier, everywhere])).not.toBe(base);
    expect(staffAccessFingerprint([])).not.toBe(base);
  });

  it('agrees with itself for the same state, however it was read', () => {
    // The server's read and the browser's read are separate objects with the same values.
    expect(staffAccessFingerprint([{ ...cashier }])).toBe(staffAccessFingerprint([cashier]));
    expect(staffAccessFingerprint([])).toBe(staffAccessFingerprint([]));
  });
});

describe('rowChangesAccess', () => {
  const known = [cashier, everywhere];

  it('reloads for a new role, status or branch on a row already known', () => {
    expect(rowChangesAccess(known, { ...cashier, role: 'kitchen' })).toBe(true);
    expect(rowChangesAccess(known, { ...cashier, status: 'suspended' })).toBe(true);
    expect(rowChangesAccess(known, { ...cashier, status: 'removed' })).toBe(true);
    expect(rowChangesAccess(known, { ...cashier, branch_id: FTT })).toBe(true);
    expect(rowChangesAccess(known, { ...everywhere, branch_id: HAM })).toBe(true);
  });

  it('reloads for a row it has not seen, such as an invitation accepted in another tab', () => {
    expect(
      rowChangesAccess(known, { id: 'c', role: 'kitchen', status: 'active', branch_id: FTT }),
    ).toBe(true);
  });

  it('stays put when nothing that decides access changed', () => {
    // An UPDATE that only touched updated_at, a PIN or an address carries the same three fields.
    expect(rowChangesAccess(known, { ...cashier })).toBe(false);
    expect(rowChangesAccess(known, { ...everywhere })).toBe(false);
    expect(
      rowChangesAccess(known, { ...everywhere, branch_id: undefined as unknown as null }),
    ).toBe(false);
  });

  it('ignores a payload without an id', () => {
    expect(rowChangesAccess(known, {})).toBe(false);
  });
});

describe('nextReloadDelay', () => {
  it('reloads at once when there was no recent forced reload', () => {
    expect(nextReloadDelay(null, 1_000_000)).toBe(0);
    expect(nextReloadDelay(1_000_000 - 60_000, 1_000_000)).toBe(0);
  });

  it('spaces a second forced reload out instead of looping', () => {
    expect(nextReloadDelay(1_000_000 - 4_000, 1_000_000)).toBe(6_000);
    expect(nextReloadDelay(1_000_000, 1_000_000)).toBe(10_000);
  });

  it('treats an unreadable or future stamp as no stamp', () => {
    expect(nextReloadDelay(Number.NaN, 1_000_000)).toBe(0);
    expect(nextReloadDelay(1_000_000 + 60_000, 1_000_000)).toBe(0);
  });
});

describe('branch scope (counter and kitchen)', () => {
  // Cashier at Hamburger and kitchen at Food Thai Thai, sitting on the Food Thai Thai board.
  const hamCashier: StaffAccessRow = { id: 'h', role: 'cashier', status: 'active', branch_id: HAM };
  const fttKitchen: StaffAccessRow = { id: 'f', role: 'kitchen', status: 'active', branch_id: FTT };
  const ownerRow: StaffAccessRow = { id: 'o', role: 'owner', status: 'active', branch_id: HAM };
  const known = [hamCashier, fttKitchen];

  it('counts the rows my_capabilities reads for a branch: that branch, no branch, owner rows', () => {
    expect(rowReachesBranch(fttKitchen, FTT)).toBe(true);
    expect(rowReachesBranch(hamCashier, FTT)).toBe(false);
    expect(rowReachesBranch(everywhere, FTT)).toBe(true);
    expect(rowReachesBranch(ownerRow, FTT)).toBe(true);
    expect(
      rowsInScope([hamCashier, fttKitchen, everywhere, ownerRow], FTT).map((r) => r.id),
    ).toEqual(['f', 'b', 'o']);
    expect(rowsInScope(known, null)).toEqual(known);
  });

  it('leaves the board alone when the same person changes at the other branch', () => {
    expect(rowChangesAccess(known, { ...hamCashier, role: 'server' }, FTT)).toBe(false);
    expect(rowChangesAccess(known, { ...hamCashier, status: 'suspended' }, FTT)).toBe(false);
    expect(
      staffAccessFingerprint(rowsInScope([{ ...hamCashier, role: 'server' }, fttKitchen], FTT)),
    ).toBe(staffAccessFingerprint(rowsInScope(known, FTT)));
    // The back office is not scoped, and still follows every branch.
    expect(rowChangesAccess(known, { ...hamCashier, role: 'server' })).toBe(true);
  });

  it('reloads for a change at this branch, and for a row moving in or out of it', () => {
    expect(rowChangesAccess(known, { ...fttKitchen, role: 'cashier' }, FTT)).toBe(true);
    expect(rowChangesAccess(known, { ...hamCashier, branch_id: FTT }, FTT)).toBe(true);
    expect(rowChangesAccess(known, { ...fttKitchen, branch_id: HAM }, FTT)).toBe(true);
    expect(rowChangesAccess(known, { ...hamCashier, branch_id: null }, FTT)).toBe(true);
    expect(
      rowChangesAccess(known, { id: 'n', role: 'kitchen', status: 'active', branch_id: FTT }, FTT),
    ).toBe(true);
    expect(
      rowChangesAccess(known, { id: 'n', role: 'kitchen', status: 'active', branch_id: HAM }, FTT),
    ).toBe(false);
    // The fingerprint agrees: moving the Hamburger row here changes what this board compares.
    expect(
      staffAccessFingerprint(rowsInScope([{ ...hamCashier, branch_id: FTT }, fttKitchen], FTT)),
    ).not.toBe(staffAccessFingerprint(rowsInScope(known, FTT)));
  });
});

describe('reloadWait', () => {
  const now = 1_000_000;

  it('reloads at once on a quiet screen with nothing open', () => {
    expect(reloadWait({ modalOpen: false, lastInputAt: null, requestedAt: now, now })).toBe(0);
    expect(
      reloadWait({ modalOpen: false, lastInputAt: now - RELOAD_QUIET_MS, requestedAt: now, now }),
    ).toBe(0);
  });

  it('waits for a tap in progress to settle', () => {
    expect(reloadWait({ modalOpen: false, lastInputAt: now - 1_000, requestedAt: now, now })).toBe(
      RELOAD_QUIET_MS - 1_000,
    );
  });

  it('keeps looking while a modal (the till payment sheet) is open', () => {
    expect(reloadWait({ modalOpen: true, lastInputAt: null, requestedAt: now, now })).toBe(
      RELOAD_MODAL_POLL_MS,
    );
  });

  it('never waits past the cap, whatever the screen is doing', () => {
    const late = now + RELOAD_MAX_DEFER_MS;
    expect(reloadWait({ modalOpen: true, lastInputAt: late, requestedAt: now, now: late })).toBe(0);
    // Close to the cap, the wait is cut to what is left of it.
    expect(
      reloadWait({ modalOpen: false, lastInputAt: late - 200, requestedAt: now, now: late - 100 }),
    ).toBe(100);
  });
});

describe('the note after a forced reload', () => {
  const now = 1_000_000;

  it('is shown to the person whose access changed, right after the reload', () => {
    expect(accessNoticeApplies(encodeAccessNotice('cashier', now - 2_000), 'cashier', now)).toBe(
      true,
    );
  });

  it('is not shown to someone else who signs in on the same tab later', () => {
    expect(accessNoticeApplies(encodeAccessNotice('cashier', now - 2_000), 'kitchen', now)).toBe(
      false,
    );
    expect(
      accessNoticeApplies(
        encodeAccessNotice('cashier', now - ACCESS_NOTICE_MAX_AGE_MS - 1),
        'cashier',
        now,
      ),
    ).toBe(false);
  });

  it('ignores a missing or unreadable note, including the old bare flag', () => {
    expect(accessNoticeApplies(null, 'cashier', now)).toBe(false);
    expect(accessNoticeApplies('1', 'cashier', now)).toBe(false);
    expect(accessNoticeApplies('{not json', 'cashier', now)).toBe(false);
    expect(accessNoticeApplies(JSON.stringify({ u: 'cashier' }), 'cashier', now)).toBe(false);
    expect(accessNoticeApplies(encodeAccessNotice('cashier', now + 5_000), 'cashier', now)).toBe(
      false,
    );
  });
});
