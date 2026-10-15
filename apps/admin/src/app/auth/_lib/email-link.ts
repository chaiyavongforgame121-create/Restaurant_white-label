// Emailed auth links (staff invitation, password reset, magic sign-in, signup and email-change
// confirmation) land on /auth/confirm, which verifies them only when the person presses
// Continue. The email templates in Supabase build the link as
//
//   https://admin.favornoms.com/auth/confirm?token_hash={{ .TokenHash }}&type=<type>&next={{ .RedirectTo }}
//
// A token_hash is verified server-side with verifyOtp, so unlike the old PKCE `?code=` it works
// in any browser on any device, not only the one that asked for the email. And because opening
// the page does not spend it, a mail scanner or a preview that fetches the link first no longer
// leaves the person with "this link has expired".
import { safeNext } from '@favornoms/shared';

export const EMAIL_LINK_TYPES = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'] as const;
export type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number];

export function isEmailLinkType(value: unknown): value is EmailLinkType {
  return typeof value === 'string' && (EMAIL_LINK_TYPES as readonly string[]).includes(value);
}

export interface EmailLink {
  tokenHash: string | null;
  type: EmailLinkType | null;
  /** GoTrue's {{ .RedirectTo }}: the redirectTo the app asked for, or the Site URL. */
  redirectTo: string | null;
}

/**
 * Reads an emailed link's query string. `next` is pasted raw by the template and is always the
 * last parameter, so it is taken verbatim to the end of the string instead of being parsed: a
 * redirect that carries its own `&` would otherwise be cut short.
 */
export function readEmailLink(search: string): EmailLink {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const at = query.startsWith('next=') ? 0 : query.indexOf('&next=');
  const head = at < 0 ? query : query.slice(0, at);
  let redirectTo: string | null = null;
  if (at >= 0) {
    const raw = query.slice(at === 0 ? 'next='.length : at + '&next='.length);
    redirectTo = decodeOnce(raw) || null;
  }
  const params = new URLSearchParams(head);
  const tokenHash = params.get('token_hash')?.trim() || null;
  const rawType = params.get('type');
  return { tokenHash, type: isEmailLinkType(rawType) ? rawType : null, redirectTo };
}

/** A redirect pasted percent-encoded (`https%3A%2F%2F…`) is decoded once; one pasted as-is is kept. */
function decodeOnce(raw: string): string {
  if (!/^https?%3A/i.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Where each kind of link goes when its redirect says nothing usable. Everything but a reset goes
 *  to the root, which sends a signed-in person on to their dashboard, a pending invitation, or
 *  onboarding: `email` covers both signup confirmation and a magic sign-in, so a fixed
 *  /onboarding would have sent returning staff to the new-restaurant wizard. */
export function defaultDestination(type: EmailLinkType | null): string {
  return type === 'recovery' ? '/auth/update-password' : '/';
}

/**
 * The in-app path a verified link continues to. The redirect is an absolute URL on whichever
 * host the request came from (the old *.vercel.app address, or the Site URL when an email was
 * sent from the Supabase dashboard), so only its path is kept and it is resolved against this
 * app's own origin. Links made for /auth/callback carry the real destination in its `next`.
 * Anything that is not a plain same-origin path falls back to the type's default.
 */
export function destinationFor(redirectTo: string | null, type: EmailLinkType | null, origin: string): string {
  const fallback = defaultDestination(type);
  if (!redirectTo) return fallback;
  // GoTrue always pastes an absolute URL; anything else is not a redirect it made.
  let url: URL;
  try {
    url = new URL(redirectTo);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
  const candidate = url.pathname === '/auth/callback' ? url.searchParams.get('next') : `${url.pathname}${url.search}`;
  if (!candidate || candidate === '/') return fallback;
  return safeNext(candidate, origin) ?? fallback;
}

/** Where a link that could not be verified sends the person. An invitation goes back to its own
 *  page, which offers Google, signing in, or a fresh set-password link; anything else goes to
 *  sign-in with the "expired" message. */
export function failureDestination(next: string, origin: string): string {
  if (next.startsWith('/invite/accept')) {
    const url = new URL(next, origin);
    url.searchParams.set('link', 'expired');
    return `${url.pathname}${url.search}`;
  }
  const url = new URL('/login', origin);
  url.searchParams.set('error', 'otp_expired');
  if (next !== '/') url.searchParams.set('next', next);
  return `${url.pathname}${url.search}`;
}
