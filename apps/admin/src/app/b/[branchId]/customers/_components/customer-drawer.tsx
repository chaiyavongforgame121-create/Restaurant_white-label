'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Gift, MapPin, Receipt, UserRound, X } from 'lucide-react';
import type { BranchCustomerDetail } from '@favornoms/database/queries';
import {
  DEFAULT_UI_LOCALE,
  formatCurrency,
  formatPhone,
  intlLocaleFor,
  isUiLocale,
} from '@favornoms/shared';
import { Badge, Sheet } from '@favornoms/ui';
import { AdjustPoints } from './adjust-points';

type LoadState =
  | { kind: 'ok'; customer: BranchCustomerDetail }
  | { kind: 'notFound' }
  | { kind: 'error' };

interface Props {
  state: LoadState;
  /** The list URL without `customer`, which is what closing the drawer navigates to. */
  closeHref: string;
  /** The branch's own names for its tiers. */
  tierLabels: Record<string, string>;
  branchId: string;
  /** loyalty.manage at this branch: shows the "Adjust points" action. */
  canAdjustPoints?: boolean;
}

const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
  'refunded',
] as const;
const ORDER_CHANNELS = ['dine_in', 'pickup', 'delivery', 'qr_ordering'] as const;
const LEDGER_TYPES = ['earned', 'redeemed', 'adjusted', 'expired'] as const;

const statusVariant = (status: string): 'success' | 'neutral' | 'info' =>
  status === 'completed' ? 'success' : status === 'cancelled' || status === 'refunded' ? 'neutral' : 'info';

const has = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/**
 * One customer as THIS branch knows them. The drawer is driven by the URL (`?customer=<id>`) so
 * the server does the reading under the merchant's own RLS, a reload keeps it open, and closing
 * it is just going back to the list URL.
 */
export function CustomerDrawer({ state, closeHref, tierLabels, branchId, canAdjustPoints = false }: Props) {
  const t = useTranslations('customers.detail');
  const tOrders = useTranslations('orders');
  const router = useRouter();
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(intlLocale, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtNumber = (n: number) => n.toLocaleString(intlLocale);
  const close = React.useCallback(() => router.replace(closeHref, { scroll: false }), [router, closeHref]);
  const tierName = (key: string) => tierLabels[key] ?? key.replace(/^./, (c) => c.toUpperCase());

  const customer = state.kind === 'ok' ? state.customer : null;
  const title = customer ? (customer.name ?? t('unnamed')) : t('title');

  return (
    <Sheet open onClose={close} side="right" title={title} ariaLabel={title}>
      {state.kind === 'notFound' ? (
        <div className="px-5 pb-8 pt-2">
          <p className="font-semibold">{t('notFound.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('notFound.description')}</p>
        </div>
      ) : state.kind === 'error' ? (
        <p className="mx-5 mt-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">{t('loadError')}</p>
      ) : customer ? (
        <div className="space-y-6 px-5 pb-8 pt-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{t('since', { date: fmtDate(customer.created_at) })}</span>
            {!customer.has_account ? <Badge variant="neutral">{t('walkInRecord')}</Badge> : null}
            {customer.name_source === 'order' ? (
              <span className="text-xs">· {t('nameFromOrder')}</span>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-3">
            <Stat label={t('stats.orders')} value={fmtNumber(customer.total_orders)} />
            <Stat label={t('stats.spent')} value={formatCurrency(customer.total_spent)} />
            <Stat
              label={t('stats.lastSeen')}
              value={customer.last_order_at ? fmtDate(customer.last_order_at) : t('never')}
            />
            <Stat
              label={t('stats.points')}
              value={customer.wallet ? fmtNumber(customer.wallet.points_balance) : '—'}
              extra={
                customer.wallet?.tier ? (
                  <Badge variant="neutral">{tierName(customer.wallet.tier)}</Badge>
                ) : null
              }
            />
          </dl>

          <section>
            <SectionTitle icon={<UserRound className="h-4 w-4" />}>{t('contact.title')}</SectionTitle>
            <dl className="mt-2 space-y-1.5 text-sm">
              <Row label={t('contact.phone')}>
                {customer.phone ? (
                  <>
                    {formatPhone(customer.phone)}
                    {customer.phone_from_order ? (
                      <span className="ml-1 text-xs text-muted-foreground">({t('fromOrder')})</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">{t('contact.none')}</span>
                )}
              </Row>
              <Row label={t('contact.email')}>
                {customer.email ? (
                  <span className="break-all">{customer.email}</span>
                ) : (
                  <span className="text-muted-foreground">{t('contact.none')}</span>
                )}
              </Row>
              {customer.birthday ? (
                <Row label={t('contact.birthday')}>
                  {new Date(`${customer.birthday}T12:00:00Z`).toLocaleDateString(intlLocale, {
                    month: 'long',
                    day: 'numeric',
                  })}
                </Row>
              ) : null}
              <Row label={t('contact.marketing')}>
                <span className="inline-flex items-center gap-1">
                  {customer.marketing_consent ? (
                    <Check className="h-4 w-4 text-success" aria-hidden />
                  ) : (
                    <X className="h-4 w-4 text-muted-foreground" aria-hidden />
                  )}
                  {customer.marketing_consent ? t('contact.consentYes') : t('contact.consentNo')}
                </span>
              </Row>
            </dl>
          </section>

          <section>
            <SectionTitle icon={<Receipt className="h-4 w-4" />}>{t('orders.title')}</SectionTitle>
            {customer.orders.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{t('orders.empty')}</p>
            ) : (
              <>
                <ul className="mt-2 divide-y divide-border/60 rounded-xl border border-border">
                  {customer.orders.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-semibold">{o.order_number}</p>
                        <p className="text-xs text-muted-foreground">
                          {fmtDate(o.created_at)}
                          {has(ORDER_CHANNELS, o.channel) ? ` · ${tOrders(`channel.${o.channel}`)}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant={statusVariant(o.status)}>
                          {has(ORDER_STATUSES, o.status) ? tOrders(`status.${o.status}`) : o.status}
                        </Badge>
                        <span className="font-semibold tabular-nums">{formatCurrency(o.total)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                {customer.order_count > customer.orders.length ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('orders.showing', { shown: customer.orders.length, count: customer.order_count })}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <section>
            <SectionTitle icon={<MapPin className="h-4 w-4" />}>{t('addresses.title')}</SectionTitle>
            {customer.addresses.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{t('addresses.empty')}</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {customer.addresses.map((a) => (
                  <li key={a.id} className="rounded-xl border border-border px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {a.label ? <span className="font-semibold">{a.label}</span> : null}
                      {a.is_default ? <Badge variant="neutral">{t('addresses.default')}</Badge> : null}
                    </div>
                    <p className="text-muted-foreground">{a.line}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionTitle icon={<Gift className="h-4 w-4" />}>{t('loyalty.title')}</SectionTitle>
            {customer.wallet ? (
              <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                <MiniStat label={t('loyalty.balance')} value={fmtNumber(customer.wallet.points_balance)} />
                <MiniStat label={t('loyalty.earned')} value={fmtNumber(customer.wallet.lifetime_earned)} />
                <MiniStat label={t('loyalty.spent')} value={fmtNumber(customer.wallet.lifetime_spent)} />
              </dl>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{t('loyalty.none')}</p>
            )}
            {canAdjustPoints ? (
              // Keyed by customer so switching rows never carries a half-typed correction over.
              <AdjustPoints
                key={customer.id}
                branchId={branchId}
                customerId={customer.id}
                balance={customer.wallet?.points_balance ?? null}
              />
            ) : null}
            {customer.ledger.length > 0 ? (
              <>
                <h4 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('loyalty.ledgerTitle')}
                </h4>
                <ul className="mt-1 divide-y divide-border/60 text-sm">
                  {customer.ledger.map((l) => (
                    <li key={l.id} className="flex items-start justify-between gap-3 py-1.5">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {has(LEDGER_TYPES, l.type) ? t(`loyalty.type.${l.type}`) : l.type}
                        </p>
                        <p className="truncate text-xs text-muted-foreground" title={l.description ?? undefined}>
                          {fmtDate(l.created_at)}
                          {l.description ? ` · ${l.description}` : ''}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 font-semibold tabular-nums ${l.points >= 0 ? 'text-success' : 'text-warning'}`}
                      >
                        {l.points > 0 ? '+' : l.points < 0 ? '−' : ''}
                        {fmtNumber(Math.abs(l.points))}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : customer.wallet ? (
              <p className="mt-2 text-sm text-muted-foreground">{t('loyalty.ledgerEmpty')}</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 font-display text-base font-semibold">
      {icon}
      {children}
    </h3>
  );
}

function Stat({ label, value, extra }: { label: string; value: string; extra?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-2 font-display text-lg font-semibold tabular-nums">
        {value}
        {extra}
      </dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
