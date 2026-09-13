import { describe, expect, it } from 'vitest';
import {
  formatInZone,
  isValidTimeZone,
  localInputToUtcIso,
  utcToLocalInput,
  wallTimeToUtc,
} from './zoned-time';

// These run in whatever zone the host happens to use, which is the point: every assertion is
// about the BRANCH's zone. If the implementation ever fell back to the host clock, the Chicago
// cases would break on a UTC runner and the Bangkok ones on a US laptop.

describe('localInputToUtcIso', () => {
  it('is the bug report: Christmas Day at 12:01 AM in Chicago is not 00:01 UTC', () => {
    // The form used to send "2026-12-25T00:01" raw, which Postgres stored as 00:01 UTC —
    // 6:01 PM on Christmas Eve at the shop.
    expect(localInputToUtcIso('2026-12-25T00:01', 'America/Chicago')).toBe('2026-12-25T06:01:00.000Z');
  });

  it('uses daylight time in summer', () => {
    expect(localInputToUtcIso('2026-10-12T01:38', 'America/Chicago')).toBe('2026-10-12T06:38:00.000Z');
  });

  it('works east of Greenwich too', () => {
    expect(localInputToUtcIso('2026-09-12T08:00', 'Asia/Bangkok')).toBe('2026-09-12T01:00:00.000Z');
  });

  it('gets the hour right just after clocks go back, which a single pass does not', () => {
    // 03:00 CST on the night US DST ends. One pass reads the CDT offset and lands at 08:00Z.
    expect(localInputToUtcIso('2026-11-01T03:00', 'America/Chicago')).toBe('2026-11-01T09:00:00.000Z');
  });

  it('gets the hour right the evening after clocks go back', () => {
    expect(localInputToUtcIso('2026-11-02T18:00', 'America/Chicago')).toBe('2026-11-03T00:00:00.000Z');
  });

  it('gets the hour right after clocks go forward', () => {
    expect(localInputToUtcIso('2026-03-09T18:00', 'America/Chicago')).toBe('2026-03-09T23:00:00.000Z');
  });

  it('resolves a wall time that happens twice to a real instant that reads back as that time', () => {
    const iso = localInputToUtcIso('2026-11-01T01:30', 'America/Chicago');
    expect(iso).not.toBeNull();
    expect(utcToLocalInput(iso as string, 'America/Chicago')).toBe('2026-11-01T01:30');
  });

  it('accepts the seconds some browsers include', () => {
    expect(localInputToUtcIso('2026-12-25T00:01:30', 'America/Chicago')).toBe('2026-12-25T06:01:30.000Z');
  });

  it('refuses a value it cannot read rather than guessing', () => {
    expect(localInputToUtcIso('', 'America/Chicago')).toBeNull();
    expect(localInputToUtcIso('12/25/2026 12:01 AM', 'America/Chicago')).toBeNull();
    expect(localInputToUtcIso('2026-13-01T00:00', 'America/Chicago')).toBeNull();
    expect(localInputToUtcIso('2026-12-25T24:00', 'America/Chicago')).toBeNull();
  });

  it('refuses a zone the runtime does not know', () => {
    expect(localInputToUtcIso('2026-12-25T00:01', 'Mars/Olympus_Mons')).toBeNull();
    expect(localInputToUtcIso('2026-12-25T00:01', '')).toBeNull();
  });
});

describe('utcToLocalInput', () => {
  it('round-trips a closure the merchant typed', () => {
    for (const [value, tz] of [
      ['2026-12-25T00:01', 'America/Chicago'],
      ['2026-07-04T18:45', 'America/New_York'],
      ['2026-04-13T09:00', 'Asia/Bangkok'],
      ['2026-11-02T18:00', 'America/Chicago'],
    ] as const) {
      const iso = localInputToUtcIso(value, tz);
      expect(iso).not.toBeNull();
      expect(utcToLocalInput(iso as string, tz)).toBe(value);
    }
  });

  it('writes midnight as 00, not 24', () => {
    expect(utcToLocalInput('2026-12-25T06:00:00.000Z', 'America/Chicago')).toBe('2026-12-25T00:00');
  });

  it('is empty for something it cannot read', () => {
    expect(utcToLocalInput('not a date', 'America/Chicago')).toBe('');
    expect(utcToLocalInput('2026-12-25T06:00:00.000Z', 'Nowhere/Special')).toBe('');
  });
});

describe('formatInZone', () => {
  it('says what the shop clock says, not the device', () => {
    expect(formatInZone('2026-12-25T06:01:00.000Z', 'America/Chicago')).toBe('12/25/2026, 12:01 AM');
    expect(formatInZone('2026-12-25T06:01:00.000Z', 'Asia/Bangkok')).toBe('12/25/2026, 1:01 PM');
  });

  it('can say just the date', () => {
    expect(formatInZone('2027-08-31T23:51:00.000Z', 'America/Chicago', { dateOnly: true })).toBe('8/31/2027');
  });

  it('uses plain spaces, so the text compares and copies like the rest of the page', () => {
    expect(formatInZone('2026-12-25T06:01:00.000Z', 'America/Chicago')).not.toMatch(/[  ]/);
  });

  it('hands back input it cannot read', () => {
    expect(formatInZone('garbage', 'America/Chicago')).toBe('garbage');
    expect(formatInZone('2026-12-25T06:01:00.000Z', 'Bad/Zone')).toBe('2026-12-25T06:01:00.000Z');
  });
});

describe('wallTimeToUtc', () => {
  it('is the number the ISO helper is built on', () => {
    expect(new Date(wallTimeToUtc(2026, 12, 25, 0, 1, 'America/Chicago')).toISOString()).toBe(
      '2026-12-25T06:01:00.000Z',
    );
  });
});

describe('isValidTimeZone', () => {
  it('knows a real zone from a typo', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Asia/Bangkok')).toBe(true);
    expect(isValidTimeZone('America/Chicagoo')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });
});
