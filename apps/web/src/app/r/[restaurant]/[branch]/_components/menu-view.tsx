'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Bike, Clock, MapPin, Search, ShoppingBag, Star, Store, Utensils, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  formatCurrency,
  pickLocalized,
  type Branch,
  type MenuCardStyle,
  type MenuCategory,
  type MenuItem,
  type MenuLayout,
} from '@favornoms/shared';
import {
  Badge,
  Button,
  Card,
  cn,
  DietaryBadge,
  EmptyState,
  IconButton,
  Segmented,
} from '@favornoms/ui';
import { useCart } from '@/store/cart';
import type { Locale } from '@/i18n/config';
import { MenuItemSheet } from './menu-item-sheet';

interface BranchReviews {
  summary: { rating: number | null; count: number };
  recent: Array<{ food_stars: number; delivery_stars: number | null; comment: string; created_at: string }>;
}

interface ComboRow {
  id: string;
  name: string;
  description: string | null;
  total_price: number | string;
  image_url: string | null;
  items: Array<{ menu_item_id: string; item_name: string; quantity: number; list_price: number }>;
}

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
  logoUrl?: string | null;
  heroUrl?: string | null;
  heroTitle?: string;
  heroSubtitle?: string;
}

export function MenuView({ branch, categories, items, isOpen = true, reviews, combos = [], happyHours = [], menuLayout = 'grid4', menuCardStyle = 'standard', logoUrl, heroUrl, heroTitle, heroSubtitle }: MenuViewProps) {
  const t = useTranslations();
  const [search, setSearch] = React.useState('');
  const [activeCategory, setActiveCategory] = React.useState<string>('all');
  const [activeItem, setActiveItem] = React.useState<MenuItem | null>(null);
  const [dietaryFilters, setDietaryFilters] = React.useState<Set<string>>(new Set());
  const [usuals, setUsuals] = React.useState<MenuItem[]>([]);

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
  const effectiveHeroTitle = heroTitle?.trim() ? heroTitle : 'Welcome — order something delicious';
  const effectiveHeroSubtitle = heroSubtitle?.trim()
    ? heroSubtitle
    : `Now serving from ${branch.name}`;

  return (
    <div>
      <Hero
        title={effectiveHeroTitle}
        subtitle={effectiveHeroSubtitle}
        address={branch.address}
        logoUrl={logoUrl}
        heroUrl={heroUrl}
      />

      {!isOpen && (
        <div className="container mt-4">
          <div className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
            <strong>Currently closed.</strong> We&apos;re not taking new orders right now. Please check back during business hours.
          </div>
        </div>
      )}

      {reviews && reviews.summary.count > 0 && (
        <ReviewsStrip reviews={reviews} />
      )}

      {combos.length > 0 && (
        <CombosRow combos={combos} branchId={branch.id} />
      )}

      {happyHours.length > 0 && (
        <HappyHourSections happyHours={happyHours} onOpen={setActiveItem} />
      )}

      <section className="container mt-6 space-y-6 lg:mt-8">
        <ChannelAndSearch
          channel={channel}
          setChannel={setChannel}
          search={search}
          setSearch={setSearch}
        />

        {!search && usuals.length > 0 && (
          <YourUsualsRow items={usuals} onOpen={setActiveItem} />
        )}

        {!search && recommended.length > 0 && (
          <RecommendedRow items={recommended} onOpen={setActiveItem} />
        )}

        {availableDietary.length > 0 && (
          <DietaryFilters
            available={availableDietary}
            selected={dietaryFilters}
            onToggle={toggleDietary}
            onClear={() => setDietaryFilters(new Set())}
          />
        )}

        <CategoryTabs
          categories={categories}
          active={activeCategory}
          onChange={setActiveCategory}
          counts={counts}
        />

        <MenuGrid items={filtered} onOpen={setActiveItem} layout={menuLayout} cardStyle={menuCardStyle} />

        {filtered.length === 0 && (
          <EmptyState
            icon={<Utensils className="h-7 w-7" />}
            title={t('menu.noResults')}
            description={t('menu.search')}
          />
        )}
      </section>

      <FloatingCartBar />

      <MenuItemSheet item={activeItem} onClose={() => setActiveItem(null)} />
    </div>
  );
}

/* -------------------- Hero -------------------- */

function Hero({
  title,
  subtitle,
  address,
  logoUrl,
  heroUrl,
}: {
  title: string;
  subtitle: string;
  address: string;
  logoUrl?: string | null;
  heroUrl?: string | null;
}) {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-gradient-sunset opacity-90" />
      <div className="absolute inset-0 -z-10 bg-noise opacity-50" />
      <div className="container relative pt-6 pb-8 lg:pt-12 lg:pb-16">
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div>
            {logoUrl ? (
              <div className="relative mb-4 h-12 w-44">
                <Image src={logoUrl} alt={title} fill className="object-contain object-left" sizes="176px" />
              </div>
            ) : null}
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
            className="relative mx-auto hidden aspect-square w-full max-w-md overflow-hidden rounded-3xl shadow-warm lg:block"
          >
            <Image
              src={heroUrl || 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?auto=format&fit=crop&w=900&h=900&q=80'}
              alt={title}
              fill
              priority
              sizes="(max-width: 1024px) 0, 50vw"
              className="object-cover"
            />
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/30 bg-white/85 px-4 py-3 backdrop-blur-md">
              <p className="text-xs font-medium text-muted-foreground">Now serving</p>
              <p className="font-display text-lg font-semibold">{title}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------- Channel + Search -------------------- */

function ChannelAndSearch({
  channel,
  setChannel,
  search,
  setSearch,
}: {
  channel: 'delivery' | 'pickup' | 'dine_in';
  setChannel: (c: 'delivery' | 'pickup' | 'dine_in') => void;
  search: string;
  setSearch: (s: string) => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <Segmented
        value={channel}
        onChange={setChannel}
        options={[
          { value: 'delivery', label: t('channel.delivery'), icon: <Bike className="h-4 w-4" /> },
          { value: 'pickup', label: t('channel.pickup'), icon: <ShoppingBag className="h-4 w-4" /> },
          { value: 'dine_in', label: t('channel.dineIn'), icon: <Store className="h-4 w-4" /> },
        ]}
      />
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
            aria-label="Clear search"
            onClick={() => setSearch('')}
            className="focus-ring absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/* -------------------- Recommended row -------------------- */

function RecommendedRow({ items, onOpen }: { items: MenuItem[]; onOpen: (i: MenuItem) => void }) {
  const t = useTranslations('menu');
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-semibold tracking-tight">{t('recommended')}</h2>
        <span className="text-sm text-muted-foreground">{t('popular')}</span>
      </div>
      <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 scrollbar-hide lg:mx-0 lg:px-0">
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
                  <Badge variant="muted" className="text-sm">Sold out</Badge>
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
  const locale = useLocale() as Locale;
  const t = useTranslations('menu');
  const items = [
    { id: 'all', name: t('categories'), iconEmoji: '🍽️' } as const,
    ...categories.map((c) => ({
      id: c.id,
      name: pickLocalized(c.name, c.nameTranslations, locale),
      iconEmoji: c.iconEmoji ?? '🍴',
    })),
  ];

  return (
    <nav
      aria-label="Categories"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-hide lg:mx-0 lg:px-0"
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
  const add = useCart((s) => s.add);
  const lines = useCart((s) => s.lines);
  const inCartQty = lines.find((l) => l.menuItemId === item.id)?.quantity ?? 0;
  const soldOut = !!item.outOfStock;

  if (compact) {
    return (
      <article className="group">
        <Card className="flex items-stretch gap-3 overflow-hidden border-border/40 p-2 transition-shadow hover:shadow-warm">
          <button
            onClick={onOpen}
            className="focus-ring relative h-24 w-24 shrink-0 overflow-hidden rounded-xl text-left"
            aria-label={`Open ${item.name}`}
          >
            {item.imageUrl ? (
              <Image src={item.imageUrl} alt={item.name} fill sizes="96px" className={cn('object-cover', soldOut && 'opacity-40')} />
            ) : (
              <div className={cn('absolute inset-0 bg-gradient-sunset', soldOut && 'opacity-40')} aria-hidden />
            )}
            {soldOut && (
              <span className="absolute inset-0 grid place-items-center">
                <span className="rounded-full bg-background/85 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  Sold out
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
              <Button
                size="sm"
                variant={soldOut ? 'ghost' : inCartQty > 0 ? 'soft' : 'gradient'}
                onClick={() => { if (!soldOut) add(item); }}
                disabled={soldOut}
                aria-label={soldOut ? `${item.name} sold out` : `Add ${item.name}`}
              >
                {soldOut ? 'Sold out' : inCartQty > 0 ? `${inCartQty} ${t('inCart')}` : `+ ${t('addToCart')}`}
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
          aria-label={`Open ${item.name}`}
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
              New
            </Badge>
          )}
          {item.isRecommended && !item.isNew && (
            <Badge variant="solid" className="absolute left-3 top-3">
              <Star className="h-3 w-3 fill-current" /> Chef
            </Badge>
          )}
          {soldOut && (
            <span className="absolute inset-0 grid place-items-center bg-background/60">
              <Badge variant="muted" className="text-sm">Sold out</Badge>
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
              <Star className="h-3.5 w-3.5 fill-accent text-accent" />
              <span className="font-semibold text-foreground">{item.rating?.toFixed(1)}</span>
              <span>·</span>
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
            <Button
              size="sm"
              variant={soldOut ? 'ghost' : inCartQty > 0 ? 'soft' : 'gradient'}
              onClick={() => { if (!soldOut) add(item); }}
              disabled={soldOut}
              aria-label={soldOut ? `${item.name} sold out` : `Add ${item.name}`}
            >
              {soldOut ? 'Sold out' : inCartQty > 0 ? `${inCartQty} ${t('inCart')}` : `+ ${t('addToCart')}`}
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
              <p className="text-xs text-muted-foreground">{reviews.summary.count.toLocaleString()} customer reviews</p>
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

function CombosRow({ combos, branchId }: { combos: ComboRow[]; branchId: string }) {
  const addCombo = useCart((s) => s.addCombo);

  return (
    <section className="container mt-6">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold">🔥 Combos & deals</h2>
        <span className="text-xs text-muted-foreground">{combos.length} available</span>
      </div>
      <div className="-mx-2 mt-3 flex snap-x snap-mandatory overflow-x-auto px-2 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {combos.map((c) => {
          const list = (c.items ?? []).reduce(
            (s, it) => s + Number(it.list_price ?? 0) * (it.quantity ?? 1),
            0,
          );
          const savings = list - Number(c.total_price);
          return (
            <article
              key={c.id}
              className="mr-3 inline-block w-72 shrink-0 snap-start overflow-hidden rounded-2xl border border-border bg-card shadow-soft"
            >
              {c.image_url ? (
                <div
                  className="aspect-[16/10] w-full bg-muted bg-cover bg-center"
                  style={{ backgroundImage: `url(${c.image_url})` }}
                  role="img"
                  aria-label={c.name}
                />
              ) : (
                <div className="grid aspect-[16/10] w-full place-items-center bg-gradient-warm text-3xl text-white">🍔</div>
              )}
              <div className="p-3">
                <h3 className="font-display text-base font-bold leading-tight">{c.name}</h3>
                {c.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
                )}
                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {(c.items ?? []).slice(0, 4).map((it, i) => (
                    <li key={i}>· {it.quantity > 1 ? `${it.quantity}×` : ''}{it.item_name}</li>
                  ))}
                  {(c.items ?? []).length > 4 && <li>… + {(c.items ?? []).length - 4} more</li>}
                </ul>
                <div className="mt-3 flex items-center justify-between">
                  <div>
                    <p className="font-display text-lg font-bold text-primary">
                      {formatCurrency(Number(c.total_price))}
                    </p>
                    {savings > 0 && (
                      <p className="text-[10px] font-semibold text-success">Save {formatCurrency(savings)}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="gradient"
                    onClick={() =>
                      addCombo({
                        comboId: c.id,
                        name: c.name,
                        imageUrl: c.image_url,
                        totalPrice: Number(c.total_price),
                        branchId,
                        contents: (c.items ?? []).map((it) => ({
                          item_name: it.item_name,
                          quantity: it.quantity,
                        })),
                      })
                    }
                  >
                    Add to cart
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

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTime(t: string): string {
  const [hStr, mStr] = t.split(':');
  let h = Number(hStr);
  const m = mStr ?? '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function formatWindow(days: number[], start: string, end: string): string {
  const dayPart =
    days.length >= 7
      ? 'Daily'
      : days
          .slice()
          .sort((a, b) => a - b)
          .map((d) => DOW_LABELS[d])
          .join(', ');
  return `${dayPart} · ${formatTime(start)}–${formatTime(end)}`;
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
  const discountText =
    hh.discountType === 'percent' ? `${hh.discountValue}% off` : `${formatCurrency(hh.discountValue)} off`;
  const windowText = formatWindow(hh.daysOfWeek, hh.startTime, hh.endTime);

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
            Live now
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
          {discountText} on everything on the menu{hh.isLive ? ' right now' : ' during this window'} 🍽️
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
                style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
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

const DIETARY_LABELS: Record<string, { label: string; emoji: string }> = {
  vegan: { label: 'Vegan', emoji: '🌱' },
  'gluten-free': { label: 'Gluten-free', emoji: '🌾' },
  halal: { label: 'Halal', emoji: '🕌' },
  spicy: { label: 'Spicy', emoji: '🌶️' },
  'chef-pick': { label: "Chef's pick", emoji: '⭐' },
  new: { label: 'New', emoji: '✨' },
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
  return (
    <div className="-mx-1 flex flex-wrap gap-2 px-1">
      {available.map((tag) => {
        const meta = DIETARY_LABELS[tag] ?? { label: tag, emoji: '' };
        const isOn = selected.has(tag);
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            aria-pressed={isOn}
            className={`focus-ring inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              isOn
                ? 'bg-primary text-primary-foreground shadow-soft'
                : 'border border-border bg-card text-foreground hover:border-primary/40'
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
          <X className="h-3 w-3" /> Clear
        </button>
      )}
    </div>
  );
}

function YourUsualsRow({ items, onOpen }: { items: MenuItem[]; onOpen: (item: MenuItem) => void }) {
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold">👋 Your usuals</h2>
        <span className="text-xs text-muted-foreground">{items.length} items you order most</span>
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
              style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
              role="img"
              aria-label={item.name}
            >
              {item.outOfStock && (
                <span className="absolute inset-0 grid place-items-center bg-background/60">
                  <Badge variant="muted" className="text-xs">Sold out</Badge>
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
