import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as edge from '../../../../supabase/functions/place-order/kitchen-lead';
import {
  KITCHEN_LEAD_DEFAULT_MIN,
  KITCHEN_MINUTES_MAX,
  isKitchenMinutes,
  kitchenLeadMin,
} from './kitchen-lead';

// Values that are not a whole number of minutes from 0 to a week. Each must be skipped, never
// coerced: "15" and 7.5 are what Number() and a raw ::int cast each read their own way.
const BAD: Array<[string, unknown]> = [
  ['a fraction', 7.5],
  ['a negative', -1],
  ['more than a week', 10081],
  ['a numeric string', '15'],
  ['a padded string', '15 '],
  ['text', 'abc'],
  ['an empty string', ''],
  ['a boolean', true],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['an array', [5]],
  ['an object', { minutes: 5 }],
];

describe('kitchenLeadMin', () => {
  it('reads schedule_lead_time_min when it is a whole number of minutes', () => {
    expect(kitchenLeadMin({ schedule_lead_time_min: 5, prep_time_min: 20 })).toBe(5);
    expect(kitchenLeadMin({ schedule_lead_time_min: 10080 })).toBe(10080);
  });

  it('takes a saved 0 as an answer ("at the booked time"), not a gap', () => {
    expect(kitchenLeadMin({ schedule_lead_time_min: 0, prep_time_min: 20 })).toBe(0);
    expect(kitchenLeadMin({ prep_time_min: 0 })).toBe(0);
  });

  it('falls back to prep_time_min, then 15', () => {
    expect(kitchenLeadMin({ prep_time_min: 20 })).toBe(20);
    expect(kitchenLeadMin({ schedule_lead_time_min: null, prep_time_min: 20 })).toBe(20);
    expect(kitchenLeadMin({})).toBe(15);
    expect(KITCHEN_LEAD_DEFAULT_MIN).toBe(15);
  });

  it.each(BAD)('skips a lead that is %s for a valid prep time', (_label, value) => {
    expect(kitchenLeadMin({ schedule_lead_time_min: value, prep_time_min: 20 })).toBe(20);
  });

  it.each(BAD)('skips both when both are %s: the default', (_label, value) => {
    expect(kitchenLeadMin({ schedule_lead_time_min: value, prep_time_min: value })).toBe(15);
  });

  it('answers 15 for settings that are not an object', () => {
    for (const settings of [null, undefined, 'x', 42, [], [{ schedule_lead_time_min: 5 }]]) {
      expect(kitchenLeadMin(settings)).toBe(15);
    }
  });

  it('turns -0 into 0, as the SQL resolver does', () => {
    expect(Object.is(kitchenLeadMin(JSON.parse('{"schedule_lead_time_min": -0}')), 0)).toBe(true);
  });

  it('reads 15.0 from JSON as 15 (a whole number)', () => {
    expect(kitchenLeadMin(JSON.parse('{"schedule_lead_time_min": 15.0}'))).toBe(15);
  });

  it("the owner's example: an 11:30 booking with 5 reaches the kitchen at 11:25", () => {
    const booked = Date.parse('2026-10-25T11:30:00Z');
    const kitchenAt = booked - kitchenLeadMin({ schedule_lead_time_min: 5, prep_time_min: 15 }) * 60_000;
    expect(new Date(kitchenAt).toISOString()).toBe('2026-10-25T11:25:00.000Z');
  });
});

describe('isKitchenMinutes', () => {
  it('takes whole numbers from 0 to a week', () => {
    expect(KITCHEN_MINUTES_MAX).toBe(7 * 24 * 60);
    for (const v of [0, 1, 15, 240, 10080]) expect(isKitchenMinutes(v)).toBe(true);
  });

  it.each(BAD)('refuses %s', (_label, value) => {
    expect(isKitchenMinutes(value)).toBe(false);
  });
});

// place-order holds a booking by its copy (a Deno function cannot import this package); the two
// must give the same answer for every input, or a booking is held by one number and drawn on the
// kitchen board by another.
describe('place-order: its copy of the rule', () => {
  const cases: unknown[] = [
    null,
    undefined,
    {},
    'x',
    [],
    { schedule_lead_time_min: 5, prep_time_min: 20 },
    { schedule_lead_time_min: 0, prep_time_min: 20 },
    { schedule_lead_time_min: 10080 },
    { prep_time_min: 20 },
    { prep_time_min: 0 },
    JSON.parse('{"schedule_lead_time_min": -0}'),
    ...BAD.map(([, v]) => ({ schedule_lead_time_min: v, prep_time_min: 20 })),
    ...BAD.map(([, v]) => ({ schedule_lead_time_min: v, prep_time_min: v })),
  ];

  it('has the same default and ceiling', () => {
    expect(edge.KITCHEN_LEAD_DEFAULT_MIN).toBe(KITCHEN_LEAD_DEFAULT_MIN);
    expect(edge.KITCHEN_MINUTES_MAX).toBe(KITCHEN_MINUTES_MAX);
  });

  it.each(cases.map((c) => [JSON.stringify(c) ?? String(c), c]))('answers %s the same', (_label, settings) => {
    expect(Object.is(edge.kitchenLeadMin(settings), kitchenLeadMin(settings))).toBe(true);
  });
});

// The release job's half: the newest migration that defines private.branch_kitchen_lead_min must
// read the same two keys in the same order, with the same ceiling and default.
describe('SQL: private.branch_kitchen_lead_min', () => {
  const dir = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(dir + f, 'utf8').includes('function private.branch_kitchen_lead_min('))
    .sort();
  const sql = defining.length ? readFileSync(dir + defining[defining.length - 1]!, 'utf8') : '';
  const body = sql.slice(sql.indexOf('function private.branch_kitchen_lead_min('));

  it('finds a migration that defines it', () => {
    expect(defining.length).toBeGreaterThan(0);
  });

  it('reads schedule_lead_time_min, then prep_time_min, up to 10080, else 15', () => {
    const lead = body.indexOf("'schedule_lead_time_min'");
    const prep = body.indexOf("'prep_time_min'");
    expect(lead).toBeGreaterThan(-1);
    expect(prep).toBeGreaterThan(lead);
    expect(body).toContain(String(KITCHEN_MINUTES_MAX));
    expect(body).toContain(`return ${KITCHEN_LEAD_DEFAULT_MIN};`);
  });
});
