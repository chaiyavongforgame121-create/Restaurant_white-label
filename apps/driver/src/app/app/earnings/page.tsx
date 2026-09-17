'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Receipt, Send, Store, TrendingUp } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  listDriverEarnings,
  listDriverWithdrawals,
  requestDriverWithdrawal,
  type DriverWithdrawalRow,
} from '@favornoms/database/queries';
import {
  branchSubtitle,
  displayRestaurantName,
  intlLocaleFor,
  restaurantLabel,
  summariseDriverEarnings,
  type DriverEarningsSummary,
  type RestaurantEarnings,
  type UiLocale,
} from '@favornoms/shared';
import { Badge, Button, Card, EmptyState, Sheet } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';
import { driverPayoutQrPath } from './_components/payout-media';
import { PayoutQrCard } from './_components/payout-qr-card';

// RPC raises these as bare exception messages; each maps to a key under earnings.errors.
// Anything else gets the translated generic message rather than the raw server text.
const RPC_ERROR_KEYS = {
  bank_details_required: 'bankDetailsRequired',
  withdrawal_already_pending: 'withdrawalAlreadyPending',
  nothing_to_withdraw: 'nothingToWithdraw',
} as const;

// Withdrawal statuses with a translated badge; anything else is shown as stored.
const WITHDRAWAL_STATUSES = ['pending', 'paid', 'rejected'] as const;
type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];
const isWithdrawalStatus = (s: string): s is WithdrawalStatus =>
  (WITHDRAWAL_STATUSES as readonly string[]).includes(s);

const EMPTY_SUMMARY: DriverEarningsSummary = {
  restaurants: [],
  restaurantCount: 0,
  totals: {
    available: 0,
    requested: 0,
    paid: 0,
    lifetime: 0,
    deliveries: 0,
    availableDeliveries: 0,
    base: 0,
    distance: 0,
    tip: 0,
  },
};

const money = (n: number) => `$${n.toFixed(2)}`;

export default function EarningsPage() {
  const t = useTranslations('earnings');
  const locale = useLocale() as UiLocale;
  const { driver } = useDriverSession();
  const [withdrawals, setWithdrawals] = React.useState<DriverWithdrawalRow[]>([]);
  const [summary, setSummary] = React.useState<DriverEarningsSummary>(EMPTY_SUMMARY);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [requesting, setRequesting] = React.useState<RestaurantEarnings | null>(null);
  const [bankName, setBankName] = React.useState('');
  const [accountNumber, setAccountNumber] = React.useState('');
  const [accountName, setAccountName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Held here rather than read off `driver` on every render so the card and the copy of it
  // inside the request sheet can never disagree about whether a QR is saved.
  const [qrPath, setQrPath] = React.useState<string | null>(() => driverPayoutQrPath(driver));

  const refresh = React.useCallback(async () => {
    const supabase = getBrowserClient();
    try {
      // The settlement ledger is the source of truth for what each restaurant owes and paid;
      // the withdrawals list only records what has been asked for.
      const [ledger, requests] = await Promise.all([
        listDriverEarnings(supabase, driver.id),
        listDriverWithdrawals(supabase, driver.id),
      ]);
      setSummary(summariseDriverEarnings(ledger));
      setWithdrawals(requests);
      setLoadFailed(false);
    } catch {
      // Whatever is already on screen stays: a read that never landed is not "you earned
      // nothing", and a rider deciding whether to chase a restaurant must not be told it is.
      setLoadFailed(true);
    }
  }, [driver.id]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const { restaurants, totals, restaurantCount } = summary;
  // Below two restaurants the "all restaurants" framing is noise: there is only one pot.
  const manyRestaurants = restaurantCount > 1;
  const unpaid = totals.available + totals.requested;

  const pendingBranchIds = new Set(
    withdrawals.filter((w) => w.status === 'pending').map((w) => w.branch_id),
  );

  const openRequest = (r: RestaurantEarnings) => {
    // Prefill bank details from the driver's most recent request, any restaurant.
    const last = withdrawals[0];
    setBankName(last?.bank_name ?? '');
    setAccountNumber(last?.account_number ?? '');
    setAccountName(last?.account_name ?? '');
    setError(null);
    setRequesting(r);
  };

  const submit = async () => {
    if (!requesting) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    // Branch-scoped on purpose: the RPC tags only this restaurant's untagged accrued rows and
    // pays the sum of those, so a request can never reach into another restaurant's balance.
    const { error: rpcErr } = await requestDriverWithdrawal(supabase, requesting.branchId, {
      bankName: bankName.trim(),
      accountNumber: accountNumber.trim(),
      accountName: accountName.trim(),
    });
    setBusy(false);
    if (rpcErr) {
      const code = (Object.keys(RPC_ERROR_KEYS) as Array<keyof typeof RPC_ERROR_KEYS>).find((k) =>
        rpcErr.message.includes(k),
      );
      setError(code ? t(`errors.${RPC_ERROR_KEYS[code]}`) : t('errors.generic'));
      return;
    }
    setRequesting(null);
    void refresh();
  };

  const requestingSubtitle = requesting ? branchSubtitle(requesting) : null;

  return (
    <div className="container max-w-xl py-6">
      <header className="mb-5 px-1">
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        {manyRestaurants && (
          <p className="mt-0.5 text-sm text-muted-foreground">{t('separatePay')}</p>
        )}
      </header>

      {loadFailed && (
        <p role="alert" className="mb-4 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {t('loadError')}
        </p>
      )}

      <Card className="mb-3 bg-gradient-warm p-5 text-white">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-6 w-6 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-white/80">
              {manyRestaurants ? t('lifetime.allLabel') : t('lifetime.label')}
            </p>
            <p className="font-display text-3xl font-bold">{money(totals.lifetime)}</p>
            <p className="truncate text-xs text-white/80">
              {restaurantCount === 0
                ? t('lifetime.noDeliveries')
                : manyRestaurants
                  ? t('lifetime.many', {
                      restaurants: restaurantCount,
                      deliveries: totals.deliveries,
                    })
                  : t('lifetime.one', {
                      restaurant: displayRestaurantName(restaurants[0]?.restaurantName ?? '', locale),
                      deliveries: totals.deliveries,
                    })}
            </p>
          </div>
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{t('unpaid.label')}</p>
          <p className="font-display text-2xl font-bold">{money(unpaid)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {manyRestaurants ? t('unpaid.many') : t('unpaid.one')}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{t('paid.label')}</p>
          <p className="font-display text-2xl font-bold">{money(totals.paid)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {manyRestaurants ? t('paid.many') : t('paid.one')}
          </p>
        </Card>
      </div>

      {/* One restaurant already gets this split on its own card below — showing it twice would
          only invite the reader to treat one of the two as somebody else's money. */}
      {manyRestaurants && (
        <Card className="mb-5 p-4">
          <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            {t('breakdown.allRestaurants')}
          </p>
          <div className="grid grid-cols-3 divide-x divide-border text-center">
            <div>
              <p className="text-[11px] uppercase text-muted-foreground">{t('breakdown.base')}</p>
              <p className="font-semibold">{money(totals.base)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase text-muted-foreground">{t('breakdown.distance')}</p>
              <p className="font-semibold">{money(totals.distance)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase text-muted-foreground">{t('breakdown.tips')}</p>
              <p className="font-semibold">{money(totals.tip)}</p>
            </div>
          </div>
        </Card>
      )}

      <PayoutQrCard qrPath={qrPath} onChange={setQrPath} />

      <h2 className="mb-2 px-1 font-display text-lg font-semibold">{t('balances.title')}</h2>
      {restaurants.length === 0 ? (
        <EmptyState
          className="mb-5 rounded-xl border border-dashed border-border bg-card"
          icon={<Store className="h-6 w-6" />}
          title={t('balances.emptyTitle')}
          description={t('balances.emptyDescription')}
        />
      ) : (
        <ul className="mb-5 space-y-2">
          {restaurants.map((r) => {
            const pending = pendingBranchIds.has(r.branchId);
            const subtitle = branchSubtitle(r);
            const canRequest = !pending && r.available > 0;
            const restaurantName = displayRestaurantName(r.restaurantName, locale);
            return (
              <li key={r.branchId}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Store className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{restaurantName}</p>
                      {subtitle && (
                        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t('balances.deliveries', { count: r.deliveries })}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        {t('balances.toWithdraw')}
                      </p>
                      <p className="font-display text-xl font-bold text-primary">
                        {money(r.available)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 divide-x divide-border rounded-xl bg-muted/40 py-2 text-center">
                    <div>
                      <p className="text-[10px] uppercase text-muted-foreground">{t('breakdown.base')}</p>
                      <p className="text-sm font-semibold">{money(r.base)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase text-muted-foreground">{t('breakdown.distance')}</p>
                      <p className="text-sm font-semibold">{money(r.distance)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase text-muted-foreground">{t('breakdown.tips')}</p>
                      <p className="text-sm font-semibold">{money(r.tip)}</p>
                    </div>
                  </div>

                  <dl className="mt-2 flex justify-between text-xs text-muted-foreground">
                    <div className="flex gap-1.5">
                      <dt>{t('balances.paidByRestaurant')}</dt>
                      <dd className="font-semibold text-foreground">{money(r.paid)}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>{t('balances.lifetime')}</dt>
                      <dd className="font-semibold text-foreground">{money(r.lifetime)}</dd>
                    </div>
                  </dl>

                  {pending && (
                    <p className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning">
                      {r.available > 0
                        ? t('balances.pendingWithNew', {
                            requested: money(r.requested),
                            restaurant: restaurantName,
                            available: money(r.available),
                          })
                        : t('balances.pendingNothingNew', {
                            requested: money(r.requested),
                            restaurant: restaurantName,
                          })}
                    </p>
                  )}

                  <Button
                    variant="gradient"
                    fullWidth
                    className="mt-3"
                    disabled={!canRequest}
                    onClick={() => openRequest(r)}
                    leftIcon={<Send className="h-4 w-4" />}
                  >
                    {pending
                      ? t('balances.requestPending')
                      : r.available > 0
                        ? t('balances.request', { amount: money(r.available) })
                        : t('balances.nothingToWithdraw')}
                  </Button>
                  {canRequest && manyRestaurants && (
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      {t('balances.settlesOnly', { restaurant: restaurantName })}
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-1 px-1 font-display text-lg font-semibold">{t('withdrawals.title')}</h2>
      <p className="mb-2 px-1 text-xs text-muted-foreground">{t('withdrawals.oneRestaurantEach')}</p>
      {withdrawals.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t('withdrawals.empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {withdrawals.map((w) => {
            const label = restaurantLabel(w.branch);
            const subtitle = branchSubtitle(label);
            return (
              <li key={w.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {displayRestaurantName(label.restaurantName, locale)}
                      </p>
                      {subtitle && (
                        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {w.bank_name} · ··{w.account_number.slice(-4)} ·{' '}
                        {new Date(w.created_at).toLocaleDateString(intlLocaleFor(locale))}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-display text-lg font-bold">{money(Number(w.amount))}</p>
                      <Badge
                        variant={
                          w.status === 'paid'
                            ? 'success'
                            : w.status === 'rejected'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {isWithdrawalStatus(w.status) ? t(`withdrawals.status.${w.status}`) : w.status}
                      </Badge>
                    </div>
                  </div>
                  {w.status === 'rejected' && w.rejection_reason && (
                    <p className="mt-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
                      {w.rejection_reason}
                    </p>
                  )}
                  {w.status === 'paid' && (
                    <Link
                      href={`/app/earnings/receipt/${w.id}`}
                      className="focus-ring mt-2 inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-primary"
                    >
                      <Receipt className="h-4 w-4" /> {t('withdrawals.viewReceipt')}
                    </Link>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet open={requesting !== null} onClose={() => setRequesting(null)} title={t('request.title')}>
        {requesting && (
          <div className="space-y-3 px-5 pb-8 pt-1">
            <Card className="bg-muted/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {displayRestaurantName(requesting.restaurantName, locale)}
                  </p>
                  {requestingSubtitle && (
                    <p className="truncate text-xs text-muted-foreground">{requestingSubtitle}</p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('request.summary', { deliveries: requesting.availableDeliveries })}
                  </p>
                </div>
                <p className="shrink-0 font-display text-2xl font-bold text-primary">
                  {money(requesting.available)}
                </p>
              </div>
              <p className="mt-2 border-t border-dashed border-border pt-2 text-xs text-muted-foreground">
                {t('request.settlesOnly', {
                  restaurant: displayRestaurantName(requesting.restaurantName, locale),
                })}
              </p>
            </Card>
            <PayoutQrCard qrPath={qrPath} onChange={setQrPath} compact />
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{t('request.bank')}</span>
              <input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                className="input"
                placeholder={t('request.bankPlaceholder')}
                maxLength={80}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{t('request.accountNumber')}</span>
              <input
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                className="input"
                maxLength={34}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{t('request.accountName')}</span>
              <input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                className="input"
                maxLength={80}
              />
            </label>
            {error && (
              <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <Button
              variant="gradient"
              fullWidth
              onClick={submit}
              loading={busy}
              disabled={!bankName.trim() || !accountNumber.trim() || !accountName.trim()}
            >
              {t('request.submit', { amount: money(requesting.available) })}
            </Button>
          </div>
        )}
      </Sheet>

      <style jsx>{`
        .input {
          width: 100%;
          height: 48px;
          padding: 0 1rem;
          font-size: 16px;
          border-radius: 0.875rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
        }
        .input:focus-visible {
          outline: none;
          border-color: hsl(var(--primary));
          box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
        }
      `}</style>
    </div>
  );
}
