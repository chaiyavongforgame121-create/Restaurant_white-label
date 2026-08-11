// OAuth / PKCE landing pad. Google (and any future provider) sends the diner back here
// with a `code`; we trade it for a session cookie and drop them back where they started.
//
// This lives OUTSIDE /r/[restaurant]/[branch] on purpose: the provider redirect URI has to
// be a single fixed path per host, and a tenant-scoped one would need one allowlist entry
// per branch. `middleware.ts` exempts /auth/ from the custom-domain rewrite so this route
// still runs on merchant domains.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import { resolveTenantBySlug } from '@favornoms/database/queries';
import { safeNext } from '@favornoms/shared';

export const dynamic = 'force-dynamic';

const TENANT_PATH = /^\/r\/([^/]+)\/([^/]+)(?:\/|$)/;

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get('code');
  // Shared guard — see @favornoms/shared. This value becomes a 302 Location header served
  // from the merchant's own domain, so it must be proven same-origin, not merely
  // "starts with a slash".
  const next = safeNext(request.nextUrl.searchParams.get('next'), origin);

  // Bounce failures back to the sign-in page the diner came from. On a custom domain the
  // `next` has no /r/ prefix, but /sign-in is rewritten to the branch page anyway.
  const tenantMatch = next?.match(TENANT_PATH);
  const restaurantSlug = tenantMatch?.[1];
  const branchSlug = tenantMatch?.[2];
  const signInPath =
    restaurantSlug && branchSlug ? `/r/${restaurantSlug}/${branchSlug}/sign-in` : '/sign-in';
  // Carry `next` through the failure bounce. Without it the diner lands on sign-in with
  // next === null, and a retry falls into goNext's router.back() branch — which walks them
  // backwards into the Google page they just came from instead of on to /checkout.
  const fail = (reason: string) => {
    const url = new URL(signInPath, origin);
    url.searchParams.set('error', reason);
    if (next) url.searchParams.set('next', next);
    return NextResponse.redirect(url);
  };

  if (!code) return fail('missing_code');

  const supabase = await getServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return fail('oauth_failed');

  // signInWithOAuth has no user_metadata option, so handle_new_user never provisions a
  // customers row for a Google signup — do it here. Non-fatal: a failure costs the diner
  // their points balance on this visit, not their session.
  if (restaurantSlug && branchSlug) {
    try {
      const tenant = await resolveTenantBySlug(supabase, restaurantSlug, branchSlug);
      if (tenant) {
        // Ships in docs/AUTH-OTPLESS.sql; types.ts is regenerated once the human applies it.
        const rpc = supabase.rpc as unknown as (
          fn: 'provision_customer_for_branch',
          args: { p_branch_id: string },
        ) => Promise<{ error: { message: string } | null }>;
        await rpc('provision_customer_for_branch', { p_branch_id: tenant.branch.id });
      }
    } catch {
      // Ignore — the row is also created lazily by get_or_create_my_customer / place-order.
    }
  }

  return NextResponse.redirect(new URL(next ?? '/', origin));
}
