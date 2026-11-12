// What the trial signup does when the address it was given already has an account.
//
// Every app here shares one Supabase project, so a former staff member (removing them from a
// restaurant's staff leaves their login in place) or a diner from a storefront already has an
// account, and signUp cannot make a second one. Telling them to go and sign in instead stranded
// them on the page meant to start their trial, so signup now tries the password they just typed:
// if it is theirs, they are signed in and continue to /onboarding like any new owner. These
// helpers hold the decisions, so they can be tested without a browser or an auth server.

import { authErrorKey, type AuthErrorLike } from '../../auth/_lib/auth-error';

/** The part of signUp's answer that says whether the address was already taken. */
export interface SignUpAnswer {
  user?: { identities?: readonly unknown[] | null } | null;
  error?: AuthErrorLike | null;
}

export function signUpFoundAccount({ user, error }: SignUpAnswer): boolean {
  // With email confirmation off, GoTrue says so outright.
  if (error) return error.code === 'user_already_exists' || error.code === 'email_exists';
  // With it on (as in this project), it answers 200 with a fake user carrying no identities, so
  // signup cannot be used to probe who is registered; the auth log records user_repeated_signup.
  return !!user && (user.identities?.length ?? 0) === 0;
}

export type ExistingAccountOutcome =
  | 'signed_in'
  | 'not_confirmed'
  | 'rate_limited'
  | 'unavailable'
  | 'other_password';

/** Reads signInWithPassword's answer for an address signUp found already registered. */
export function existingAccountOutcome(error: AuthErrorLike | null | undefined): ExistingAccountOutcome {
  if (!error) return 'signed_in';
  const key = authErrorKey(error);
  if (key === 'errors.tooManyRequests') return 'rate_limited';
  if (key === 'errors.emailNotConfirmed') return 'not_confirmed';
  // invalid_credentials: the account has another password, or none at all (Google only, or a
  // staff account from the magic-link days). Older servers say so only in the message.
  if (
    error.code === 'invalid_credentials' ||
    (!error.code && error.status === 400 && /invalid login credentials/i.test(error.message ?? ''))
  ) {
    return 'other_password';
  }
  // Anything else taught nothing about the password: the network or the auth server failed (an
  // HTML error page reaches auth-js as AuthUnknownError with no status), or the account is
  // banned. "A different password" would send them off to replace one that may be right.
  return 'unavailable';
}

/** The text for a refused password-link send: once a link has gone out, the refusal is about
 *  the next one and the first may still arrive (mailLimit); before that it is "too many". */
export function passwordLinkRefusalKey(alreadySent: boolean): 'signup.errors.mailLimit' | 'errors.tooManyRequests' {
  return alreadySent ? 'signup.errors.mailLimit' : 'errors.tooManyRequests';
}

/**
 * How long a mail button should wait after GoTrue refused a send as too soon or over the
 * project's cap, or null when the refusal was something else. The per-address floor says how
 * long in its message ("…only request this after 42 seconds"); otherwise `fallbackSeconds`.
 */
export function mailRetryAfter(error: AuthErrorLike, fallbackSeconds: number): number | null {
  const message = error.message ?? '';
  const tooSoon =
    error.status === 429 ||
    error.code === 'over_email_send_rate_limit' ||
    /security purposes|rate limit/i.test(message);
  if (!tooSoon) return null;
  const wait = Number(/(\d+)\s*second/i.exec(message)?.[1] ?? fallbackSeconds);
  return Number.isFinite(wait) && wait > 0 ? wait : fallbackSeconds;
}
