import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LONG_SHIFT_MS,
  MAX_RANGE_DAYS,
  SHIFT_SELECT,
  STAFF_ROSTER_SELECT,
  TIMELOG_PRESETS,
  filterableMembers,
  groupShiftsByDay,
  isLongOpenShift,
  parseStaffFilter,
  parseTimelogRange,
  presetQuery,
  rangeBoundsUtc,
  shiftDurationMs,
  spanDays,
  splitDuration,
  staffName,
  totalsByPerson,
  type RosterMember,
  type ShiftRow,
} from './timelog-model';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-10-16T20:00:00Z'); // 15:00 in Chicago (CDT, UTC-5)
const H = 3600_000;

function shift(partial: Partial<ShiftRow> & { id: string }): ShiftRow {
  return {
    staff_member_id: 'alice',
    clocked_in_at: '2026-10-16T14:00:00Z',
    clocked_out_at: '2026-10-16T18:00:00Z',
    notes: null,
    ...partial,
  };
}

function member(partial: Partial<RosterMember> & { id: string }): RosterMember {
  return { role: 'cashier', invited_email: null, user_id: null, branch_id: 'b1', status: 'active', ...partial };
}

describe('what the page reads', () => {
  it('names its roster columns one by one, never the PIN hash or permissions', () => {
    expect(STAFF_ROSTER_SELECT.split(',').map((c) => c.trim())).toEqual(['id', 'role', 'invited_email', 'user_id', 'branch_id', 'status']);
    expect(STAFF_ROSTER_SELECT).not.toMatch(/pin_hash|permissions|\*/);
    expect(SHIFT_SELECT).not.toMatch(/\*/);
  });
});

describe('the date range', () => {
  const today = '2026-10-16';

  it('defaults to the last 7 days, today included', () => {
    expect(parseTimelogRange({}, today)).toEqual({ from: '2026-10-10', to: today, preset: 'week', clamped: false });
    expect(parseTimelogRange({ range: 'nonsense' }, today).preset).toBe('week');
  });

  it('reads each preset', () => {
    expect(parseTimelogRange({ range: 'today' }, today)).toMatchObject({ from: today, to: today, preset: 'today' });
    expect(parseTimelogRange({ range: 'month' }, today)).toMatchObject({ from: '2026-09-17', to: today, preset: 'month' });
    for (const p of TIMELOG_PRESETS) {
      const r = parseTimelogRange({ range: p }, today);
      expect(spanDays(r.from, r.to)).toBe({ today: 1, week: 7, month: 30 }[p]);
    }
  });

  it('takes picked dates over a preset, swaps them when backwards, and recognises a preset span', () => {
    expect(parseTimelogRange({ range: 'today', from: '2026-10-01', to: '2026-10-05' }, today)).toEqual({
      from: '2026-10-01', to: '2026-10-05', preset: null, clamped: false,
    });
    expect(parseTimelogRange({ from: '2026-10-05', to: '2026-10-01' }, today)).toMatchObject({ from: '2026-10-01', to: '2026-10-05' });
    expect(parseTimelogRange({ from: '2026-10-10', to: today }, today).preset).toBe('week');
  });

  it('refuses dates that are not real days', () => {
    expect(parseTimelogRange({ from: '2026-02-31', to: '2026-03-02' }, today).preset).toBe('week');
    expect(parseTimelogRange({ from: '16/10/2026', to: today }, today).preset).toBe('week');
  });

  it('cuts a range longer than the cap at the start and says so', () => {
    const r = parseTimelogRange({ from: '2025-01-01', to: today }, today);
    expect(r.to).toBe(today);
    expect(spanDays(r.from, r.to)).toBe(MAX_RANGE_DAYS);
    expect(r.clamped).toBe(true);
  });

  it('covers the branch days from local midnight to local midnight', () => {
    // Chicago is UTC-5 in October.
    expect(rangeBoundsUtc({ from: '2026-10-10', to: '2026-10-16' }, TZ)).toEqual({
      startIso: '2026-10-10T05:00:00.000Z',
      endIso: '2026-10-17T05:00:00.000Z',
    });
    // Across the November DST change the end moves to UTC-6.
    expect(rangeBoundsUtc({ from: '2026-10-31', to: '2026-11-01' }, TZ).endIso).toBe('2026-11-02T06:00:00.000Z');
  });

  it('keeps the staff filter on a preset link, and accepts only an id for it', () => {
    expect(presetQuery('week', null)).toBe('?range=week');
    expect(presetQuery('today', '3f0c8a52-1d2e-4c3b-9a8f-0123456789ab')).toBe('?range=today&staff=3f0c8a52-1d2e-4c3b-9a8f-0123456789ab');
    expect(parseStaffFilter('3F0C8A52-1D2E-4C3B-9A8F-0123456789AB')).toBe('3f0c8a52-1d2e-4c3b-9a8f-0123456789ab');
    expect(parseStaffFilter("1' or '1'='1")).toBeNull();
    expect(parseStaffFilter(undefined)).toBeNull();
  });
});

describe('shift durations', () => {
  it('runs from clock-in to clock-out, or to now while open', () => {
    expect(shiftDurationMs(shift({ id: 's1' }), NOW)).toBe(4 * H);
    expect(shiftDurationMs(shift({ id: 's2', clocked_out_at: null }), NOW)).toBe(6 * H);
  });

  it('never counts a negative or unreadable shift against the total', () => {
    expect(shiftDurationMs(shift({ id: 's1', clocked_out_at: '2026-10-16T13:00:00Z' }), NOW)).toBe(0);
    expect(shiftDurationMs(shift({ id: 's2', clocked_in_at: 'garbage' }), NOW)).toBe(0);
  });

  it('formats whole hours and zero-padded minutes, dropping seconds', () => {
    expect(splitDuration(7 * H + 5 * 60_000 + 59_000)).toEqual({ hours: 7, minutes: '05' });
    expect(splitDuration(0)).toEqual({ hours: 0, minutes: '00' });
    expect(splitDuration(-5)).toEqual({ hours: 0, minutes: '00' });
    expect(splitDuration(26 * H + 30 * 60_000)).toEqual({ hours: 26, minutes: '30' });
  });

  it('flags an open shift past twelve hours as a probable forgotten clock-out', () => {
    expect(isLongOpenShift(shift({ id: 's1', clocked_in_at: new Date(NOW - LONG_SHIFT_MS).toISOString(), clocked_out_at: null }), NOW)).toBe(true);
    expect(isLongOpenShift(shift({ id: 's2', clocked_in_at: new Date(NOW - LONG_SHIFT_MS + 60_000).toISOString(), clocked_out_at: null }), NOW)).toBe(false);
    // A closed shift is never flagged, however long.
    expect(isLongOpenShift(shift({ id: 's3', clocked_in_at: '2026-10-14T00:00:00Z' }), NOW)).toBe(false);
  });
});

describe('days and totals', () => {
  const rows: ShiftRow[] = [
    // 16 Oct, 09:00–13:00 Chicago.
    shift({ id: 'a1', staff_member_id: 'alice' }),
    // 15 Oct 22:00 – 16 Oct 02:00 Chicago: stays with the evening it started.
    shift({ id: 'b1', staff_member_id: 'bob', clocked_in_at: '2026-10-16T03:00:00Z', clocked_out_at: '2026-10-16T07:00:00Z' }),
    // 16 Oct 07:00 Chicago, still on.
    shift({ id: 'b2', staff_member_id: 'bob', clocked_in_at: '2026-10-16T12:00:00Z', clocked_out_at: null }),
    // 15 Oct 08:00–16:30 Chicago.
    shift({ id: 'a0', staff_member_id: 'alice', clocked_in_at: '2026-10-15T13:00:00Z', clocked_out_at: '2026-10-15T21:30:00Z' }),
  ];

  it('groups by the branch day of the clock-in, newest day first, earliest shift first', () => {
    const days = groupShiftsByDay(rows, TZ, NOW);
    expect(days.map((d) => [d.day, d.shifts.map((s) => s.id)])).toEqual([
      ['2026-10-16', ['b2', 'a1']],
      ['2026-10-15', ['a0', 'b1']],
    ]);
    expect(days[0]!.totalMs).toBe(8 * H + 4 * H);
    expect(days[1]!.totalMs).toBe(8.5 * H + 4 * H);
  });

  it('marks an overnight shift with the day it ended, and an open one as open', () => {
    const [today, yesterday] = groupShiftsByDay(rows, TZ, NOW);
    const overnight = yesterday!.shifts.find((s) => s.id === 'b1')!;
    expect(overnight.outDay).toBe('2026-10-16');
    const open = today!.shifts.find((s) => s.id === 'b2')!;
    expect(open.open).toBe(true);
    expect(open.outDay).toBeNull();
  });

  it('adds each person up, the most hours first', () => {
    expect(totalsByPerson(rows, NOW)).toEqual([
      { staffMemberId: 'alice', shifts: 2, totalMs: 12.5 * H },
      { staffMemberId: 'bob', shifts: 2, totalMs: 12 * H },
    ]);
    expect(totalsByPerson([], NOW)).toEqual([]);
  });
});

describe('names and the staff filter', () => {
  it('calls a person by their invite address, or the viewer by their own sign-in', () => {
    const viewer = { id: 'u-owner', email: 'owner@example.com' };
    expect(staffName(member({ id: 'm1', invited_email: 'cook@example.com' }), viewer)).toBe('cook@example.com');
    expect(staffName(member({ id: 'm2', user_id: 'u-owner' }), viewer)).toBe('owner@example.com');
    expect(staffName(member({ id: 'm3', user_id: 'u-other' }), viewer)).toBeNull();
    expect(staffName(undefined, viewer)).toBeNull();
  });

  it('offers the active people of this branch, and anyone with a shift on screen', () => {
    const roster = [
      member({ id: 'here', branch_id: 'b1' }),
      member({ id: 'everywhere', branch_id: null, role: 'admin' }),
      member({ id: 'owner', branch_id: 'b2', role: 'owner' }),
      member({ id: 'elsewhere', branch_id: 'b2' }),
      member({ id: 'invited', branch_id: 'b1', status: 'pending' }),
      member({ id: 'left', branch_id: 'b1', status: 'removed' }),
      member({ id: 'moved', branch_id: 'b2', status: 'suspended' }),
    ];
    expect(filterableMembers(roster, 'b1', ['moved']).map((m) => m.id)).toEqual(['here', 'everywhere', 'owner', 'moved']);
  });
});

describe('time log sentences', () => {
  it('has every sentence the page uses in all four languages', () => {
    const keys = [
      'metaTitle', 'title', 'subtitle', 'accessDenied.title', 'accessDenied.reason', 'filters.presets', 'filters.from',
      'filters.to', 'filters.staff', 'filters.everyone', 'filters.apply', 'filters.clamped', 'loadError.title',
      'loadError.body', 'summary.label', 'summary.hours', 'summary.shifts', 'summary.people', 'truncated', 'onShift.title',
      'onShift.since', 'onShift.sinceDay', 'onShift.long', 'empty.title', 'empty.description', 'dayTotal',
      'columns.person', 'columns.clockIn', 'columns.clockOut', 'columns.duration', 'note', 'stillOn', 'outOnDay',
      'people.title', 'people.shifts', 'people.hours', 'duration',
      ...TIMELOG_PRESETS.map((p) => `filters.preset.${p}`),
    ];
    const read = (tree: unknown, key: string) =>
      key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../messages/en/timelog.json'), 'utf8'));
    for (const locale of ['en', 'th', 'es', 'vi']) {
      const file = path.resolve(__dirname, `../../../../../../messages/${locale}/timelog.json`);
      const tree = JSON.parse(readFileSync(file, 'utf8'));
      for (const key of keys) {
        const value = read(tree, key);
        expect(typeof value, `${locale} timelog.${key}`).toBe('string');
        // Every placeholder English uses is there in the translation too.
        for (const ph of String(read(en, key)).match(/\{(\w+)[,}]/g) ?? []) {
          expect(value as string, `${locale} timelog.${key} ${ph}`).toContain(ph.slice(0, -1));
        }
      }
    }
  });

  it('is registered with the app, or next-intl would print raw keys', () => {
    const namespaces = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../../../scripts/i18n/namespaces.json'), 'utf8'));
    expect(namespaces.admin).toContain('timelog');
    const loader = readFileSync(path.resolve(__dirname, '../../../../../i18n/messages.ts'), 'utf8');
    for (const locale of ['en', 'es', 'vi', 'th']) expect(loader).toContain(`timelog: ${locale}_timelog,`);
  });
});
