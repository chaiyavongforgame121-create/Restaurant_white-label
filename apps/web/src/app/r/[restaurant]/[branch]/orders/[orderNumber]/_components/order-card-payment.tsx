'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, CreditCard, Loader2, RotateCcw } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { formatCurrency } from '@favornoms/shared';
import { Button, Card } from '@favornoms/ui';
import {
  CARD_PAYMENT_TIME_TO_PAY_MINUTES,
  PAYMENT_RETURN_PARAMS,
  cardFailureReasonKey,
  cardPaymentErrorCode,
  cardPaymentView,
  cardRefundTotals,
  cardRefusalKey,
  checkCardPayment,
  minutesLeftToPay,
  readPaymentReturn,
  startCardPayment,
  takeCardError,
  takeCartToClear,
  type CardRefundTotals,
  type CardStatus,
} from '@/lib/card-payment';
import {
  StripeCardForm,
  type CardFormApi,
  type CardFormState,
} from '@/components/card-payment/stripe-card-form';
import { useCart } from '@/store/cart';

interface Props {
  orderId: string;
  orderNumber: string;
  branchId: string;
  orderStatus: string;
  awaitingPayment: boolean;
  createdAt: string;
  total: number;
  payment: { status: string; gateway_metadata?: Record<string, unknown> | null };
}

/** How often, and for how long, a payment Stripe reports as processing is asked about again. */
const PROCESSING_POLL_MS = 5_000;
const PROCESSING_POLL_LIMIT = 36;

/**
 * The card payment of a storefront order, on its order page.
 *
 * This is where the checkout lands after a card step, whatever happened there, and where a diner
 * comes back from 3-D Secure or a bank page (Stripe's return_url). It asks the server where the
 * payment stands — the server asks Stripe and records a success, so nobody waits on a slow
 * webhook — and then says paid, processing or failed. An unpaid order can be paid, or paid again
 * after a decline, right here until it runs out of time; the form is Stripe's, for the branch's
 * own account, and the money goes straight there.
 *
 * It replaces the old "card payment is not available here" notice. An order from before card
 * payments were taken online carries no connected account and is told to pay the restaurant, as
 * that notice did.
 */
export function OrderCardPayment({
  orderId,
  orderNumber,
  branchId,
  orderStatus,
  awaitingPayment,
  createdAt,
  total,
  payment,
}: Props) {
  const t = useTranslations('tracking.cardPayment');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const clearCart = useCart((s) => s.clear);
  const hasStripeAccount = typeof payment.gateway_metadata?.stripe_account === 'string';

  const [status, setStatus] = React.useState<CardStatus | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  // Stripe.js's own words for the last failed attempt (already in the diner's language).
  const [attemptError, setAttemptError] = React.useState<string | null>(null);
  const [intent, setIntent] = React.useState<{
    clientSecret: string;
    publishableKey: string;
    stripeAccount: string;
  } | null>(null);
  const [intentError, setIntentError] = React.useState<string | null>(null);
  const [loadingIntent, setLoadingIntent] = React.useState(false);
  const [formState, setFormState] = React.useState<CardFormState>('loading');
  // Bumped by "Try again" after the card form failed to load, so the form mounts afresh and
  // Stripe.js is fetched again (stripeFor forgets a failed load for exactly this).
  const [formKey, setFormKey] = React.useState(0);
  const [paying, setPaying] = React.useState(false);
  const form = React.useRef<CardFormApi | null>(null);
  // What has gone back to the card; null until read, and never read for an order that was not
  // paid, since there is nothing to refund on one.
  const [refunds, setRefunds] = React.useState<CardRefundTotals | null>(null);

  const closed = orderStatus === 'cancelled' || orderStatus === 'refunded';
  const view = cardPaymentView({
    orderStatus,
    awaitingPayment,
    // The status check's answer is newer than the row the page loaded with.
    paymentStatus: status?.payment_status ?? payment.status,
    hasStripeAccount,
    state: status?.state ?? null,
    createdAt,
    nowMs,
    refunds,
    total,
  });
  const open = view === 'pay' || view === 'failed';

  const refresh = React.useCallback(async (): Promise<CardStatus | null> => {
    setChecking(true);
    try {
      const next = await checkCardPayment(orderId);
      setStatus(next);
      return next;
    } catch (err) {
      console.error('card_status_failed', (err as Error)?.message);
      return null;
    } finally {
      setChecking(false);
    }
  }, [orderId]);

  const loadIntent = React.useCallback(async () => {
    setLoadingIntent(true);
    setIntentError(null);
    try {
      const next = await startCardPayment(orderId);
      if (next.state === 'awaiting') {
        setIntent({
          clientSecret: next.client_secret,
          publishableKey: next.publishable_key,
          stripeAccount: next.stripe_account,
        });
      } else {
        // Paid, or on its way, since this page last looked.
        void refresh();
      }
    } catch (err) {
      const code = cardPaymentErrorCode((err as Error)?.message ?? '');
      if (code === 'already_paid') {
        void refresh();
      } else {
        if (!code) console.error('card_intent_failed', (err as Error)?.message);
        setIntentError(cardRefusalKey(code));
      }
    } finally {
      setLoadingIntent(false);
    }
  }, [orderId, refresh]);

  // Arriving: from the checkout (paid, failed or not started), back from Stripe's return_url, or
  // simply opening the order. The cart the checkout could not empty before a redirect is emptied
  // here, the return's query (the client secret among it) is taken off the address bar, and the
  // payment is re-checked with Stripe before anything is shown as unpaid.
  const arrived = React.useRef(false);
  React.useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    if (takeCartToClear(branchId, orderNumber)) clearCart();
    // From the router, not window.location: after the checkout's client-side push the page can
    // render before the address bar has caught up.
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    const back = readPaymentReturn(params);
    const carried = takeCardError(orderId);
    if (carried) setAttemptError(carried);
    if (PAYMENT_RETURN_PARAMS.some((key) => params.has(key))) {
      for (const key of PAYMENT_RETURN_PARAMS) params.delete(key);
      const query = params.toString();
      window.history.replaceState(window.history.state, '', `${pathname}${query ? `?${query}` : ''}`);
    }
    if (!hasStripeAccount || payment.status === 'completed' || payment.status === 'refunded') return;
    if (orderStatus === 'cancelled' || orderStatus === 'refunded') return;
    void (async () => {
      const now = await refresh();
      const state = now?.state ?? null;
      if (state === 'paid' || state === 'processing') return;
      // Nothing to offer once the time is up; the expiry job is about to cancel the order.
      if (minutesLeftToPay(createdAt, Date.now()) <= 0) return;
      if (back.paymentIntent && back.redirectStatus === 'succeeded' && state === null) return;
      void loadIntent();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stripe released the order (the webhook flipped awaiting_payment, and realtime brought the
  // order row) while this page was open: ask once more so the box says paid rather than "pay now".
  const wasAwaiting = React.useRef(awaitingPayment);
  React.useEffect(() => {
    const released = wasAwaiting.current && !awaitingPayment;
    wasAwaiting.current = awaitingPayment;
    if (!released || !hasStripeAccount || status?.state === 'paid') return;
    if (orderStatus === 'cancelled' || orderStatus === 'refunded') return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingPayment]);

  // The refunds on this card payment, read when there can be any: the order was paid when the
  // page loaded, or it has closed (realtime brings the cancel while the diner watches, and the
  // restaurant's refund is on record before the order is cancelled). A failed read leaves the
  // box as it was; the page is re-read on the next visit.
  const paidOnLoad = payment.status === 'completed' || payment.status === 'refunded';
  const paidNow = paidOnLoad || status?.state === 'paid';
  React.useEffect(() => {
    if (!hasStripeAccount || !(closed || paidNow)) return;
    let stale = false;
    void (async () => {
      // By order, not by this payment row: an order can carry one card row per attempt, and the
      // refund belongs to whichever attempt was charged. Every payment_refunds row is a Stripe
      // card refund, so nothing else is counted.
      const { data, error } = await getBrowserClient()
        .from('payment_refunds')
        .select('amount, status')
        .eq('order_id', orderId);
      if (stale) return;
      if (error) {
        console.error('card_refunds_read_failed', error.message);
        return;
      }
      setRefunds(cardRefundTotals(data as Array<{ amount: number | string; status: string }> | null));
    })();
    return () => {
      stale = true;
    };
  }, [hasStripeAccount, closed, paidNow, orderId]);

  // A payment still being taken (a bank debit, a slow 3-D Secure) is asked about again for a few
  // minutes; after that the webhook and the realtime order update carry the news.
  const polls = React.useRef(0);
  React.useEffect(() => {
    if (status?.state !== 'processing' || polls.current >= PROCESSING_POLL_LIMIT) return;
    const id = window.setTimeout(() => {
      polls.current += 1;
      void refresh();
    }, PROCESSING_POLL_MS);
    return () => window.clearTimeout(id);
  }, [status, refresh]);

  // The minutes left to pay, kept current while there is something to pay.
  React.useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [open]);

  const pay = async () => {
    const card = form.current;
    if (!card || paying) return;
    setPaying(true);
    setAttemptError(null);
    try {
      const outcome = await card.confirm(null, `${window.location.origin}${pathname}`);
      if (outcome.error) {
        setAttemptError(outcome.error.message ?? null);
      }
      await refresh();
    } catch (err) {
      console.error('card_confirm_failed', (err as Error)?.message);
      setAttemptError(null);
      await refresh();
    } finally {
      setPaying(false);
    }
  };

  // The card form could not load (js.stripe.com blocked, the connection dropped, or Stripe
  // refused the form). Mount it again, and ask the server again too: if the order can no longer
  // be paid by card, its answer says why instead of a form that fails the same way.
  const retryForm = () => {
    setFormState('loading');
    setFormKey((k) => k + 1);
    void loadIntent();
  };

  if (view === 'closed') return null;

  // What went back to the card, in dollars. A payment marked refunded before its refund rows were
  // read went back in full.
  const refundedAmount = refunds ? (refunds.refundedCents + refunds.pendingCents) / 100 : total;

  if (view === 'refunded' || view === 'refunding') {
    return (
      <Card role="status" className="mt-6 border-info/40 bg-info/5 p-4">
        <p className="flex items-center gap-2 font-semibold">
          <RotateCcw className="h-5 w-5 text-info" />
          {view === 'refunded' ? t('refundedTitle') : t('refundingTitle')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(view === 'refunded' ? 'refundedBody' : 'refundingBody', { amount: formatCurrency(refundedAmount) })}
        </p>
      </Card>
    );
  }

  if (view === 'refundFailed') {
    return (
      <Card role="status" className="mt-6 border-warning/40 bg-warning/5 p-4">
        <p className="font-semibold text-warning">{t('refundFailedTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('refundFailedBody')}</p>
      </Card>
    );
  }

  if (view === 'paid') {
    // Part of it already given back (a missing item, say): the diner should see that here too.
    const partCents = refunds ? refunds.refundedCents + refunds.pendingCents : 0;
    return (
      <Card className="mt-6 border-success/40 bg-success/5 p-4">
        <p className="flex items-center gap-2 font-semibold text-success">
          <CheckCircle2 className="h-5 w-5" /> {t('paidTitle')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{t('paidBody')}</p>
        {partCents > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('partlyRefunded', { amount: formatCurrency(partCents / 100) })}
          </p>
        )}
      </Card>
    );
  }

  if (view === 'processing') {
    return (
      <Card role="status" className="mt-6 p-4">
        <p className="flex items-center gap-2 font-semibold">
          <Loader2 className="h-5 w-5 animate-spin text-primary" /> {t('processingTitle')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{t('processingBody')}</p>
      </Card>
    );
  }

  if (view === 'expired') {
    return (
      <Card role="status" className="mt-6 border-warning/40 bg-warning/5 p-4">
        <p className="font-semibold text-warning">{t('expiredTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('expiredBody', { minutes: CARD_PAYMENT_TIME_TO_PAY_MINUTES })}
        </p>
      </Card>
    );
  }

  if (view === 'payAtRestaurant') {
    return (
      <Card role="status" className="mt-6 border-warning/40 bg-warning/5 p-4">
        <p className="text-sm font-semibold text-warning">{t('payAtRestaurantTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('payAtRestaurantBody')}</p>
      </Card>
    );
  }

  // 'pay' or 'failed': the order waits for its money, and the form is right here.
  const failed = view === 'failed';
  const reason = failed
    ? attemptError || t(`reasons.${cardFailureReasonKey(status?.failure_code ?? null)}` as never)
    : attemptError;
  const minutes = minutesLeftToPay(createdAt, nowMs);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <Card className={`mt-6 p-4 ${failed ? 'border-danger/40 bg-danger/5' : ''}`}>
        <p className="flex items-center gap-2 font-semibold">
          <CreditCard className="h-5 w-5 text-primary" />
          {failed ? t('failedTitle') : t('payTitle', { amount: formatCurrency(total) })}
        </p>
        {reason && <p className="mt-1 text-sm text-danger">{reason}</p>}
        <p className="mt-1 text-sm text-muted-foreground">
          {failed ? `${t('failedBody')} ` : ''}
          {t('payBody', { minutes })}
        </p>

        <div className="mt-3">
          {intentError ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-danger">
                {t(`errors.${intentError}` as never)}
              </p>
              {(intentError === 'generic' || intentError === 'inProgress') && (
                <Button variant="outline" size="md" fullWidth loading={loadingIntent} onClick={() => void loadIntent()}>
                  {t('retry')}
                </Button>
              )}
            </div>
          ) : !intent ? (
            <p role="status" className="text-xs text-muted-foreground">
              {checking ? t('checking') : t('preparing')}
            </p>
          ) : (
            <>
              <StripeCardForm
                key={formKey}
                publishableKey={intent.publishableKey}
                stripeAccount={intent.stripeAccount}
                clientSecret={intent.clientSecret}
                locale={locale}
                onApi={(api) => {
                  form.current = api;
                }}
                onStateChange={setFormState}
              />
              {formState === 'failed' ? (
                <div className="mt-2 space-y-2">
                  <p role="alert" className="text-sm text-danger">
                    {t('errors.generic')}
                  </p>
                  <Button variant="outline" size="md" fullWidth loading={loadingIntent} onClick={retryForm}>
                    {t('retry')}
                  </Button>
                </div>
              ) : (
                <Button
                  className="mt-3"
                  variant="gradient"
                  size="lg"
                  fullWidth
                  loading={paying}
                  disabled={formState !== 'ready'}
                  onClick={() => void pay()}
                >
                  {t('payNow', { amount: formatCurrency(total) })}
                </Button>
              )}
              <p className="mt-2 text-xs text-muted-foreground">{t('securedNote')}</p>
            </>
          )}
        </div>
      </Card>
    </motion.div>
  );
}
