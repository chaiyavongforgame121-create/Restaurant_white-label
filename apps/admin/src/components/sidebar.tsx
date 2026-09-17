'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import {
  BarChart3, Building2, ChefHat, ChevronDown, ClipboardList, Cog,
  CreditCard, Gift, Landmark, LayoutDashboard, Menu as MenuIcon, MicVocal, Monitor,
  Network, Package, Palette, QrCode, Receipt, ShieldCheck, Star, Store, Tag, Tv, UserRound,
  Users, Wallet, X,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { isPlatformAdmin } from '@favornoms/database/queries';
import { hasFeature, type Entitlements, type FeatureKey } from '@favornoms/shared';
import { cn, RiderIcon } from '@favornoms/ui';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from './theme-toggle';

interface Props {
  branchId: string;
  branchName: string;
  branches?: { id: string; name: string }[];
  entitlements: Entitlements;
  /** What this user may do here, from public.my_capabilities(). Nav entries are hidden
   *  when the capability is missing: RLS denies the page anyway, and advertising a
   *  screen that answers "access denied" reads as a broken product. */
  capabilities?: string[];
  /** brands.logo_url for this branch's brand — or the restaurant's default brand, or
   *  restaurants.brand_settings.logoUrl. Null keeps the platform mark, which is still the
   *  right answer for a merchant who has not uploaded a logo. */
  logoUrl?: string | null;
  /** What the logo stands for, for alt text. The visible name stays the branch, which is
   *  what a merchant is actually working inside. */
  brandName?: string | null;
}

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  feature?: FeatureKey;
  /** Hidden unless the user holds this capability. Absent = visible to anyone who
   *  already passed the backoffice.access gate in the layout. */
  capability?: string;
  /** Hover text for an entry whose label alone does not say what the screen is for. */
  description?: string;
};
/** `id` is the stable React key; `title` is translated. */
type NavGroup = { id: string; title: string; feature?: FeatureKey; items: NavItem[] };

export function Sidebar({
  branchId,
  branchName,
  branches = [],
  entitlements,
  capabilities = [],
  logoUrl = null,
  brandName = null,
}: Props) {
  const t = useTranslations('shell');
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [platformAdmin, setPlatformAdmin] = React.useState(false);
  const base = `/b/${branchId}`;

  // The platform owner had no way back to /platform from a back office but typing it: the
  // only link was the impersonation banner, which is not shown on a restaurant they are
  // staff of. Asked once per mount; isPlatformAdmin fails closed, so any error hides the
  // entry rather than showing it to a merchant.
  React.useEffect(() => {
    let cancelled = false;
    void isPlatformAdmin(getBrowserClient()).then((yes) => {
      if (!cancelled) setPlatformAdmin(yes);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fails CLOSED, unlike the tier ladder this replaced: hasFeature() requires an
  // explicit `true` on a live subscription, so an unknown plan hides the add-on
  // surfaces instead of advertising them. Only add-on features are gated here —
  // everything in Base stays visible for every paying tenant.
  const allowed = (feature?: FeatureKey) => !feature || hasFeature(entitlements, feature);
  // Capability gating sits alongside the entitlement gate: entitlements answer "did the
  // restaurant pay for this", capabilities answer "may this person use it". Both must pass.
  const capSet = React.useMemo(() => new Set(capabilities), [capabilities]);
  const permitted = (capability?: string) => !capability || capSet.has(capability);

  const core: NavItem[] = [
    { href: `${base}/dashboard`, label: t('nav.dashboard'), icon: LayoutDashboard, capability: 'dashboard.view' },
    { href: `${base}/orders`, label: t('nav.orders'), icon: Receipt, capability: 'orders.view' },
    // "Live deliveries" alone read as a report of past deliveries to more than one
    // merchant; the hover says which of the two screens this is.
    { href: `${base}/deliveries`, label: t('nav.liveDeliveries'), icon: RiderIcon, feature: 'delivery', capability: 'delivery.manage', description: t('nav.liveDeliveriesHint') },
    { href: `${base}/menu`, label: t('nav.menu'), icon: ChefHat, capability: 'menu.manage' },
    { href: `/kitchen/${branchId}`, label: t('nav.kitchenDisplay'), icon: Monitor, capability: 'kitchen.access' },
    { href: `/counter/${branchId}`, label: t('nav.counter'), icon: Store, capability: 'counter.access' },
    { href: `${base}/qr`, label: t('nav.qrCode'), icon: QrCode },
    { href: `${base}/reports`, label: t('nav.reports'), icon: BarChart3, capability: 'reports.view' },
    // Shown for single-branch restaurants too: it is the only screen that puts
    // driver payouts and the subscription next to revenue, which the per-branch
    // Reports page never does.
    { href: `${base}/hq`, label: t('nav.headOffice'), icon: Landmark, capability: 'hq.view' },
    // Kept in core, not under Advanced: merchants were reporting "I can't see my
    // ratings anywhere", and Advanced is collapsed by default.
    { href: `${base}/ratings`, label: t('nav.ratings'), icon: Star },
  ];

  const advanced: NavGroup[] = [
    {
      id: 'operations',
      title: t('sections.operations'),
      items: [
        { href: `${base}/inventory`, label: t('nav.inventory'), icon: Package, capability: 'inventory.manage' },
      ],
    },
    {
      id: 'ai-suite',
      title: t('sections.aiSuite'),
      feature: 'ai_suite',
      items: [
        { href: `${base}/signage`, label: t('nav.digitalSignage'), icon: Tv, feature: 'digital_signage' },
        { href: `${base}/ai-voice`, label: t('nav.aiVoice'), icon: MicVocal, feature: 'ai_voice' },
      ],
    },
    {
      id: 'people',
      title: t('sections.peopleGrowth'),
      items: [
        { href: `${base}/staff`, label: t('nav.staff'), icon: Users, capability: 'staff.manage' },
        { href: `${base}/drivers`, label: t('nav.drivers'), icon: RiderIcon, feature: 'delivery', capability: 'drivers.manage' },
        { href: `${base}/payouts`, label: t('nav.driverPayouts'), icon: Wallet, feature: 'delivery', capability: 'drivers.manage' },
        { href: `${base}/customers`, label: t('nav.customers'), icon: UserRound, capability: 'customers.view' },
        { href: `${base}/promos`, label: t('nav.promos'), icon: Tag, capability: 'promos.manage' },
        // Owner-only for the same reason as Head office: the catalog is
        // restaurant-scoped, so a reward a branch manager creates is redeemable
        // at every other branch. Writes are refused by RLS regardless.
        { href: `${base}/loyalty`, label: t('nav.loyaltyRewards'), icon: Gift, capability: 'loyalty.manage' },
      ],
    },
    {
      id: 'records',
      title: t('sections.records'),
      items: [
        { href: `${base}/receipts`, label: t('nav.receipts'), icon: Receipt, capability: 'orders.view' },
        { href: `${base}/activity`, label: t('nav.activityLog'), icon: ClipboardList, capability: 'reports.view' },
      ],
    },
    {
      id: 'setup',
      title: t('sections.setup'),
      items: [
        { href: `${base}/branch`, label: t('nav.branchSettings'), icon: Building2, capability: 'branch.settings' },
        { href: `${base}/brands`, label: t('nav.brandAndBranches'), icon: Palette, capability: 'brand.edit' },
        { href: `${base}/franchise`, label: t('nav.franchise'), icon: Network, capability: 'hq.view' },
        { href: `${base}/settings/plan`, label: t('nav.planBilling'), icon: CreditCard, capability: 'billing.manage' },
        { href: `${base}/settings`, label: t('nav.preferences'), icon: Cog, capability: 'branch.settings' },
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
          title={item.description}
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

  // Lifted out of the header because the logo and no-logo arms both render it: the
  // switcher when there is more than one branch, the plain name otherwise.
  const nameBlock = (
    <>
      {branches.length > 1 ? (
        <select
          value={branchId}
          onChange={(e) => router.push(`/b/${e.target.value}/dashboard`)}
          className="focus-ring -ml-1 max-w-[150px] truncate rounded-md bg-transparent py-0.5 font-display text-base font-semibold"
          aria-label={t('sidebar.switchBranch')}
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
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('sidebar.merchant')}</p>
    </>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="focus-ring fixed left-3 top-3 z-30 grid h-11 w-11 place-items-center rounded-full bg-card shadow-warm lg:hidden"
        aria-label={t('sidebar.openMenu')}
      >
        <MenuIcon className="h-5 w-5" />
      </button>

      {/* Backdrop */}
      {mobileOpen && (
        <button
          aria-label={t('sidebar.closeMenu')}
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
        <div className="flex items-start justify-between gap-2 px-5 py-4">
          {/* The merchant's own logo, in the chrome they spend the day inside. It is
              uploaded two screens away (Branch settings -> Branding, which writes the very
              brands.logo_url the storefront header reads) and this was the one place it
              never appeared. A logo is a wide lockup, so it takes its own row above the
              branch line rather than being crushed into the 36px mark slot — and the
              branch switcher stays, because a multi-branch merchant needs to see, and
              change, which location they are editing. With no logo the row is unchanged.

              The link goes to the dashboard rather than /b/{branchId}, which has no page
              and answered every click on this mark with a 404. */}
          {logoUrl ? (
            <div className="min-w-0 flex-1">
              <Link
                href={`${base}/dashboard`}
                onClick={() => setMobileOpen(false)}
                className="focus-ring block w-fit max-w-full rounded-xl"
              >
                {/* A plain <img>, not next/image: brands.logo_url is free-form text, and
                    next/image throws at render on a host outside images.remotePatterns —
                    one legacy row would take down every back-office page instead of
                    showing a broken image. Same call ImageUpload makes. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoUrl}
                  alt={brandName ?? branchName}
                  className="h-9 w-[168px] max-w-full object-contain object-left"
                />
              </Link>
              <div className="mt-2 min-w-0 leading-tight">{nameBlock}</div>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Link
                href={`${base}/dashboard`}
                onClick={() => setMobileOpen(false)}
                className="focus-ring shrink-0"
                aria-label={t('sidebar.branchDashboard', { branch: branchName })}
              >
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-warm text-white shadow-warm">
                  <ChefHat className="h-5 w-5" />
                </span>
              </Link>
              <div className="min-w-0 leading-tight">{nameBlock}</div>
            </div>
          )}
          <button
            onClick={() => setMobileOpen(false)}
            className="focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted lg:hidden"
            aria-label={t('sidebar.closeMenu')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-2 overflow-y-auto px-3 pb-6">
          <ul className="space-y-0.5">
            {core.filter((i) => allowed(i.feature) && permitted(i.capability)).map(renderItem)}
          </ul>

          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="focus-ring mt-2 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-muted"
            aria-expanded={advancedOpen}
          >
            {t('sections.advanced')}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')} />
          </button>

          {advancedOpen &&
            advanced
              .filter((section) => allowed(section.feature))
              .map((section) => {
                const items = section.items.filter(
                  (i) => allowed(i.feature) && permitted(i.capability),
                );
                if (items.length === 0) return null;
                return (
                  <div key={section.id} className="pt-1">
                    <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                      {section.title}
                    </p>
                    <ul className="space-y-0.5">{items.map(renderItem)}</ul>
                  </div>
                );
              })}
        </nav>
        <div className="space-y-2 border-t border-border/60 px-3 py-3">
          {platformAdmin && (
            <ul>{renderItem({ href: '/platform', label: t('nav.platformConsole'), icon: ShieldCheck })}</ul>
          )}
          <LocaleSwitcher className="w-full" />
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
