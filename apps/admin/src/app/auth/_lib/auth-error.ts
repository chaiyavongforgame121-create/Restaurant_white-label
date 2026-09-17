// What a merchant reads when the auth server refuses something.
//
// GoTrue's own messages are English and technical ("Signups not allowed for otp"), so the sign-in,
// sign-up, reset and invitation screens never print them. This picks a message key in the `auth`
// namespace from the error's stable code or HTTP status; the raw text stays in the console.

export type AuthErrorKey =
  | 'errors.tooManyRequests'
  | 'errors.emailNotConfirmed'
  | 'errors.weakPassword'
  | 'errors.samePassword'
  | 'errors.invalidEmail'
  | 'errors.linkUnavailable'
  | 'errors.emailNotSent'
  | 'errors.signupDisabled'
  | 'errors.accountExists'
  | 'errors.sessionExpired'
  | 'errors.reauthenticationNeeded'
  | 'errors.generic';

export interface AuthErrorLike {
  name?: string | null;
  code?: string | null;
  status?: number | null;
  message?: string | null;
}

export function authErrorKey(error: AuthErrorLike): AuthErrorKey {
  // Thrown by the client itself (no request, no code) when the session went away after the page
  // loaded, e.g. signed out in another tab; retrying can never work, so say the session ended.
  if (error.name === 'AuthSessionMissingError') return 'errors.sessionExpired';
  const code = error.code ?? '';
  // over_request_rate_limit, over_email_send_rate_limit, over_sms_send_rate_limit.
  if (error.status === 429 || code.startsWith('over_')) return 'errors.tooManyRequests';
  switch (code) {
    case 'email_not_confirmed':
      return 'errors.emailNotConfirmed';
    case 'weak_password':
      return 'errors.weakPassword';
    case 'same_password':
      return 'errors.samePassword';
    case 'email_address_invalid':
      return 'errors.invalidEmail';
    // signInWithOtp with shouldCreateUser: false, for an address with no account.
    case 'otp_disabled':
      return 'errors.linkUnavailable';
    case 'email_address_not_authorized':
      return 'errors.emailNotSent';
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'errors.signupDisabled';
    case 'user_already_exists':
    case 'email_exists':
      return 'errors.accountExists';
    case 'session_not_found':
    case 'session_expired':
    case 'refresh_token_not_found':
      return 'errors.sessionExpired';
    case 'reauthentication_needed':
      return 'errors.reauthenticationNeeded';
    default:
      return 'errors.generic';
  }
}
