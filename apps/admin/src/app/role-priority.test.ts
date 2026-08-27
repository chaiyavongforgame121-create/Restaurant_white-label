import { describe, expect, it } from 'vitest';
import { Constants } from '@favornoms/database';

/**
 * ROLE_PRIORITY decides which membership wins when a user is staff at several places.
 * A role missing from it gets `indexOf === -1` and therefore sorts FIRST — ahead of
 * `owner` — so an omission silently changes where a multi-role user lands after
 * sign-in. That makes "did we remember to add the new role" a real correctness
 * question, not a style one, and it is exactly the kind of thing an enum change
 * forgets. This test fails the moment staff_role gains a value.
 */
const ROLE_PRIORITY = [
  'owner',
  'admin',
  'manager',
  'cashier',
  'server',
  'kitchen',
  'staff',
  'driver',
];

describe('ROLE_PRIORITY', () => {
  it('covers every staff_role in the database enum', () => {
    const enumRoles = [...Constants.public.Enums.staff_role];
    expect([...ROLE_PRIORITY].sort()).toEqual(enumRoles.sort());
  });

  it('never leaves a role unranked, which would sort it above owner', () => {
    for (const role of Constants.public.Enums.staff_role) {
      expect(ROLE_PRIORITY.indexOf(role)).toBeGreaterThanOrEqual(0);
    }
  });

  it('ranks owner first', () => {
    expect(ROLE_PRIORITY[0]).toBe('owner');
  });
});
