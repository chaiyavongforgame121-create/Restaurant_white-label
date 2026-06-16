'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  BarChart3, Bike, Building2, CalendarClock, ChefHat, ChevronDown, ClipboardList, Cog,
  LayoutDashboard, Megaphone, Menu as MenuIcon, Monitor, Network, Package, Palette,
  QrCode, Receipt, Store, Tag, Timer, UserRound, Users, X,
} from 'lucide-react';
import { cn } from '@favornoms/ui';
import { ThemeToggle } from './theme-toggle';

type Tier = 'starter' | 'pro' | 'enterprise';
const TIER_RANK: Record<Tier, number> = { starter: 0, pro: 1, enterprise: 2 };

interface Props {
  branchId: string;
  branchName: string;
  branches?: { id: string; name: string }[];
  tier?: string;
}

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; minTier?: Tier };
type NavGroup = { title: string; minTier?: Tier; items: NavItem[] };

export function Sidebar({ branchId, branchName, branches = [], tier }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const base = `/b/${branchId}`;

  // Unknown/missing tier fails OPEN (shows everything) so paid features are never hidden by mistake.
  const currentRank = tier && tier in TIER_RANK ? TIER_RANK[tier as Tier] : Number.MAX_SAFE_INTEGER;
  const allowed = (minTier?: Tier) => currentRank >= (minTier ? TIER_RANK[minTier] : 0);

  const core: NavItem[] = [
    { href: `${base}/dashboard`, label: 'Dashboard', icon: LayoutDashboard },
    { href: `${base}/orders`, label: 'Orders', icon: Receipt },
    { href: `${base}/deliveries`, label: 'Live deliveries', icon: Bike },
    { href: `${base}/menu`, label: 'Menu', icon: ChefHat },
    { href: `/kitchen/${branchId}`, label: 'Kitchen display', icon: Monitor },
    { href: `/counter/${branchId}`, label: 'Counter', icon: Store },
    { href: `${base}/qr`, label: 'QR code', icon: QrCode },
    { href: `${base}/reports`, label: 'Reports', icon: BarChart3 },
  ];

  const advanced: NavGroup[] = [
    {
      title: 'Dine-in',
      minTier: 'pro',
      items: [
        { href: `${base}/reservations`, label: 'Reservations', icon: CalendarClock },
        { href: `${base}/waitlist`, label: 'Waitlist', icon: Users },
        { href: `${base}/floor-plan`, label: 'Floor plan', icon: LayoutDashboard },
      ],
    },
    {
      title: 'Operations',
      minTier: 'pro',
      items: [
        { href: `${base}/inventory`, label: 'Inventory', icon: Package },
        { href: `${base}/shifts`, label: 'Shifts', icon: Timer },
      ],
    },
    {
      title: 'People & growth',
      items: [
        { href: `${base}/staff`, label: 'Staff', icon: Users },
        { href: `${base}/drivers`, label: 'Drivers', icon: Bike },
        { href: `${base}/customers`, label: 'Customers', icon: UserRound },
        { href: `${base}/marketing`, label: 'Marketing', icon: Megaphone, minTier: 'pro' },
        { href: `${base}/promos`, label: 'Promos', icon: Tag, minTier: 'pro' },
      ],
    },
    {
      title: 'Records',
      items: [
        { href: `${base}/receipts`, label: 'Receipts', icon: Receipt },
        { href: `${base}/activity`, label: 'Activity log', icon: ClipboardList },
      ],
    },
    {
      title: 'Setup',
      items: [
        { href: `${base}/branch`, label: 'Branch settings', icon: Building2 },
        { href: `${base}/brands`, label: 'Brands', icon: Palette, minTier: 'enterprise' },
        { href: `${base}/franchise`, label: 'Franchise', icon: Network, minTier: 'enterprise' },
        { href: `${base}/settings`, label: 'Preferences', icon: Cog },
      ],
    },
  ];

  const renderItem = (item: NavItem) => {
    const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
    const Icon = item.icon;
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          onClick={() => setMobileOpen(false)}
          className={cn(
            'focus-ring relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
            active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
          )}
        >
          {active && (
            <motion.span
              layoutId="admin-active"
              className="absolute inset-y-1 left-0 w-1 rounded-r-full bg-primary"
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            />
          )}
          <Icon className="h-4 w-4" />
          {item.label}
        </Link>
      </li>
    );
  };

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="focus-ring fixed left-3 top-3 z-30 grid h-11 w-11 place-items-center rounded-full bg-card shadow-warm lg:hidden"
        aria-label="Open menu"
      >
        <MenuIcon className="h-5 w-5" />
      </button>

      {/* Backdrop */}
      {mobileOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border/60 bg-card pb-safe transition-transform lg:translate-x-0 lg:sticky lg:top-0 lg:h-dynamic-screen',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={base} onClick={() => setMobileOpen(false)} className="focus-ring shrink-0">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-warm text-white shadow-warm">
                <ChefHat className="h-5 w-5" />
              </span>
            </Link>
            <div className="min-w-0 leading-tight">
              {branches.length > 1 ? (
                <select
                  value={branchId}
                  onChange={(e) => router.push(`/b/${e.target.value}/dashboard`)}
                  className="focus-ring -ml-1 max-w-[150px] truncate rounded-md bg-transparent py-0.5 font-display text-base font-semibold"
                  aria-label="Switch branch"
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="truncate font-display text-base font-semibold">{branchName}</p>
              )}
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Merchant</p>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-2 overflow-y-auto px-3 pb-6">
          <ul className="space-y-0.5">{core.map(renderItem)}</ul>

          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="focus-ring mt-2 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-muted"
            aria-expanded={advancedOpen}
          >
            Advanced
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')} />
          </button>

          {advancedOpen &&
            advanced
              .filter((section) => allowed(section.minTier))
              .map((section) => {
                const items = section.items.filter((i) => allowed(i.minTier));
                if (items.length === 0) return null;
                return (
                  <div key={section.title} className="pt-1">
                    <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                      {section.title}
                    </p>
                    <ul className="space-y-0.5">{items.map(renderItem)}</ul>
                  </div>
                );
              })}
        </nav>
        <div className="border-t border-border/60 px-3 py-3">
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
