import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { getAnonServerClient } from '@favornoms/database/server';
import { tenantCacheTag } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * "The shop just changed something — drop your cached copy of it."
 *
 * The storefront caches restaurant/branch/brand data across requests, and the merchant edits
 * it in a DIFFERENT deployment (apps/admin) which cannot call revalidateTag() inside this one.
 * The durable fix is the storefront version counter in the database
 * (supabase/migrations/20260904151000_storefront_versions.sql): a trigger bumps it, the cache
 * key changes, the next request misses. This route is the belt to that braces — it works the
 * instant the admin app calls it, needs no migration, and covers the case where a merchant is
 * staring at their own storefront on a second phone right after pressing Save.
 *
 * Deliberately unauthenticated, and safe to be:
 *  - it accepts no data and returns none; the only effect is that the NEXT request for this
 *    tenant re-reads three publicly readable rows;
 *  - the tenant it names is resolved from the database (or its slugs are shape-checked), and
 *    a tag no cache entry carries is simply a no-op;
 *  - each tenant may be revalidated at most once every few seconds, which caps the achievable
 *    cost at less than the app's own fallback re-read cadence.
 * The alternative — a shared secret — cannot work: the caller is a browser in another app, so
 * the secret would have to be NEXT_PUBLIC, and sending a staff access token to a second origin
 * to prove identity risks far more than a cache miss is worth.
 */

/** Per-tenant floor between accepted revalidations. */
const MIN_GAP_MS = 3_000;
/** Bound on the throttle map, so a stream of distinct branch ids cannot grow it forever. */
const MAX_TRACKED = 500;

const lastRevalidated = new Map<string, number>();

function throttled(key: string): boolean {
  const now = Date.now();
  const previous = lastRevalidated.get(key);
  if (previous !== undefined && now - previous < MIN_GAP_MS) return true;
  if (lastRevalidated.size >= MAX_TRACKED) {
    // Insertion-ordered: the oldest entry is the least likely to be asked for again.
    const oldest = lastRevalidated.keys().next();
    if (!oldest.done) lastRevalidated.delete(oldest.value);
  }
  lastRevalidated.set(key, now);
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/i;

interface Body {
  branchId?: unknown;
  restaurant?: unknown;
  branch?: unknown;
}

export async function POST(request: Request) {
  // Read as text, not request.json(): the admin app posts this cross-origin as `text/plain`
  // with `mode: 'no-cors'` so the browser sends it as a simple request with no preflight and
  // no CORS round trip. A JSON content-type would need one, and would fail.
  let body: Body = {};
  try {
    const raw = await request.text();
    if (raw) body = JSON.parse(raw) as Body;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const url = new URL(request.url);
  const branchId =
    typeof body.branchId === 'string' ? body.branchId : url.searchParams.get('branchId');
  const restaurantSlug =
    typeof body.restaurant === 'string' ? body.restaurant : url.searchParams.get('restaurant');
  const branchSlug = typeof body.branch === 'string' ? body.branch : url.searchParams.get('branch');

  let slugs: { restaurant: string; branch: string } | null = null;

  if (restaurantSlug && branchSlug && SLUG.test(restaurantSlug) && SLUG.test(branchSlug)) {
    slugs = { restaurant: restaurantSlug, branch: branchSlug };
  } else if (branchId && UUID.test(branchId)) {
    // The admin app knows the branch it is editing, not the slugs the storefront is addressed
    // by, so resolve them here. Doubles as the existence check.
    const supabase = getAnonServerClient();
    const { data: branchRow } = await supabase
      .from('branches')
      .select('slug, restaurant_id')
      .eq('id', branchId)
      .maybeSingle();
    if (!branchRow) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const { data: restaurantRow } = await supabase
      .from('restaurants')
      .select('slug')
      .eq('id', branchRow.restaurant_id)
      .maybeSingle();
    if (!restaurantRow) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    slugs = { restaurant: restaurantRow.slug, branch: branchRow.slug };
  }

  if (!slugs) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const tag = tenantCacheTag(slugs.restaurant, slugs.branch);
  if (throttled(tag)) return new NextResponse(null, { status: 429 });

  revalidateTag(tag);
  return new NextResponse(null, { status: 204 });
}
