'use client';

import * as React from 'react';
import { Award, ChevronRight, Gift, History } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  getMyLoyalty,
  listMyLoyaltyTransactions,
  type LoyaltyTxRow,
} from '@favornoms/database/queries';
import { Badge, Card, Sheet } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { AccountHeader, SignInGate } from '../../_components/account-ui';

type Loyalty = NonNullable<Awaited<ReturnType<typeof getMyLoyalty>>>;

/**
 * Every tier used to render in the same brand orange, so a Bronze member's bar
 * was pixel-identical to a Platinum member's. These are the platform-fixed
 * --tier-* tokens (see packages/ui/src/globals.css): deliberately NOT themed per
 * brand, because the thresholds behind them are DB-global.
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

/**
 * Tier thresholds are the DB's, measured against `lifetime_earned` — mirroring
 * them here keeps "X points to Gold" honest instead of guessed.
 */
const TIERS = [
  { key: 'bronze', label: 'Bronze', threshold: 0, emoji: '🥉', tone: TONES.bronze },
  { key: 'silver', label: 'Silver', threshold: 10000, emoji: '🥈', tone: TONES.silver },
  { key: 'gold', label: 'Gold', threshold: 30000, emoji: '🥇', tone: TONES.gold },
  { key: 'platinum', label: 'Platinum', threshold: 100000, emoji: '💎', tone: TONES.platinum },
] as const;

type Tier = (typeof TIERS)[number];

const TIER_BENEFITS: Record<Tier['key'], string[]> = {
  bronze: [
    'Where every member starts — no minimum spend.',
    'Redeem 100 points for ' + formatCurrency(1) + ' off, up to 50% of a subtotal.',
  ],
  silver: [
    'Unlocked at 10,000 lifetime points.',
    'A Silver badge on your account, so the restaurant can send you member-only offers.',
  ],
  gold: [
    'Unlocked at 30,000 lifetime points.',
    'Gold-only promotions and early access to campaigns the restaurant runs for its best regulars.',
  ],
  platinum: [
    'Unlocked at 100,000 lifetime points.',
    'The top tier — the restaurant’s most exclusive offers land here first.',
  ],
};

/** Transaction kinds returned by `list_my_loyalty_transactions`. */
const TX_META: Record<string, { label: string; variant: React.ComponentProps<typeof Badge>['variant'] }> = {
  earned: { label: 'Earned', variant: 'success' },
  redeemed: { label: 'Redeemed', variant: 'default' },
  expired: { label: 'Expired', variant: 'muted' },
  adjusted: { label: 'Adjusted', variant: 'warning' },
};

function tierIndexFor(lifetimeEarned: number): number {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i += 1) {
    if (lifetimeEarned >= TIERS[i]!.threshold) idx = i;
  }
  return idx;
}

export function LoyaltyView({
  base,
  brandName,
  branchId,
}: {
  base: string;
  brandName: string;
  branchId: string;
}) {
  const { user, loading } = useAuth();
  const [loyalty, setLoyalty] = React.useState<Loyalty | null>(null);
  const [txns, setTxns] = React.useState<LoyaltyTxRow[]>([]);
  const [busy, setBusy] = React.useState(true);

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
    ]).then(([l, t]) => {
      setLoyalty(l);
      setTxns(t);
      setBusy(false);
    });
  }, [user, branchId]);

  const balance = loyalty?.points_balance ?? 0;
  const lifetimeEarned = loyalty?.lifetime_earned ?? 0;
  const currentTier = TIERS[tierIndexFor(lifetimeEarned)]!;

  return (
    <div className="container max-w-2xl pb-24 pt-4">
      <AccountHeader base={base} title="Loyalty & rewards" />
      {loading ? null : !user ? (
        <SignInGate base={base} message={`Sign in to see your ${brandName} points and rewards.`} />
      ) : (
        <div className="space-y-5">
          <Card className="overflow-hidden p-0">
            <div className="bg-gradient-warm p-6 text-white">
              <p className="text-sm text-white/80">Your points</p>
              <p className="font-display text-5xl font-bold leading-tight">{balance.toLocaleString()}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="solid" className="bg-white/25 text-white">
                  <Award className="h-3 w-3" /> {currentTier.label} member
                </Badge>
                <span className="text-xs text-white/80">
                  worth {formatCurrency(balance / 100)} off your next order
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-border text-center">
              <Stat label="Lifetime earned" value={(loyalty?.lifetime_earned ?? 0).toLocaleString()} />
              <Stat label="Lifetime redeemed" value={(loyalty?.lifetime_spent ?? 0).toLocaleString()} />
            </div>
          </Card>

          <TierTrack lifetimeEarned={lifetimeEarned} />

          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Gift className="h-5 w-5 text-primary" /> How points work
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>
                Earn <strong className="text-foreground">1 point per {formatCurrency(1)}</strong> of your
                order subtotal.
              </li>
              <li>
                Points land{' '}
                <strong className="text-foreground">once the order is completed</strong> — orders still
                being prepared or on their way don&apos;t count yet.
              </li>
              <li>
                Redeem at checkout —{' '}
                <strong className="text-foreground">100 points = {formatCurrency(1)} off</strong> (up to
                50% of your subtotal).
              </li>
              <li>
                Redeemed points leave your balance right away, but the entry shows in{' '}
                <strong className="text-foreground">Recent activity</strong> once that order is
                completed.
              </li>
              <li>Keep ordering to climb tiers and unlock more perks.</li>
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <History className="h-5 w-5 text-primary" /> Recent activity
            </h2>
            {busy ? (
              <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
            ) : txns.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No points activity yet — your first order will start earning.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {txns.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      {/* The kind of movement is spelled out so nobody reads a
                          redemption or an adjustment as "points I earned". Only
                          completed orders ever produce an `earned` row. */}
                      <div className="flex items-center gap-2">
                        <Badge variant={TX_META[t.type]?.variant ?? 'muted'}>
                          {TX_META[t.type]?.label ?? t.type.replace(/_/g, ' ')}
                        </Badge>
                        {t.description && (
                          <p className="truncate text-sm font-medium">{t.description}</p>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(t.created_at).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 font-display text-base font-bold tabular-nums ${
                        t.points >= 0 ? 'text-success' : 'text-muted-foreground'
                      }`}
                    >
                      {t.points >= 0 ? '+' : ''}
                      {t.points.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * Bronze → Platinum rail. The tier the customer is actually in is filled in and
 * lifted; every tier is tappable for a breakdown of what it unlocks.
 */
function TierTrack({ lifetimeEarned }: { lifetimeEarned: number }) {
  const [openTier, setOpenTier] = React.useState<Tier | null>(null);
  const currentIndex = tierIndexFor(lifetimeEarned);
  const current = TIERS[currentIndex]!;
  const next = TIERS[currentIndex + 1] ?? null;
  const pointsToNext = next ? Math.max(next.threshold - lifetimeEarned, 0) : 0;
  // Fraction of the way through the current band, so the fill sits between the
  // two node centres instead of snapping tier to tier.
  const bandProgress = next
    ? Math.min(Math.max((lifetimeEarned - current.threshold) / (next.threshold - current.threshold), 0), 1)
    : 1;
  const fillPercent = ((currentIndex + (next ? bandProgress : 0)) / (TIERS.length - 1)) * 100;

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">Your tier</h2>
        <span className="text-xs text-muted-foreground">
          {lifetimeEarned.toLocaleString()} lifetime points
        </span>
      </div>

      <div className="relative mt-5">
        <div className="absolute left-[12.5%] right-[12.5%] top-5 h-1.5 rounded-full bg-muted" />
        <div
          className={`absolute left-[12.5%] top-5 h-1.5 rounded-full transition-[width] duration-500 ${current.tone.bg}`}
          style={{ width: `calc(${fillPercent}% * 0.75)` }}
        />
        <ul className="relative grid grid-cols-4 gap-1">
          {TIERS.map((tier, i) => {
            const reached = i <= currentIndex;
            const isCurrent = i === currentIndex;
            return (
              <li key={tier.key} className="flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => setOpenTier(tier)}
                  aria-label={`${tier.label} tier benefits`}
                  aria-current={isCurrent ? 'true' : undefined}
                  className="focus-ring flex flex-col items-center gap-1.5 rounded-2xl px-1 py-1"
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
                    className={`text-[11px] font-semibold leading-tight ${
                      isCurrent ? tier.tone.label : 'text-muted-foreground'
                    }`}
                  >
                    {tier.label}
                  </span>
                  <span className="text-[10px] leading-none text-muted-foreground">
                    {tier.threshold.toLocaleString()}
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
            <strong className="font-semibold">{pointsToNext.toLocaleString()} more points</strong> to
            reach {next.label}.
          </p>
        ) : (
          <p className="text-sm font-semibold">You&apos;re at the top tier — enjoy it! 🎉</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Tap any tier to see what it unlocks.
        </p>
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
                  ? 'This is your tier right now.'
                  : 'You have already passed this tier.'
                : `${(openTier.threshold - lifetimeEarned).toLocaleString()} more points to unlock.`}
            </p>
            <ul className="space-y-2 text-sm">
              {TIER_BENEFITS[openTier.key].map((benefit) => (
                <li key={benefit} className="flex gap-2">
                  {/* Tinted to the tapped tier, so the sheet visibly belongs to it. */}
                  <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 ${openTier.tone.label}`} />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
            <div className="rounded-2xl border border-border bg-muted/40 p-4">
              <p className="font-display text-sm font-semibold">How you earn points</p>
              <p className="mt-1 text-sm text-muted-foreground">
                You earn 1 point for every {formatCurrency(1)} of an order&apos;s subtotal. Points are
                credited when the order is completed — nothing is added while an order is still
                pending, being prepared, or on its way, and cancelled orders never earn.
              </p>
            </div>
          </div>
        )}
      </Sheet>
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
