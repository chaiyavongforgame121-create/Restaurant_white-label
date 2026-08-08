'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bike, ShoppingBag, Store } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@favornoms/ui';
import { useCart, type OrderChannel } from '@/store/cart';

interface Props {
  branchId: string;
  branchName?: string;
  /** `delivery` entitlement. Defaults false so a missing prop cannot sell delivery. */
  canDeliver?: boolean;
}

/**
 * Blocking order-type picker. Delivery, pickup and dine-in change the price, the
 * fields the diner has to fill in and where the food ends up, so the storefront
 * makes the diner say which one before anything can go in the cart.
 *
 * Mounted on all three ordering surfaces (menu, cart, checkout) rather than in
 * the layout — the layout also wraps order tracking, receipts and account pages,
 * which must stay reachable without an order type. Same reasoning as the
 * entitlement gate in lib/tenant.ts.
 *
 * Deliberately not dismissible: no backdrop click, no Escape, no close button.
 */
export function OrderTypeGate({ branchId, branchName, canDeliver = false }: Props) {
  const t = useTranslations();

  // useCart.persist is undefined during SSR — start false and confirm hydration
  // in the effect, matching cart-view / checkout-view / app-shell.
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    const persist = useCart.persist;
    if (!persist || persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = persist.onFinishHydration(() => setHydrated(true));
    void persist.rehydrate();
    return unsub;
  }, []);

  const channel = useCart((s) => s.channel);
  const channelBranchId = useCart((s) => s.channelBranchId);
  const setChannel = useCart((s) => s.setChannel);
  const resolveChannel = useCart((s) => s.resolveChannel);

  // Only after hydration: before it the store still holds initializer defaults,
  // and rehydration would merge the persisted values straight back over any
  // decision made here.
  React.useEffect(() => {
    if (!hydrated) return;
    resolveChannel(canDeliver, branchId);
  }, [hydrated, canDeliver, branchId, resolveChannel]);

  const open = hydrated && (channel === null || channelBranchId !== branchId);

  // Nothing behind the overlay should scroll while the gate is up.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Move focus into the dialog and keep it there. The backdrop only absorbs
  // POINTER events: the gate renders inside <main>, which comes after the header
  // and nav in DOM order, so without a trap the first Tab lands on the brand link
  // and a keyboard user can fill a whole cart without ever picking an order type.
  // It is also what makes `aria-modal` real — a screen reader only honours it
  // once the virtual cursor is inside the dialog.
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const tiles = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled])'));
    const focusFirst = () => (tiles()[0] ?? panel).focus();
    focusFirst();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = tiles();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const outside = !panel.contains(active);
      if (e.shiftKey ? active === first || outside : active === last || outside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    // Backstop for focus that arrives from outside the keydown path — a round
    // trip through the browser chrome, or a stray programmatic focus().
    const onFocusIn = (e: FocusEvent) => {
      if (!panel.contains(e.target as Node)) focusFirst();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  const options: Array<{ value: OrderChannel; label: string; hint: string; icon: React.ReactNode }> = [
    ...(canDeliver
      ? [
          {
            value: 'delivery' as const,
            label: t('channel.delivery'),
            hint: t('orderType.deliveryHint'),
            icon: <Bike className="h-6 w-6" />,
          },
        ]
      : []),
    {
      value: 'pickup',
      label: t('channel.pickup'),
      hint: t('orderType.pickupHint'),
      icon: <ShoppingBag className="h-6 w-6" />,
    },
    {
      value: 'dine_in',
      label: t('channel.dineIn'),
      hint: t('orderType.dineInHint'),
      icon: <Store className="h-6 w-6" />,
    },
  ];

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="order-type-gate-title"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            initial={{ opacity: 0, y: 48, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="relative w-full max-w-md overflow-hidden rounded-t-3xl bg-card shadow-2xl outline-none sm:mx-4 sm:rounded-3xl"
          >
            <div className="relative bg-gradient-warm p-6 text-white">
              <div className="absolute inset-0 bg-noise opacity-30" />
              <div className="relative">
                <h2 id="order-type-gate-title" className="font-display text-2xl font-bold">
                  {t('orderType.title')}
                </h2>
                <p className="mt-1 text-sm text-white/85">
                  {branchName ? t('orderType.subtitleNamed', { branch: branchName }) : t('orderType.subtitle')}
                </p>
              </div>
            </div>

            <div className="grid gap-3 p-5">
              {options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setChannel(opt.value, branchId)}
                  className={cn(
                    'focus-ring flex items-center gap-4 rounded-2xl border border-border bg-background px-4 py-4 text-left transition-colors',
                    'hover:border-primary hover:bg-primary/5',
                  )}
                >
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    {opt.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-display text-lg font-semibold">{opt.label}</span>
                    <span className="block text-sm text-muted-foreground">{opt.hint}</span>
                  </span>
                </button>
              ))}
              <p className="px-1 text-center text-xs text-muted-foreground">{t('orderType.changeLater')}</p>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
