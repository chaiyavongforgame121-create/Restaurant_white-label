// OAuth / PKCE landing pad. Google (and any future provider) sends the diner back here
// with a `code`; we trade it for a session cookie and drop them back where they started.
//
// This lives OUTSIDE /r/[restaurant]/[branch] on purpose: the provider redirect URI has to
// be a single fixed path per host, and a tenant-scoped one would need one allowlist entry
// per branch.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import { movedStorefrontPath, resolveStorefrontPath, resolveTenantBySlug } from '@favornoms/database/queries';
import { safeNext } from '@favornoms/shared';

export const dynamic = 'force-dynamic';

// The query string is not part of a slug: `next` is often the menu itself with one
// (/r/a/b?t=…), and reading "b?t=…" as the branch slug found no tenant to provision at.
const TENANT_PATH = /^\/r\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/;

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get('code');
  // Shared guard — see @favornoms/shared. This value becomes a 302 Location header, so it
  // must be proven same-origin, not merely "starts with a slash".
  let next = safeNext(request.nextUrl.searchParams.get('next'), origin);

  // Bounce failures back to the sign-in page the diner came from. A sign-in started at a
  // storefront's old address bounces to the old sign-in path, and the middleware 308s that on.
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
  // customers row for a Google signup — do it here, for the branch the diner signed in at
  // (each branch keeps its own record of them; another branch gets its row on first use).
  // Non-fatal: a failure costs the diner their prefilled profile on this visit, not their
  // session.
  //
  // Called as a method on the client. It used to be pulled off as a bare function to retype
  // it, which dropped `this` inside supabase-js, threw, and was swallowed below — so a Google
  // sign-in never provisioned anything here.
  if (restaurantSlug && branchSlug) {
    try {
      let tenant = await resolveTenantBySlug(supabase, restaurantSlug, branchSlug);
      // A sign-in started at an address the storefront has since moved from (a tab opened before
      // a rename, an old link): provision at the branch those slugs name now, and send the diner
      // straight to its current address rather than through one more redirect.
      if (!tenant) {
        const resolution = await resolveStorefrontPath(supabase, restaurantSlug, branchSlug);
        if (resolution?.status === 'redirect' && resolution.restaurantSlug && resolution.branchSlug) {
          tenant = await resolveTenantBySlug(supabase, resolution.restaurantSlug, resolution.branchSlug);
          if (tenant && next) next = movedStorefrontPath(next, resolution) ?? next;
        }
      }
      if (tenant) {
        const { error: provisionError } = await supabase.rpc('provision_customer_for_branch', {
          p_branch_id: tenant.branch.id,
        });
        if (provisionError) console.error('provision_customer_for_branch failed', provisionError.message);
      }
    } catch (err) {
      // Ignore — the row is also created lazily by get_or_create_my_customer / place-order.
      console.error('provisioning the customer row failed', err);
    }
  }

  return NextResponse.redirect(new URL(next ?? '/', origin));
}
