import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KITCHEN_LEAD_CASES } from '../../../../supabase/functions/place-order/kitchen-lead.cases';
import * as edge from '../../../../supabase/functions/place-order/kitchen-lead';
import {
  KITCHEN_LEAD_DEFAULT_MIN,
  KITCHEN_MINUTES_MAX,
  isKitchenMinutes,
  kitchenLeadMin,
} from './kitchen-lead';

// Values that are not a whole number of minutes from 0 to a week. Each must be skipped, never
// coerced: "15" and 7.5 are what Number() and a raw ::int cast each read their own way. NaN,
// Infinity and undefined cannot come out of JSON but can be passed from code.
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
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['an array', [5]],
  ['an object', { minutes: 5 }],
];

// The table all three readers run (supabase/functions/place-order/kitchen-lead.cases.ts).
const TABLE = KITCHEN_LEAD_CASES.map(([label, settings, lead]): [string, string, number] => [label, settings, lead]);

describe('kitchenLeadMin', () => {
  // toBe is Object.is, so a -0 does not pass for the 0 the SQL resolver returns.
  it.each(TABLE)('%s: %s -> %i', (_label, settings, lead) => {
    expect(kitchenLeadMin(JSON.parse(settings))).toBe(lead);
  });

  it('is the prep time plus busy mode, at most a week', () => {
    expect(kitchenLeadMin({ prep_time_min: 20, busy_extra_prep_min: 10 })).toBe(30);
    expect(kitchenLeadMin({ prep_time_min: KITCHEN_MINUTES_MAX, busy_extra_prep_min: 10 })).toBe(KITCHEN_MINUTES_MAX);
    expect(kitchenLeadMin({})).toBe(KITCHEN_LEAD_DEFAULT_MIN);
    expect(KITCHEN_LEAD_DEFAULT_MIN).toBe(15);
  });

  it('never reads schedule_lead_time_min', () => {
    for (const lead of [0, 5, 60, 10080, '5', null]) {
      expect(kitchenLeadMin({ schedule_lead_time_min: lead, prep_time_min: 20 })).toBe(20);
      expect(kitchenLeadMin({ schedule_lead_time_min: lead })).toBe(15);
    }
  });

  it.each(BAD)('skips a prep time that is %s for the default', (_label, value) => {
    expect(kitchenLeadMin({ prep_time_min: value })).toBe(15);
    expect(kitchenLeadMin({ prep_time_min: value, busy_extra_prep_min: 10 })).toBe(25);
  });

  it.each(BAD)('counts a busy extra that is %s as none', (_label, value) => {
    expect(kitchenLeadMin({ prep_time_min: 20, busy_extra_prep_min: value })).toBe(20);
  });

  it('answers 15 for settings that are not an object', () => {
    for (const settings of [null, undefined, 'x', 42, true, [], [{ prep_time_min: 5 }]]) {
      expect(kitchenLeadMin(settings)).toBe(15);
    }
  });

  it("the owner's rule: an 11:30 booking at prep 20 reaches the kitchen at 11:10, in busy mode (10) at 11:00", () => {
    const booked = Date.parse('2026-11-16T11:30:00Z');
    const at = (settings: unknown) => new Date(booked - kitchenLeadMin(settings) * 60_000).toISOString();
    expect(at({ prep_time_min: 20 })).toBe('2026-11-16T11:10:00.000Z');
    expect(at({ prep_time_min: 20, busy_extra_prep_min: 10 })).toBe('2026-11-16T11:00:00.000Z');
    expect(at({ prep_time_min: 20, schedule_lead_time_min: 5 })).toBe('2026-11-16T11:10:00.000Z');
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
    'x',
    [],
    ...KITCHEN_LEAD_CASES.map(([, settings]) => JSON.parse(settings) as unknown),
    ...BAD.map(([, v]) => ({ prep_time_min: v })),
    ...BAD.map(([, v]) => ({ prep_time_min: 20, busy_extra_prep_min: v })),
    ...BAD.map(([, v]) => ({ prep_time_min: v, busy_extra_prep_min: v })),
    ...BAD.map(([, v]) => ({ schedule_lead_time_min: v, prep_time_min: 20 })),
  ];

  it('has the same default and ceiling', () => {
    expect(edge.KITCHEN_LEAD_DEFAULT_MIN).toBe(KITCHEN_LEAD_DEFAULT_MIN);
    expect(edge.KITCHEN_MINUTES_MAX).toBe(KITCHEN_MINUTES_MAX);
  });

  it.each(cases.map((c) => [JSON.stringify(c) ?? String(c), c]))('answers %s the same', (_label, settings) => {
    expect(edge.kitchenLeadMin(settings)).toBe(kitchenLeadMin(settings));
  });
});

// The release job's half. supabase/tests/kitchen_lead_is_prep_time.sql runs the table against
// private.branch_kitchen_lead_min on a local stack; this keeps its rows the table's rows, so a row
// added to one and not the other fails here rather than going untested in SQL.
describe('SQL test: the same table, row for row', () => {
  const file = fileURLToPath(new URL('../../../../supabase/tests/kitchen_lead_is_prep_time.sql', import.meta.url));
  const sql = readFileSync(file, 'utf8');
  // perform pg_temp.lead_case('<label>', '<settings>', <lead>);  ('' is a quote inside a literal)
  const rows = [...sql.matchAll(/pg_temp\.lead_case\('((?:[^']|'')*)', '((?:[^']|'')*)', (\d+)\);/g)].map(
    (m): [string, string, number] => [m[1]!.replace(/''/g, "'"), m[2]!.replace(/''/g, "'"), Number(m[3])],
  );

  it('carries every row of the table, in order, and no other', () => {
    expect(rows).toEqual(TABLE);
  });
});

// The newest migration that defines private.branch_kitchen_lead_min must read the same two keys,
// in the same order, with the same defaults and ceiling, and not the old lead.
describe('SQL: private.branch_kitchen_lead_min', () => {
  const marker = 'create or replace function private.branch_kitchen_lead_min(';
  const dir = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(dir + f, 'utf8').includes(marker))
    .sort();
  const sql = defining.length ? readFileSync(dir + defining[defining.length - 1]!, 'utf8') : '';
  const from = sql.indexOf('$function$', sql.indexOf(marker));
  const body = from < 0 ? '' : sql.slice(from, sql.indexOf('$function$', from + 1));

  it('finds a migration that defines it', () => {
    expect(defining.length).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(0);
  });

  it('reads prep_time_min (default 15), then busy_extra_prep_min (default 0), capped at 10080', () => {
    const prep = body.indexOf("'prep_time_min'");
    const busy = body.indexOf("'busy_extra_prep_min'");
    expect(prep).toBeGreaterThan(-1);
    expect(busy).toBeGreaterThan(prep);
    expect(body).toContain(`v_prep    integer := ${KITCHEN_LEAD_DEFAULT_MIN};`);
    expect(body).toContain('v_busy    integer := 0;');
    expect(body).toContain(`<= ${KITCHEN_MINUTES_MAX}`);
    expect(body).toContain(`return least(v_prep + v_busy, ${KITCHEN_MINUTES_MAX});`);
  });

  it('no longer reads schedule_lead_time_min', () => {
    expect(body).not.toContain('schedule_lead_time_min');
  });
});
