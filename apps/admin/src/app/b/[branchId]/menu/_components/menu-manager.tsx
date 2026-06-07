'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Copy, Edit3, LayoutGrid, Move, Plus, Save, Sparkles, Trash2, X } from 'lucide-react';
import type { MenuCategory, MenuItem } from '@favornoms/shared';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { listCategories, listMenuItems } from '@favornoms/database/queries';
import { Badge, Button, Card, IconButton, Sheet } from '@favornoms/ui';
import { MenuReorder } from './menu-reorder';

interface Props {
  branchId: string;
  categories: MenuCategory[];
  items: MenuItem[];
}

export function MenuManager({ branchId, categories: initCategories, items: initItems }: Props) {
  const [items, setItems] = React.useState(initItems);
  const [categories, setCategories] = React.useState(initCategories);
  const [editing, setEditing] = React.useState<MenuItem | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [mode, setMode] = React.useState<'grid' | 'reorder'>('grid');

  const refresh = async () => {
    const supabase = getBrowserClient();
    // Use the same query helpers as the server page so the refreshed rows are
    // mapped to the camelCase shape (categoryId/imageUrl/…) the grid expects.
    // A raw snake_case select here left categoryId undefined, which filtered
    // every item out of its category and blanked the page after save.
    const [nextItems, nextCategories] = await Promise.all([
      listMenuItems(supabase, branchId),
      listCategories(supabase, branchId),
    ]);
    setItems(nextItems);
    setCategories(nextCategories);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this menu item? This cannot be undone.')) return;
    const supabase = getBrowserClient();
    await supabase.from('menu_items').delete().eq('id', id);
    setItems((curr) => curr.filter((i) => i.id !== id));
  };

  const handleDuplicate = async (id: string) => {
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('duplicate_menu_item', { p_item_id: id });
    if (error) { alert(error.message); return; }
    await refresh();
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-col gap-3 px-2 lg:flex-row lg:items-start lg:justify-between lg:px-0">
        <div className="pl-14 lg:pl-0">
          <h1 className="font-display text-3xl font-bold">Menu</h1>
          <p className="mt-1 text-muted-foreground">{items.length} items across {categories.length} categories</p>
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
              <LayoutGrid className="h-4 w-4" /> Edit
            </button>
            <button
              type="button"
              onClick={() => setMode('reorder')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                mode === 'reorder' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
              aria-pressed={mode === 'reorder'}
            >
              <Move className="h-4 w-4" /> Reorder
            </button>
          </div>
          {mode === 'grid' && (
            <>
              <Link href={`/b/${branchId}/menu/modifiers`}>
                <Button variant="ghost">
                  Modifiers
                </Button>
              </Link>
              <Link href={`/b/${branchId}/menu/combos`}>
                <Button variant="ghost">
                  Combos
                </Button>
              </Link>
              <Link href={`/b/${branchId}/menu/happy-hours`}>
                <Button variant="ghost">
                  Happy hours
                </Button>
              </Link>
              <Link href={`/b/${branchId}/menu/import`}>
                <Button variant="ghost" leftIcon={<Sparkles className="h-4 w-4" />}>
                  AI import
                </Button>
              </Link>
              <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                Add item
              </Button>
            </>
          )}
        </div>
      </header>

      {mode === 'reorder' ? (
        <MenuReorder branchId={branchId} categories={categories} items={items} onSaved={refresh} />
      ) : null}

      {mode === 'grid' && categories.map((cat) => {
        const catItems = items.filter((i) => i.categoryId === cat.id);
        if (catItems.length === 0) return null;
        return (
          <section key={cat.id} className="mb-8 px-2 lg:px-0">
            <h2 className="mb-3 flex items-center gap-2 font-display text-xl font-semibold">
              <span aria-hidden>{cat.iconEmoji ?? '🍴'}</span>
              {cat.name}
              <Badge variant="muted">{catItems.length}</Badge>
            </h2>
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
                            {formatCurrency(item.price)}
                          </span>
                        </div>
                        <div className="mt-auto flex items-center gap-1">
                          <IconButton label="Edit" size="sm" onClick={() => setEditing(item)}>
                            <Edit3 className="h-4 w-4" />
                          </IconButton>
                          <IconButton label="Duplicate" size="sm" onClick={() => handleDuplicate(item.id)}>
                            <Copy className="h-4 w-4" />
                          </IconButton>
                          <IconButton label="Delete" size="sm" className="text-danger" onClick={() => handleDelete(item.id)}>
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

      {/* Editor sheet — usable in grid mode only */}
      <Sheet
        open={!!editing || creating}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
        title={editing ? 'Edit item' : 'Add menu item'}
        side="right"
      >
        <ItemEditor
          branchId={branchId}
          categories={categories}
          item={editing}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            refresh();
          }}
        />
      </Sheet>
    </div>
  );
}

function ItemEditor({
  branchId, categories, item, onSaved,
}: {
  branchId: string;
  categories: MenuCategory[];
  item: MenuItem | null;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(item?.name ?? '');
  const [description, setDescription] = React.useState(item?.description ?? '');
  const [price, setPrice] = React.useState(item?.price.toString() ?? '');
  const [imageUrl, setImageUrl] = React.useState(item?.imageUrl ?? '');
  const [categoryId, setCategoryId] = React.useState(item?.categoryId ?? categories[0]?.id ?? '');
  const [recommended, setRecommended] = React.useState(item?.isRecommended ?? false);
  const [isNew, setIsNew] = React.useState(item?.isNew ?? false);
  const [trackStock, setTrackStock] = React.useState(false);
  const [stockQuantity, setStockQuantity] = React.useState('0');
  const [lowStockThreshold, setLowStockThreshold] = React.useState('5');
  const [uploading, setUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Load track_stock + stock_quantity for existing items
  React.useEffect(() => {
    if (!item) return;
    const supabase = getBrowserClient();
    void supabase
      .from('menu_items')
      .select('track_stock, stock_quantity, low_stock_threshold')
      .eq('id', item.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setTrackStock(!!data.track_stock);
          setStockQuantity(String(data.stock_quantity ?? 0));
          setLowStockThreshold(String(data.low_stock_threshold ?? 5));
        }
      });
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
      alert(upErr.message);
    }
    setUploading(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
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
        track_stock: trackStock,
        stock_quantity: trackStock ? Number(stockQuantity) : null,
        low_stock_threshold: trackStock ? Number(lowStockThreshold) : null,
      };
      const { error: dbErr } = item
        ? await supabase.from('menu_items').update(payload).eq('id', item.id)
        : await supabase.from('menu_items').insert(payload);
      if (dbErr) {
        const { describePlanError } = await import('@favornoms/database/queries');
        const planErr = describePlanError(dbErr);
        if (planErr) {
          alert(
            `You've reached your plan's limit (${planErr.current} of ${planErr.limit} items). ` +
              `Upgrade your subscription in Preferences → Plan to add more.`,
          );
        } else {
          alert(dbErr.message);
        }
        return;
      }
      onSaved();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-4 p-5">
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="input"
        />
      </Field>
      <Field label="Category">
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.iconEmoji} {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Price (USD)">
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
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="input min-h-[80px] resize-none"
        />
      </Field>
      <Field label="Image">
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
          {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
          <input
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="…or paste URL"
            className="input"
          />
        </div>
      </Field>

      <div className="rounded-xl border border-border bg-muted/20 p-3 space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />
          Track stock
        </label>
        {trackStock && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Current stock">
              <input value={stockQuantity} onChange={(e) => setStockQuantity(e.target.value.replace(/\D/g, ''))} className="input" inputMode="numeric" />
            </Field>
            <Field label="Low-stock alert at">
              <input value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value.replace(/\D/g, ''))} className="input" inputMode="numeric" />
            </Field>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={recommended} onChange={(e) => setRecommended(e.target.checked)} />
          Chef&apos;s recommendation
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isNew} onChange={(e) => setIsNew(e.target.checked)} />
          New
        </label>
      </div>
      <Button
        type="submit"
        variant="gradient"
        size="xl"
        fullWidth
        loading={saving}
        leftIcon={<Save className="h-4 w-4" />}
      >
        Save
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
