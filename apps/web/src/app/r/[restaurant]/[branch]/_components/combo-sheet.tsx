'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { formatCurrency } from '@favornoms/shared';
import { Button, QuantityStepper, Sheet } from '@favornoms/ui';
import { useCart } from '@/store/cart';

export interface ComboRow {
  id: string;
  name: string;
  description: string | null;
  total_price: number | string;
  image_url: string | null;
  items: Array<{ menu_item_id: string; item_name: string; quantity: number; list_price: number }>;
}

/**
 * Detail sheet for a combo, mirroring MenuItemSheet.
 *
 * Combos used to drop straight into the cart from the carousel — the same complaint the
 * per-item quick-add had: the diner never got to see what was actually in the deal before
 * committing. A combo has no modifier groups to choose, but it DOES bundle several dishes
 * and a saving, which is exactly the thing worth reading first. So the card opens this and
 * the Add button lives here, next to the full contents list and a quantity stepper.
 */
export function ComboSheet({
  combo,
  branchId,
  onClose,
  requireAuthThen,
}: {
  combo: ComboRow | null;
  branchId: string;
  onClose: () => void;
  /** Adding is a mutation, so it stays behind the same login gate as every other add. */
  requireAuthThen: (action: () => void) => void;
}) {
  const t = useTranslations();
  const addCombo = useCart((s) => s.addCombo);
  const [qty, setQty] = React.useState(1);

  // Reset the stepper whenever a different combo is opened, otherwise the previous
  // combo's quantity carries over into the next one.
  React.useEffect(() => {
    if (combo) setQty(1);
  }, [combo?.id]);

  // Every hook above runs unconditionally, so this early return keeps hook order stable.
  if (!combo) return null;

  const unit = Number(combo.total_price);
  const list = (combo.items ?? []).reduce(
    (s, it) => s + Number(it.list_price ?? 0) * (it.quantity ?? 1),
    0,
  );
  const savings = list - unit;
  const total = unit * qty;

  const handleAdd = () => {
    requireAuthThen(() => {
      addCombo(
        {
          comboId: combo.id,
          name: combo.name,
          imageUrl: combo.image_url,
          totalPrice: unit,
          branchId,
          contents: (combo.items ?? []).map((it) => ({
            item_name: it.item_name,
            quantity: it.quantity,
          })),
        },
        qty,
      );
      onClose();
    });
  };

  return (
    <Sheet open onClose={onClose} hideCloseButton className="max-h-[94dvh]">
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-t-3xl">
        {combo.image_url ? (
          <Image src={combo.image_url} alt={combo.name} fill sizes="100vw" priority className="object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-gradient-warm text-5xl text-white" aria-hidden>
            🍔
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-card via-card/20 to-transparent" />
        <button
          onClick={onClose}
          aria-label="Close"
          className="focus-ring absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-card/85 text-foreground shadow-soft backdrop-blur"
        >
          <span className="text-lg leading-none">×</span>
        </button>
      </div>

      <div className="px-5 pb-32 pt-2 lg:pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold leading-tight">{combo.name}</h2>
            {combo.description && (
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">{combo.description}</p>
            )}
          </div>
          <span className="text-right">
            {savings > 0 && (
              <span className="block text-xs text-muted-foreground line-through">
                {formatCurrency(list)}
              </span>
            )}
            <span className="font-display text-2xl font-bold text-primary">{formatCurrency(unit)}</span>
            {savings > 0 && (
              <span className="block text-[10px] font-bold uppercase tracking-wider text-success">
                Save {formatCurrency(savings)}
              </span>
            )}
          </span>
        </div>

        <div className="mt-6">
          <p className="font-display text-sm font-semibold">What&apos;s included</p>
          <ul className="mt-2 space-y-2">
            {(combo.items ?? []).map((it, i) => (
              <li
                key={`${it.menu_item_id}-${i}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2"
              >
                <span className="min-w-0 text-sm">
                  <span className="font-medium">{it.item_name}</span>
                  {it.quantity > 1 && (
                    <span className="ml-1.5 text-muted-foreground">× {it.quantity}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatCurrency(Number(it.list_price ?? 0) * (it.quantity ?? 1))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.05, type: 'spring', stiffness: 350, damping: 28 }}
        className="sticky inset-x-0 bottom-0 border-t border-border/60 bg-card/95 px-5 pb-safe pt-4 backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <QuantityStepper value={qty} onChange={setQty} min={1} size="lg" />
          <Button variant="gradient" size="xl" fullWidth onClick={handleAdd}>
            {`${t('menu.addToCart')} · ${formatCurrency(total)}`}
          </Button>
        </div>
      </motion.div>
    </Sheet>
  );
}
