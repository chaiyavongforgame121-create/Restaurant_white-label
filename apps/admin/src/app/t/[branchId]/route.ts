// TEST-ONLY back-office access link. Signs a demo reviewer straight into ONE branch's
// admin, skipping the email magic-link round-trip so a non-technical tester can just click
// a URL. The credential is carried in the link itself (`?k` = base64("email:password")) and
// is NEVER stored in this (public) repo — the link is the secret. `signInWithPassword` still
// verifies real credentials, so this is a convenience login, not an auth bypass, and the
// app's own staff/RLS checks still gate what the reviewer can see. Delete this route before
// a real launch (or rotate the demo account's password to revoke every issued link at once).
import { NextResponse, type NextRequest } from 'next/server';
import { getServerClient } from '@favornoms/database/server';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ branchId: string }> },
) {
  // Hard-404 in production unless explicitly re-enabled, matching /api/test-sign-in.
  // Without this gate the route shipped live: a password in a query string lands in
  // server logs, browser history and Referer headers, and the link is bearer-grade —
  // anyone who sees it holds back-office access until the password is rotated.
  // Set ENABLE_TEST_AUTH=1 on a demo deployment if a reviewer still needs it.
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_TEST_AUTH !== '1') {
    return new NextResponse(null, { status: 404 });
  }

  const { branchId } = await params;
  const origin = request.nextUrl.origin;

  let email = '';
  let password = '';
  try {
    const decoded = Buffer.from(request.nextUrl.searchParams.get('k') ?? '', 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      email = decoded.slice(0, i);
      password = decoded.slice(i + 1);
    }
  } catch {
    /* malformed token — fall through to the login page */
  }
  if (!email || !password) return NextResponse.redirect(new URL('/login', origin));

  const supabase = await getServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return NextResponse.redirect(new URL('/login?error=link', origin));

  // Land on the branch dashboard; membership is still enforced by the branch layout.
  const safe = /^[0-9a-fA-F-]{36}$/.test(branchId) ? branchId : '';
  return NextResponse.redirect(new URL(safe ? `/b/${safe}/dashboard` : '/', origin));
}
