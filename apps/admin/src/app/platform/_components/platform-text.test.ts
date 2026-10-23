import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformErrorKey } from './platform-text';

// A refusal that names its cause must reach the operator as that cause: "something went
// wrong" sends them to retry a write the database will refuse every time.

describe('platformErrorKey', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => log.mockClear());

  it('names the card-billing refusal first', () => {
    expect(platformErrorKey('ERROR: stripe_managed (P0001)')).toBe('stripe.errors.managed');
  });

  it('has no delivery refusal any more', () => {
    // The card-rail guard that refused to hide a delivering branch was dropped with the
    // delivery add-on (docs/PACKAGING-2026-10-24.md §4.2); the stray code reads as any failure.
    expect(platformErrorKey('ERROR: stripe_delivery_active (P0001)')).toBe('errors.generic');
  });

  it('keeps the older causes and the fallback', () => {
    expect(platformErrorKey('permission denied for function x', '42501')).toBe('errors.notPlatformAdmin');
    expect(platformErrorKey('TypeError: Failed to fetch')).toBe('errors.network');
    expect(platformErrorKey('boom')).toBe('errors.generic');
    expect(platformErrorKey('boom', null, 'errors.reactivateFailed')).toBe('errors.reactivateFailed');
  });

  it('logs the raw text instead of showing it', () => {
    platformErrorKey('ERROR: stripe_managed (P0001)');
    expect(log).toHaveBeenCalled();
  });
});
