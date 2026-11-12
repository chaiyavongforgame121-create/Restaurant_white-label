import { describe, expect, it } from 'vitest';
import {
  existingAccountOutcome,
  mailRetryAfter,
  passwordLinkRefusalKey,
  signUpFoundAccount,
} from './existing-account';

describe('signUpFoundAccount', () => {
  it('reads the identity-less user GoTrue returns for a taken address', () => {
    expect(signUpFoundAccount({ user: { identities: [] }, error: null })).toBe(true);
    expect(signUpFoundAccount({ user: { identities: null }, error: null })).toBe(true);
    expect(signUpFoundAccount({ user: {}, error: null })).toBe(true);
  });

  it('reads the explicit refusal sent when email confirmation is off', () => {
    expect(signUpFoundAccount({ user: null, error: { code: 'user_already_exists', status: 422 } })).toBe(true);
    expect(signUpFoundAccount({ user: null, error: { code: 'email_exists', status: 422 } })).toBe(true);
  });

  it('leaves a genuinely new address and other refusals alone', () => {
    expect(signUpFoundAccount({ user: { identities: [{ provider: 'email' }] }, error: null })).toBe(false);
    expect(signUpFoundAccount({ user: null, error: null })).toBe(false);
    expect(signUpFoundAccount({ user: null, error: { code: 'weak_password', status: 422 } })).toBe(false);
    expect(signUpFoundAccount({ user: { identities: [] }, error: { code: 'over_request_rate_limit', status: 429 } })).toBe(false);
  });
});

describe('existingAccountOutcome', () => {
  it('signs in when the typed password is theirs', () => {
    expect(existingAccountOutcome(null)).toBe('signed_in');
    expect(existingAccountOutcome(undefined)).toBe('signed_in');
  });

  it('separates the refusals that are not about the password', () => {
    expect(existingAccountOutcome({ code: 'email_not_confirmed', status: 400 })).toBe('not_confirmed');
    expect(existingAccountOutcome({ code: 'over_request_rate_limit', status: 429 })).toBe('rate_limited');
    expect(existingAccountOutcome({ status: 429, message: 'Too many requests' })).toBe('rate_limited');
    expect(existingAccountOutcome({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' })).toBe(
      'unavailable',
    );
    expect(existingAccountOutcome({ code: 'unexpected_failure', status: 500 })).toBe('unavailable');
  });

  it('treats a wrong or missing password as another password', () => {
    expect(existingAccountOutcome({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' })).toBe(
      'other_password',
    );
    expect(existingAccountOutcome({ status: 400, message: 'Invalid login credentials' })).toBe('other_password');
  });

  it('does not blame the password for failures that say nothing about it', () => {
    // auth-js turns a non-JSON error page (an HTML 500, a proxy page) into this, with no status.
    expect(existingAccountOutcome({ name: 'AuthUnknownError', message: 'Unexpected token <' })).toBe('unavailable');
    expect(existingAccountOutcome({ code: 'user_banned', status: 400, message: 'User is banned' })).toBe('unavailable');
    expect(existingAccountOutcome({ code: 'validation_failed', status: 400 })).toBe('unavailable');
    expect(existingAccountOutcome({ status: 400, message: 'Something else' })).toBe('unavailable');
  });
});

describe('passwordLinkRefusalKey', () => {
  it('says "too many" before any link went out, and that the first may still arrive after', () => {
    expect(passwordLinkRefusalKey(false)).toBe('errors.tooManyRequests');
    expect(passwordLinkRefusalKey(true)).toBe('signup.errors.mailLimit');
  });
});

describe('mailRetryAfter', () => {
  it('waits as long as the per-address floor says', () => {
    expect(
      mailRetryAfter(
        { status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 42 seconds.' },
        60,
      ),
    ).toBe(42);
  });

  it('falls back when the refusal names no wait', () => {
    expect(mailRetryAfter({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }, 60)).toBe(60);
    expect(mailRetryAfter({ status: 429 }, 60)).toBe(60);
    // Recognised by the message alone, with no code or 429 to go on.
    expect(mailRetryAfter({ status: 400, message: 'email rate limit exceeded' }, 60)).toBe(60);
    expect(mailRetryAfter({ message: 'For security purposes, you can only request this after 0 seconds.' }, 60)).toBe(60);
  });

  it('ignores refusals that are not rate limits', () => {
    expect(mailRetryAfter({ code: 'email_address_invalid', status: 400 }, 60)).toBeNull();
    expect(mailRetryAfter({ code: 'unexpected_failure', status: 500, message: 'Error sending recovery email' }, 60)).toBeNull();
  });
});
