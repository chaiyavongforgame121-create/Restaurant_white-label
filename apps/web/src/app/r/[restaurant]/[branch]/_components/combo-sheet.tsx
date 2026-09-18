'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { Package } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Button, cn, QuantityStepper, Sheet } from '@favornoms/ui';
import { useCart } from '@/store/cart';
import { stashPendingAdd } from '@/lib/pending-cart';
import { cssUrl } from '@/lib/css-url';

/** One row of v_active_combos, as the storefront reads it. */
export interface ComboRow {
  id: string;
  name: string;
  description: string | null;
  total_price: number | string;
  image_url: string | null;
  /** False while any dish in it is switched off, 86'd or short of stock: shown, not sold. */
  is_available: boolean;
  /** In the order the merchant arranged them. */
  items: Array<{
    menu_item_id: string;
    item_name: string;
    item_image_url?: string | null;
    quantity: number;
    list_price: number;
    is_available?: boolean;
  }>;
}

/** The photos of the dishes in a combo, first four distinct ones, in the combo's order. */
function dishPhotos(combo: ComboRow): string[] {
  const seen = new Set<string>();
  for (const it of combo.items ?? []) {
    if (it.item_image_url) seen.add(it.item_image_url);
  }
  return [...seen].slice(0, 4);
}

/**
 * A combo's picture, filling its (relatively positioned) parent.
 *
 * Without a photo of its own a combo used to show a burger emoji on the branch gradient -- so
 * Food Thai Thai's Family Meal of soup and green curry was advertised with a hamburger. It now
 * shows the dishes that are in it side by side, and a plain box icon when none has a photo.
 * Backgrounds rather than next/image: dish photos can come from any host a menu was imported from.
 */
export function ComboArt({ combo, className }: { combo: ComboRow; className?: string }) {
  if (combo.image_url) {
    return (
      <div
        role="img"
        aria-label={combo.name}
        className={cn('absolute inset-0 bg-muted bg-cover bg-center', className)}
        style={{ backgroundImage: cssUrl(combo.image_url) }}
      />
    );
  }
  const photos = dishPhotos(combo);
  if (photos.length === 0) {
    return (
      <div className={cn('absolute inset-0 grid place-items-center bg-muted', className)} aria-hidden>
        <Package className="h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
      </div>
    );
  }
  const quad = photos.length >= 3;
  return (
    <div
      className={cn(
        'absolute inset-0 grid gap-0.5 bg-muted',
        quad ? 'grid-cols-2 grid-rows-2' : photos.length === 2 ? 'grid-cols-2' : '',
        className,
      )}
      role="img"
      aria-label={combo.name}
    >
      {photos.map((src, i) => (
        <div
          key={src}
          // Three photos: the first takes the whole left column.
          className={cn('bg-cover bg-center', quad && photos.length === 3 && i === 0 && 'row-span-2')}
          style={{ backgroundImage: cssUrl(src) }}
        />
      ))}
    </div>
  );
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
  requireAuthThen: (action: () => void, nextPath?: string, onSignedOut?: () => void) => void;
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
  const soldOut = !combo.is_available;

  const handleAdd = () => {
    if (soldOut) return;
    const pick = {
      comboId: combo.id,
      name: combo.name,
      // No photo of its own: the cart line shows its first dish rather than a blank tile.
      imageUrl: combo.image_url ?? dishPhotos(combo)[0] ?? null,
      totalPrice: unit,
      branchId,
      contents: (combo.items ?? []).map((it) => ({
        item_name: it.item_name,
        quantity: it.quantity,
      })),
    };
    requireAuthThen(
      () => {
        addCombo(pick, qty);
        onClose();
      },
      undefined,
      // Signed out: park it so the trip through sign-in keeps the deal and quantity.
      () => stashPendingAdd({ kind: 'combo', branchId, combo: pick, quantity: qty }),
    );
  };

  return (
    <Sheet open onClose={onClose} hideCloseButton className="max-h-[94dvh]">
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-t-3xl">
        {combo.image_url ? (
          <Image
            src={combo.image_url}
            alt={combo.name}
            fill
            sizes="100vw"
            priority
            className={cn('object-cover', soldOut && 'opacity-40 grayscale')}
          />
        ) : (
          <ComboArt combo={combo} className={cn(soldOut && 'opacity-40 grayscale')} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-card via-card/20 to-transparent" />
        <button
          onClick={onClose}
          aria-label={t('common.close')}
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
              <p className="mt-1 max-w-prose whitespace-pre-line text-sm text-muted-foreground">
                {combo.description}
              </p>
            )}
            {soldOut && (
              <p className="mt-2 text-sm font-medium text-muted-foreground">
                {t('storefront.combos.soldOutHint')}
              </p>
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
                {t('storefront.combos.save', { amount: formatCurrency(savings) })}
              </span>
            )}
          </span>
        </div>

        <div className="mt-6">
          <p className="font-display text-sm font-semibold">{t('menu.whatsIncluded')}</p>
          <ul className="mt-2 space-y-2">
            {(combo.items ?? []).map((it, i) => (
              <li
                key={`${it.menu_item_id}-${i}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2"
              >
                <span className={cn('min-w-0 text-sm', it.is_available === false && 'text-muted-foreground')}>
                  <span className="font-medium">{it.item_name}</span>
                  {it.quantity > 1 && (
                    <span className="ml-1.5 text-muted-foreground">× {it.quantity}</span>
                  )}
                  {it.is_available === false && (
                    <Badge variant="muted" className="ml-2">
                      {t('menu.soldOut')}
                    </Badge>
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
          {!soldOut && <QuantityStepper value={qty} onChange={setQty} min={1} size="lg" />}
          <Button
            variant={soldOut ? 'ghost' : 'gradient'}
            size="xl"
            fullWidth
            onClick={handleAdd}
            disabled={soldOut}
            aria-label={soldOut ? t('menu.itemSoldOut', { name: combo.name }) : undefined}
          >
            {soldOut ? t('menu.soldOut') : t('menu.addWithPrice', { price: formatCurrency(total) })}
          </Button>
        </div>
      </motion.div>
    </Sheet>
  );
}
