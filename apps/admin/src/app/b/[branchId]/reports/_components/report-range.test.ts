import { describe, expect, it } from 'vitest';
import {
  addDays,
  localDay,
  parseReportRange,
  presetRange,
  rangeDays,
  reportRangeLabel,
  reportRangeQuery,
} from './report-range';

/**
 * The range is the one piece of Reports state that three places have to agree on: the URL,
 * the server page that passes p_from/p_to to six RPCs, and the picker the merchant clicks.
 * A disagreement shows up as a report for the wrong week, which nobody notices — so the
 * boundaries are pinned here rather than left to a visual check.
 */

// 23:30 on the 7th in New York; already the 8th in Bangkok. Every "today" below is the
// branch's today, never the server's.
const NOW = new Date('2026-09-08T03:30:00Z');
const NY = 'America/New_York';
const BKK = 'Asia/Bangkok';

describe('localDay', () => {
  it('reads the same instant as a different calendar date in each branch timezone', () => {
    expect(localDay(NOW, NY)).toBe('2026-09-07');
    expect(localDay(NOW, BKK)).toBe('2026-09-08');
  });
});

describe('addDays', () => {
  it('steps whole days across a spring-forward boundary', () => {
    // 2026-03-08 is when the US clocks jump; a midnight anchor could land back on the 7th.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-03-08', -1)).toBe('2026-03-07');
  });

  it('crosses month and year ends', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('parseReportRange presets', () => {
  it('day is the branch’s today at both ends', () => {
    expect(parseReportRange({ range: 'day' }, NY, NOW)).toEqual({
      preset: 'day',
      from: '2026-09-07',
      to: '2026-09-07',
    });
    expect(parseReportRange({ range: 'day' }, BKK, NOW)).toEqual({
      preset: 'day',
      from: '2026-09-08',
      to: '2026-09-08',
    });
  });

  it('week and month count today as day one', () => {
    expect(parseReportRange({ range: 'week' }, NY, NOW)).toEqual({
      preset: 'week',
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(parseReportRange({ range: 'month' }, NY, NOW)).toEqual({
      preset: 'month',
      from: '2026-08-09',
      to: '2026-09-07',
    });
  });

  it('falls back to the week for a missing or hand-mangled range', () => {
    expect(parseReportRange({}, NY, NOW).preset).toBe('week');
    expect(parseReportRange({ range: 'quarter' }, NY, NOW).preset).toBe('week');
    expect(parseReportRange({ range: '' }, NY, NOW).preset).toBe('week');
  });
});

describe('parseReportRange custom', () => {
  it('keeps a valid custom range verbatim', () => {
    expect(
      parseReportRange({ range: 'custom', from: '2026-08-01', to: '2026-08-15' }, NY, NOW),
    ).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-08-15' });
  });

  it('swaps a reversed range instead of returning an empty report', () => {
    expect(
      parseReportRange({ range: 'custom', from: '2026-08-15', to: '2026-08-01' }, NY, NOW),
    ).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-08-15' });
  });

  it('degrades to the week when either date is missing or malformed', () => {
    expect(parseReportRange({ range: 'custom', from: '2026-08-01' }, NY, NOW).preset).toBe('week');
    expect(
      parseReportRange({ range: 'custom', from: '01/08/2026', to: '2026-08-15' }, NY, NOW).preset,
    ).toBe('week');
  });
});

describe('parseReportRange ?days= back-compat', () => {
  it('maps the old pills onto the presets they match', () => {
    expect(parseReportRange({ days: '7' }, NY, NOW)).toEqual({
      preset: 'week',
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(parseReportRange({ days: '30' }, NY, NOW).preset).toBe('month');
    expect(parseReportRange({ days: '1' }, NY, NOW).preset).toBe('day');
  });

  it('shows an unmatched span as an explicit custom window rather than the wrong pill', () => {
    const r = parseReportRange({ days: '90' }, NY, NOW);
    expect(r).toEqual({ preset: 'custom', from: '2026-06-10', to: '2026-09-07' });
    expect(rangeDays(r)).toBe(90);
  });

  it('clamps junk and out-of-bounds spans', () => {
    // Unparseable and zero both fall through to the old default of a week.
    expect(rangeDays(parseReportRange({ days: 'abc' }, NY, NOW))).toBe(7);
    expect(rangeDays(parseReportRange({ days: '0' }, NY, NOW))).toBe(7);
    expect(rangeDays(parseReportRange({ days: '-5' }, NY, NOW))).toBe(1);
    // The RPCs raise range_too_wide past 366 days, so the parser never asks for more.
    expect(rangeDays(parseReportRange({ days: '5000' }, NY, NOW))).toBe(366);
  });

  it('lets an explicit range win over a stale days param', () => {
    expect(parseReportRange({ range: 'day', days: '90' }, NY, NOW).preset).toBe('day');
  });
});

describe('round trip', () => {
  it('rebuilds the same range from its own query string', () => {
    const custom = parseReportRange({ range: 'custom', from: '2026-08-01', to: '2026-08-15' }, NY, NOW);
    const sp = new URLSearchParams(reportRangeQuery(custom).slice(1));
    expect(
      parseReportRange(
        {
          range: sp.get('range') ?? undefined,
          from: sp.get('from') ?? undefined,
          to: sp.get('to') ?? undefined,
        },
        NY,
        NOW,
      ),
    ).toEqual(custom);
  });

  it('leaves preset dates out of the URL so a shared link follows the reader’s today', () => {
    expect(reportRangeQuery(parseReportRange({ range: 'week' }, NY, NOW))).toBe('?range=week');
  });
});

describe('labels and pills', () => {
  it('names each preset and carries a custom span as values, not English', () => {
    expect(reportRangeLabel({ preset: 'day', from: 'x', to: 'x' })).toEqual({ key: 'today', values: {} });
    expect(reportRangeLabel({ preset: 'week', from: 'x', to: 'x' })).toEqual({ key: 'last7Days', values: {} });
    expect(reportRangeLabel({ preset: 'month', from: 'x', to: 'x' })).toEqual({ key: 'last30Days', values: {} });
    expect(reportRangeLabel({ preset: 'custom', from: '2026-08-01', to: '2026-08-15' })).toEqual({
      key: 'span',
      values: { from: '2026-08-01', to: '2026-08-15' },
    });
    expect(reportRangeLabel({ preset: 'custom', from: '2026-08-01', to: '2026-08-01' })).toEqual({
      key: 'singleDay',
      values: { day: '2026-08-01' },
    });
  });

  it('keeps the merchant’s dates when they switch to the custom pill', () => {
    const current = parseReportRange({ range: 'month' }, NY, NOW);
    expect(presetRange('custom', '2026-09-07', current)).toEqual({
      preset: 'custom',
      from: current.from,
      to: current.to,
    });
    expect(presetRange('day', '2026-09-07', current)).toEqual({
      preset: 'day',
      from: '2026-09-07',
      to: '2026-09-07',
    });
  });
});
