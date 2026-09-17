import { describe, expect, it } from 'vitest';
import { authErrorKey } from './auth-error';

describe('authErrorKey', () => {
  it('reads rate limits from the status or the code', () => {
    expect(authErrorKey({ status: 429, message: 'For security purposes, you can only request this after 42 seconds.' })).toBe(
      'errors.tooManyRequests',
    );
    expect(authErrorKey({ code: 'over_email_send_rate_limit' })).toBe('errors.tooManyRequests');
    expect(authErrorKey({ code: 'over_request_rate_limit', status: 400 })).toBe('errors.tooManyRequests');
  });

  it('maps the codes a merchant can act on', () => {
    expect(authErrorKey({ code: 'otp_disabled', message: 'Signups not allowed for otp' })).toBe('errors.linkUnavailable');
    expect(authErrorKey({ code: 'weak_password' })).toBe('errors.weakPassword');
    expect(authErrorKey({ code: 'same_password' })).toBe('errors.samePassword');
    expect(authErrorKey({ code: 'email_exists' })).toBe('errors.accountExists');
    expect(authErrorKey({ code: 'session_not_found' })).toBe('errors.sessionExpired');
  });

  it('treats a session that disappeared after load as expired', () => {
    // auth-js throws this before any request, with status 400 and no code.
    expect(authErrorKey({ name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' })).toBe('errors.sessionExpired');
  });

  it('never passes raw server text through', () => {
    expect(authErrorKey({ message: 'duplicate key value violates unique constraint' })).toBe('errors.generic');
    expect(authErrorKey({ code: 'unexpected_failure', status: 500 })).toBe('errors.generic');
    expect(authErrorKey({})).toBe('errors.generic');
  });
});
