'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { AlertTriangle, Clock, Flame, Star } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  defaultSelections,
  formatCurrency,
  formatUnitPrice,
  lineTotal,
  MAX_LINE_QUANTITY,
  validateSelections,
  type MenuItem,
  type UiLocale,
} from '@favornoms/shared';
import { Badge, Button, DietaryBadge, QuantityStepper, Sheet } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { listItemModifierGroups } from '@favornoms/database/queries';
import { cartLineKey, cartQuantityOf, useCart, type CartLineModifier } from '@/store/cart';
import { useRequireAuth } from '@/components/auth/require-auth';
import { cssUrl } from '@/lib/css-url';
import { stashPendingAdd } from '@/lib/pending-cart';
import { resolveRecommendations, type RecommendationRow } from '@/lib/recommendations';
import { useSoldOutText } from './sold-out';

interface Props {
  item: MenuItem | null;
  onClose: () => void;
  /** The branch's loaded menu. "You might also like" rows come back from the RPC as thin
   *  records, so each one is resolved against this list — the sheet and the cart need the
   *  effective price, the stock flag and the branch id — and dropped when it is not there. */
  items: MenuItem[];
  /** Swap the sheet to another item in place (a recommendation tap). */
  onOpenItem: (item: MenuItem) => void;
}

interface ModifierGroup {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  is_required: boolean;
  selection_type: 'single' | 'multiple';
  display_order: number;
  options: ModifierOption[];
}

interface ModifierOption {
  id: string;
  name: string;
  price_delta: number;
  is_default: boolean;
  is_active: boolean;
}

export function MenuItemSheet({ item, onClose, items, onOpenItem }: Props) {
  const t = useTranslations();
  // A value that is not a UiLocale gives English in validateSelections.
  const locale = useLocale() as UiLocale;
  const [qty, setQty] = React.useState(1);
  const [notes, setNotes] = React.useState('');
  const [groups, setGroups] = React.useState<ModifierGroup[]>([]);
  const [selections, setSelections] = React.useState<Record<string, Set<string>>>({});
  /** The item whose option groups (and default picks) `groups` and `selections` hold. */
  const [groupsFor, setGroupsFor] = React.useState<string | null>(null);
  const [recommended, setRecommended] = React.useState<RecommendationRow[]>([]);
  const add = useCart((s) => s.add);
  // Adding to the cart requires a signed-in diner; a guest is sent to sign-in
  // and returned to the menu (usePathname) afterwards.
  const { requireAuthThen } = useRequireAuth();

  const [cached, setCached] = React.useState<MenuItem | null>(item);
  const heroRef = React.useRef<HTMLDivElement>(null);

  // The newest copy of the open item: its price and sold-out flag, and what the sheet keeps
  // showing while it animates closed.
  React.useEffect(() => {
    if (item) setCached(item);
  }, [item]);

  // Keyed on the id, not the object, as the counter's item sheet is. A live menu refresh (any
  // dish edited, a stock count moving, the window regaining focus) hands the open sheet a fresh
  // object for the same dish, and keying on the object reset the sheet under the diner: a SET A
  // set to "No Egg" and seven went back to the default fried egg and one, and Add then put a
  // second, different SET A line on the bill.
  const itemId = item?.id ?? null;
  React.useEffect(() => {
    if (itemId) {
      // A recommendation tap swaps `item` while the sheet stays mounted, so a slow
      // response for the item the diner just left must not land on the new one.
      let cancelled = false;
      setQty(1);
      setNotes('');
      setGroups([]);
      setSelections({});
      setGroupsFor(null);
      // Cleared here rather than left to the RPC: the previous item's strip must not
      // linger under the new item while its own recommendations are on the way.
      setRecommended([]);
      // Same reason for the scroll: the sheet keeps its offset across a swap, so put the
      // new item's photo back in view instead of leaving the diner at the bottom.
      heroRef.current?.scrollIntoView({ block: 'start' });
      // Load modifier groups for this item
      void (async () => {
        const supabase = getBrowserClient();
        // The same reader as the counter's item sheet, so both show the options in the order the
        // merchant arranged them. This copy sorted them by price, which shuffled a group whose
        // options all cost the same. A failed read shows no options, as the inline query did.
        const groupRows: ModifierGroup[] = await listItemModifierGroups(supabase, itemId).catch((err) => {
          console.error('[menu-item-sheet] loading option groups failed', err);
          return [];
        });
        if (cancelled) return;
        setGroups(groupRows);
        // The defaults the counter's sheet starts from too (defaultSelections), so a dish opened
        // from any card, row or search result, on either surface, starts the same way.
        const defaults = defaultSelections(groupRows);
        const init: Record<string, Set<string>> = {};
        for (const g of groupRows) init[g.id] = new Set(defaults[g.id] ?? []);
        setSelections(init);
        setGroupsFor(itemId);

        // Fetch co-purchase recommendations.
        const { data: recs } = await supabase.rpc('recommendations_for_item', {
          p_menu_item_id: itemId,
          p_limit: 4,
        });
        if (cancelled) return;
        setRecommended((recs ?? []) as RecommendationRow[]);
      })();
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [itemId]);

  const view = item ?? cached;
  const soldOut = !!view?.outOfStock;
  // Add waits for this item's options, as the counter's sheet does. Tapped before they arrived it
  // added the dish with none -- not even a default the diner could see -- so the same dish added
  // a moment later, with its default picked, landed on a separate line; and it skipped any group
  // the merchant made required, which place-order does not check.
  const optionsReady = !!view && groupsFor === view.id;
  // "Sold out until 5:00 PM" for a hand-set 86, in the branch's time zone.
  const soldOutText = useSoldOutText();

  const modDelta = React.useMemo(() => {
    let sum = 0;
    for (const g of groups) {
      const picked = selections[g.id] ?? new Set();
      for (const optId of picked) {
        const opt = g.options.find((o) => o.id === optId);
        if (opt) sum += Number(opt.price_delta);
      }
    }
    return sum;
  }, [groups, selections]);

  // Same rules as before (required minimum, then the maximum), phrased in the interface
  // language with the group name exactly as the merchant typed it.
  const validation = React.useMemo(
    () => validateSelections(groups, selections, locale),
    [groups, selections, locale],
  );

  const openableRecs = React.useMemo(
    () => resolveRecommendations(recommended, items, view?.id),
    [recommended, items, view?.id],
  );

  // The chosen options, in group order, with the price each adds right now: what goes on the line.
  const chosen = React.useMemo(() => {
    const out: CartLineModifier[] = [];
    for (const g of groups) {
      const picked = selections[g.id] ?? new Set();
      for (const optId of picked) {
        const opt = g.options.find((o) => o.id === optId);
        if (opt) {
          out.push({
            group_id: g.id,
            group_name: g.name,
            option_id: opt.id,
            option_name: opt.name,
            price_delta: Number(opt.price_delta),
          });
        }
      }
    }
    return out;
  }, [groups, selections]);

  // How many of exactly this selection the cart already holds: Add lands on that line, and
  // place-order refuses a line above MAX_LINE_QUANTITY. The stepper stops at what still fits, so
  // the diner sees the limit here rather than an add that quietly stops at it.
  const lineKey = view ? cartLineKey({ menuItemId: view.id, modifiers: chosen, notes }) : null;
  const inCart = useCart((s) => (lineKey ? cartQuantityOf(s.lines, lineKey) : 0));
  const room = Math.max(0, MAX_LINE_QUANTITY - inCart);
  const lineFull = room === 0;
  // Brought down to what fits once the options or the note land on a fuller line. Rendered from
  // `addQty` meanwhile, so the stepper never shows a count Add would not put in.
  React.useEffect(() => {
    if (room > 0) setQty((q) => Math.min(q, room));
  }, [room]);
  const addQty = Math.min(qty, Math.max(1, room));

  if (!view) return null;

  // The line as place-order will charge it, and as the cart will show it: the unit (a happy-hour
  // $7.995 stays $7.995) plus options, times the quantity, rounded to the cent once.
  const total = lineTotal(view.price, modDelta, addQty);

  const toggleOption = (group: ModifierGroup, optId: string) => {
    setSelections((curr) => {
      const next = { ...curr };
      const set = new Set(next[group.id] ?? []);
      if (group.selection_type === 'single' || group.max_select === 1) {
        next[group.id] = set.has(optId) ? new Set() : new Set([optId]);
      } else {
        if (set.has(optId)) {
          set.delete(optId);
        } else if (set.size < group.max_select) {
          set.add(optId);
        }
        next[group.id] = set;
      }
      return next;
    });
  };

  const handleAdd = () => {
    if (!optionsReady || validation || soldOut || lineFull) return;
    const modifiers = chosen.length > 0 ? chosen : undefined;
    requireAuthThen(
      () => {
        add(view, addQty, notes, modifiers);
        onClose();
      },
      undefined,
      // Signed out: park the fully-configured line so sign-in does not discard the
      // quantity, modifiers and notes the diner just picked. Replayed by
      // PendingCartReplay as soon as a session exists.
      () =>
        stashPendingAdd({
          kind: 'item',
          branchId: view.branchId,
          item: view,
          quantity: addQty,
          notes: notes || undefined,
          modifiers,
        }),
    );
  };

  return (
    <Sheet open={!!item} onClose={onClose} hideCloseButton className="max-h-[94dvh]">
      <div ref={heroRef} className="relative aspect-[16/10] w-full overflow-hidden rounded-t-3xl">
        {view.imageUrl ? (
          <Image
            src={view.imageUrl}
            alt={view.name}
            fill
            sizes="100vw"
            priority
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-sunset" aria-hidden />
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
            <h2 className="font-display text-2xl font-bold leading-tight">{view.name}</h2>
            {view.description && (
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">{view.description}</p>
            )}
          </div>
          <span className="text-right">
            {view.listPrice && view.listPrice > view.price && (
              <span className="block text-xs text-muted-foreground line-through">
                {formatUnitPrice(view.listPrice)}
              </span>
            )}
            <span className="font-display text-2xl font-bold text-primary">
              {formatUnitPrice(view.price)}
            </span>
            {view.saleLabel && (
              <span className="block text-[10px] font-bold uppercase tracking-wider text-success">
                {view.saleLabel}
              </span>
            )}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {view.rating && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
              <Star className="h-4 w-4 fill-accent text-accent" />
              <span className="font-semibold text-foreground">{view.rating.toFixed(1)}</span>
              <span className="text-xs">({view.reviewCount})</span>
            </span>
          )}
          {view.prepTimeMinutes && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
              <Clock className="h-4 w-4" />
              {t('menu.minutes', { n: view.prepTimeMinutes })}
            </span>
          )}
          {view.calories && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
              <Flame className="h-4 w-4" />
              {t('menu.calories', { n: view.calories })}
            </span>
          )}
        </div>

        {view.dietaryTags && view.dietaryTags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {view.dietaryTags.map((tag) => (
              <DietaryBadge key={tag} tag={tag} />
            ))}
          </div>
        )}

        {view.allergens && view.allergens.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-warning">
              {/* The allergens themselves are the merchant's words and stay as entered. */}
              {t.rich('menu.allergens', {
                list: view.allergens.join(', '),
                b: (chunks) => <span className="font-semibold">{chunks}</span>,
              })}
            </p>
          </div>
        )}

        {/* Modifier groups */}
        {optionsReady && groups.length > 0 && (
          <div className="mt-6 space-y-5">
            {groups.map((g) => {
              const picked = selections[g.id] ?? new Set();
              return (
                <fieldset key={g.id} className="space-y-2">
                  <legend className="flex items-baseline justify-between gap-3">
                    <span className="font-display text-base font-semibold">
                      {g.name}
                      {g.is_required && (
                        <span className="ml-1 text-xs font-normal text-destructive">{t('menu.required')}</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {g.max_select === 1 ? t('menu.pickOne') : t('menu.pickUpTo', { max: g.max_select })}
                    </span>
                  </legend>
                  <div className="space-y-1.5">
                    {g.options.map((opt) => {
                      const selected = picked.has(opt.id);
                      const disabled =
                        !selected &&
                        g.selection_type !== 'single' &&
                        g.max_select > 1 &&
                        picked.size >= g.max_select;
                      return (
                        <label
                          key={opt.id}
                          className={`focus-ring flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 transition ${
                            selected
                              ? 'border-primary bg-primary/5'
                              : 'border-border bg-card hover:border-primary/40'
                          } ${disabled ? 'opacity-50' : ''}`}
                        >
                          <span className="flex items-center gap-3">
                            <input
                              type={g.selection_type === 'single' || g.max_select === 1 ? 'radio' : 'checkbox'}
                              name={`mod-${g.id}`}
                              checked={selected}
                              disabled={disabled}
                              onChange={() => toggleOption(g, opt.id)}
                              className="h-4 w-4 accent-primary"
                            />
                            <span className="text-sm">{opt.name}</span>
                          </span>
                          {Number(opt.price_delta) !== 0 && (
                            <span className="text-sm font-semibold tabular-nums">
                              {Number(opt.price_delta) > 0 ? '+' : ''}
                              {formatCurrency(Number(opt.price_delta))}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </div>
        )}

        <div className="mt-6 space-y-2">
          <label htmlFor="item-notes" className="text-sm font-medium">
            {t('cart.notes')}
          </label>
          <textarea
            id="item-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('cart.notesPlaceholder')}
            rows={2}
            className="focus-ring w-full resize-none rounded-2xl border border-border bg-card px-4 py-3 text-base placeholder:text-muted-foreground"
          />
        </div>

        {validation && (
          <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {validation}
          </p>
        )}

        {/* Why the stepper stops short of 99, or Add is off: this exact selection is already in
            the cart, and one order takes at most MAX_LINE_QUANTITY of it. */}
        {inCart > 0 && addQty >= room && (
          <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">
            {t('menu.lineLimit', { inCart, max: MAX_LINE_QUANTITY })}
          </p>
        )}

        {openableRecs.length > 0 && (
          <div className="mt-7">
            <p className="font-display text-sm font-semibold">{t('menu.alsoLike')}</p>
            <div className="-mx-1 mt-2 flex snap-x snap-mandatory overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {openableRecs.map(({ target }) => (
                // A button like every other card that opens the sheet: opening is a read,
                // so the login gate stays on the Add button of the sheet it swaps to.
                <button
                  key={target.id}
                  type="button"
                  onClick={() => onOpenItem(target)}
                  aria-label={t('menu.openItem', { name: target.name })}
                  className="focus-ring mr-2 inline-flex w-32 shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-shadow hover:shadow-warm"
                >
                  <div
                    className={`relative aspect-square w-full bg-muted bg-cover bg-center ${target.imageUrl ? '' : 'bg-gradient-sunset'}`}
                    style={
                      target.imageUrl ? { backgroundImage: cssUrl(target.imageUrl) } : undefined
                    }
                    role="img"
                    aria-label={target.name}
                  >
                    {target.outOfStock && (
                      <span className="absolute inset-0 grid place-items-center bg-background/60 px-1">
                        <Badge variant="muted" className="text-center text-xs">
                          {soldOutText.label(target)}
                        </Badge>
                      </span>
                    )}
                  </div>
                  <div className="px-2 py-1.5">
                    <p className="line-clamp-2 text-xs font-semibold leading-tight">
                      {target.name}
                    </p>
                    <p className="mt-0.5 text-xs font-bold text-primary">
                      {formatUnitPrice(target.price)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.05, type: 'spring', stiffness: 350, damping: 28 }}
        className="sticky inset-x-0 bottom-0 border-t border-border/60 bg-card/95 px-5 pb-safe pt-4 backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <QuantityStepper
            value={addQty}
            onChange={setQty}
            min={1}
            max={Math.max(1, room)}
            size="lg"
          />
          <Button
            variant="gradient"
            size="xl"
            fullWidth
            onClick={handleAdd}
            disabled={!optionsReady || !!validation || soldOut || lineFull}
          >
            {soldOut && view
              ? soldOutText.label(view)
              : t('menu.addWithPrice', { price: formatCurrency(total) })}
          </Button>
        </div>
      </motion.div>
    </Sheet>
  );
}
