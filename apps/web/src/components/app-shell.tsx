'use client';

import * as React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { Home, Receipt, ShoppingBag, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@favornoms/ui';
import { useCart } from '@/store/cart';
import { ThemeToggle } from './theme-toggle';

export function AppShell({
  base,
  brandName = 'Favornoms',
  logoUrl = null,
  children,
}: {
  base: string;
  brandName?: string;
  /** brands.logo_url. Absent for a merchant who has not uploaded one, which is why the
   *  initial-in-a-circle fallback stays. */
  logoUrl?: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  // Start false so SSR never touches `useCart.persist` (undefined on the server);
  // flip true once the client mounts / persist finishes rehydrating.
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    const persist = useCart.persist;
    if (!persist || persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = persist.onFinishHydration(() => setHydrated(true));
    void persist.rehydrate();
    return unsub;
  }, []);
  const count = useCart((s) => (hydrated ? s.itemCount() : 0));

  const tabs = [
    {
      href: `${base}`,
      label: t('menu'),
      icon: Home,
      match: (p: string) => p === base || p === `${base}/`,
    },
    {
      href: `${base}/cart`,
      label: t('cart'),
      icon: ShoppingBag,
      badge: count,
      match: (p: string) => p.startsWith(`${base}/cart`) || p.startsWith(`${base}/checkout`),
    },
    {
      href: `${base}/orders`,
      label: t('orders'),
      icon: Receipt,
      match: (p: string) => p.startsWith(`${base}/orders`),
    },
    {
      href: `${base}/account`,
      label: t('account'),
      icon: UserRound,
      match: (p: string) => p.startsWith(`${base}/account`),
    },
  ];

  return (
    <div className="relative flex min-h-dynamic-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-border/40 bg-background/85 backdrop-blur-xl">
        <div className="container flex h-14 items-center justify-between gap-3">
          {/* The header is the most-seen piece of branding in the whole storefront — it is
              on every page — and it used to render brandName.charAt(0) unconditionally. A
              merchant could upload a logo on the Brands page, watch it appear in the hero
              and on the browser tab, and still see a generic letter here. It now uses the
              logo when there is one.

              A logo is a wide lockup (the hero renders it at h-12 w-44), so it replaces the
              mark AND the wordmark rather than sitting beside a duplicate of the name; the
              name stays for screen readers. Without a logo, nothing changes. */}
          <Link href={base} className="focus-ring inline-flex items-center gap-2 rounded-full">
            {logoUrl ? (
              <>
                <span className="relative block h-8 w-[150px]">
                  <Image
                    src={logoUrl}
                    alt={brandName}
                    fill
                    className="object-contain object-left"
                    sizes="150px"
                    priority
                  />
                </span>
                <span className="sr-only">{brandName}</span>
              </>
            ) : (
              <>
                <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-warm text-white shadow-warm">
                  <span className="font-display text-lg leading-none">{brandName.charAt(0)}</span>
                </span>
                <span className="font-display text-lg font-semibold tracking-tight">{brandName}</span>
              </>
            )}
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 pb-24 lg:pb-8">{children}</main>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/40 bg-background/95 pb-safe backdrop-blur-xl lg:hidden"
      >
        <ul className="container grid h-16 grid-cols-4">
          {tabs.map((tab) => {
            const active = tab.match ? tab.match(pathname) : pathname === tab.href;
            const Icon = tab.icon;
            return (
              <li key={tab.href} className="flex">
                <Link
                  href={tab.href}
                  className={cn(
                    'focus-ring relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active-pill"
                      className="absolute inset-x-6 -top-px h-1 rounded-full bg-primary"
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                  )}
                  <span className="relative">
                    <Icon className="h-6 w-6" aria-hidden />
                    {tab.badge ? (
                      <span className="absolute -right-2 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground shadow-soft">
                        {tab.badge}
                      </span>
                    ) : null}
                  </span>
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
