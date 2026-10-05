import { describe, expect, it } from 'vitest';
import { liftCooldownFailure } from '@favornoms/database/queries';
import { activeCooldownUntil, cooldownEndLabel, liftMessage } from './cooldown';

// Peter Box and Bobby Chu were put on the 60-minute cooldown at 15:32 and 15:34 on 2026-10-05,
// by the kitchen's own retries, and nothing in the product could lift it.

const NOW = Date.parse('2026-10-05T15:40:00Z');

describe('activeCooldownUntil', () => {
  it('is the end time while the cooldown runs, and nothing once it is over', () => {
    expect(activeCooldownUntil('2026-10-05T16:32:44Z', NOW)).toBe('2026-10-05T16:32:44Z');
    expect(activeCooldownUntil('2026-10-05T15:39:59Z', NOW)).toBeNull();
    expect(activeCooldownUntil(null, NOW)).toBeNull();
    expect(activeCooldownUntil('not a time', NOW)).toBeNull();
  });
});

describe('cooldownEndLabel', () => {
  it('writes only the time when it ends today', () => {
    expect(cooldownEndLabel('2026-10-05T16:32:44Z', NOW, 'en-US', 'UTC')).toBe('4:32 PM');
  });

  it('adds the date when it ends on another day', () => {
    const label = cooldownEndLabel('2026-10-06T00:20:00Z', NOW, 'en-US', 'UTC');
    expect(label).toContain('Oct 6');
    expect(label).toContain('12:20');
  });

  it('reads "today" in the viewer’s zone, not UTC', () => {
    // 16:32 UTC is 11:32 the same day in Houston; 00:20 UTC on the 6th is still the 5th there.
    expect(cooldownEndLabel('2026-10-06T00:20:00Z', NOW, 'en-US', 'America/Chicago')).toBe('7:20 PM');
  });

  it('says nothing for a cooldown that is over', () => {
    expect(cooldownEndLabel('2026-10-05T15:00:00Z', NOW, 'en-US', 'UTC')).toBeNull();
  });
});

describe('lifting a cooldown', () => {
  it('maps the database refusals, the shared one first', () => {
    expect(liftCooldownFailure('forbidden: cooldown_shared_with_other_branch')).toBe('sharedForbidden');
    expect(liftCooldownFailure('forbidden')).toBe('forbidden');
    expect(liftCooldownFailure('driver_not_at_branch')).toBe('failed');
    expect(liftCooldownFailure('Could not find the function public.lift_driver_cooldown')).toBe('failed');
  });

  it('tells the merchant what happened', () => {
    expect(liftMessage({ ok: true, wasUntil: '2026-10-05T16:32:44Z' })).toEqual({ key: 'lifted', tone: 'done' });
    // Nothing to lift is not a failure: the rider can go online, which is what was wanted.
    expect(liftMessage({ ok: false, reason: 'alreadyOver' })).toEqual({ key: 'alreadyOver', tone: 'done' });
    expect(liftMessage({ ok: false, reason: 'sharedForbidden', message: 'x' })).toEqual({
      key: 'sharedForbidden',
      tone: 'error',
    });
    expect(liftMessage({ ok: false, reason: 'failed', message: 'x' })).toEqual({ key: 'failed', tone: 'error' });
  });
});
