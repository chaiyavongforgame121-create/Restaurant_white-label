import { describe, expect, it } from 'vitest';
import { adjustPointsErrorKey, parseAdjustPoints } from './adjust-points-model';

describe('adjustPointsErrorKey', () => {
  it.each([
    ['not_authorized', 'notAuthorized'],
    ['bad_delta:0', 'badDelta'],
    ['bad_delta:2000000', 'badDelta'],
    ['bad_reason', 'badReason'],
    ['customer_not_in_branch', 'notInBranch'],
    ['insufficient_points', 'insufficient'],
  ])('maps %j to %j', (message, key) => {
    expect(adjustPointsErrorKey(message)).toBe(key);
  });

  it('never shows raw database text', () => {
    expect(adjustPointsErrorKey('TypeError: Failed to fetch')).toBe('generic');
    expect(adjustPointsErrorKey(undefined)).toBe('generic');
  });
});

describe('parseAdjustPoints', () => {
  it('accepts whole points from 1 to a million', () => {
    expect(parseAdjustPoints('1')).toBe(1);
    expect(parseAdjustPoints(' 250 ')).toBe(250);
    expect(parseAdjustPoints('1000000')).toBe(1_000_000);
  });

  it.each(['', '0', '-5', '1.5', '1e3', '1000001', 'abc'])('refuses %j', (raw) => {
    expect(parseAdjustPoints(raw)).toBeNull();
  });
});
