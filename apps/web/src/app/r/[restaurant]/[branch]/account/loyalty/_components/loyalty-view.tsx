'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Award, ChevronRight, Gift, History } from 'lucide-react';
import { DEFAULT_UI_LOCALE, formatCurrency, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  DEFAULT_LOYALTY_PROGRAM,
  getLoyaltyProgram,
  getMyLoyalty,
  listLoyaltyRewards,
  listMyLoyaltyTransactions,
  type LoyaltyProgram,
  type LoyaltyReward,
  type LoyaltyTxRow,
} from '@favornoms/database/queries';
import { Badge, Card, Sheet } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { AccountHeader, SignInGate } from '../../_components/account-ui';

type Loyalty = NonNullable<Awaited<ReturnType<typeof getMyLoyalty>>>;
type LoyaltyT = ReturnType<typeof useTranslations<'loyalty'>>;

/**
 * Every tier used to render in the same brand orange, so a Bronze member's bar
 * was pixel-identical to a Platinum member's. These are the platform-fixed
 * --tier-* tokens (see packages/ui/src/globals.css): deliberately NOT themed per
 * brand. The four rungs are the same everywhere; their thresholds, names and
 * benefits are each branch's own (see buildTiers).
 *
 * Written as whole literal class strings — Tailwind's scanner cannot see a class
 * assembled at runtime, so `bg-tier-${key}` would compile to nothing.
 */
const TONES = {
  bronze: {
    bg: 'bg-tier-bronze', fg: 'text-tier-bronze-foreground',
    soft: 'bg-tier-bronze/15', label: 'text-tier-bronze', ring: 'ring-tier-bronze/25',
  },
  silver: {
    bg: 'bg-tier-silver', fg: 'text-tier-silver-foreground',
    soft: 'bg-tier-silver/15', label: 'text-tier-silver', ring: 'ring-tier-silver/25',
  },
  gold: {
    bg: 'bg-tier-gold', fg: 'text-tier-gold-foreground',
    soft: 'bg-tier-gold/15', label: 'text-tier-gold', ring: 'ring-tier-gold/25',
  },
  platinum: {
    bg: 'bg-tier-platinum', fg: 'text-tier-platinum-foreground',
    soft: 'bg-tier-platinum/15', label: 'text-tier-platinum', ring: 'ring-tier-platinum/25',
  },
} as const;

/** The emoji and colour of each rung. Everything a diner reads — the name, the thresholds, the
 *  benefit lines — comes from the restaurant; these labels are only the fallback, and stay in the
 *  platform's English because an untouched tier comes back from the server with the same name. */
const TIER_BASE = [
  { key: 'bronze', label: 'Bronze', emoji: '🥉', tone: TONES.bronze },
  { key: 'silver', label: 'Silver', emoji: '🥈', tone: TONES.silver },
  { key: 'gold', label: 'Gold', emoji: '🥇', tone: TONES.gold },
  { key: 'platinum', label: 'Platinum', emoji: '💎', tone: TONES.platinum },
] as const;

type TierKey = (typeof TIER_BASE)[number]['key'];

interface Tier {
  key: TierKey;
  label: string;
  emoji: string;
  tone: (typeof TONES)[TierKey];
  threshold: number;
  /** The merchant's own lines, or null when they have never written any for this rung. */
  perks: string[] | null;
}

/**
 * The ladder this branch grants, measured against `lifetime_earned`. The thresholds, the name
 * of each rung and the lines under it were all written here once, so a merchant who changed them
 * would have had the page promising a tier the server never awarded — or naming it in a language
 * their diners don't read. Only the emoji and the colour are still the platform's.
 */
function buildTiers(program: LoyaltyProgram): Tier[] {
  const byKey = new Map(program.tiers.map((t) => [t.key, t]));
  return TIER_BASE.map((base, i) => {
    const t = byKey.get(base.key);
    return {
      ...base,
      label: t?.label.trim() || base.label,
      threshold:
        t && Number.isFinite(t.threshold) ? t.threshold : DEFAULT_LOYALTY_PROGRAM.tiers[i]!.threshold,
      perks: t?.perks ?? null,
    };
  });
}

/**
 * What a rung promises. The first line is drawn from the threshold every time rather than stored,
 * so moving a tier can never leave a stale number in the merchant's copy; the rest is theirs, shown
 * exactly as written, or the platform's for a tier they have never touched. The platform's lines are
 * DEFAULT_TIER_PERKS in @favornoms/database; `loyalty.defaultPerks.*` carries them in each language
 * (English identical — see default-perks.test.ts). An empty array they saved means they chose to say
 * nothing more, and is respected.
 */
function tierBenefits(tier: Tier, t: LoyaltyT): string[] {
  const opening =
    tier.threshold <= 0 ? t('tiers.starter') : t('tiers.unlockedAt', { points: tier.threshold });
  return [opening, ...(tier.perks ?? [t(`defaultPerks.${tier.key}`)])];
}

const TX_META: Record<
  string,
  { labelKey: 'earned' | 'redeemed' | 'expired' | 'adjusted'; variant: React.ComponentProps<typeof Badge>['variant'] }
> = {
  earned: { labelKey: 'earned', variant: 'success' },
  redeemed: { labelKey: 'redeemed', variant: 'default' },
  expired: { labelKey: 'expired', variant: 'muted' },
  adjusted: { labelKey: 'adjusted', variant: 'warning' },
};

function tierIndexFor(lifetimeEarned: number, tiers: Tier[]): number {
  let idx = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    if (lifetimeEarned >= tiers[i]!.threshold) idx = i;
  }
  return idx;
}

/** The Intl locale for numbers and dates in the current interface language. */
function useIntlLocale(): string {
  const raw = useLocale();
  return intlLocaleFor(isUiLocale(raw) ? raw : DEFAULT_UI_LOCALE);
}

export function LoyaltyView({
  base,
  brandName,
  branchId,
}: {
  base: string;
  /** The storefront's full name ("<brand> - <branch>"): points, rewards and tiers are this
   *  branch's alone, so the page says whose they are. */
  brandName: string;
  branchId: string;
}) {
  const t = useTranslations('loyalty');
  const tAccount = useTranslations('account');
  const intlLocale = useIntlLocale();
  const { user, loading } = useAuth();
  const [loyalty, setLoyalty] = React.useState<Loyalty | null>(null);
  const [txns, setTxns] = React.useState<LoyaltyTxRow[]>([]);
  const [rewards, setRewards] = React.useState<LoyaltyReward[]>([]);
  // undefined = still loading, null = the read failed. Neither may be drawn as the platform's
  // ladder: the page would tell a Platinum member they are Bronze, and quote a rate the restaurant
  // does not use, while the Account screen one tap away shows the server's real grade.
  const [program, setProgram] = React.useState<LoyaltyProgram | null | undefined>(undefined);
  const [busy, setBusy] = React.useState(true);

  // The programme is public, so it loads whether or not the diner is signed in — the page shows
  // the ladder and the rate to someone deciding whether to join.
  React.useEffect(() => {
    let cancelled = false;
    setProgram(undefined);
    void getLoyaltyProgram(getBrowserClient(), branchId).then((p) => {
      if (!cancelled) setProgram(p);
    });
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  React.useEffect(() => {
    if (!user) {
      setBusy(false);
      return;
    }
    const supabase = getBrowserClient();
    setBusy(true);
    void Promise.all([
      getMyLoyalty(supabase, branchId),
      listMyLoyaltyTransactions(supabase, branchId, 30),
      listLoyaltyRewards(supabase, branchId),
    ]).then(([l, t, r]) => {
      setLoyalty(l);
      setTxns(t);
      setRewards(r);
      setBusy(false);
    });
  }, [user, branchId]);

  const balance = loyalty?.points_balance ?? 0;
  const lifetimeEarned = loyalty?.lifetime_earned ?? 0;
  const tiers = React.useMemo(() => buildTiers(program ?? DEFAULT_LOYALTY_PROGRAM), [program]);
  // The badge shows the tier the server graded (the one checkout and redemption act on), named in
  // the restaurant's words — not a recomputation from thresholds that may not have loaded.
  const badgeLabel =
    tiers.find((t) => t.key === (loyalty?.tier ?? 'bronze'))?.label ??
    (loyalty?.tier ?? 'bronze').replace(/^./, (c) => c.toUpperCase());
  // The catalog arrives sorted by the merchant's sort_order, then points_cost —
  // so the cheapest thing still out of reach is the first unaffordable one by
  // cost, not the first in display order.
  const affordable = rewards.filter((r) => r.points_cost <= balance);
  const nextReward = rewards
    .filter((r) => r.points_cost > balance)
    .reduce<LoyaltyReward | null>((best, r) => (!best || r.points_cost < best.points_cost ? r : best), null);
  const strong = (chunks: React.ReactNode) => <strong className="text-foreground">{chunks}</strong>;

  return (
    <div className="container max-w-2xl pb-24 pt-4">
      <AccountHeader base={base} title={tAccount('sections.loyalty')} />
      {loading ? null : !user ? (
        <SignInGate base={base} message={t('signInPrompt', { brandName })} />
      ) : (
        <div className="space-y-5">
          <Card className="overflow-hidden p-0">
            <div className="bg-gradient-warm p-6 text-white">
              <p className="text-sm text-white/80">{t('yourPoints', { brandName })}</p>
              <p className="font-display text-5xl font-bold leading-tight">{balance.toLocaleString(intlLocale)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="solid" className="bg-white/25 text-white">
                  <Award className="h-3 w-3" />{' '}
                  {program === undefined ? (
                    <span
                      className="inline-block h-3 w-16 animate-pulse rounded bg-white/30"
                      aria-label={t('loadingTier')}
                    />
                  ) : (
                    t('memberBadge', { tier: badgeLabel })
                  )}
                </Badge>
                {/* Points buy named rewards now, not a floating dollar rate, so
                    quoting one would be a number the diner can never cash in. */}
                <span className="text-xs text-white/80">
                  {affordable.length > 0
                    ? t('rewardsReady', { count: affordable.length })
                    : nextReward
                      ? t('pointsForReward', { points: nextReward.points_cost - balance, reward: nextReward.name })
                      : t('keepOrdering')}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-border text-center">
              <Stat label={t('lifetimeEarned')} value={(loyalty?.lifetime_earned ?? 0).toLocaleString(intlLocale)} />
              <Stat label={t('lifetimeRedeemed')} value={(loyalty?.lifetime_spent ?? 0).toLocaleString(intlLocale)} />
            </div>
            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              {t('branchNote', { brandName })}
            </p>
          </Card>

          <RewardsCatalog rewards={rewards} balance={balance} busy={busy} brandName={brandName} />

          {program ? (
            <TierTrack
              lifetimeEarned={lifetimeEarned}
              tiers={tiers}
              pointsPerCurrency={program.pointsPerCurrency}
            />
          ) : (
            <TierTrackPlaceholder failed={program === null} />
          )}

          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Gift className="h-5 w-5 text-primary" /> {t('howPoints.title')}
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {program ? (
                <li>
                  {t.rich('howPoints.earnRate', {
                    points: program.pointsPerCurrency,
                    amount: formatCurrency(1),
                    strong,
                  })}
                </li>
              ) : program === undefined ? (
                <li aria-busy="true">
                  <span className="inline-block h-4 w-56 max-w-full animate-pulse rounded bg-muted" />
                </li>
              ) : (
                <li>{t('howPoints.earnFallback')}</li>
              )}
              <li>{t.rich('howPoints.landing', { strong })}</li>
              <li>{t.rich('howPoints.checkout', { strong })}</li>
              <li>{t.rich('howPoints.redeemed', { strong })}</li>
              <li>{t('howPoints.climb')}</li>
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <History className="h-5 w-5 text-primary" /> {t('activity.title')}
            </h2>
            {busy ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('loading')}</p>
            ) : txns.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('activity.empty')}</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {txns.map((tx) => {
                  const txMeta = TX_META[tx.type];
                  return (
                    <li key={tx.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        {/* The kind of movement is spelled out so nobody reads a
                            redemption or an adjustment as "points I earned". Only
                            completed orders ever produce an `earned` row. */}
                        <div className="flex items-center gap-2">
                          <Badge variant={txMeta?.variant ?? 'muted'}>
                            {txMeta ? t(`activity.types.${txMeta.labelKey}`) : tx.type.replace(/_/g, ' ')}
                          </Badge>
                          {tx.description && (
                            <p className="truncate text-sm font-medium">{tx.description}</p>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {new Date(tx.created_at).toLocaleDateString(intlLocale, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 font-display text-base font-bold tabular-nums ${
                          tx.points >= 0 ? 'text-success' : 'text-muted-foreground'
                        }`}
                      >
                        {tx.points >= 0 ? '+' : ''}
                        {tx.points.toLocaleString(intlLocale)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/** What a reward gives, in the diner's words. The item name is the merchant's, shown as typed. */
function rewardValueLabel(r: LoyaltyReward, t: LoyaltyT): string {
  switch (r.kind) {
    case 'percent_off':
      return r.max_discount
        ? t('rewards.percentOffCapped', {
            percent: Number(r.value),
            max: formatCurrency(Number(r.max_discount)),
          })
        : t('rewards.percentOff', { percent: Number(r.value) });
    case 'fixed_off':
      return t('rewards.fixedOff', { amount: formatCurrency(Number(r.value)) });
    case 'free_item':
      return r.menu_item_name
        ? t('rewards.freeItem', { item: r.menu_item_name })
        : t('rewards.freeItemGeneric');
    default:
      return t('rewards.freeDelivery');
  }
}

/**
 * The merchant's reward catalog. This is the whole answer to "what are my points
 * for?" — points are no longer a free-floating currency, so if the restaurant
 * has listed nothing, saying so plainly beats an empty box.
 */
function RewardsCatalog({
  rewards,
  balance,
  busy,
  brandName,
}: {
  rewards: LoyaltyReward[];
  balance: number;
  busy: boolean;
  brandName: string;
}) {
  const t = useTranslations('loyalty');
  const intlLocale = useIntlLocale();
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Gift className="h-5 w-5 text-primary" /> {t('rewards.title')}
      </h2>
      {busy ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('loading')}</p>
      ) : rewards.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('rewards.empty', { brandName })}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rewards.map((r) => {
            const short = Math.max(0, r.points_cost - balance);
            const value = rewardValueLabel(r, t);
            return (
              <li
                key={r.id}
                className={`flex items-center justify-between gap-3 rounded-2xl border p-3 ${
                  short === 0 ? 'border-primary/30 bg-primary/5' : 'border-border'
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {Number(r.min_subtotal) > 0
                      ? t('rewards.withMinimum', { value, amount: formatCurrency(Number(r.min_subtotal)) })
                      : value}
                  </p>
                  {r.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.description}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-display text-base font-bold tabular-nums">
                    {r.points_cost.toLocaleString(intlLocale)}
                  </p>
                  <p className="text-[11px] leading-none text-muted-foreground">
                    {short === 0 ? t('rewards.ready') : t('rewards.toGo', { points: short })}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rewards.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">{t('rewards.pickAtCheckout')}</p>
      )}
    </Card>
  );
}

/**
 * Bronze → Platinum rail. The tier the customer is actually in is filled in and
 * lifted; every tier is tappable for a breakdown of what it unlocks.
 */
function TierTrack({
  lifetimeEarned,
  tiers,
  pointsPerCurrency,
}: {
  lifetimeEarned: number;
  tiers: Tier[];
  pointsPerCurrency: number;
}) {
  const t = useTranslations('loyalty');
  const intlLocale = useIntlLocale();
  const [openTier, setOpenTier] = React.useState<Tier | null>(null);
  const currentIndex = tierIndexFor(lifetimeEarned, tiers);
  const current = tiers[currentIndex]!;
  const next = tiers[currentIndex + 1] ?? null;
  const pointsToNext = next ? Math.max(next.threshold - lifetimeEarned, 0) : 0;
  // Fraction of the way through the current band, so the fill sits between the
  // two node centres instead of snapping tier to tier.
  const bandProgress = next
    ? Math.min(Math.max((lifetimeEarned - current.threshold) / (next.threshold - current.threshold), 0), 1)
    : 1;
  const fillPercent = ((currentIndex + (next ? bandProgress : 0)) / (tiers.length - 1)) * 100;

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">{t('tiers.title')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('tiers.lifetimePoints', { points: lifetimeEarned })}
        </span>
      </div>

      <div className="relative mt-5">
        <div className="absolute left-[12.5%] right-[12.5%] top-5 h-1.5 rounded-full bg-muted" />
        <div
          className={`absolute left-[12.5%] top-5 h-1.5 rounded-full transition-[width] duration-500 ${current.tone.bg}`}
          style={{ width: `calc(${fillPercent}% * 0.75)` }}
        />
        <ul className="relative grid grid-cols-4 gap-1">
          {tiers.map((tier, i) => {
            const reached = i <= currentIndex;
            const isCurrent = i === currentIndex;
            return (
              <li key={tier.key} className="flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => setOpenTier(tier)}
                  aria-label={t('tiers.benefitsAria', { tier: tier.label })}
                  aria-current={isCurrent ? 'true' : undefined}
                  className="focus-ring flex w-full min-w-0 flex-col items-center gap-1.5 rounded-2xl px-1 py-1"
                >
                  <span
                    className={`relative z-10 grid h-11 w-11 place-items-center rounded-full text-lg transition ${
                      isCurrent
                        ? `${tier.tone.bg} ${tier.tone.fg} shadow-warm ring-4 ${tier.tone.ring}`
                        : reached
                          ? `${tier.tone.soft} ${tier.tone.label}`
                          : 'bg-muted text-muted-foreground/60 grayscale'
                    }`}
                  >
                    {tier.emoji}
                  </span>
                  <span
                    className={`w-full break-words text-center text-[11px] font-semibold leading-tight ${
                      isCurrent ? tier.tone.label : 'text-muted-foreground'
                    }`}
                  >
                    {tier.label}
                  </span>
                  <span className="text-[10px] leading-none text-muted-foreground">
                    {tier.threshold.toLocaleString(intlLocale)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-4 rounded-2xl bg-muted/40 px-4 py-3">
        {next ? (
          <p className="text-sm">
            {t.rich('tiers.toNext', {
              points: pointsToNext,
              tier: next.label,
              strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
            })}
          </p>
        ) : (
          <p className="text-sm font-semibold">{t('tiers.top')}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{t('tiers.tapHint')}</p>
      </div>

      <Sheet
        open={!!openTier}
        onClose={() => setOpenTier(null)}
        title={openTier ? `${openTier.emoji} ${openTier.label}` : undefined}
      >
        {openTier && (
          <div className="space-y-4 px-5 pb-8">
            <p className="text-sm text-muted-foreground">
              {lifetimeEarned >= openTier.threshold
                ? openTier.key === current.key
                  ? t('tiers.current')
                  : t('tiers.passed')
                : t('tiers.toUnlock', { points: openTier.threshold - lifetimeEarned })}
            </p>
            <ul className="space-y-2 text-sm">
              {tierBenefits(openTier, t).map((benefit, i) => (
                <li key={`${openTier.key}-${i}`} className="flex gap-2">
                  {/* Tinted to the tapped tier, so the sheet visibly belongs to it. */}
                  <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 ${openTier.tone.label}`} />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
            <div className="rounded-2xl border border-border bg-muted/40 p-4">
              <p className="font-display text-sm font-semibold">{t('tiers.earnTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('tiers.earnBody', { points: pointsPerCurrency, amount: formatCurrency(1) })}
              </p>
            </div>
          </div>
        )}
      </Sheet>
    </Card>
  );
}

function TierTrackPlaceholder({ failed }: { failed: boolean }) {
  const t = useTranslations('loyalty');
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">{t('tiers.title')}</h2>
      {failed ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('tiers.failed')}</p>
      ) : (
        <div className="mt-5 grid grid-cols-4 gap-1" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <span className="h-11 w-11 animate-pulse rounded-full bg-muted" />
              <span className="h-3 w-10 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-4">
      <p className="font-display text-xl font-bold text-primary">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
