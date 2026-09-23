'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Copy, Edit3, FileSpreadsheet, LayoutGrid, Move, Plus, Save, Tags, Trash2 } from 'lucide-react';
import type { MenuCategory, MenuItem } from '@favornoms/shared';
import { DEFAULT_UI_LOCALE, formatCurrency, isUiLocale } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { listCategories, listMenuItems } from '@favornoms/database/queries';
import { Badge, Button, Card, IconButton, Sheet, useConfirm } from '@favornoms/ui';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  formatSoldOutUntil,
  stockState,
} from '../../inventory/_components/stock-model';
import { CATEGORY_EMOJIS, CategoryManager } from './category-manager';
import { MenuReorder } from './menu-reorder';
import { ItemModifierEditor, type ItemModifierEditorHandle } from './item-modifier-editor';
import { menuErrorKey } from './menu-errors';
import { MENU_STOCK_COLUMNS, type MenuItemStockRow } from './menu-stock';

export type { MenuItemStockRow } from './menu-stock';

interface ItemStock {
  trackStock: boolean;
  stockQuantity: number | null;
  lowStockThreshold: number;
  /** menu_items.sold_out_until as stored; stockState() decides whether it still holds. */
  soldOutUntil: string | null;
  station: string | null;
}

/**
 * Station codes the kitchen board filters on (the same list menu import and the CSV use). The
 * board builds its station pills from the dishes' stations, so a branch whose menu was built by
 * hand — Food Thai Thai — had no way to get any.
 */
const STATION_CODES = ['hot', 'cold', 'bar', 'dessert', 'expo'] as const;

function isStationCode(value: string): value is (typeof STATION_CODES)[number] {
  return (STATION_CODES as readonly string[]).includes(value);
}

function toStockMap(rows: MenuItemStockRow[]): Record<string, ItemStock> {
  const map: Record<string, ItemStock> = {};
  for (const row of rows) {
    map[row.id] = {
      trackStock: row.track_stock === true,
      stockQuantity: row.stock_quantity ?? null,
      lowStockThreshold: row.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
      soldOutUntil: row.sold_out_until ?? null,
      station: row.station ?? null,
    };
  }
  return map;
}

interface SavedItemSummary {
  /** Null only if an insert somehow came back without one. */
  id: string | null;
  name: string;
  trackStock: boolean;
  stockQuantity: number | null;
  lowStockThreshold: number;
  station: string | null;
  /** set_stock lifted a kitchen 86 on the way (a count above 0). */
  cleared86: boolean;
  /** The item itself saved, but something attached to it did not. Already translated. */
  warning?: string;
}

interface Props {
  branchId: string;
  categories: MenuCategory[];
  items: MenuItem[];
  stockRows: MenuItemStockRow[];
  /** branches.timezone, for "Sold out until …". */
  timezone: string;
  /** branches.settings.currency. */
  currency: string;
}

/** Logs the raw failure and returns the translated message the merchant sees instead. */
function useMenuErrorText() {
  const t = useTranslations('menu');
  return (context: string, err: unknown) => {
    console.error(`[menu] ${context} failed`, err);
    return t(`errors.${menuErrorKey(err)}`);
  };
}

export function MenuManager({
  branchId,
  categories: initCategories,
  items: initItems,
  stockRows,
  timezone,
  currency,
}: Props) {
  const t = useTranslations('menu');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const errorText = useMenuErrorText();
  const [items, setItems] = React.useState(initItems);
  const [categories, setCategories] = React.useState(initCategories);
  const [stock, setStock] = React.useState(() => toStockMap(stockRows));
  const [busyIds, setBusyIds] = React.useState<string[]>([]);
  const [editing, setEditing] = React.useState<MenuItem | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [managingCategories, setManagingCategories] = React.useState(false);
  const [mode, setMode] = React.useState<'grid' | 'reorder'>('grid');
  const [notice, setNotice] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const confirm = useConfirm();

  // The confirmation is the only proof a save landed — the card can look identical
  // afterwards — but it should not sit there for the rest of the shift either.
  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Newest wins. A reload started before a change (a duplicate's refresh, say) can land after it
  // and paint the old list back — the "Show on menu" tap then appeared to undo itself.
  const refreshSeq = React.useRef(0);
  const refresh = async () => {
    const seq = ++refreshSeq.current;
    const supabase = getBrowserClient();
    try {
      // Use the same query helpers as the server page so the refreshed rows are
      // mapped to the camelCase shape (categoryId/imageUrl/…) the grid expects.
      // A raw snake_case select here left categoryId undefined, which filtered
      // every item out of its category and blanked the page after save.
      const [nextItems, nextCategories, stockRes] = await Promise.all([
        // Hidden dishes included, as on first load: this is the screen that switches them back on.
        listMenuItems(supabase, branchId, { includeInactive: true }),
        listCategories(supabase, branchId),
        supabase.from('menu_items').select(MENU_STOCK_COLUMNS).eq('branch_id', branchId),
      ]);
      if (stockRes.error) throw stockRes.error;
      if (seq !== refreshSeq.current) return;
      setItems(nextItems);
      setCategories(nextCategories);
      setStock(toStockMap((stockRes.data ?? []) as MenuItemStockRow[]));
    } catch (err) {
      // This used to reject unhandled. A refresh that fails in silence is
      // indistinguishable from a save that did nothing, which is exactly the
      // complaint this screen collected.
      setProblem(t('notices.reloadFailed', { reason: errorText('menu reload', err) }));
    }
  };

  const handleSaved = (saved: SavedItemSummary) => {
    setEditing(null);
    setCreating(false);
    setProblem(saved.warning ?? null);
    // Paint the new stock state straight away. refresh() will confirm it a moment
    // later, but the merchant has to see the card change on the same click that
    // closed the sheet, or the save reads as nothing at all.
    const savedId = saved.id;
    if (savedId) {
      setStock((cur) => ({
        ...cur,
        [savedId]: {
          trackStock: saved.trackStock,
          stockQuantity: saved.trackStock ? saved.stockQuantity : null,
          lowStockThreshold: saved.lowStockThreshold,
          // A count above 0 (set_stock) lifts an 86; otherwise it stands until the reload says.
          soldOutUntil: saved.cleared86 ? null : (cur[savedId]?.soldOutUntil ?? null),
          station: saved.station,
        },
      }));
    }
    setNotice(
      saved.trackStock
        ? t('notices.savedTracking', { name: saved.name, count: saved.stockQuantity ?? 0 })
        : t('notices.savedUntracked', { name: saved.name }),
    );
    void refresh();
  };

  const handleDelete = async (id: string) => {
    if (
      !(await confirm({
        title: t('deleteConfirm.title'),
        body: t('deleteConfirm.body'),
        confirmLabel: t('deleteConfirm.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    const { error } = await supabase.from('menu_items').delete().eq('id', id);
    if (error) {
      setProblem(errorText('delete item', error));
      return;
    }
    setItems((curr) => curr.filter((i) => i.id !== id));
    setProblem(null);
  };

  const handleDuplicate = async (id: string) => {
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('duplicate_menu_item', { p_item_id: id });
    if (error) {
      setProblem(errorText('duplicate_menu_item', error));
      return;
    }
    setProblem(null);
    // duplicate_menu_item makes the copy hidden on purpose, so a half-edited "(Copy)" never
    // reaches customers. Say so, and say how to publish it — the badge alone did not.
    setNotice(t('notices.copied'));
    await refresh();
  };

  // A dish the kitchen 86'd stayed "Out of stock" for the rest of the day with nothing in the
  // back office saying so or undoing it; the only way back was the kitchen board's 5-second toast.
  const handleBackOnSale = async (target: MenuItem) => {
    setBusyIds((cur) => [...cur, target.id]);
    const { error } = await getBrowserClient().rpc('set_item_86', {
      p_menu_item_id: target.id,
      p_sold_out: false,
    });
    setBusyIds((cur) => cur.filter((id) => id !== target.id));
    if (error) {
      setProblem(t('notices.backOnSaleFailed', { name: target.name, reason: errorText('set_item_86', error) }));
      return;
    }
    setProblem(null);
    const cur = stock[target.id];
    // Lifting the 86 does not conjure stock: a counted dish at 0 is still sold out.
    const emptyShelf = !!cur?.trackStock && (cur.stockQuantity ?? 0) <= 0;
    setStock((s) => {
      const row = s[target.id];
      return row ? { ...s, [target.id]: { ...row, soldOutUntil: null } } : s;
    });
    setItems((curr) =>
      curr.map((i) => (i.id === target.id ? { ...i, soldOutUntil: null, outOfStock: emptyShelf } : i)),
    );
    setNotice(
      emptyShelf
        ? t('notices.backOnSaleEmpty', { name: target.name })
        : t('notices.backOnSale', { name: target.name }),
    );
    void refresh();
  };

  // One tap from the grid. The update asks for the row back: an RLS-denied update matches no
  // row and returns no error, which would look exactly like success.
  const handleVisibility = async (target: MenuItem, visible: boolean) => {
    const supabase = getBrowserClient();
    const { data, error } = await supabase
      .from('menu_items')
      .update({ is_active: visible })
      .eq('id', target.id)
      .select('id')
      .maybeSingle();
    if (error || !data) {
      setProblem(error ? errorText('set item visibility', error) : t('notices.visibilityUnchanged'));
      return;
    }
    setProblem(null);
    // Any reload already in flight read the row before this change; it must not paint over it.
    refreshSeq.current += 1;
    setItems((curr) => curr.map((i) => (i.id === target.id ? { ...i, isActive: visible } : i)));
    setNotice(
      visible
        ? t('notices.nowVisible', { name: target.name })
        : t('notices.nowHidden', { name: target.name }),
    );
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-col gap-3 px-2 lg:flex-row lg:items-start lg:justify-between lg:px-0">
        <div className="pl-14 lg:pl-0">
          <h1 className="font-display text-3xl font-bold">{t('header.title')}</h1>
          <p className="mt-1 text-muted-foreground">
            {t('header.summary', { items: items.length, categories: categories.length })}
          </p>
          {/* The sections below are in the order diners see, and that order is set by dragging
              inside the Categories panel — which looked like a plain list of names, so nobody
              found it. Say where it is, next to the button that opens it. */}
          {mode === 'grid' && categories.length > 1 && (
            <p className="mt-1 text-sm text-muted-foreground">{t('header.orderHint')}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-border bg-card p-1">
            <button
              type="button"
              onClick={() => setMode('grid')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                mode === 'grid' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
              aria-pressed={mode === 'grid'}
            >
              <LayoutGrid className="h-4 w-4" /> {t('header.modeEdit')}
            </button>
            <button
              type="button"
              onClick={() => setMode('reorder')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                mode === 'reorder' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
              aria-pressed={mode === 'reorder'}
            >
              <Move className="h-4 w-4" /> {t('header.modeReorder')}
            </button>
          </div>
          {mode === 'grid' && (
            <>
              <Button variant="ghost" leftIcon={<Tags className="h-4 w-4" />} onClick={() => setManagingCategories(true)}>
                {t('categories.button')}
              </Button>
              <Link href={`/b/${branchId}/menu/modifiers`}>
                <Button variant="ghost">
                  {t('header.modifiers')}
                </Button>
              </Link>
              <Link href={`/b/${branchId}/menu/combos`}>
                <Button variant="ghost">
                  {t('header.combos')}
                </Button>
              </Link>
              <Link href={`/b/${branchId}/menu/happy-hours`}>
                <Button variant="ghost">
                  {t('header.happyHours')}
                </Button>
              </Link>
              <Link href={`/b/${branchId}/menu/import`}>
                <Button variant="ghost" leftIcon={<FileSpreadsheet className="h-4 w-4" />}>
                  {t('header.csvImport')}
                </Button>
              </Link>
              <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                {t('header.addItem')}
              </Button>
            </>
          )}
        </div>
      </header>

      {notice && (
        <p
          role="status"
          className="mx-2 mb-4 rounded-xl bg-success/10 px-4 py-2 text-sm text-success lg:mx-0"
        >
          {notice}
        </p>
      )}
      {problem && (
        <p
          role="alert"
          className="mx-2 mb-4 rounded-xl bg-warning/10 px-4 py-2 text-sm text-warning lg:mx-0"
        >
          {problem}
        </p>
      )}

      {mode === 'reorder' ? (
        <MenuReorder branchId={branchId} categories={categories} items={items} onSaved={refresh} />
      ) : null}

      {mode === 'grid' && categories.map((cat) => {
        const catItems = items.filter((i) => i.categoryId === cat.id);
        if (catItems.length === 0) return null;
        return (
          <section key={cat.id} className="mb-8 px-2 lg:px-0">
            {/* The button sits beside the heading, not inside it, so a screen reader's heading list
                reads "Burgers 3" rather than "Burgers 3 Manage categories". */}
            <div className="mb-3 flex items-center gap-2">
              <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
                <span aria-hidden>{cat.iconEmoji ?? '🍴'}</span>
                {cat.name}
                <Badge variant="muted">{catItems.length}</Badge>
              </h2>
              <IconButton
                label={t('categories.manage')}
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setManagingCategories(true)}
              >
                <Tags className="h-4 w-4" />
              </IconButton>
            </div>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catItems.map((item) => (
                <motion.li
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <Card className="overflow-hidden">
                    <div className="flex">
                      <div className="relative h-24 w-24 shrink-0">
                        {item.imageUrl ? (
                          <Image
                            src={item.imageUrl}
                            alt={item.name}
                            fill
                            sizes="96px"
                            className="object-cover"
                          />
                        ) : (
                          <div className="absolute inset-0 bg-gradient-sunset" aria-hidden />
                        )}
                      </div>
                      <div className="flex flex-1 flex-col gap-1 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="line-clamp-2 font-semibold leading-tight">{item.name}</h3>
                          <span className="shrink-0 font-display text-base font-bold text-primary">
                            {formatCurrency(item.price, currency)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.isActive === false && (
                            <>
                              <span
                                className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground"
                                title={t('card.hiddenHint')}
                              >
                                {t('card.hidden')}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleVisibility(item, true)}
                                className="focus-ring rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/20"
                              >
                                {t('card.showOnMenu')}
                              </button>
                            </>
                          )}
                          <StockBadge
                            stock={stock[item.id]}
                            timezone={timezone}
                            locale={locale}
                            busy={busyIds.includes(item.id)}
                            onBackOnSale={() => void handleBackOnSale(item)}
                          />
                        </div>
                        <div className="mt-auto flex items-center gap-1">
                          <IconButton label={t('card.edit')} size="sm" onClick={() => setEditing(item)}>
                            <Edit3 className="h-4 w-4" />
                          </IconButton>
                          <IconButton label={t('card.duplicate')} size="sm" onClick={() => handleDuplicate(item.id)}>
                            <Copy className="h-4 w-4" />
                          </IconButton>
                          <IconButton label={t('card.delete')} size="sm" className="text-danger" onClick={() => handleDelete(item.id)}>
                            <Trash2 className="h-4 w-4" />
                          </IconButton>
                        </div>
                      </div>
                    </div>
                  </Card>
                </motion.li>
              ))}
            </ul>
          </section>
        );
      })}

      <Sheet
        open={managingCategories}
        onClose={() => setManagingCategories(false)}
        title={t('categories.title')}
        ariaLabel={t('categories.title')}
        side="right"
      >
        <CategoryManager
          branchId={branchId}
          categories={categories}
          items={items}
          onChanged={refresh}
          onNotice={setNotice}
        />
      </Sheet>

      {/* Editor sheet — usable in grid mode only */}
      <Sheet
        open={!!editing || creating}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
        title={editing ? t('sheet.editTitle') : t('sheet.addTitle')}
        side="right"
      >
        {/* Keyed so every state initialiser re-runs for the item actually being
            edited. Sheet unmounts its children today, but nothing in ItemEditor
            should depend on that — without a key, a change there would silently
            prefill the previous item's stock figures into the next one. */}
        <ItemEditor
          key={editing?.id ?? 'new'}
          branchId={branchId}
          categories={categories}
          item={editing}
          initialStock={editing ? stock[editing.id] : undefined}
          timezone={timezone}
          locale={locale}
          onCategoryCreated={(cat) => setCategories((cur) => [...cur, cat])}
          onSaved={handleSaved}
        />
      </Sheet>
    </div>
  );
}

/**
 * What the merchant needs to see from the grid: whether this item is being counted,
 * whether it has run out, and whether the kitchen has 86'd it — with the way back on
 * sale right next to it. An 86 shows whether or not the dish is counted: it was the half
 * of "sold out" this card never showed, so a dish with 29 on the shelf read "29 left"
 * here while every diner saw "Out of stock". When Track stock goes off the count badge
 * disappears — which is the only thing on the card that moves after that save.
 */
function StockBadge({
  stock,
  timezone,
  locale,
  busy,
  onBackOnSale,
}: {
  stock: ItemStock | undefined;
  timezone: string;
  locale: string;
  busy: boolean;
  onBackOnSale: () => void;
}) {
  const t = useTranslations('menu');
  if (!stock) return null;
  const st = stockState({
    track_stock: stock.trackStock,
    stock_quantity: stock.stockQuantity,
    low_stock_threshold: stock.lowStockThreshold,
    sold_out_until: stock.soldOutUntil,
  });
  if (st.soldOutUntil) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="danger">
          {t('card.soldOutUntil', { time: formatSoldOutUntil(st.soldOutUntil, timezone, locale) })}
        </Badge>
        <button
          type="button"
          onClick={onBackOnSale}
          disabled={busy}
          className="focus-ring rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {t('card.backOnSale')}
        </button>
      </div>
    );
  }
  if (st.count === null) return null;
  return (
    <div className="flex">
      <Badge variant={st.isSoldOut ? 'danger' : st.isLow ? 'warning' : 'muted'}>
        {st.isSoldOut ? t('card.soldOut') : t('card.stockLeft', { count: st.count })}
      </Badge>
    </div>
  );
}

/**
 * Quick-pick allergens. `value` is what gets saved on the item and shown to diners, so it stays
 * English exactly as before; `key` only picks the translated label on the picker button.
 */
const COMMON_ALLERGENS = [
  { value: 'Peanuts', key: 'peanuts' },
  { value: 'Tree nuts', key: 'treeNuts' },
  { value: 'Milk', key: 'milk' },
  { value: 'Eggs', key: 'eggs' },
  { value: 'Fish', key: 'fish' },
  { value: 'Shellfish', key: 'shellfish' },
  { value: 'Soy', key: 'soy' },
  { value: 'Wheat / Gluten', key: 'wheatGluten' },
  { value: 'Sesame', key: 'sesame' },
] as const;

function ItemEditor({
  branchId, categories, item, initialStock, timezone, locale, onSaved, onCategoryCreated,
}: {
  branchId: string;
  categories: MenuCategory[];
  item: MenuItem | null;
  /** Stock as the page last read it, so the checkbox opens in the right position. */
  initialStock: ItemStock | undefined;
  timezone: string;
  locale: string;
  onSaved: (saved: SavedItemSummary) => void;
  onCategoryCreated: (cat: MenuCategory) => void;
}) {
  const t = useTranslations('menu');
  const errorText = useMenuErrorText();
  const [name, setName] = React.useState(item?.name ?? '');
  const [description, setDescription] = React.useState(item?.description ?? '');
  const [price, setPrice] = React.useState(item?.price.toString() ?? '');
  const [imageUrl, setImageUrl] = React.useState(item?.imageUrl ?? '');
  const [categoryId, setCategoryId] = React.useState(item?.categoryId ?? categories[0]?.id ?? '');
  const categoryValid = categories.some((c) => c.id === categoryId);
  const [recommended, setRecommended] = React.useState(item?.isRecommended ?? false);
  const [isNew, setIsNew] = React.useState(item?.isNew ?? false);
  // New dishes are visible by default, as the column's default has always made them.
  const [visible, setVisible] = React.useState(item?.isActive ?? true);
  // Written only when the merchant moves the box. This editor holds the page's copy of the dish,
  // so saving a price change would otherwise put back a dish someone hid since the page loaded.
  const visibleTouched = React.useRef(false);
  const [trackStock, setTrackStock] = React.useState(initialStock?.trackStock ?? false);
  const [stockQuantity, setStockQuantity] = React.useState(
    String(initialStock?.stockQuantity ?? 0),
  );
  const [lowStockThreshold, setLowStockThreshold] = React.useState(
    String(initialStock?.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD),
  );
  /** Set the moment the merchant moves the checkbox, so a late read cannot undo it. */
  const stockTouched = React.useRef(false);
  /** Set when the merchant types a count: only then is it written, through set_stock. */
  const countTouched = React.useRef(false);
  /**
   * The stock the database last reported. A save compares against it instead of writing the
   * editor's copy back: every sale moves the count, and writing an untouched count back used
   * to undo the sales made while the sheet was open.
   */
  const loadedStock = React.useRef({
    trackStock: initialStock?.trackStock ?? false,
    stockQuantity: initialStock?.stockQuantity ?? null,
  });
  const [soldOutUntil, setSoldOutUntil] = React.useState<string | null>(initialStock?.soldOutUntil ?? null);
  const [station, setStation] = React.useState(initialStock?.station ?? '');
  /** Written only when the merchant changes it, like `visible`. */
  const stationTouched = React.useRef(false);
  const [uploading, setUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [allergens, setAllergens] = React.useState<string[]>(item?.allergens ?? []);
  const [allergenDraft, setAllergenDraft] = React.useState('');
  const [showNewCat, setShowNewCat] = React.useState(false);
  const [newCatName, setNewCatName] = React.useState('');
  const [newCatEmoji, setNewCatEmoji] = React.useState('🍽️');
  const [creatingCat, setCreatingCat] = React.useState(false);
  const modifierRef = React.useRef<ItemModifierEditorHandle>(null);

  const addAllergen = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setAllergens((cur) => (cur.some((a) => a.toLowerCase() === v.toLowerCase()) ? cur : [...cur, v]));
    setAllergenDraft('');
  };
  const removeAllergen = (a: string) => setAllergens((cur) => cur.filter((x) => x !== a));

  const createCategory = async () => {
    const nm = newCatName.trim();
    if (!nm) return;
    setCreatingCat(true);
    const supabase = getBrowserClient();
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.displayOrder ?? 0), -1);
    const { data, error: catErr } = await supabase
      .from('menu_categories')
      .insert({ branch_id: branchId, name: nm, icon_emoji: newCatEmoji || null, display_order: maxOrder + 1, is_active: true })
      .select('id, branch_id, name, display_order, icon_emoji')
      .single();
    setCreatingCat(false);
    if (catErr || !data) {
      setError(catErr ? errorText('create category', catErr) : t('editor.createCategoryFailed'));
      return;
    }
    const cat: MenuCategory = {
      id: data.id,
      branchId: data.branch_id,
      name: data.name,
      displayOrder: data.display_order ?? 0,
      iconEmoji: data.icon_emoji ?? undefined,
    };
    onCategoryCreated(cat);
    setCategoryId(cat.id);
    setShowNewCat(false);
    setNewCatName('');
    setNewCatEmoji('🍽️');
  };

  // Re-read the stock columns on open. stock_quantity moves without the merchant:
  // every order decrements it, so the copy the page was rendered with can be minutes
  // out of date and saving it back would undo those sales.
  //
  // Two guards, both load-bearing. `cancelled` stops a read for one item landing in a
  // later item's editor, and `stockTouched` stands down entirely once the merchant has
  // moved the checkbox — a slow read landing after a click used to put the tick back
  // with no trace, which is one of the ways "Track stock cannot be unticked" is
  // reported. The read error is surfaced too: swallowing it left the box showing
  // whatever it happened to hold and the merchant believing that was the truth.
  React.useEffect(() => {
    if (!item) return;
    let cancelled = false;
    const supabase = getBrowserClient();
    void supabase
      .from('menu_items')
      .select('track_stock, stock_quantity, low_stock_threshold, sold_out_until, station')
      .eq('id', item.id)
      .maybeSingle()
      .then(({ data, error: readErr }) => {
        if (cancelled) return;
        if (readErr) {
          if (stockTouched.current || countTouched.current) return;
          setError(t('editor.stockReadFailed', { reason: errorText('read item stock', readErr) }));
          return;
        }
        if (!data) return;
        // What the database holds is recorded whatever the merchant has touched: the save
        // compares against it.
        loadedStock.current = {
          trackStock: data.track_stock === true,
          stockQuantity: data.stock_quantity ?? null,
        };
        setSoldOutUntil(data.sold_out_until ?? null);
        if (!stationTouched.current) setStation(data.station ?? '');
        if (stockTouched.current || countTouched.current) return;
        setTrackStock(data.track_stock === true);
        setStockQuantity(String(data.stock_quantity ?? 0));
        setLowStockThreshold(String(data.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD));
      });
    return () => {
      cancelled = true;
    };
    // `t` and `errorText` are recreated on render; the read belongs to the item alone, as before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  const uploadImage = async (file: File) => {
    setUploading(true);
    const supabase = getBrowserClient();
    const path = `menu/${branchId}/${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
    const { error: upErr } = await supabase.storage.from('branch-assets').upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (!upErr) {
      const { data } = supabase.storage.from('branch-assets').getPublicUrl(path);
      setImageUrl(data.publicUrl);
    } else {
      setError(errorText('upload item image', upErr));
    }
    setUploading(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // The category this editor opened with can be deleted meanwhile (from the Categories panel,
    // or another tab). Saving its id would fail on the foreign key with a message about deleting;
    // re-pointing the dish silently would move it without asking. Ask for a category instead.
    if (!categoryValid) {
      setError(t('editor.chooseCategory'));
      return;
    }
    // Catch half-built option groups before we create anything, so a blank or
    // optionless group never reaches the DB (and the customer menu).
    if (!item) {
      const draftError = modifierRef.current?.validateDraft();
      if (draftError) {
        setError(draftError);
        return;
      }
    }
    // A tracked dish always has a count (menu_items_tracked_stock_has_count); a blank one used to
    // be saved as 0, which put the dish on sale as "Sold out".
    if (trackStock && stockQuantity.trim() === '') {
      setError(t('editor.stockRequired'));
      return;
    }
    const count = Number(stockQuantity || 0);
    const threshold = Number(lowStockThreshold || 0);
    const loaded = loadedStock.current;
    // An existing dish's count changes only through set_stock, and only when the merchant gave
    // one: switching tracking on, or typing a count. set_stock logs it in stock_count_log with
    // the previous figure and, above 0, lifts a kitchen 86. Writing stock_quantity straight
    // from this sheet did neither, and saving a price change wrote back the count the sheet
    // opened with over every sale made since.
    const countViaSetStock = !!item && trackStock && (!loaded.trackStock || countTouched.current);
    setSaving(true);
    try {
      const supabase = getBrowserClient();
      const payload = {
        branch_id: branchId,
        category_id: categoryId,
        name,
        description: description || null,
        price: Number(price),
        image_url: imageUrl || null,
        is_recommended: recommended,
        is_new: isNew,
        ...(item && !visibleTouched.current ? {} : { is_active: visible }),
        ...(item && !stationTouched.current ? {} : { station: station || null }),
        // A new dish is inserted with its count in one statement: nothing has been sold yet.
        ...(!item ? { track_stock: trackStock, stock_quantity: trackStock ? count : null } : {}),
        // Tracking off: no count (the check constraint's other half).
        ...(item && !trackStock && loaded.trackStock ? { track_stock: false, stock_quantity: null } : {}),
        // low_stock_threshold is NOT NULL (default 5) — never send null. Left alone while tracking
        // is off, so switching it back on restores the merchant's own level.
        ...(trackStock ? { low_stock_threshold: threshold } : {}),
        allergens,
      };
      // Both branches ask for the id back. The insert needs it to attach any option
      // groups built inline (draft mode); the update needs it as proof. An update that
      // matches no row — a deleted item, an RLS write denial — comes back 204 with no
      // error, which was indistinguishable from a successful save, and the merchant was
      // told nothing either way.
      const res = item
        ? await supabase
            .from('menu_items')
            .update(payload)
            .eq('id', item.id)
            .select('id')
            .maybeSingle()
        : await supabase.from('menu_items').insert(payload).select('id').single();
      if (res.error) {
        const { describePlanError } = await import('@favornoms/database/queries');
        const planErr = describePlanError(res.error);
        setError(
          planErr
            ? t('editor.planLimit', { current: planErr.current, limit: planErr.limit })
            : errorText('save item', res.error),
        );
        return;
      }
      const savedId = (res.data as { id: string } | null)?.id ?? null;
      if (item && !savedId) {
        setError(t('editor.nothingSaved'));
        return;
      }
      // New item: persist the draft option groups now that it has an id.
      let warning: string | undefined;
      if (!item && savedId) {
        const persistRes = await modifierRef.current?.persistDraft(savedId);
        if (persistRes?.error) {
          // The item itself is saved, so the sheet still closes and the grid still
          // reloads; the warning rides up to the page banner, which outlives the sheet.
          warning = t('editor.optionsWarning', { name, reason: persistRes.error });
        }
      }
      // What the card should show until the reload lands.
      let savedTracking = trackStock;
      let savedCount: number | null = trackStock ? (item ? loaded.stockQuantity : count) : null;
      let cleared86 = false;
      if (countViaSetStock && item) {
        const { data: counted, error: countErr } = await supabase.rpc('set_stock', {
          p_menu_item_id: item.id,
          p_counted_qty: count,
        });
        if (countErr) {
          // The rest of the dish is saved; the count is not, and the banner says so.
          warning = t('editor.stockNotSaved', { name, reason: errorText('set_stock', countErr) });
          savedTracking = loaded.trackStock;
          savedCount = loaded.trackStock ? loaded.stockQuantity : null;
        } else {
          savedCount = count;
          cleared86 = (counted as { cleared_86?: boolean } | null)?.cleared_86 === true;
        }
      }
      onSaved({
        id: savedId,
        name,
        trackStock: savedTracking,
        stockQuantity: savedCount,
        lowStockThreshold: trackStock ? threshold : Number(lowStockThreshold || DEFAULT_LOW_STOCK_THRESHOLD),
        station: station || null,
        cleared86,
        warning,
      });
    } catch (err) {
      setError(errorText('save item', err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-4 p-5">
      <Field label={t('editor.name')}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="input"
        />
      </Field>
      <Field label={t('editor.category')}>
        <div className="flex items-center gap-2">
          <select
            value={categoryValid ? categoryId : ''}
            onChange={(e) => setCategoryId(e.target.value)}
            className="input flex-1"
          >
            {!categoryValid && (
              <option value="" disabled>
                {t('editor.chooseCategory')}
              </option>
            )}
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.iconEmoji} {c.name}
              </option>
            ))}
          </select>
          <Button type="button" variant="ghost" size="md" onClick={() => setShowNewCat((s) => !s)}>
            {showNewCat ? t('editor.cancelNewCategory') : t('editor.newCategory')}
          </Button>
        </div>
        {showNewCat && (
          <div className="mt-2 space-y-2 rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2">
              <input
                value={newCatEmoji}
                onChange={(e) => setNewCatEmoji(e.target.value)}
                aria-label={t('editor.categoryIcon')}
                maxLength={4}
                className="focus-ring h-12 w-16 shrink-0 rounded-xl border border-border bg-background text-center text-2xl"
              />
              <input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder={t('editor.categoryNamePlaceholder')}
                className="focus-ring h-12 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_EMOJIS.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => setNewCatEmoji(em)}
                  className={`h-9 w-9 rounded-lg border text-lg ${
                    newCatEmoji === em ? 'border-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  {em}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="soft"
              size="md"
              onClick={createCategory}
              loading={creatingCat}
              disabled={!newCatName.trim()}
            >
              {t('editor.createCategory')}
            </Button>
          </div>
        )}
      </Field>
      <Field label={t('editor.price')}>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required
          className="input"
        />
      </Field>
      <Field label={t('editor.station')}>
        <select
          value={station}
          onChange={(e) => {
            stationTouched.current = true;
            setStation(e.target.value);
          }}
          className="input"
        >
          <option value="">{t('editor.stationNone')}</option>
          {STATION_CODES.map((code) => (
            <option key={code} value={code}>
              {t(`stations.${code}`)}
            </option>
          ))}
          {/* A station the list does not know (an older import) is kept as it was, not cleared. */}
          {station && !isStationCode(station) && <option value={station}>{station}</option>}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">{t('editor.stationHint')}</p>
      </Field>
      <Field label={t('editor.description')}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="input min-h-[80px] resize-none"
        />
      </Field>

      <Field label={t('editor.allergens')}>
        <div className="space-y-2">
          {allergens.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {/* The saved text, exactly as diners see it — never relabelled. */}
              {allergens.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning"
                >
                  {a}
                  <button
                    type="button"
                    onClick={() => removeAllergen(a)}
                    aria-label={t('editor.removeAllergen', { allergen: a })}
                    className="text-warning/70 hover:text-danger"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={allergenDraft}
              onChange={(e) => setAllergenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addAllergen(allergenDraft);
                }
              }}
              placeholder={t('editor.allergenPlaceholder')}
              className="input flex-1"
            />
            <Button type="button" variant="ghost" size="md" onClick={() => addAllergen(allergenDraft)} disabled={!allergenDraft.trim()}>
              {t('editor.addAllergen')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {COMMON_ALLERGENS.filter((a) => !allergens.some((x) => x.toLowerCase() === a.value.toLowerCase())).map((a) => {
              const label = t(`allergenPresets.${a.key}`);
              return (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => addAllergen(a.value)}
                  title={label !== a.value ? a.value : undefined}
                  className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40"
                >
                  + {label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('editor.allergenHint')}
          </p>
        </div>
      </Field>
      <Field label={t('editor.image')}>
        <div className="space-y-2">
          {imageUrl && (
            <div className="relative h-32 w-32 overflow-hidden rounded-xl bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="" className="h-full w-full object-cover" />
            </div>
          )}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadImage(f);
            }}
            className="block w-full text-sm file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-primary file:px-4 file:py-2 file:text-primary-foreground"
          />
          {uploading && <p className="text-xs text-muted-foreground">{t('editor.uploading')}</p>}
          <input
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder={t('editor.imageUrlPlaceholder')}
            className="input"
          />
        </div>
      </Field>

      <div className="rounded-xl border border-border bg-muted/20 p-3 space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={trackStock}
            onChange={(e) => {
              // Claim the value for the merchant before anything else can set it.
              stockTouched.current = true;
              setTrackStock(e.target.checked);
              // Starting to count asks for a count: a pre-filled 0 made the dish sold out the
              // moment it was saved.
              if (e.target.checked && !loadedStock.current.trackStock && !countTouched.current) {
                setStockQuantity('');
              }
            }}
          />
          {t('editor.trackStock')}
        </label>
        <p className="text-xs text-muted-foreground">
          {trackStock ? t('editor.trackStockOnHint') : t('editor.trackStockOffHint')}
        </p>
        {(() => {
          const lifts = stockState({
            track_stock: false,
            stock_quantity: null,
            low_stock_threshold: null,
            sold_out_until: soldOutUntil,
          }).soldOutUntil;
          return lifts ? (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              {t('editor.soldOutUntil', { time: formatSoldOutUntil(lifts, timezone, locale) })}
            </p>
          ) : null;
        })()}
        {trackStock && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('editor.currentStock')}>
              <input
                value={stockQuantity}
                onChange={(e) => {
                  countTouched.current = true;
                  setStockQuantity(e.target.value.replace(/\D/g, ''));
                }}
                className="input"
                inputMode="numeric"
              />
            </Field>
            <Field label={t('editor.lowStockAt')}>
              <input value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value.replace(/\D/g, ''))} className="input" inputMode="numeric" />
            </Field>
          </div>
        )}
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => {
            visibleTouched.current = true;
            setVisible(e.target.checked);
          }}
          className="mt-0.5"
        />
        <span>
          <span className="block font-medium">{t('editor.showOnMenu')}</span>
          <span className="block text-xs text-muted-foreground">
            {t('editor.showOnMenuHint')}
          </span>
        </span>
      </label>
      <div className="flex gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={recommended} onChange={(e) => setRecommended(e.target.checked)} />
          {t('editor.recommended')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isNew} onChange={(e) => setIsNew(e.target.checked)} />
          {t('editor.isNew')}
        </label>
      </div>
      <div className="rounded-xl border border-border bg-muted/20 p-3">
        <ItemModifierEditor ref={modifierRef} branchId={branchId} itemId={item?.id ?? null} />
      </div>

      {/* Next to the button that failed. This screen used to speak only through
          window.alert(), which mobile browsers swallow and Chrome suppresses outright
          once a merchant ticks "prevent additional dialogs" — so a rejected save and a
          save that did nothing looked exactly the same. */}
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="gradient"
        size="xl"
        fullWidth
        loading={saving}
        leftIcon={<Save className="h-4 w-4" />}
      >
        {t('editor.save')}
      </Button>
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
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
