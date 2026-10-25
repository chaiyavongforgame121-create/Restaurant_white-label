// OAuth / PKCE landing pad. Google (and any future provider) sends the diner back here
// with a `code`; we trade it for a session cookie and drop them back where they started.
//
// This lives OUTSIDE /r/[restaurant]/[branch] on purpose: the provider redirect URI has to
// be a single fixed path per host, and a tenant-scoped one would need one allowlist entry
// per branch.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import {
  movedStorefrontPath,
  resolveStorefrontPath,
  resolveTenantBySlug,
  storefrontPathHead,
} from '@favornoms/database/queries';
import { safeNext } from '@favornoms/shared';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get('code');
  // Shared guard — see @favornoms/shared. This value becomes a 302 Location header, so it
  // must be proven same-origin, not merely "starts with a slash".
  let next = safeNext(request.nextUrl.searchParams.get('next'), origin);
  const supabase = await getServerClient();

  // Which storefront `next` belongs to, in either form: /r/<web-address>/… or
  // /r/<restaurant>/<branch>/… (docs/SHORT-STOREFRONT-URLS-2026-10-26.md). Only the database can
  // tell /r/hamburger/checkout (a web address and a page) from /r/demo/brooklyn (a restaurant and
  // a branch), so it is asked about the head of the path — never the query string: `next` is
  // often the menu itself with one (/r/a/b?t=…), and reading "b?t=…" as the branch slug found no
  // tenant to provision at. Asked before the code is traded, so a failure can bounce to the right
  // sign-in page too.
  const head = next ? storefrontPathHead(next) : null;
  const resolution = head ? await resolveStorefrontPath(supabase, head.first, head.second) : null;
  const storefront = resolution && resolution.status !== 'none' ? resolution : null;
  // A sign-in started at an address the storefront has since moved from (a tab opened before a
  // rename, an old link, the long form of a branch that now has a web address): send the diner
  // straight to its current address rather than through one more redirect.
  if (next && storefront?.status === 'redirect') next = movedStorefrontPath(next, storefront) ?? next;

  // Bounce failures back to the storefront's sign-in page, at its public base. When the database
  // could not answer, a long-form pair is still the best guess; the middleware 308s it on.
  const base =
    storefront?.publicBase ?? (resolution === null && head?.second ? `/r/${head.first}/${head.second}` : null);
  const signInPath = base ? `${base}/sign-in` : '/sign-in';
  // The branch to provision at: the one the address names today (the long form behind a short or
  // an old address), or, when the database could not say, a long-form pair as it stands.
  const pair = storefront?.restaurantSlug && storefront.branchSlug
    ? { restaurant: storefront.restaurantSlug, branch: storefront.branchSlug }
    : resolution === null && head?.second
      ? { restaurant: head.first, branch: head.second }
      : null;
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
  if (pair) {
    try {
      const tenant = await resolveTenantBySlug(supabase, pair.restaurant, pair.branch);
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
