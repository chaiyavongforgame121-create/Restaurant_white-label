import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as edge from '../../../../supabase/functions/place-order/asap-delivery';
import { ASAP_DELIVERY_DEFAULT, asapDeliveryEnabled } from './asap-delivery';

// Every value that is not exactly `true`. Each must read as off: "true" and 1 are what a cast or a
// truthiness check would each read their own way.
const OFF: Array<[string, unknown]> = [
  ['false', false],
  ['a string "true"', 'true'],
  ['1', 1],
  ['"on"', 'on'],
  ['an empty object', {}],
  ['an array', [true]],
  ['null', null],
];

const settingsCases: unknown[] = [
  null,
  undefined,
  {},
  'x',
  true,
  [],
  [{ asap_delivery_enabled: true }],
  { asap_delivery_enabled: true },
  { asap_delivery_enabled: true, scheduling_enabled: false },
  ...OFF.map(([, v]) => ({ asap_delivery_enabled: v })),
];

describe('asapDeliveryEnabled', () => {
  it('is off for a branch that never ticked the box', () => {
    expect(ASAP_DELIVERY_DEFAULT).toBe(false);
    expect(asapDeliveryEnabled({})).toBe(false);
    expect(asapDeliveryEnabled({ scheduling_enabled: true })).toBe(false);
  });

  it('is on only for true', () => {
    expect(asapDeliveryEnabled({ asap_delivery_enabled: true })).toBe(true);
  });

  it.each(OFF)('reads %s as off', (_label, value) => {
    expect(asapDeliveryEnabled({ asap_delivery_enabled: value })).toBe(false);
  });

  it('reads settings that are not an object as off', () => {
    for (const s of [null, undefined, 'x', true, 1, [], [{ asap_delivery_enabled: true }]]) {
      expect(asapDeliveryEnabled(s)).toBe(false);
    }
  });
});

// place-order refuses an ASAP delivery by its copy (a Deno function cannot import this package);
// the two must give the same answer for every input, or the storefront offers a box the server
// refuses, or hides one it would take.
describe('place-order: its copy of the rule', () => {
  it('has the same default', () => {
    expect(edge.ASAP_DELIVERY_DEFAULT).toBe(ASAP_DELIVERY_DEFAULT);
  });

  it.each(settingsCases.map((c) => [JSON.stringify(c) ?? String(c), c]))('answers %s the same', (_label, settings) => {
    expect(edge.asapDeliveryEnabled(settings)).toBe(asapDeliveryEnabled(settings));
  });
});

// The database's half: the newest migration that defines patch_branch_settings must still refuse a
// value that is not a JSON boolean (or null), so nothing but true/false is ever stored and every
// reader — this one, place-order's and any SQL — reads it the same way.
describe('SQL: patch_branch_settings', () => {
  const dir = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(dir + f, 'utf8').includes('function public.patch_branch_settings('))
    .sort();
  const sql = defining.length ? readFileSync(dir + defining[defining.length - 1]!, 'utf8') : '';
  const body = sql.slice(sql.indexOf('function public.patch_branch_settings('));

  it('finds a migration that defines it', () => {
    expect(defining.length).toBeGreaterThan(0);
  });

  it('accepts only a boolean or null for asap_delivery_enabled', () => {
    expect(body).toContain("v_key = 'asap_delivery_enabled' and jsonb_typeof(v_value) not in ('boolean', 'null')");
  });
});
