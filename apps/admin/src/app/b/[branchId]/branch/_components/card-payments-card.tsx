'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Clock, CreditCard, ExternalLink, Lock, Unplug } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { StripeConnectError, callStripeConnect, type StripeConnectAction } from '@favornoms/database/queries';
import { Badge, Button, Card, useConfirm } from '@favornoms/ui';
import {
  type CardAccountState,
  type CardPaymentsStatus,
  cardPaymentsStatus,
  connectErrorKey,
  disabledNotice,
  requirementGroups,
  shareOptions,
  sharedWith,
  stripeReturnParam,
  withoutStripeParam,
} from './card-payments-model';

// Card payments: the Stripe account this branch's diners pay into (Stripe Connect, direct
// charges, docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md). Stripe hosts the whole setup, business,
// owners and bank account included, so this card only starts it, says where it stands in plain
// words, and sends the owner back to Stripe when Stripe needs more.
//
// Every change goes through the stripe-connect-onboard edge function, which checks the
// capability itself: billing.manage (the owner) to connect, share or disconnect, branch.settings
// to check the status or open the dashboard. canConnect only decides which buttons are shown.

export interface CardPaymentsAccountRow extends CardAccountState {
  branch_id: string;
  branch_name: string;
}

interface Props {
  branchId: string;
  branchName: string;
  /** This branch's row, as RLS let the page read it. */
  account: CardAccountState | null;
  /** The restaurant's rows the caller may read, this branch's included. */
  restaurantAccounts: CardPaymentsAccountRow[];
  /** billing.manage: may connect, share and disconnect. */
  canConnect: boolean;
  /** branch.settings: may see the account at all (the RLS read). */
  canView: boolean;
  /** The card_payment entitlement. Connecting is allowed without it; diners see card only with it. */
  canUseCard: boolean;
}

const STATUS_BADGE: Record<CardPaymentsStatus, 'muted' | 'warning' | 'info' | 'success' | 'danger'> = {
  not_connected: 'muted',
  onboarding: 'warning',
  under_review: 'info',
  ready: 'success',
  action_needed: 'danger',
};

export function CardPaymentsCard({
  branchId,
  branchName,
  account: initialAccount,
  restaurantAccounts,
  canConnect,
  canView,
  canUseCard,
}: Props) {
  const t = useTranslations('branchOps.cardPayments');
  const router = useRouter();
  const confirm = useConfirm();
  const [account, setAccount] = React.useState<CardAccountState | null>(initialAccount);
  const [busy, setBusy] = React.useState<StripeConnectAction | `share:${string}` | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [dormant, setDormant] = React.useState(false);
  const handledReturn = React.useRef(false);

  // A server refresh brings a newer row (a webhook may have landed); take it.
  React.useEffect(() => setAccount(initialAccount), [initialAccount]);

  const status = cardPaymentsStatus(account);
  const groups = requirementGroups(account?.requirements_due);
  const reason = disabledNotice(account);
  const options = account ? [] : shareOptions(restaurantAccounts, branchId);
  const alsoPays = account ? sharedWith(restaurantAccounts, { branch_id: branchId, stripe_account_id: account.stripe_account_id }) : [];

  const run = React.useCallback(
    async (action: StripeConnectAction, extra?: { source_branch_id?: string }) => {
      setError(null);
      setBusy(extra?.source_branch_id ? `share:${extra.source_branch_id}` : action);
      try {
        const res = await callStripeConnect(getBrowserClient(), { branch_id: branchId, action, ...extra });
        if (res.dormant) {
          setDormant(true);
          return null;
        }
        return res;
      } catch (e) {
        const code = e instanceof StripeConnectError ? e.code : null;
        console.error('Card payments action failed', action, e);
        setError(t(connectErrorKey(code)));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [branchId, t],
  );

  const startOnboarding = React.useCallback(async () => {
    const res = await run('start');
    // A link is single-use and expires within minutes, so it is followed at once, never shown.
    if (res?.url) {
      window.location.assign(res.url);
      return;
    }
    // No link. The function stores a new account before it asks Stripe for the onboarding link,
    // so a start that failed on the link still left an account behind. Re-read the row, so the
    // card shows "Finish setting up" with Continue and Disconnect, not "Not connected" with a
    // "Use the same account" button the function would refuse with already_connected.
    router.refresh();
  }, [run, router]);

  // What Stripe says now, shown at once; the server refresh that follows brings the row itself.
  const refresh = React.useCallback(async () => {
    const res = await run('refresh');
    if (!res) return;
    if (res.connected === false) setAccount(null);
    else if (res.state) {
      const state = res.state;
      setAccount((prev) => (prev ? { ...prev, ...state } : prev));
    }
    router.refresh();
  }, [run, router]);

  // Stripe sends the owner back with ?stripe=return (they left or finished the form) or
  // ?stripe=refresh (the link had expired or was used). The parameter is removed first, so a
  // reload does not repeat it.
  React.useEffect(() => {
    if (handledReturn.current || !canView) return;
    const which = stripeReturnParam(window.location.search);
    if (!which) return;
    handledReturn.current = true;
    router.replace(withoutStripeParam(window.location.pathname, window.location.search), { scroll: false });
    if (which === 'return') {
      setNotice(t('returned'));
      void refresh();
    } else if (canConnect) {
      setNotice(t('refreshExpired'));
      void startOnboarding();
    } else {
      setNotice(t('refreshExpiredNoPermission'));
    }
  }, [canView, canConnect, router, refresh, startOnboarding, t]);

  const openDashboard = async () => {
    setNotice(null);
    const res = await run('dashboard');
    if (res?.url) window.open(res.url, '_blank', 'noopener,noreferrer');
  };

  const share = async (sourceBranchId: string) => {
    await run('share', { source_branch_id: sourceBranchId });
    // Re-read on a refusal too: already_connected means this branch has an account the page did
    // not know of (a start that failed half-way, another tab), and the card should show it.
    router.refresh();
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: t('disconnectConfirm.title', { branch: branchName }),
      body: t('disconnectConfirm.body'),
      confirmLabel: t('disconnectConfirm.confirm'),
      destructive: true,
    });
    if (!ok) return;
    const res = await run('disconnect');
    if (!res) return;
    setAccount(null);
    router.refresh();
  };

  const StatusIcon =
    status === 'ready' ? CheckCircle2 : status === 'under_review' ? Clock : status === 'not_connected' ? CreditCard : AlertTriangle;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <CreditCard className="h-5 w-5 text-primary" /> {t('title')}
        </h2>
        {canView && (
          <Badge variant={STATUS_BADGE[status]} className="flex items-center gap-1">
            <StatusIcon className="h-3.5 w-3.5" />
            {t(`status.${status}`)}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t('description')}</p>

      {!canView ? (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('readOnly')}</span>
        </p>
      ) : (
        <>
          <p className="mt-3 text-sm">
            {status === 'action_needed' && account?.charges_enabled
              ? t('statusBody.action_needed_charges_on')
              : t(`statusBody.${status}`)}
          </p>

          {reason && (
            <p className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <span>{t(`disabled.${reason}`)}</span>
            </p>
          )}

          {groups.length > 0 && status !== 'onboarding' && (
            <div className="mt-3 rounded-xl border border-border p-3 text-sm">
              <p className="font-medium">{t('requirementsTitle')}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {groups.map((g) => (
                  <li key={g}>{t(`requirements.${g}`)}</li>
                ))}
              </ul>
            </div>
          )}

          {status === 'ready' && account && !account.payouts_enabled && (
            <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>{t('payoutsOff')}</span>
            </p>
          )}

          {alsoPays.length > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">{t('sharedWith', { branches: alsoPays.join(', ') })}</p>
          )}

          {!canUseCard && (
            <p className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted px-4 py-3 text-sm">
              <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{t('packageLocked')}</span>
              <Link
                href={`/b/${branchId}/settings/plan`}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {t('viewPackages')}
              </Link>
            </p>
          )}

          {dormant && (
            <p className="mt-3 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">{t('notConfigured')}</p>
          )}
          {notice && !error && (
            <p className="mt-3 rounded-xl bg-info/10 px-4 py-3 text-sm text-foreground">{notice}</p>
          )}
          {error && <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {canConnect && status === 'not_connected' && (
              <Button onClick={startOnboarding} loading={busy === 'start'} disabled={busy !== null} leftIcon={<CreditCard className="h-4 w-4" />}>
                {t('actions.connect')}
              </Button>
            )}
            {canConnect && (status === 'onboarding' || status === 'action_needed') && (
              <Button onClick={startOnboarding} loading={busy === 'start'} disabled={busy !== null}>
                {t('actions.continue')}
              </Button>
            )}
            {account && status !== 'onboarding' && (
              <Button
                variant="outline"
                onClick={openDashboard}
                loading={busy === 'dashboard'}
                disabled={busy !== null}
                leftIcon={<ExternalLink className="h-4 w-4" />}
              >
                {t('actions.dashboard')}
              </Button>
            )}
            {account && (
              <Button variant="ghost" onClick={refresh} loading={busy === 'refresh'} disabled={busy !== null}>
                {t('actions.refresh')}
              </Button>
            )}
            {canConnect && account && (
              <Button
                variant="ghost"
                onClick={disconnect}
                loading={busy === 'disconnect'}
                disabled={busy !== null}
                leftIcon={<Unplug className="h-4 w-4" />}
                className="text-danger"
              >
                {t('actions.disconnect')}
              </Button>
            )}
          </div>

          {canConnect && options.length > 0 && (
            <div className="mt-4 rounded-xl border border-border p-3">
              <p className="text-sm text-muted-foreground">{t('shareHint')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {options.map((o) => (
                  <Button
                    key={o.accountId}
                    variant="soft"
                    size="sm"
                    onClick={() => share(o.sourceBranchId)}
                    loading={busy === `share:${o.sourceBranchId}`}
                    disabled={busy !== null}
                  >
                    {t('actions.share', { branches: o.branchNames.join(', ') })}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {!canConnect && (
            <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('ownerOnly')}</span>
            </p>
          )}
        </>
      )}
    </Card>
  );
}
