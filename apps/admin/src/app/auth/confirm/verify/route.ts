// The Continue button on /auth/confirm posts here. This is the only place an emailed token_hash is
// spent: verifyOtp trades it for a session cookie on this browser, whichever device asked for the
// email, and the person continues to where the link was going. A GET never reaches this code, so
// a mail scanner that fetches the link cannot use it up.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import { safeNext } from '@favornoms/shared';
import { defaultDestination, failureDestination, isEmailLinkType } from '../../_lib/email-link';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const origin = request.nextUrl.origin;

  // A form on another site must not sign this browser into an account the attacker controls
  // (login CSRF: the token in that case is the attacker's own). Sec-Fetch-Site is what modern
  // browsers send and cannot be forged by a page; without it, Origin must match, and 'null' (a
  // no-referrer page or a sandboxed iframe) does not.
  const site = request.headers.get('sec-fetch-site');
  const sentFrom = request.headers.get('origin');
  const crossSite = site ? site !== 'same-origin' : !!sentFrom && sentFrom !== origin;
  if (crossSite) return new NextResponse('Forbidden', { status: 403 });

  const form = await request.formData();
  const tokenHash = String(form.get('token_hash') ?? '').trim();
  const rawType = form.get('type');
  const type = isEmailLinkType(rawType) ? rawType : null;
  const next = safeNext(String(form.get('next') ?? ''), origin) ?? defaultDestination(type);

  // 303 so the browser follows with a GET, not a second POST.
  const go = (path: string) => NextResponse.redirect(new URL(path, origin), 303);

  if (!tokenHash || !type) return go(failureDestination(next, origin));

  const supabase = await getServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) {
    console.error('[auth/confirm] verifyOtp failed:', type, error.code ?? error.message);
    return go(failureDestination(next, origin));
  }
  return go(next);
}
