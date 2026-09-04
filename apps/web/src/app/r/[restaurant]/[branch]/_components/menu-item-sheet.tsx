'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { AlertTriangle, Clock, Flame, Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, type MenuItem } from '@favornoms/shared';
import { Badge, Button, DietaryBadge, QuantityStepper, Sheet } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useCart, type CartLineModifier } from '@/store/cart';
import { useRequireAuth } from '@/components/auth/require-auth';
import { stashPendingAdd } from '@/lib/pending-cart';
import { resolveRecommendations, type RecommendationRow } from '@/lib/recommendations';

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
  const [qty, setQty] = React.useState(1);
  const [notes, setNotes] = React.useState('');
  const [groups, setGroups] = React.useState<ModifierGroup[]>([]);
  const [selections, setSelections] = React.useState<Record<string, Set<string>>>({});
  const [loadingGroups, setLoadingGroups] = React.useState(false);
  const [recommended, setRecommended] = React.useState<RecommendationRow[]>([]);
  const add = useCart((s) => s.add);
  // Adding to the cart requires a signed-in diner; a guest is sent to sign-in
  // and returned to the menu (usePathname) afterwards.
  const { requireAuthThen } = useRequireAuth();

  const [cached, setCached] = React.useState<MenuItem | null>(item);
  const heroRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (item) {
      // A recommendation tap swaps `item` while the sheet stays mounted, so a slow
      // response for the item the diner just left must not land on the new one.
      let cancelled = false;
      setCached(item);
      setQty(1);
      setNotes('');
      setGroups([]);
      setSelections({});
      // Cleared here rather than left to the RPC: the previous item's strip must not
      // linger under the new item while its own recommendations are on the way.
      setRecommended([]);
      // Same reason for the scroll: the sheet keeps its offset across a swap, so put the
      // new item's photo back in view instead of leaving the diner at the bottom.
      heroRef.current?.scrollIntoView({ block: 'start' });
      // Load modifier groups for this item
      setLoadingGroups(true);
      void (async () => {
        const supabase = getBrowserClient();
        const { data } = await supabase
          .from('menu_item_modifiers')
          .select(
            `display_order,
             modifier_group_id,
             modifier_groups!inner(
               id, name, min_select, max_select, is_required, selection_type, display_order,
               modifier_options(id, name, price_delta, is_default, is_active)
             )`,
          )
          .eq('menu_item_id', item.id)
          .order('display_order');
        if (cancelled) return;
        const groupRows = (data ?? [])
          .map((row) => {
            const g = Array.isArray(row.modifier_groups) ? row.modifier_groups[0] : row.modifier_groups;
            if (!g) return null;
            const options = (g.modifier_options ?? [])
              .filter((o) => o.is_active)
              .sort((a, b) => Number(a.price_delta) - Number(b.price_delta));
            return {
              id: g.id,
              name: g.name,
              min_select: g.min_select ?? 0,
              max_select: g.max_select ?? 1,
              is_required: !!g.is_required,
              selection_type: (g.selection_type as 'single' | 'multiple') ?? 'single',
              display_order: g.display_order ?? 0,
              options,
            } as ModifierGroup;
          })
          .filter((x): x is ModifierGroup => x !== null);
        setGroups(groupRows);
        // Pre-select defaults
        const init: Record<string, Set<string>> = {};
        for (const g of groupRows) {
          const defaults = g.options.filter((o) => o.is_default).map((o) => o.id);
          init[g.id] = new Set(defaults.slice(0, g.max_select));
        }
        setSelections(init);
        setLoadingGroups(false);

        // Fetch co-purchase recommendations.
        const { data: recs } = await supabase.rpc('recommendations_for_item', {
          p_menu_item_id: item.id,
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
  }, [item]);

  const view = item ?? cached;
  const soldOut = !!view?.outOfStock;

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

  const validation = React.useMemo(() => {
    for (const g of groups) {
      const count = (selections[g.id] ?? new Set()).size;
      if (g.is_required && count < g.min_select) {
        return `Pick at least ${g.min_select} option${g.min_select === 1 ? '' : 's'} for ${g.name}`;
      }
      if (count > g.max_select) {
        return `Pick at most ${g.max_select} option${g.max_select === 1 ? '' : 's'} for ${g.name}`;
      }
    }
    return null;
  }, [groups, selections]);

  const openableRecs = React.useMemo(
    () => resolveRecommendations(recommended, items, view?.id),
    [recommended, items, view?.id],
  );

  if (!view) return null;

  const unitWithMods = view.price + modDelta;
  const total = unitWithMods * qty;

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
    if (validation || soldOut) return;
    const flatMods: CartLineModifier[] = [];
    for (const g of groups) {
      const picked = selections[g.id] ?? new Set();
      for (const optId of picked) {
        const opt = g.options.find((o) => o.id === optId);
        if (opt) {
          flatMods.push({
            group_id: g.id,
            group_name: g.name,
            option_id: opt.id,
            option_name: opt.name,
            price_delta: Number(opt.price_delta),
          });
        }
      }
    }
    const modifiers = flatMods.length > 0 ? flatMods : undefined;
    requireAuthThen(
      () => {
        add(view, qty, notes, modifiers);
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
          quantity: qty,
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
          aria-label="Close"
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
                {formatCurrency(view.listPrice)}
              </span>
            )}
            <span className="font-display text-2xl font-bold text-primary">
              {formatCurrency(view.price)}
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
              <span className="font-semibold">Allergen info — contains:</span>{' '}
              {view.allergens.join(', ')}
            </p>
          </div>
        )}

        {/* Modifier groups */}
        {!loadingGroups && groups.length > 0 && (
          <div className="mt-6 space-y-5">
            {groups.map((g) => {
              const picked = selections[g.id] ?? new Set();
              return (
                <fieldset key={g.id} className="space-y-2">
                  <legend className="flex items-baseline justify-between gap-3">
                    <span className="font-display text-base font-semibold">
                      {g.name}
                      {g.is_required && <span className="ml-1 text-xs font-normal text-destructive">required</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {g.max_select === 1 ? 'Pick 1' : `Pick up to ${g.max_select}`}
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
                  aria-label={`Open ${target.name}`}
                  className="focus-ring mr-2 inline-flex w-32 shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-shadow hover:shadow-warm"
                >
                  <div
                    className={`relative aspect-square w-full bg-muted bg-cover bg-center ${target.imageUrl ? '' : 'bg-gradient-sunset'}`}
                    style={
                      target.imageUrl ? { backgroundImage: `url(${target.imageUrl})` } : undefined
                    }
                    role="img"
                    aria-label={target.name}
                  >
                    {target.outOfStock && (
                      <span className="absolute inset-0 grid place-items-center bg-background/60">
                        <Badge variant="muted" className="text-xs">
                          Sold out
                        </Badge>
                      </span>
                    )}
                  </div>
                  <div className="px-2 py-1.5">
                    <p className="line-clamp-2 text-xs font-semibold leading-tight">
                      {target.name}
                    </p>
                    <p className="mt-0.5 text-xs font-bold text-primary">
                      {formatCurrency(target.price)}
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
          <QuantityStepper value={qty} onChange={setQty} min={1} size="lg" />
          <Button
            variant="gradient"
            size="xl"
            fullWidth
            onClick={handleAdd}
            disabled={!!validation || soldOut}
          >
            {soldOut ? 'Sold out' : `${t('menu.addToCart')} · ${formatCurrency(total)}`}
          </Button>
        </div>
      </motion.div>
    </Sheet>
  );
}
