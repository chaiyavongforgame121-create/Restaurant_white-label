'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface ComboItem {
  menu_item_id: string;
  quantity: number;
  is_swappable: boolean;
  swap_group: string | null;
}

interface Combo {
  id: string;
  name: string;
  description: string | null;
  total_price: number | string;
  image_url: string | null;
  is_active: boolean;
  combo_items: ComboItem[];
}

interface MenuItem {
  id: string;
  name: string;
  price: number | string;
}

interface Props {
  branchId: string;
  initialCombos: Combo[];
  menuItems: MenuItem[];
}

export function CombosManager({ branchId, initialCombos, menuItems }: Props) {
  const router = useRouter();
  const [combos, setCombos] = React.useState(initialCombos);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refetch = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('combo_sets')
      .select(
        `id, name, description, total_price, image_url, is_active,
         combo_items(menu_item_id, quantity, is_swappable, swap_group)`,
      )
      .eq('branch_id', branchId);
    setCombos((data ?? []) as Combo[]);
    router.refresh();
  };

  const createCombo = async () => {
    const name = window.prompt('Combo name (e.g. "Burger Combo", "Family Meal")');
    if (!name) return;
    const priceStr = window.prompt('Total price (USD)', '0');
    if (priceStr === null) return;
    const price = Number(priceStr);
    if (!Number.isFinite(price) || price <= 0) {
      setError('Invalid price');
      return;
    }
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('combo_sets').insert({
      branch_id: branchId,
      name,
      total_price: price,
      is_active: true,
    });
    if (insErr) {
      setError(insErr.message);
      return;
    }
    refetch();
  };

  const updateCombo = async (id: string, patch: Partial<Combo>) => {
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.from('combo_sets').update(patch).eq('id', id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setCombos((curr) => curr.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const deleteCombo = async (id: string) => {
    if (!window.confirm('Delete this combo? Existing orders are not affected.')) return;
    const supabase = getBrowserClient();
    await supabase.from('combo_sets').delete().eq('id', id);
    refetch();
  };

  const addItem = async (comboId: string, menuItemId: string) => {
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase
      .from('combo_items')
      .insert({ combo_id: comboId, menu_item_id: menuItemId, quantity: 1, is_swappable: false });
    if (insErr) {
      setError(insErr.message);
      return;
    }
    refetch();
  };

  const updateItemQty = async (comboId: string, menuItemId: string, qty: number) => {
    const supabase = getBrowserClient();
    if (qty <= 0) {
      await supabase
        .from('combo_items')
        .delete()
        .eq('combo_id', comboId)
        .eq('menu_item_id', menuItemId);
    } else {
      await supabase
        .from('combo_items')
        .update({ quantity: qty })
        .eq('combo_id', comboId)
        .eq('menu_item_id', menuItemId);
    }
    refetch();
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Combo meals</h1>
          <p className="mt-1 text-muted-foreground">
            Bundle items at a discount. Customers see combos in a featured row above the menu.
          </p>
        </div>
        <Button variant="gradient" onClick={createCombo} leftIcon={<Plus className="h-4 w-4" />}>
          New combo
        </Button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {combos.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          No combos yet. Click <strong>New combo</strong> to create your first bundle deal.
        </Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
          {combos.map((combo) => {
            const childItems = combo.combo_items
              .map((ci) => {
                const m = menuItems.find((x) => x.id === ci.menu_item_id);
                return m ? { ...ci, name: m.name, price: Number(m.price) } : null;
              })
              .filter((x): x is NonNullable<typeof x> => x !== null);
            const listPriceTotal = childItems.reduce((s, c) => s + c.price * c.quantity, 0);
            const savings = listPriceTotal - Number(combo.total_price);

            return (
              <li key={combo.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <input
                          value={combo.name}
                          onChange={(e) => updateCombo(combo.id, { name: e.target.value })}
                          className="focus-ring rounded-lg border border-border bg-background px-2 py-1 font-display text-lg font-bold"
                        />
                        <Badge variant={combo.is_active ? 'success' : 'muted'}>
                          {combo.is_active ? 'Active' : 'Hidden'}
                        </Badge>
                      </div>
                      <div className="mt-2 flex items-center gap-3 text-sm">
                        <label className="flex items-center gap-1">
                          <span className="text-muted-foreground">Price</span>
                          <input
                            type="number"
                            step="0.01"
                            value={String(combo.total_price)}
                            onChange={(e) => updateCombo(combo.id, { total_price: e.target.value as never })}
                            className="focus-ring w-24 rounded-lg border border-border bg-background px-2 py-1 tabular-nums"
                          />
                        </label>
                        {savings > 0 && (
                          <span className="text-xs font-semibold text-success">
                            Saves {formatCurrency(savings)}
                          </span>
                        )}
                        <label className="ml-auto flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={combo.is_active}
                            onChange={(e) => updateCombo(combo.id, { is_active: e.target.checked })}
                          /> Active
                        </label>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteCombo(combo.id)}
                      leftIcon={<Trash2 className="h-4 w-4" />}
                    >
                      Delete
                    </Button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setExpandedId((c) => (c === combo.id ? null : combo.id))}
                    className="focus-ring mt-3 text-xs font-semibold text-primary underline"
                  >
                    {expandedId === combo.id ? 'Hide contents' : `${childItems.length} item${childItems.length === 1 ? '' : 's'} in this combo →`}
                  </button>

                  {expandedId === combo.id && (
                    <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                      {childItems.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No items yet — add some below.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {childItems.map((ci) => (
                            <li key={ci.menu_item_id} className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-sm">
                              <span>{ci.name}</span>
                              <span className="flex items-center gap-3">
                                <span className="text-xs text-muted-foreground">{formatCurrency(ci.price)} each</span>
                                <input
                                  type="number"
                                  min={0}
                                  value={ci.quantity}
                                  onChange={(e) => updateItemQty(combo.id, ci.menu_item_id, Number(e.target.value) || 0)}
                                  className="focus-ring w-16 rounded-lg border border-border bg-background px-2 py-0.5 tabular-nums"
                                />
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

                      <AddItemPicker
                        menuItems={menuItems.filter((m) => !childItems.some((c) => c.menu_item_id === m.id))}
                        onPick={(id) => addItem(combo.id, id)}
                      />
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddItemPicker({
  menuItems,
  onPick,
}: {
  menuItems: MenuItem[];
  onPick: (id: string) => void;
}) {
  const [value, setValue] = React.useState('');

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => {
          const id = e.target.value;
          if (id) {
            onPick(id);
            setValue('');
          }
        }}
        className="focus-ring flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      >
        <option value="">Add an item…</option>
        {menuItems.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({formatCurrency(Number(m.price))})
          </option>
        ))}
      </select>
    </div>
  );
}
