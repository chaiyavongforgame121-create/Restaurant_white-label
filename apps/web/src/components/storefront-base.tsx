'use client';

import * as React from 'react';

export interface StorefrontAddress {
  /**
   * Where this storefront's pages live for the browser: `/r/<web-address>` when the branch has
   * one, else `/r/<restaurant>/<branch>`. Every customer link starts here.
   */
  base: string;
  /** The long form's slugs: what the app's routes and public.storefront_version read. Never a link. */
  restaurantSlug: string;
  branchSlug: string;
}

const StorefrontAddressContext = React.createContext<StorefrontAddress | null>(null);

/**
 * Hands the storefront's public base down from the branch layout (storefrontBase(tenant)).
 *
 * Client components used to build links from useParams(), which is the route — the long form —
 * even while the browser is on the short address the middleware rewrote, so every link they built
 * left the short address for one that 308s back to it. They read it here instead
 * (docs/SHORT-STOREFRONT-URLS-2026-10-26.md §3).
 */
export function StorefrontAddressProvider({
  base,
  restaurantSlug,
  branchSlug,
  children,
}: StorefrontAddress & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ base, restaurantSlug, branchSlug }),
    [base, restaurantSlug, branchSlug],
  );
  return <StorefrontAddressContext.Provider value={value}>{children}</StorefrontAddressContext.Provider>;
}

/** The storefront's public base, or '' outside a storefront (no branch layout above). */
export function useStorefrontBase(): string {
  return React.useContext(StorefrontAddressContext)?.base ?? '';
}

/** The whole address, or null outside a storefront. */
export function useStorefrontAddress(): StorefrontAddress | null {
  return React.useContext(StorefrontAddressContext);
}
