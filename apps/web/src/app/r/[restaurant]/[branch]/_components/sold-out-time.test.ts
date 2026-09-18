import { describe, expect, it } from 'vitest';
import { earliestSoldOutUntil, formatSoldOutUntil } from './sold-out-time';

// 2026-09-18 10:00 in Chicago (CDT, UTC-5).
const NOW = new Date('2026-09-18T15:00:00Z');

describe('formatSoldOutUntil', () => {
  it('gives the time alone later today, in the branch zone', () => {
    // 22:30Z is 5:30 PM in Chicago, whatever zone the test machine runs in.
    expect(formatSoldOutUntil('2026-09-18T22:30:00Z', 'America/Chicago', 'en', NOW)).toBe('5:30 PM');
    expect(formatSoldOutUntil('2026-09-18T22:30:00Z', 'America/Chicago', 'th', NOW)).toBe('17:30 น.');
    expect(formatSoldOutUntil('2026-09-18T22:30:00Z', 'America/Chicago', 'vi', NOW)).toBe('17:30');
    expect(formatSoldOutUntil('2026-09-18T22:30:00Z', 'America/Chicago', 'es', NOW)).toBe('5:30 p. m.');
  });

  it('counts the day in the branch zone, not UTC', () => {
    // 03:00Z on the 19th is still 10:00 PM on the 18th in Chicago: today.
    expect(formatSoldOutUntil('2026-09-19T03:00:00Z', 'America/Chicago', 'en', NOW)).toBe('10:00 PM');
  });

  it('adds the weekday within the week and the date beyond it', () => {
    const tomorrow = formatSoldOutUntil('2026-09-19T14:00:00Z', 'America/Chicago', 'en', NOW);
    expect(tomorrow).toMatch(/^Sat 9:00 AM$/);
    const later = formatSoldOutUntil('2026-09-30T14:00:00Z', 'America/Chicago', 'en', NOW);
    expect(later).toMatch(/^Sep 30 9:00 AM$/);
  });

  it('gives up on a bad timestamp or zone instead of guessing', () => {
    expect(formatSoldOutUntil('not a date', 'America/Chicago', 'en', NOW)).toBeNull();
    expect(formatSoldOutUntil('2026-09-18T22:30:00Z', 'Not/AZone', 'en', NOW)).toBeNull();
  });
});

describe('earliestSoldOutUntil', () => {
  it('finds the first 86 to lift and ignores items without one', () => {
    expect(
      earliestSoldOutUntil([
        { soldOutUntil: null },
        { soldOutUntil: '2026-09-18T22:30:00Z' },
        {},
        { soldOutUntil: '2026-09-18T20:00:00Z' },
      ]),
    ).toBe(Date.parse('2026-09-18T20:00:00Z'));
    expect(earliestSoldOutUntil([{ soldOutUntil: null }, {}])).toBeNull();
  });
});
