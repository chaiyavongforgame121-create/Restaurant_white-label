'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChefHat,
  Clock,
  MapPin,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Star,
  Store,
  Utensils,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  formatCurrency,
  intlLocaleFor,
  isUiLocale,
  DEFAULT_UI_LOCALE,
  type Branch,
  type MenuCardStyle,
  type MenuCategory,
  type MenuItem,
  type MenuLayout,
  type UiLocale,
} from '@favornoms/shared';
import {
  Badge,
  Button,
  Card,
  cn,
  DietaryBadge,
  EmptyState,
  RiderIcon,
  Segmented,
} from '@favornoms/ui';
import { useRealtime } from '@favornoms/database/realtime';
import { useCart, type OrderChannel } from '@/store/cart';
import { useRequireAuth } from '@/components/auth/require-auth';
import { cssUrl } from '@/lib/css-url';
import { ComboArt, ComboSheet, type ComboRow as ComboRowType } from './combo-sheet';
import { MenuItemSheet } from './menu-item-sheet';
import { OrderTypeGate } from './order-type-gate';
import { BranchTimeZoneContext, useSoldOutText } from './sold-out';
import { earliestSoldOutUntil } from './sold-out-time';
import { useTableLabel, useTablePin } from './table-pin';

/** Never re-run the server tree more often than this, whatever the kitchen is doing. */
const LIVE_MIN_GAP_MS = 5_000;
/** A view that comes back after this long re-reads; flicking to another app and back does not. */
const LIVE_WAKE_MIN_AGE_MS = 60_000;

/**
 * Keeps an already-open menu honest.
 *
 * Every navigation already renders fresh data — prices, sold-out flags, happy hours and the
 * "Currently closed" banner are all read per request. What nothing covered is the app that is
 * simply LEFT OPEN: an installed storefront stays alive on a phone for hours, so a diner who
 * opened the menu at lunch and came back at dinner was ordering from lunch's menu, at lunch's
 * prices, from a kitchen that had 86'd half of it. There was no subscription and no refresh on
 * wake; the only cure was tapping a tab.
 *
 * `router.refresh()` re-runs the server tree and keeps client state — the search box, the
 * selected category, the cart, the order-type gate all survive it, which is why this is a
 * refresh and not a reload.
 */
function useLiveStorefront(branchId: string, restaurantSlug: string, branchSlug: string) {
  const router = useRouter();
  const lastRefresh = React.useRef(Date.now());
  const timer = React.useRef<number | null>(null);
  // storefront_versions only exists once its migration is applied. Subscribing to a table the
  // database does not have puts the channel in a CHANNEL_ERROR/backoff loop, so ask first;
  // menu_items alone still carries price and availability either way.
  const [versionsLive, setVersionsLive] = React.useState(false);

  const refresh = React.useCallback(() => {
    if (timer.current !== null) return;
    const wait = Math.max(0, LIVE_MIN_GAP_MS - (Date.now() - lastRefresh.current));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      lastRefresh.current = Date.now();
      router.refresh();
    }, wait);
  }, [router]);

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { getBrowserClient } = await import('@favornoms/database/client');
      const supabase = getBrowserClient();
      // Newer than the last types.ts regeneration — same thin typed escape the menu page uses.
      const rpcAny = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>;
      try {
        const { data, error } = await rpcAny('storefront_version', {
          p_restaurant_slug: restaurantSlug,
          p_branch_slug: branchSlug,
        });
        if (!cancelled && !error && data != null) setVersionsLive(true);
      } catch {
        /* leave it off; menu_items still covers the menu itself */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restaurantSlug, branchSlug]);

  // Desktop alt-tab never fires visibilitychange, and useRealtime only listens for that and
  // for `online`.
  React.useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastRefresh.current > LIVE_WAKE_MIN_AGE_MS) refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useRealtime({
    channel: `storefront:${branchId}`,
    tables: [
      ...(versionsLive
        ? [
            {
              table: 'storefront_versions',
              event: 'UPDATE' as const,
              filter: `branch_id=eq.${branchId}`,
            },
          ]
        : []),
      // Belt and braces: the counter covers hours, categories, branding and combos too, but
      // menu_items is the row that matters most and it is already published.
      { table: 'menu_items', filter: `branch_id=eq.${branchId}` },
    ],
    onChange: refresh,
    // useRealtime calls this on first connect, on reconnect, when the tab becomes visible and
    // when the network returns. Only the long sleeps are worth a full re-render.
    refetch: () => {
      if (Date.now() - lastRefresh.current > LIVE_WAKE_MIN_AGE_MS) refresh();
    },
  });

  return refresh;
}

/** Past the lift time before re-reading, so the server's clock has passed it too. */
const SOLD_OUT_LIFT_SLACK_MS = 2_000;
/** A lift the server did not see yet (its clock behind this one) is re-read this often... */
const SOLD_OUT_RETRY_MS = 15_000;
/** ...this many times, then left to the live refreshes. */
const SOLD_OUT_MAX_RETRIES = 4;
/** setTimeout's ceiling (about 24.8 days); an 86 further out is picked up by a later refresh. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A hand-set 86 (menu_items.sold_out_until) lifts on its own: nothing is written when it does, so
 * no realtime event says so, and an open menu kept the dish sold out until the diner reloaded.
 * This re-reads the menu when the earliest one lifts; the refreshed items carry the next one.
 */
function useRefreshWhenSoldOutLifts(items: MenuItem[], refresh: () => void) {
  const retries = React.useRef(0);
  React.useEffect(() => {
    const next = earliestSoldOutUntil(items);
    if (next === null) {
      retries.current = 0;
      return undefined;
    }
    const overdue = next <= Date.now();
    if (overdue && retries.current >= SOLD_OUT_MAX_RETRIES) return undefined;
    const delay = overdue ? SOLD_OUT_RETRY_MS : next - Date.now() + SOLD_OUT_LIFT_SLACK_MS;
    if (delay > MAX_TIMEOUT_MS) return undefined;
    const id = window.setTimeout(() => {
      retries.current = overdue ? retries.current + 1 : 0;
      refresh();
    }, delay);
    return () => window.clearTimeout(id);
  }, [items, refresh]);
}

/**
 * branches.timezone for the "Sold out until" times. Read only when a dish is 86'd until a time
 * and the page did not pass the zone, and only after mount, so the server's HTML and the first
 * client render agree (both say plain "Sold out").
 */
function useBranchTimeZone(branchId: string, items: MenuItem[], fromPage?: string): string | undefined {
  const [mounted, setMounted] = React.useState(false);
  const [fetched, setFetched] = React.useState<string | undefined>(undefined);
  const needed = !fromPage && items.some((i) => !!i.soldOutUntil);

  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    if (!needed || fetched) return undefined;
    let cancelled = false;
    void (async () => {
      const { getBrowserClient } = await import('@favornoms/database/client');
      const { data } = await getBrowserClient()
        .from('branches')
        .select('timezone')
        .eq('id', branchId)
        .maybeSingle();
      const tz = (data as { timezone?: string | null } | null)?.timezone;
      if (!cancelled && tz) setFetched(tz);
    })();
    return () => {
      cancelled = true;
    };
  }, [needed, fetched, branchId]);

  return mounted ? (fromPage ?? fetched) : undefined;
}

/** The interface language as the shared helpers type it; anything unexpected reads as English. */
function useUiLocaleValue(): UiLocale {
  const locale = useLocale();
  return isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE;
}

interface BranchReviews {
  summary: { rating: number | null; count: number };
  recent: Array<{ food_stars: number; delivery_stars: number | null; comment: string; created_at: string }>;
}

// Shape lives with the sheet that renders it in full — one definition, not two.
type ComboRow = ComboRowType;

interface HappyHourSection {
  id: string;
  name: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  daysOfWeek: number[];
  startTime: string; // 'HH:MM:SS'
  endTime: string;
  isLive: boolean;
  appliesToAll: boolean;
  items: MenuItem[];
}

interface MenuViewProps {
  branch: Branch;
  categories: MenuCategory[];
  items: MenuItem[];
  isOpen?: boolean;
  reviews?: BranchReviews | null;
  combos?: ComboRow[];
  happyHours?: HappyHourSection[];
  menuLayout?: MenuLayout;
  menuCardStyle?: MenuCardStyle;
  heroUrl?: string | null;
  heroTitle?: string;
  heroSubtitle?: string;
  /** Schedule Delivery can be booked here (resolveScheduleDelivery). Defaults false so a missing prop
   *  cannot sell delivery. */
  canDeliver?: boolean;
  /** A `?t=` token resolved to a table here, so the order type is already settled. */
  seatingFromScan?: boolean;
  /** branches.timezone (storefront_status.timezone), for "Sold out until" times. When absent it
   *  is read in the browser, and only if a dish is 86'd until a time. Not branch.settings.timezone:
   *  that is a settings key nothing writes, so it is always the America/New_York default. */
  timeZone?: string;
}

export function MenuView({ branch, categories, items, isOpen = true, reviews, combos = [], happyHours = [], menuLayout = 'grid4', menuCardStyle = 'standard', heroUrl, heroTitle, heroSubtitle, canDeliver = false, seatingFromScan = false, timeZone }: MenuViewProps) {
  const t = useTranslations();
  const params = useParams<{ restaurant: string; branch: string }>();
  const [search, setSearch] = React.useState('');
  const [chosenCategory, setActiveCategory] = React.useState<string>('all');
  // The live storefront refresh keeps the chosen tab, but the merchant can delete that category
  // meanwhile. Filtering on an id no dish has any more would show an empty "no results" menu with
  // no tab selected, so fall back to All.
  const activeCategory =
    chosenCategory === 'all' || categories.some((c) => c.id === chosenCategory) ? chosenCategory : 'all';
  const [activeItem, setActiveItem] = React.useState<MenuItem | null>(null);
  const [activeCombo, setActiveCombo] = React.useState<ComboRow | null>(null);
  const [dietaryFilters, setDietaryFilters] = React.useState<Set<string>>(new Set());
  const [usuals, setUsuals] = React.useState<MenuItem[]>([]);

  const refreshMenu = useLiveStorefront(branch.id, params.restaurant, params.branch);
  useRefreshWhenSoldOutLifts(items, refreshMenu);
  const branchTimeZone = useBranchTimeZone(branch.id, items, timeZone);

  // A refresh replaces `items`; an open item sheet was still rendering the object captured
  // when it opened, so the one screen a diner is actually reading was the last to hear that
  // the price changed or that it had just sold out.
  React.useEffect(() => {
    setActiveItem((current) =>
      current ? (items.find((i) => i.id === current.id) ?? current) : current,
    );
  }, [items]);

  // The same for an open combo sheet, which otherwise kept offering Add after the deal sold out.
  // A deal that left the list meanwhile (archived, emptied, switched off) stays open as sold out.
  // Returning `current` unchanged once it reads sold out keeps a fresh `combos = []` default from
  // re-rendering forever.
  React.useEffect(() => {
    setActiveCombo((current) => {
      if (!current) return current;
      const fresh = combos.find((c) => c.id === current.id);
      if (fresh) return fresh;
      return current.is_available ? { ...current, is_available: false } : current;
    });
  }, [combos]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const { getBrowserClient } = await import('@favornoms/database/client');
      const supabase = getBrowserClient();
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data: top } = await supabase.rpc('get_my_top_items', {
        p_branch_id: branch.id,
        p_limit: 6,
      });
      if (cancelled || !top) return;
      const ids = (top as Array<{ menu_item_id: string }>).map((r) => r.menu_item_id);
      const top3 = items.filter((it) => ids.includes(it.id)).slice(0, 6);
      setUsuals(top3);
    })();
    return () => { cancelled = true; };
  }, [branch.id, items]);
  const channel = useCart((s) => s.channel);
  const setChannel = useCart((s) => s.setChannel);
  // Reconciling a stale persisted channel is OrderTypeGate's job — it is the
  // only place that can wait for rehydration before deciding.

  // Scanned their table: the order type is settled and the branch is not theirs to
  // change. Offering the switcher anyway would let them send a dine-in ticket for the
  // table they are sitting at away with a driver.
  const { table: pinnedTable } = useTablePin();
  const tableLabel = useTableLabel();

  // One auth gate for the whole menu: instantiated once here and threaded down to
  // the quick-add buttons and the combo row. Calling the hook per MenuCard would
  // fire useAuth's getUser() once per item — dozens of requests on a big menu.
  const { requireAuthThen } = useRequireAuth();

  const toggleDietary = (tag: string) => {
    setDietaryFilters((curr) => {
      const next = new Set(curr);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (activeCategory !== 'all' && item.categoryId !== activeCategory) return false;
      if (dietaryFilters.size > 0) {
        const tags = new Set(item.dietaryTags ?? []);
        for (const required of dietaryFilters) {
          if (!tags.has(required as never)) return false;
        }
      }
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        (item.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [items, search, activeCategory, dietaryFilters]);

  // Only show filter chips for tags that exist on at least one item.
  const availableDietary = React.useMemo(() => {
    const all = new Set<string>();
    for (const it of items) {
      for (const t of it.dietaryTags ?? []) all.add(t);
    }
    return Array.from(all);
  }, [items]);

  const recommended = React.useMemo(() => items.filter((i) => i.isRecommended), [items]);
  const counts = React.useMemo(() => {
    const out: Record<string, number> = { all: items.length };
    for (const c of categories) {
      out[c.id] = items.filter((i) => i.categoryId === c.id).length;
    }
    return out;
  }, [items, categories]);

  // Hero copy is merchant-configurable (restaurant default + per-branch override,
  // via storefront settings). Empty falls back to sensible built-ins.
  const effectiveHeroTitle = heroTitle?.trim() ? heroTitle : t('storefront.hero.defaultTitle');
  const effectiveHeroSubtitle = heroSubtitle?.trim()
    ? heroSubtitle
    : t('storefront.hero.defaultSubtitle', { branch: branch.name });

  return (
    <BranchTimeZoneContext.Provider value={branchTimeZone}>
      <div>
        <OrderTypeGate
          branchId={branch.id}
          branchName={branch.name}
          canDeliver={canDeliver}
          seatingFromScan={seatingFromScan}
        />

        <Hero
          title={effectiveHeroTitle}
          subtitle={effectiveHeroSubtitle}
          address={branch.address}
          heroUrl={heroUrl}
        />

        <ChannelPicker
          channel={channel}
          setChannel={setChannel}
          canDeliver={canDeliver}
          lockedTableLabel={pinnedTable ? tableLabel(pinnedTable) : null}
        />

        {!isOpen && (
          <div className="container mt-4">
            <div className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
              <strong>{t('storefront.closed.title')}</strong>{' '}
              {/* Pickup is always prepared now, so it waits for opening hours — but a delivery is
                  booked for a later time, which a closed restaurant can still take. canDeliver is
                  only true with a bookable slot and orders not paused, so this never promises a
                  booking every slot would refuse. */}
              {canDeliver
                ? t('storefront.closed.canSchedule')
                : t('storefront.closed.notTaking')}
            </div>
          </div>
        )}

        {reviews && reviews.summary.count > 0 && (
          <ReviewsStrip reviews={reviews} />
        )}

        {combos.length > 0 && (
          <CombosRow combos={combos} onOpenCombo={setActiveCombo} />
        )}

        {happyHours.length > 0 && (
          <HappyHourSections happyHours={happyHours} onOpen={setActiveItem} />
        )}

        <section className="container mt-6 space-y-6 lg:mt-8">
          <MenuSearch search={search} setSearch={setSearch} />

          {!search && usuals.length > 0 && (
            <YourUsualsRow items={usuals} onOpen={setActiveItem} />
          )}

          {!search && recommended.length > 0 && (
            <RecommendedRow items={recommended} onOpen={setActiveItem} />
          )}

          {/* Browse region — filters, category chips and the grid live in ONE
              wrapper so the sticky chip bar stays pinned for the whole scroll of
              the grid instead of unpinning at the next sibling. Deliberately a
              plain toolbar, not a tinted band: it must not read as another
              "special" section like the chef's picks above it. */}
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="h-6 w-1 shrink-0 rounded-full bg-gradient-warm" />
              <h2 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
                {t('menu.title')}
              </h2>
            </div>

            {availableDietary.length > 0 && (
              <DietaryFilters
                available={availableDietary}
                selected={dietaryFilters}
                onToggle={toggleDietary}
                onClear={() => setDietaryFilters(new Set())}
              />
            )}

            {/* Full-bleed: the negative margins cancel the container padding so the
                bar's own background hides the cards scrolling under it. `top-14`
                is the AppShell header's `h-14`; z-20 keeps it under that header
                (z-40) and under the floating cart bar (z-30). */}
            <div className="sticky top-14 z-20 -mx-4 border-b border-border/60 bg-background/95 pb-1.5 pt-2.5 backdrop-blur-xl sm:-mx-6 lg:-mx-8">
              <CategoryTabs
                categories={categories}
                active={activeCategory}
                onChange={setActiveCategory}
                counts={counts}
              />
            </div>

            <MenuGrid items={filtered} onOpen={setActiveItem} layout={menuLayout} cardStyle={menuCardStyle} />

            {filtered.length === 0 && (
              <EmptyState
                icon={<Utensils className="h-7 w-7" />}
                title={t('menu.noResults')}
                description={t('menu.search')}
              />
            )}
          </div>
        </section>

        <FloatingCartBar />

        <MenuItemSheet
          item={activeItem}
          items={items}
          onOpenItem={setActiveItem}
          onClose={() => setActiveItem(null)}
        />
        <ComboSheet
          combo={activeCombo}
          branchId={branch.id}
          onClose={() => setActiveCombo(null)}
          requireAuthThen={requireAuthThen}
        />
      </div>
    </BranchTimeZoneContext.Provider>
  );
}

/* -------------------- Hero -------------------- */

function Hero({
  title,
  subtitle,
  address,
  heroUrl,
}: {
  title: string;
  subtitle: string;
  address: string;
  heroUrl?: string | null;
}) {
  const t = useTranslations('storefront');
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-gradient-sunset opacity-90" />
      <div className="absolute inset-0 -z-10 bg-noise opacity-50" />
      <div className="container relative pt-6 pb-8 lg:pt-12 lg:pb-16">
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div>
            {/* No logo here. The sticky header above carries it on every page, so repeating it
                a few pixels lower printed the same image twice in one screenful. The header is
                the one that has to be right; this was the duplicate. */}
            <h1 className="font-display text-4xl font-bold leading-[1.05] tracking-tight md:text-5xl lg:text-6xl">
              <span className="text-gradient">{title}</span>
            </h1>
            <p className="mt-3 max-w-prose text-base text-muted-foreground md:text-lg">
              {subtitle}
            </p>
            {address ? (
              <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" className="gap-1.5 px-3 py-1">
                  <MapPin className="h-3.5 w-3.5" /> {address}
                </Badge>
              </div>
            ) : null}
          </div>
          <div
            className="relative mx-auto aspect-square w-full max-w-md overflow-hidden rounded-3xl shadow-warm"
          >
            <Image
              src={heroUrl || 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?auto=format&fit=crop&w=900&h=900&q=80'}
              alt={title}
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 50vw"
              className="object-cover"
            />
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/30 bg-white/85 px-4 py-3 backdrop-blur-md">
              <p className="text-xs font-medium text-muted-foreground">{t('hero.nowServing')}</p>
              <p className="font-display text-lg font-semibold">{title}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------- Order type -------------------- */

/**
 * Pickup / Schedule Delivery, straight under the hero.
 *
 * It used to share a toolbar with the search box, below the rating strip, the combos and the
 * happy-hour sections — far enough down that a diner scrolling for food could pick a dish
 * without ever seeing how the order would reach them. How it arrives is the first decision of
 * an order, and the cart prices delivery from it, so it comes first on the page.
 */
function ChannelPicker({
  channel,
  setChannel,
  canDeliver,
  lockedTableLabel = null,
}: {
  channel: OrderChannel | null;
  setChannel: (c: OrderChannel) => void;
  canDeliver: boolean;
  /** Set when the diner scanned a table code — the order type is no longer a choice. */
  lockedTableLabel?: string | null;
}) {
  const t = useTranslations();
  // Delivery is dropped from the options entirely rather than shown disabled —
  // a restaurant without the add-on does not offer delivery at all, so a greyed
  // "Delivery" tab would only advertise something the customer cannot have.
  // Dine-in is not a tab at all: tapping it was a claim to be sitting at a table
  // that nothing had proved, and the round then had no session to land on. It is
  // the table QR that decides it, and the locked chip below is what it looks like.
  // Pickup first, then Schedule Delivery — the order checkout offers them in.
  const options = [
    { value: 'pickup' as const, label: t('channel.pickup'), icon: <ShoppingBag className="h-4 w-4" /> },
    ...(canDeliver
      ? [{ value: 'delivery' as const, label: t('channel.delivery'), icon: <RiderIcon className="h-4 w-4" /> }]
      : []),
  ];
  return (
    <section className="container mt-4">
      {lockedTableLabel ? (
        <span className="inline-flex items-center gap-2 self-start rounded-full bg-primary/10 px-4 py-2.5 text-sm font-semibold text-primary">
          <Store className="h-4 w-4" aria-hidden />
          {t('channel.dineInAt', { table: lockedTableLabel })}
        </span>
      ) : (
        /* `channel` is null only while OrderTypeGate is covering the page; the
           empty value matches no option, so nothing shows as selected. */
        <Segmented<string>
          value={channel ?? ''}
          onChange={(c) => setChannel(c as OrderChannel)}
          options={options}
        />
      )}
    </section>
  );
}

/* -------------------- Search -------------------- */

function MenuSearch({ search, setSearch }: { search: string; setSearch: (s: string) => void }) {
  const t = useTranslations();
  return (
      <div className="relative w-full lg:max-w-md">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('menu.search')}
          aria-label={t('menu.search')}
          className="focus-ring h-12 w-full rounded-full border border-border bg-card pl-11 pr-10 text-base placeholder:text-muted-foreground"
        />
        {search && (
          <button
            aria-label={t('menu.clearSearch')}
            onClick={() => setSearch('')}
            className="focus-ring absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
  );
}

/* -------------------- Recommended row -------------------- */

function RecommendedRow({ items, onOpen }: { items: MenuItem[]; onOpen: (i: MenuItem) => void }) {
  const t = useTranslations('menu');
  const soldOutText = useSoldOutText();
  return (
    // Curated band — same idiom as HappyHourCard (rounded-3xl, hairline border,
    // 5–10% tint) so the page keeps one visual family, but tinted `accent`
    // instead of `primary` so "chef's picks" reads apart from the promos above
    // and from the untinted browse region below.
    <section className="relative rounded-3xl border border-accent/30 bg-accent/10 p-4 shadow-soft sm:p-5">
      <span aria-hidden className="absolute inset-x-6 top-0 h-1 rounded-b-full bg-gradient-warm" />
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-accent text-accent-foreground shadow-soft">
          <ChefHat className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
            {t('recommended')}
          </h2>
          <p className="text-xs text-muted-foreground sm:text-sm">{t('popular')}</p>
        </div>
      </div>
      <div className="-mx-1 mt-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2 scrollbar-hide">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onOpen(item)}
            className="focus-ring relative w-[260px] flex-shrink-0 snap-start overflow-hidden rounded-3xl bg-card text-left shadow-warm transition-shadow hover:-translate-y-1 hover:shadow-glow"
          >
            <div className="relative aspect-[5/4] overflow-hidden">
              {item.imageUrl ? (
                <Image
                  src={item.imageUrl}
                  alt={item.name}
                  fill
                  sizes="260px"
                  className="object-cover transition-transform duration-500 hover:scale-105"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-sunset" aria-hidden />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              {item.outOfStock && (
                <span className="absolute inset-0 z-10 grid place-items-center bg-background/60">
                  <Badge variant="muted" className="text-sm">{soldOutText.label(item)}</Badge>
                </span>
              )}
              <div className="absolute left-3 top-3 flex gap-1.5">
                {item.dietaryTags?.slice(0, 2).map((tag) => (
                  <DietaryBadge key={tag} tag={tag} />
                ))}
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between text-white">
                <h3 className="font-display text-lg font-semibold leading-tight">{item.name}</h3>
                <div className="flex flex-col items-end gap-0.5">
                  {item.listPrice && item.listPrice > item.price ? (
                    <span className="text-[10px] text-white/80 line-through">
                      {formatCurrency(item.listPrice)}
                    </span>
                  ) : null}
                  <Badge variant="solid" className="shrink-0">
                    {formatCurrency(item.price)}
                  </Badge>
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

/* -------------------- Category tabs -------------------- */

function CategoryTabs({
  categories,
  active,
  onChange,
  counts,
}: {
  categories: MenuCategory[];
  active: string;
  onChange: (id: string) => void;
  counts: Record<string, number>;
}) {
  const t = useTranslations('menu');
  const items = [
    { id: 'all', name: t('categories'), iconEmoji: '🍽️' } as const,
    ...categories.map((c) => ({
      id: c.id,
      // Exactly as the merchant typed it, whatever language the interface is in. The seeded
      // name_translations would otherwise replace their category names for Thai viewers.
      name: c.name,
      iconEmoji: c.iconEmoji ?? '🍴',
    })),
  ];

  return (
    // Rendered inside the full-bleed sticky bar, which already carries the
    // negative margins — the padding here re-aligns the chips with the grid
    // while letting the scroll region run to the screen edge.
    <nav
      aria-label={t('categories')}
      className="flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-hide sm:px-6 lg:px-8"
    >
      {items.map((cat) => {
        const isActive = active === cat.id;
        return (
          <motion.button
            key={cat.id}
            onClick={() => onChange(cat.id)}
            whileTap={{ scale: 0.95 }}
            className={`focus-ring relative flex shrink-0 items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm font-semibold transition-colors ${
              isActive
                ? 'border-transparent bg-primary text-primary-foreground shadow-warm'
                : 'border-border bg-card text-foreground hover:border-primary/30'
            }`}
          >
            <span className="text-base leading-none" aria-hidden>
              {cat.iconEmoji}
            </span>
            {cat.name}
            <span
              className={`rounded-full px-1.5 text-[10px] font-bold ${
                isActive ? 'bg-white/25 text-white' : 'bg-muted text-muted-foreground'
              }`}
            >
              {counts[cat.id] ?? 0}
            </span>
          </motion.button>
        );
      })}
    </nav>
  );
}

/* -------------------- Menu grid -------------------- */

// Fixed column count per layout — the merchant's pick is honored at every screen
// width (WYSIWYG), not just on desktop. Literal class strings so Tailwind's JIT
// keeps them. 'list' = single full-width column.
const MENU_GRID_CLASS: Record<MenuLayout, string> = {
  list: 'grid-cols-1',
  grid2: 'grid-cols-2',
  grid3: 'grid-cols-3',
  grid4: 'grid-cols-4',
};

function MenuGrid({
  items,
  onOpen,
  layout,
  cardStyle,
}: {
  items: MenuItem[];
  onOpen: (i: MenuItem) => void;
  layout: MenuLayout;
  cardStyle: MenuCardStyle;
}) {
  return (
    <div className={`grid gap-4 ${MENU_GRID_CLASS[layout]}`}>
      {items.map((item, idx) => (
        <MenuCard
          key={item.id}
          item={item}
          index={idx}
          onOpen={() => onOpen(item)}
          compact={cardStyle === 'compact'}
        />
      ))}
    </div>
  );
}

// No login gate here any more: the card only OPENS the detail sheet, which is a read.
// The gate now sits on the sheet's Add button, where the actual mutation happens.
function MenuCard({
  item,
  onOpen,
  compact = false,
}: {
  item: MenuItem;
  index: number;
  onOpen: () => void;
  compact?: boolean;
}) {
  const t = useTranslations('menu');
  const lines = useCart((s) => s.lines);
  const inCartQty = lines.find((l) => l.menuItemId === item.id)?.quantity ?? 0;
  const soldOut = !!item.outOfStock;
  // The picture carries "Sold out until 5:00 PM"; the button keeps the short word, it is narrow.
  const soldOutText = useSoldOutText();

  if (compact) {
    return (
      <article className="group">
        <Card className="flex items-stretch gap-3 overflow-hidden border-border/40 p-2 transition-shadow hover:shadow-warm">
          <button
            onClick={onOpen}
            className="focus-ring relative h-24 w-24 shrink-0 overflow-hidden rounded-xl text-left"
            aria-label={t('openItem', { name: item.name })}
          >
            {item.imageUrl ? (
              <Image src={item.imageUrl} alt={item.name} fill sizes="96px" className={cn('object-cover', soldOut && 'opacity-40')} />
            ) : (
              <div className={cn('absolute inset-0 bg-gradient-sunset', soldOut && 'opacity-40')} aria-hidden />
            )}
            {soldOut && (
              <span className="absolute inset-0 grid place-items-center px-1">
                <span className="rounded-full bg-background/85 px-2 py-0.5 text-center text-[10px] font-semibold leading-tight text-muted-foreground">
                  {soldOutText.label(item)}
                </span>
              </span>
            )}
          </button>
          <div className="flex min-w-0 flex-1 flex-col py-1">
            <button onClick={onOpen} className="focus-ring text-left">
              <h3 className="line-clamp-1 font-display text-base font-semibold leading-tight">{item.name}</h3>
              {item.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
              )}
            </button>
            <div className="mt-auto flex items-center justify-between pt-1">
              <div className="flex items-baseline gap-1.5">
                {item.listPrice && item.listPrice > item.price ? (
                  <span className="text-xs text-muted-foreground line-through">{formatCurrency(item.listPrice)}</span>
                ) : null}
                <span className="font-display text-lg font-semibold text-primary">{formatCurrency(item.price)}</span>
              </div>
              {/* Opens the item sheet rather than adding straight to the cart —
                  otherwise required modifiers/options are silently skipped. */}
              <Button
                size="sm"
                variant={soldOut ? 'ghost' : inCartQty > 0 ? 'soft' : 'gradient'}
                onClick={() => { if (!soldOut) onOpen(); }}
                disabled={soldOut}
                aria-label={soldOut ? soldOutText.ariaLabel(item) : t('chooseOptions', { name: item.name })}
              >
                {soldOut ? t('soldOut') : inCartQty > 0 ? t('inCartCount', { count: inCartQty }) : t('quickAdd')}
              </Button>
            </div>
          </div>
        </Card>
      </article>
    );
  }

  return (
    <article className="group transition-transform hover:-translate-y-1">
      <Card className="flex h-full flex-col overflow-hidden border-border/40 transition-shadow hover:shadow-warm">
        <button
          onClick={onOpen}
          className="focus-ring relative aspect-[4/3] w-full overflow-hidden text-left"
          aria-label={t('openItem', { name: item.name })}
        >
          {item.imageUrl ? (
            <Image
              src={item.imageUrl}
              alt={item.name}
              fill
              sizes="(max-width:640px) 100vw, (max-width:1024px) 50vw, 25vw"
              className="object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-sunset" aria-hidden />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
          {item.isNew && (
            <Badge variant="solid" className="absolute left-3 top-3 bg-accent text-accent-foreground">
              {t('badgeNew')}
            </Badge>
          )}
          {item.isRecommended && !item.isNew && (
            <Badge variant="solid" className="absolute left-3 top-3">
              <Star className="h-3 w-3 fill-current" /> {t('badgeChef')}
            </Badge>
          )}
          {soldOut && (
            <span className="absolute inset-0 grid place-items-center bg-background/60">
              <Badge variant="muted" className="text-sm">{soldOutText.label(item)}</Badge>
            </span>
          )}
        </button>
        <div className="flex flex-1 flex-col gap-2 p-4">
          <button onClick={onOpen} className="focus-ring text-left">
            <h3 className="font-display text-lg font-semibold leading-tight">{item.name}</h3>
            {item.description && (
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
            )}
          </button>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {item.dietaryTags?.map((tag) => (
              <DietaryBadge key={tag} tag={tag} />
            ))}
          </div>
          <div className="mt-auto flex items-center justify-between pt-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {item.rating != null && (
                <>
                  <Star className="h-3.5 w-3.5 fill-accent text-accent" />
                  <span className="font-semibold text-foreground">{item.rating.toFixed(1)}</span>
                  <span>·</span>
                </>
              )}
              <Clock className="h-3.5 w-3.5" />
              {t('minutes', { n: item.prepTimeMinutes ?? 12 })}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <div className="flex flex-col leading-tight gap-0">
              {item.listPrice && item.listPrice > item.price ? (
                <span className="text-xs text-muted-foreground line-through">
                  {formatCurrency(item.listPrice)}
                </span>
              ) : null}
              <span className="font-display text-xl font-semibold text-primary">
                {formatCurrency(item.price)}
              </span>
              {item.saleLabel ? (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
                  {item.saleLabel}
                </span>
              ) : null}
            </div>
            {/* Opens the item sheet rather than adding straight to the cart —
                otherwise required modifiers/options are silently skipped. */}
            <Button
              size="sm"
              variant={soldOut ? 'ghost' : inCartQty > 0 ? 'soft' : 'gradient'}
              onClick={() => { if (!soldOut) onOpen(); }}
              disabled={soldOut}
              aria-label={soldOut ? soldOutText.ariaLabel(item) : t('chooseOptions', { name: item.name })}
            >
              {soldOut ? t('soldOut') : inCartQty > 0 ? t('inCartCount', { count: inCartQty }) : t('quickAdd')}
            </Button>
          </div>
        </div>
      </Card>
    </article>
  );
}

/* -------------------- Floating cart bar -------------------- */

function FloatingCartBar() {
  const params = useParams<{ restaurant: string; branch: string }>();
  const cartHref = `/r/${params.restaurant}/${params.branch}/cart`;
  const lines = useCart((s) => s.lines);
  const subtotal = useCart((s) => s.subtotal());
  const itemCount = useCart((s) => s.itemCount());
  const t = useTranslations('cart');

  return (
    <AnimatePresence>
      {lines.length > 0 && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="pointer-events-none fixed inset-x-0 bottom-16 z-30 px-3 pb-2 lg:bottom-4"
        >
          <div className="container">
            <Link href={cartHref} className="pointer-events-auto block">
              <Button
                variant="gradient"
                size="xl"
                fullWidth
                rightIcon={
                  <span className="inline-flex items-center gap-2 rounded-full bg-white/25 px-3 py-1 font-bold">
                    {formatCurrency(subtotal)}
                  </span>
                }
                leftIcon={<ShoppingBag className="h-5 w-5" />}
              >
                {t('itemCount', { count: itemCount })} · {t('checkout')}
              </Button>
            </Link>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ReviewsStrip({ reviews }: { reviews: { summary: { rating: number | null; count: number }; recent: Array<{ food_stars: number; comment: string }> } }) {
  const t = useTranslations('storefront');
  return (
    <section className="container mt-5">
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-amber-500/15 text-amber-500">
              <Star className="h-6 w-6 fill-current" />
            </span>
            <div>
              <p className="font-display text-xl font-bold leading-none">
                {reviews.summary.rating != null ? Number(reviews.summary.rating).toFixed(1) : '—'}
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">/ 5</span>
              </p>
              <p className="text-xs text-muted-foreground">{t('reviews.count', { count: reviews.summary.count })}</p>
            </div>
          </div>
          {reviews.recent.length > 0 && (
            <div className="hidden max-w-md text-right text-xs italic text-muted-foreground sm:block">
              &ldquo;{reviews.recent[0]!.comment.slice(0, 90)}{reviews.recent[0]!.comment.length > 90 ? '…' : ''}&rdquo;
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CombosRow({
  combos,
  onOpenCombo,
}: {
  combos: ComboRow[];
  /** Opens the combo detail sheet. Adding happens there, behind the usual login gate. */
  onOpenCombo: (combo: ComboRow) => void;
}) {
  const t = useTranslations('storefront');
  const tMenu = useTranslations('menu');
  // The merchant's order, with deals that cannot be made right now still shown, greyed.
  const availableCount = combos.filter((c) => c.is_available).length;
  return (
    <section className="container mt-6">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold">{t('combos.title')}</h2>
        <span className="text-xs text-muted-foreground">{t('combos.available', { count: availableCount })}</span>
      </div>
      <div className="-mx-2 mt-3 flex snap-x snap-mandatory overflow-x-auto px-2 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {combos.map((c) => {
          const list = (c.items ?? []).reduce(
            (s, it) => s + Number(it.list_price ?? 0) * (it.quantity ?? 1),
            0,
          );
          const savings = list - Number(c.total_price);
          const soldOut = !c.is_available;
          return (
            <article
              key={c.id}
              className="mr-3 inline-block w-72 shrink-0 snap-start overflow-hidden rounded-2xl border border-border bg-card shadow-soft"
            >
              <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
                <ComboArt combo={c} className={cn(soldOut && 'opacity-40 grayscale')} />
                {soldOut && (
                  <span className="absolute inset-0 grid place-items-center">
                    <span className="rounded-full bg-background/85 px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                      {tMenu('soldOut')}
                    </span>
                  </span>
                )}
              </div>
              <div className={cn('p-3', soldOut && 'opacity-70')}>
                <h3 className="font-display text-base font-bold leading-tight">{c.name}</h3>
                {c.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
                )}
                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {(c.items ?? []).slice(0, 4).map((it, i) => (
                    // The dish that is holding the deal up, struck through.
                    <li key={i} className={cn(it.is_available === false && 'line-through')}>
                      · {it.quantity > 1 ? `${it.quantity}×` : ''}{it.item_name}
                    </li>
                  ))}
                  {(c.items ?? []).length > 4 && (
                    <li>{t('combos.more', { count: (c.items ?? []).length - 4 })}</li>
                  )}
                </ul>
                <div className="mt-3 flex items-center justify-between">
                  <div>
                    <p className="font-display text-lg font-bold text-primary">
                      {formatCurrency(Number(c.total_price))}
                    </p>
                    {savings > 0 && (
                      <p className="text-[10px] font-semibold text-success">
                        {t('combos.save', { amount: formatCurrency(savings) })}
                      </p>
                    )}
                  </div>
                  {/* Opens the detail sheet rather than adding straight to the cart — a
                      combo bundles several dishes and a saving, which the diner should be
                      able to read before committing. The Add button lives in the sheet.
                      A sold-out deal is not offered, like a sold-out dish. */}
                  <Button
                    size="sm"
                    variant={soldOut ? 'ghost' : 'gradient'}
                    onClick={() => { if (!soldOut) onOpenCombo(c); }}
                    disabled={soldOut}
                    aria-label={soldOut ? tMenu('itemSoldOut', { name: c.name }) : undefined}
                  >
                    {soldOut ? tMenu('soldOut') : t('combos.viewDeal')}
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------- Happy hour sections -------------------- */

/** A Sunday, so day 0..6 of the happy-hour row lands on the matching weekday name. */
const DOW_REFERENCE_SUNDAY_MS = Date.UTC(2026, 0, 4);
const DAY_MS = 24 * 60 * 60 * 1000;

function weekdayLabel(day: number, locale: UiLocale): string {
  return new Intl.DateTimeFormat(intlLocaleFor(locale), { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(DOW_REFERENCE_SUNDAY_MS + day * DAY_MS),
  );
}

/**
 * 'HH:MM:SS' as each language writes a shop's clock — the same conventions the shared
 * describeRanges uses: English and Latin American Spanish read 12-hour, Vietnamese and Thai
 * 24-hour (Thai adds น.).
 */
function formatTime(value: string, locale: UiLocale): string {
  const [hStr, mStr] = value.split(':');
  let h = Number(hStr);
  const m = mStr ?? '00';
  if (locale === 'vi' || locale === 'th') {
    const clock = `${String(h).padStart(2, '0')}:${m}`;
    return locale === 'th' ? `${clock} น.` : clock;
  }
  const [am, pm] = locale === 'es' ? ['a. m.', 'p. m.'] : ['AM', 'PM'];
  const ampm = h >= 12 ? pm : am;
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function HappyHourSections({
  happyHours,
  onOpen,
}: {
  happyHours: HappyHourSection[];
  onOpen: (i: MenuItem) => void;
}) {
  return (
    <section className="container mt-6 space-y-4">
      {happyHours.map((hh) => (
        <HappyHourCard key={hh.id} hh={hh} onOpen={onOpen} />
      ))}
    </section>
  );
}

function HappyHourCard({ hh, onOpen }: { hh: HappyHourSection; onOpen: (i: MenuItem) => void }) {
  const t = useTranslations('storefront');
  const locale = useUiLocaleValue();
  const discountText =
    hh.discountType === 'percent'
      ? t('happyHour.percentOff', { value: String(hh.discountValue) })
      : t('happyHour.amountOff', { amount: formatCurrency(hh.discountValue) });
  const dayPart =
    hh.daysOfWeek.length >= 7
      ? t('happyHour.daily')
      : hh.daysOfWeek
          .slice()
          .sort((a, b) => a - b)
          .map((d) => weekdayLabel(d, locale))
          .join(', ');
  const windowText = t('happyHour.window', {
    days: dayPart,
    start: formatTime(hh.startTime, locale),
    end: formatTime(hh.endTime, locale),
  });

  return (
    <div className="rounded-3xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xl" aria-hidden>
          🎉
        </span>
        <h2 className="font-display text-xl font-bold leading-tight">{hh.name}</h2>
        <Badge variant="solid">{discountText}</Badge>
        {hh.isLive ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success px-2.5 py-0.5 text-xs font-bold text-white">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-pulse-ring rounded-full bg-white" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
            </span>
            {t('happyHour.liveNow')}
          </span>
        ) : (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
            {windowText}
          </span>
        )}
      </div>
      {hh.isLive && <p className="mt-1 text-xs text-muted-foreground">{windowText}</p>}

      {hh.appliesToAll ? (
        <p className="mt-3 text-sm font-medium">
          {hh.isLive
            ? t('happyHour.everythingLive', { discount: discountText })
            : t('happyHour.everythingWindow', { discount: discountText })}
        </p>
      ) : (
        <div className="-mx-1 mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {hh.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item)}
              className="focus-ring inline-block w-40 shrink-0 snap-start overflow-hidden rounded-2xl border border-border bg-card text-left shadow-soft transition-shadow hover:shadow-warm"
            >
              <div
                className={`aspect-square w-full bg-cover bg-center ${item.imageUrl ? '' : 'bg-gradient-sunset'}`}
                style={item.imageUrl ? { backgroundImage: cssUrl(item.imageUrl) } : undefined}
                role="img"
                aria-label={item.name}
              />
              <div className="p-2.5">
                <p className="line-clamp-1 text-sm font-semibold leading-tight">{item.name}</p>
                <div className="mt-1 flex items-baseline gap-1.5">
                  {item.listPrice && item.listPrice > item.price ? (
                    <span className="text-[11px] text-muted-foreground line-through">
                      {formatCurrency(item.listPrice)}
                    </span>
                  ) : null}
                  <span className="font-display text-sm font-bold text-primary">
                    {formatCurrency(item.price)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Keyed by the stored dietary tag; the label is looked up under menu.dietary.<key>. */
const DIETARY_LABELS: Record<string, { key: string; emoji: string }> = {
  vegan: { key: 'vegan', emoji: '🌱' },
  'gluten-free': { key: 'glutenFree', emoji: '🌾' },
  halal: { key: 'halal', emoji: '🕌' },
  spicy: { key: 'spicy', emoji: '🌶️' },
  'chef-pick': { key: 'chefPick', emoji: '⭐' },
  new: { key: 'new', emoji: '✨' },
};

function DietaryFilters({
  available,
  selected,
  onToggle,
  onClear,
}: {
  available: string[];
  selected: Set<string>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const t = useTranslations('menu');
  return (
    <div className="-mx-1 flex flex-wrap items-center gap-2 px-1">
      {/* Labelled, and active reads as an outlined tint — the category chips
          directly below are solid `bg-primary`, so the two adjacent chip rows
          must not share an active colour. */}
      <span className="inline-flex shrink-0 items-center gap-1.5 pr-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
        {t('filters')}
      </span>
      {available.map((tag) => {
        const known = DIETARY_LABELS[tag];
        const meta = known
          ? { label: t(`dietary.${known.key}`), emoji: known.emoji }
          : { label: tag, emoji: '' };
        const isOn = selected.has(tag);
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            aria-pressed={isOn}
            className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
              isOn
                ? 'border-primary bg-primary/15 text-foreground shadow-soft'
                : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
            }`}
          >
            <span aria-hidden>{meta.emoji}</span>
            {meta.label}
          </button>
        );
      })}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="focus-ring inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <X className="h-3 w-3" /> {t('clearFilters')}
        </button>
      )}
    </div>
  );
}

function YourUsualsRow({ items, onOpen }: { items: MenuItem[]; onOpen: (item: MenuItem) => void }) {
  const t = useTranslations();
  const soldOutText = useSoldOutText();
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold">{t('storefront.usuals.title')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('storefront.usuals.subtitle', { count: items.length })}
        </span>
      </div>
      <div className="-mx-2 mt-3 flex snap-x snap-mandatory overflow-x-auto px-2 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item)}
            className="focus-ring mr-3 inline-block w-44 shrink-0 snap-start overflow-hidden rounded-2xl border border-border bg-card text-left shadow-soft transition-shadow hover:shadow-warm"
          >
            <div
              className={`relative aspect-square w-full bg-cover bg-center ${item.imageUrl ? '' : 'bg-gradient-sunset'}`}
              style={item.imageUrl ? { backgroundImage: cssUrl(item.imageUrl) } : undefined}
              role="img"
              aria-label={item.name}
            >
              {item.outOfStock && (
                <span className="absolute inset-0 grid place-items-center bg-background/60 px-1">
                  <Badge variant="muted" className="text-center text-xs">{soldOutText.label(item)}</Badge>
                </span>
              )}
            </div>
            <div className="p-2.5">
              <p className="line-clamp-2 text-sm font-semibold leading-tight">{item.name}</p>
              <p className="mt-1 font-display text-sm font-bold text-primary">
                {formatCurrency(item.price)}
              </p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
