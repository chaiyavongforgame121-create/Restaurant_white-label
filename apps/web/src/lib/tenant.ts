import { notFound } from 'next/navigation';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getAnonServerClient, getServerClient } from '@favornoms/database/server';
import {
  getStorefrontStatus,
  resolveTenantBySlug,
  type ResolvedTenant,
  type StorefrontStatus,
} from '@favornoms/database/queries';
import { deriveStorefrontNames, type StorefrontNames } from './app-identity';

/**
 * How long a tenant entry may live once nothing has told us it changed. With the version key
 * below this is only a backstop for a bump that never happened (the migration is not applied,
 * or someone edited a table with no trigger on it) — not the thing standing between a merchant
 * and their new logo.
 */
const TENANT_TTL_SECONDS = 300;

/**
 * Granularity of the fallback cache key when the version is unknown. This is the whole of the
 * staleness in that mode, so it is deliberately short: ten seconds of "did my save work?" is a
 * pause, thirty was long enough that merchants re-uploaded their logo twice.
 */
const FALLBACK_BUCKET_MS = 10_000;

/**
 * The version RPC only exists once 20260904151000_storefront_versions.sql has been applied.
 * Asking a database that does not have it, once per storefront request, would be a round trip
 * spent to learn nothing — so a failure switches the whole process to the time-bucket key for
 * a minute before trying again.
 */
const VERSION_RPC_RETRY_MS = 60_000;
let versionRpcUnavailableUntil = 0;

/** Cache tag for one storefront, so invalidating one tenant does not evict every other one. */
export function tenantCacheTag(restaurantSlug: string, branchSlug: string): string {
  return `tenant:${restaurantSlug}:${branchSlug}`;
}

/**
 * Tenant data (restaurant + branch + brand theme) is identical for every visitor and changes
 * only when the merchant edits branch settings — so it is cached ACROSS requests, not just
 * within one render. This is what stops every navigation from re-paying the three sequential
 * restaurants -> branches -> brands round-trips (~1.5s each warm, far worse cold) that were a
 * large part of the "everything is slow" report.
 *
 * The cached function uses the cookie-LESS anon client on purpose: unstable_cache must not
 * touch request cookies, and the storefront is publicly readable, so the anon role sees the
 * same rows.
 *
 * `versionKey` is part of the cache KEY, not the payload. A merchant save bumps
 * public.storefront_versions (DB trigger), the key changes, and the very next request misses
 * and re-reads — no revalidateTag call from an app that cannot reach this one, no shared
 * secret, and it covers every write path including CSV import and hand-written SQL. The tags
 * are still there for /api/revalidate, which is the belt to this braces.
 */
function tenantCache(restaurantSlug: string, branchSlug: string) {
  return unstable_cache(
    async (r: string, b: string, _versionKey: string): Promise<ResolvedTenant | null> => {
      const supabase = getAnonServerClient();
      return resolveTenantBySlug(supabase, r, b);
    },
    ['tenant-by-slug', restaurantSlug, branchSlug],
    {
      revalidate: TENANT_TTL_SECONDS,
      tags: ['tenant', tenantCacheTag(restaurantSlug, branchSlug)],
    },
  );
}

async function readStorefrontVersion(
  restaurantSlug: string,
  branchSlug: string,
): Promise<number | null> {
  if (Date.now() < versionRpcUnavailableUntil) return null;
  const supabase = getAnonServerClient();
  // public.storefront_version is newer than the last types.ts regeneration — same thin typed
  // escape the menu page uses for get_happy_hours_for_menu.
  const rpcAny = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  try {
    const { data, error } = await rpcAny('storefront_version', {
      p_restaurant_slug: restaurantSlug,
      p_branch_slug: branchSlug,
    });
    if (error) {
      versionRpcUnavailableUntil = Date.now() + VERSION_RPC_RETRY_MS;
      return null;
    }
    if (data == null) return null;
    const n = Number(data);
    return Number.isFinite(n) ? n : null;
  } catch {
    versionRpcUnavailableUntil = Date.now() + VERSION_RPC_RETRY_MS;
    return null;
  }
}

export interface StorefrontVersion {
  /** False when the database could not answer — callers must degrade, never fail. */
  known: boolean;
  version: number;
  /** Opaque cache-key fragment; also what the client compares to notice a change. */
  key: string;
}

/**
 * One RPC per render — the layout, the metadata, the viewport and the page all share it
 * through React `cache()`. When the database cannot answer, fall back to a short time bucket
 * so the worst case is a slightly tighter version of the old behaviour rather than an entry
 * that is stale forever.
 */
export const resolveStorefrontVersion = cache(
  async (restaurantSlug: string, branchSlug: string): Promise<StorefrontVersion> => {
    const version = await readStorefrontVersion(restaurantSlug, branchSlug);
    if (version === null) {
      return { known: false, version: 0, key: `t${Math.floor(Date.now() / FALLBACK_BUCKET_MS)}` };
    }
    return { known: true, version, key: `v${version}` };
  },
);

/**
 * Resolve `{restaurant_slug, branch_slug}` to ResolvedTenant, or null when nothing live
 * answers to that pair.
 * React `cache()` dedupes within one RSC render; the inner unstable_cache dedupes across
 * requests until the storefront version changes (or the TTL backstop expires).
 *
 * Route handlers use this rather than resolveTenant() below: they answer with a status code
 * of their own choosing, and they must not depend on notFound()'s rendering path.
 */
export const resolveTenantOptional = cache(
  async (restaurantSlug: string, branchSlug: string): Promise<ResolvedTenant | null> => {
    const { key } = await resolveStorefrontVersion(restaurantSlug, branchSlug);
    return tenantCache(restaurantSlug, branchSlug)(restaurantSlug, branchSlug, key);
  },
);

/** The same read, for a page or layout that wants the not-found page when there is no tenant. */
export const resolveTenant = cache(
  async (restaurantSlug: string, branchSlug: string): Promise<ResolvedTenant> => {
    const tenant = await resolveTenantOptional(restaurantSlug, branchSlug);
    if (!tenant) notFound();
    return tenant;
  },
);

/** A Host header with any port stripped and lower-cased — the form every lookup here wants. */
export function hostOf(headerValue: string | null | undefined): string {
  return ((headerValue ?? '').split(':')[0] ?? '').toLowerCase();
}

export interface HostTenant {
  restaurant: string;
  branch: string | null;
}

interface CustomDomainRow {
  restaurant_slug: string;
  branch_slug: string | null;
}

/**
 * Warm-instance cache for the custom-domain lookup, with the two TTLs the middleware already
 * uses. The miss TTL is the load-bearing one: the platform's own hosts never match, so
 * without negative caching every storefront request would re-ask.
 */
const HOST_TENANT_HIT_TTL_MS = 10 * 60 * 1000;
const HOST_TENANT_MISS_TTL_MS = 60_000;
const hostTenantCache = new Map<string, { value: HostTenant | null; expires: number }>();

/**
 * Which tenant, if any, a Host header really belongs to — the same
 * public.resolve_custom_domain() answer the middleware acts on before it rewrites that host's
 * "/" to a branch.
 *
 * Null for the platform's own hosts and for every host the database does not map to a live
 * branch: a Vercel preview URL, a production host nobody remembered to add to
 * NEXT_PUBLIC_APEX_HOSTS, a bare IP. Defaulting that way is the point of the function. The
 * manifest route used to infer the opposite — "absent from the static apex list" meant
 * "merchant's own domain" — and the production storefront host is absent from that list, so
 * every tenant published the platform root as its PWA id, start_url and scope. Three
 * restaurants and the marketing site claimed one installed app between them.
 */
export async function hostTenant(host: string): Promise<HostTenant | null> {
  if (!host) return null;

  const now = Date.now();
  const cached = hostTenantCache.get(host);
  if (cached && cached.expires > now) return cached.value;

  let value: HostTenant | null = null;
  try {
    const supabase = getAnonServerClient();
    const { data, error } = await supabase.rpc('resolve_custom_domain', { p_domain: host });
    if (!error) {
      const first = (data as CustomDomainRow[] | null)?.[0];
      if (first) value = { restaurant: first.restaurant_slug, branch: first.branch_slug };
    }
  } catch {
    // An unreachable database cannot prove this host belongs to anybody, and an unproven host
    // is the platform's. Serving a merchant domain the /r/-prefixed paths for a minute costs
    // a longer URL; publishing the wrong PWA identity is permanent for whoever installs it.
    value = null;
  }

  hostTenantCache.set(host, {
    value,
    expires: now + (value ? HOST_TENANT_HIT_TTL_MS : HOST_TENANT_MISS_TTL_MS),
  });
  return value;
}

/**
 * True when this host's advertised root IS this branch — i.e. the middleware rewrites "/" here
 * to /r/{restaurant}/{branch}. Only then may an installed app scope itself to the origin root.
 */
export async function hostIsOwnDomainFor(
  host: string,
  restaurantSlug: string,
  branchSlug: string,
): Promise<boolean> {
  const mapped = await hostTenant(host);
  return !!mapped && mapped.restaurant === restaurantSlug && mapped.branch === branchSlug;
}

/**
 * What this storefront may show an anonymous visitor: `entitled` (the
 * subscription deadline has not passed), plus the two customer-visible
 * feature flags. Anon-executable RPC, fails closed, `cache()`d for the render.
 *
 * Read this at the *page* level, not in the branch layout: suspension must
 * darken the ordering surfaces while leaving order tracking and receipts for
 * already-placed orders reachable. A layout cannot tell those apart.
 */
export const resolveStorefrontStatus = cache(
  async (branchId: string): Promise<StorefrontStatus> => {
    const supabase = await getServerClient();
    return getStorefrontStatus(supabase, branchId);
  },
);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Tenant theme values are free text typed by a merchant; `theme_color`, `background_color` and
 * `<meta name="theme-color">` all require a real CSS colour, and a browser that cannot parse
 * one falls back to its own default rather than telling anybody.
 */
export function hexOr(value: string | undefined, fallback: string): string {
  return value && HEX_COLOR.test(value) ? value : fallback;
}

/** Platform orange — what a storefront with no colour of its own has always used. */
export const DEFAULT_THEME_COLOR = '#FF6B35';
/** Platform dark ground, for the dark-scheme half of the browser chrome. */
export const DEFAULT_DARK_THEME_COLOR = '#1a0e08';

/**
 * The names a storefront calls itself, derived once so the surfaces that show one cannot
 * disagree.
 *
 * They used to be built inline in four places and produced four different answers for the
 * same restaurant: the manifest said "Coastal Grill — Hamburger", the home-screen label
 * said "Coastal Grill", the browser tab said "Hamburger · Favornoms" — the platform's brand,
 * in a white-labelled tenant's tab — and iOS said "Hamburger". The rules live in
 * deriveStorefrontNames so they can be tested without a database.
 */
export function storefrontNames(tenant: ResolvedTenant): StorefrontNames {
  return deriveStorefrontNames({
    brandName: tenant.theme.brandName,
    restaurantName: tenant.restaurant.name,
    branchName: tenant.branch.name,
  });
}
