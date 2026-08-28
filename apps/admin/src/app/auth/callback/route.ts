// The merchant app's landing pad for every email-borne link: magic sign-in, staff
// invitations, and password recovery.
//
// This route did not exist. `@supabase/ssr`'s createBrowserClient speaks PKCE, so
// signInWithOtp mails a link that comes back as `?code=<uuid>`; something server-side has
// to trade that code for a session cookie. apps/web has had this route all along for
// Google OAuth — apps/admin never got one, so every merchant link landed on the dashboard
// with an unspent `?code=` in the query string, no session, and an instant bounce back to
// /login. That is the "I clicked the email and nothing happened" report.
//
// Two token shapes arrive here, and both are handled:
//   ?code=…                    PKCE — the default for signInWithOtp / resetPasswordForEmail
//   ?token_hash=…&type=…       the older verify shape, still emitted by custom email
//                              templates using {{ .TokenHash }}
//
// GoTrue also redirects here with ?error=… when the link is stale, which we translate into
// a readable message on /login rather than a silent bounce.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import { safeNext } from '@favornoms/shared';

export const dynamic = 'force-dynamic';

/** Mirrors @supabase/supabase-js EmailOtpType without importing it — apps/admin depends on
 *  the package only transitively, and a type-only import from a transitive dep breaks under
 *  pnpm's strict node_modules layout. */
type EmailOtpType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email';

const OTP_TYPES: readonly EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
];

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const params = request.nextUrl.searchParams;
  // Shared open-redirect guard — see @favornoms/shared. This value becomes a 302 Location
  // served immediately after a session cookie is minted, so a hostile `next` would hand a
  // fresh *staff* session to an attacker's page.
  const next = safeNext(params.get('next'), origin) ?? '/';

  const fail = (reason: string) => {
    const url = new URL('/login', origin);
    url.searchParams.set('error', reason);
    if (next !== '/') url.searchParams.set('next', next);
    return NextResponse.redirect(url);
  };

  // GoTrue reports its own failures by redirecting to the target with ?error=… rather than
  // by refusing to redirect, so an untranslated error would render as a normal login page
  // and look like the click did nothing.
  const providerError = params.get('error_code') ?? params.get('error');
  if (providerError) return fail(providerError);

  const supabase = await getServerClient();

  const code = params.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // PKCE binds the code to a verifier stored by the browser that *started* the flow.
    // Opening the mail on a different device is therefore a legitimate failure, not a bug,
    // and the message on /login says so.
    if (error) return fail('exchange_failed');
    return NextResponse.redirect(new URL(next, origin));
  }

  const tokenHash = params.get('token_hash');
  const rawType = params.get('type');
  const type = OTP_TYPES.includes(rawType as EmailOtpType) ? (rawType as EmailOtpType) : null;
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return fail('otp_expired');
    return NextResponse.redirect(new URL(next, origin));
  }

  return fail('missing_code');
}
