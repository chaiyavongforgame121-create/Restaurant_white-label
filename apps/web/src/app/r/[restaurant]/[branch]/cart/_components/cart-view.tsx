'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ShoppingBag, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency } from '@favornoms/shared';
import { Button, Card, EmptyState, IconButton, QuantityStepper } from '@favornoms/ui';
import { useCart } from '@/store/cart';
import { VoiceOrderButton } from './voice-order-button';

export function CartView({ branchId }: { branchId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const params = useParams<{ restaurant: string; branch: string }>();
  const base = `/r/${params.restaurant}/${params.branch}`;

  const [hydrated, setHydrated] = React.useState(() => useCart.persist.hasHydrated());
  React.useEffect(() => {
    if (useCart.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useCart.persist.onFinishHydration(() => setHydrated(true));
    void useCart.persist.rehydrate();
    return unsub;
  }, []);

  const lines = useCart((s) => s.lines);
  const subtotal = useCart((s) => s.subtotal());
  const setQuantity = useCart((s) => s.setQuantity);
  const remove = useCart((s) => s.remove);
  const setLineNotes = useCart((s) => s.setLineNotes);
  const notes = useCart((s) => s.notes);
  const setNotes = useCart((s) => s.setNotes);

  if (!hydrated) return <div className="container max-w-2xl pt-4 text-sm text-muted-foreground">Loading…</div>;

  const deliveryFee = lines.length > 0 ? 40 : 0;
  const serviceFee = lines.length > 0 ? Math.round(subtotal * 0.05) : 0;
  const total = subtotal + deliveryFee + serviceFee;

  return (
    <div className="container max-w-2xl pt-4">
      <header className="mb-5 flex items-center gap-3">
        <IconButton label={t('common.back')} onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </IconButton>
        <h1 className="font-display text-2xl font-bold">{t('cart.title')}</h1>
      </header>

      <div className="mb-5">
        <VoiceOrderButton branchId={branchId} />
      </div>

      {lines.length === 0 ? (
        <EmptyState
          icon={<ShoppingBag className="h-7 w-7" />}
          title={t('cart.empty')}
          description={t('cart.emptyDescription')}
          action={
            <Link href={base}>
              <Button variant="gradient" size="lg">
                {t('cart.browseMenu')}
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-5">
          <ul className="space-y-3">
            <AnimatePresence initial={false}>
              {lines.map((line) => (
                <motion.li
                  key={line.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.25 }}
                >
                  <Card className="flex gap-3 overflow-hidden p-3">
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl">
                      {line.imageUrl ? (
                        <Image
                          src={line.imageUrl}
                          alt={line.name}
                          fill
                          sizes="80px"
                          className="object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-sunset" aria-hidden />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="line-clamp-2 font-display text-base font-semibold leading-tight">
                          {line.name}
                        </h3>
                        <IconButton
                          label="Remove"
                          size="sm"
                          onClick={() => remove(line.id)}
                          className="text-danger hover:bg-danger/10"
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
                      {line.comboId && line.comboContents && line.comboContents.length > 0 && (
                        <ul className="text-xs text-muted-foreground">
                          {line.comboContents.map((c, i) => (
                            <li key={i}>
                              · {c.quantity > 1 ? `${c.quantity}× ` : ''}{c.item_name}
                            </li>
                          ))}
                        </ul>
                      )}
                      {line.modifiers && line.modifiers.length > 0 && (
                        <ul className="text-xs text-muted-foreground">
                          {line.modifiers.map((m) => (
                            <li key={m.option_id}>
                              + {m.option_name}
                              {Number(m.price_delta) !== 0 && (
                                <span> ({m.price_delta > 0 ? '+' : ''}{formatCurrency(m.price_delta)})</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-primary">
                          {formatCurrency(
                            (line.unitPrice + (line.modifiers ?? []).reduce((s, m) => s + Number(m.price_delta ?? 0), 0))
                            * line.quantity,
                          )}
                        </span>
                        <QuantityStepper
                          value={line.quantity}
                          onChange={(q) => setQuantity(line.id, q)}
                          min={0}
                          size="sm"
                        />
                      </div>
                      <input
                        type="text"
                        value={line.notes ?? ''}
                        onChange={(e) => setLineNotes(line.id, e.target.value)}
                        placeholder={t('cart.notesPlaceholder')}
                        className="focus-ring w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground"
                        aria-label={`Note for ${line.name}`}
                      />
                    </div>
                  </Card>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>

          <Card className="p-4">
            <label htmlFor="cart-notes" className="text-sm font-medium">
              {t('cart.notes')}
            </label>
            <textarea
              id="cart-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('cart.notesPlaceholder')}
              rows={2}
              className="focus-ring mt-2 w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-base"
            />
          </Card>

          <Card className="p-4">
            <dl className="space-y-2 text-sm">
              <Row label={t('cart.subtotal')} value={formatCurrency(subtotal)} />
              <Row label={t('cart.deliveryFee')} value={formatCurrency(deliveryFee)} />
              <Row label={t('cart.serviceFee')} value={formatCurrency(serviceFee)} />
              <div className="my-2 h-px bg-border" />
              <Row label={t('cart.total')} value={formatCurrency(total)} bold />
            </dl>
          </Card>
        </div>
      )}

      {lines.length > 0 && (
        <>
          <GuestSignInHint base={base} />
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="sticky inset-x-0 bottom-16 mt-6 pb-2 lg:bottom-0 lg:py-4"
          >
            <Link href={`${base}/checkout`}>
              <Button variant="gradient" size="xl" fullWidth>
                {t('cart.checkout')} · {formatCurrency(total)}
              </Button>
            </Link>
          </motion.div>
        </>
      )}

    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? 'text-base font-bold' : ''}`}>
      <dt>{label}</dt>
      <dd className={bold ? 'font-display text-xl text-primary' : ''}>{value}</dd>
    </div>
  );
}

function GuestSignInHint({ base }: { base: string }) {
  const [signedIn, setSignedIn] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const { getBrowserClient } = await import('@favornoms/database/client');
      const supabase = getBrowserClient();
      const { data } = await supabase.auth.getUser();
      if (!cancelled) setSignedIn(!!data.user);
    })();
    return () => { cancelled = true; };
  }, []);

  if (signedIn !== false) return null;
  return (
    <div className="mt-5 rounded-2xl border border-border bg-muted/40 p-4 text-sm">
      <p>
        <strong>Continuing as guest.</strong>{' '}
        <Link
          href={`${base}/sign-in?next=${encodeURIComponent(`${base}/checkout`)}`}
          className="text-primary underline"
        >
          Sign in
        </Link>{' '}
        to earn loyalty points and reorder with one tap.
      </p>
    </div>
  );
}
