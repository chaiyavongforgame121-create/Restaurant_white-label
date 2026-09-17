'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Edit3, Trash2 } from 'lucide-react';
import type { MenuCategory, MenuItem } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, IconButton } from '@favornoms/ui';
import { categoryDeleteErrorKey, menuErrorKey } from './menu-errors';

export const CATEGORY_EMOJIS = ['🍔', '🍕', '🥗', '🍟', '🥤', '🍰', '🍣', '🌮', '🍜', '☕', '🍦', '🍗', '🥪', '🍳'];

interface Props {
  branchId: string;
  categories: MenuCategory[];
  /** Every dish at the branch, hidden ones included: they move with their category too. */
  items: MenuItem[];
  /** Reloads categories and dishes from the database. */
  onChanged: () => Promise<void>;
  /** Also shown on the menu page, so it is still there once this panel closes. */
  onNotice: (message: string) => void;
}

/**
 * Every category of the branch, including empty ones, which the grid does not show at all — so
 * this is the only place a stray test or misspelt category can be found and removed.
 *
 * Deleting goes through delete_menu_category: a category that still holds dishes is only deleted
 * together with moving them to another category, and happy hours aimed at it keep discounting the
 * same dishes. A plain DELETE would leave those dishes with no category, off every menu.
 */
export function CategoryManager({ branchId, categories, items, onChanged, onNotice }: Props) {
  const t = useTranslations('menu');
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState('');
  const [draftEmoji, setDraftEmoji] = React.useState('');
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [moveTo, setMoveTo] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [newEmoji, setNewEmoji] = React.useState('🍽️');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  // One write at a time. `busy` only disables buttons; Enter in a field (or a held key) would
  // otherwise start a second insert before the first returns and create the category twice.
  const inFlight = React.useRef(false);
  const exclusive = async (run: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await run();
    } catch (err) {
      failed('category change', err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const counts = React.useMemo(() => {
    const map = new Map<string, { total: number; hidden: number }>();
    for (const item of items) {
      if (!item.categoryId) continue;
      const entry = map.get(item.categoryId) ?? { total: 0, hidden: 0 };
      entry.total += 1;
      if (item.isActive === false) entry.hidden += 1;
      map.set(item.categoryId, entry);
    }
    return map;
  }, [items]);

  const done = (message: string) => {
    setStatus(message);
    onNotice(message);
  };

  const failed = (context: string, err: unknown) => {
    console.error(`[menu] ${context} failed`, err);
    setError(t(`errors.${menuErrorKey(err)}`));
  };

  const startRename = (cat: MenuCategory) => {
    setDeletingId(null);
    setError(null);
    setStatus(null);
    setRenamingId(cat.id);
    setDraftName(cat.name);
    setDraftEmoji(cat.iconEmoji ?? '');
  };

  const startDelete = (cat: MenuCategory) => {
    setRenamingId(null);
    setError(null);
    setStatus(null);
    setDeletingId(cat.id);
    setMoveTo(categories.find((c) => c.id !== cat.id)?.id ?? '');
  };

  /** The chosen target if it is still offered, else the first one offered. The list changes under
   *  an open panel (a category added below, or deleted elsewhere), and a select whose value matches
   *  no option shows the first option while the state still holds the old value. */
  const moveTargetFor = (cat: MenuCategory) => {
    const others = categories.filter((c) => c.id !== cat.id);
    return others.find((c) => c.id === moveTo) ?? others[0];
  };

  const saveRename = (cat: MenuCategory) =>
    exclusive(async () => {
      const name = draftName.trim();
      if (!name) {
        setError(t('categories.nameRequired'));
        return;
      }
      setError(null);
      // `.select()` so an update that row-level security quietly skipped is not reported as saved.
      const { data, error: dbErr } = await getBrowserClient()
        .from('menu_categories')
        .update({ name, icon_emoji: draftEmoji.trim() || null })
        .eq('id', cat.id)
        .select('id');
      if (dbErr) {
        failed('rename category', dbErr);
        return;
      }
      if (!data?.length) {
        setError(t('categories.errors.unchanged'));
        // Most likely deleted elsewhere: show the list as it is now.
        await onChanged();
        return;
      }
      setRenamingId(null);
      done(t('categories.saved', { name }));
      await onChanged();
    });

  const confirmDelete = (cat: MenuCategory, count: number) =>
    exclusive(async () => {
      const target = count > 0 ? moveTargetFor(cat) : undefined;
      if (count > 0 && !target) {
        setError(t('categories.errors.invalidTarget'));
        return;
      }
      setError(null);
      const { data, error: rpcErr } = await getBrowserClient().rpc('delete_menu_category', {
        p_category_id: cat.id,
        ...(target ? { p_move_items_to: target.id } : {}),
      });
      if (rpcErr) {
        const key = categoryDeleteErrorKey(rpcErr);
        if (!key) {
          failed('delete_menu_category', rpcErr);
          return;
        }
        console.error('[menu] delete_menu_category refused', rpcErr);
        setError(
          key === 'usedByHappyHour'
            ? t('categories.errors.usedByHappyHour', { names: rpcErr.details ?? '' })
            : t(`categories.errors.${key}`),
        );
        // The list was out of date: a dish was added to it, or this category or the target is gone.
        if (key === 'notEmpty' || key === 'notFound' || key === 'invalidTarget') await onChanged();
        return;
      }
      const moved = Number((data as { moved_items?: number } | null)?.moved_items ?? 0);
      setDeletingId(null);
      done(
        target && moved > 0
          ? t('categories.deletedMoved', { name: cat.name, count: moved, target: target.name })
          : t('categories.deleted', { name: cat.name }),
      );
      await onChanged();
    });

  const addCategory = () =>
    exclusive(async () => {
      const name = newName.trim();
      if (!name) return;
      setError(null);
      setStatus(null);
      const maxOrder = categories.reduce((m, c) => Math.max(m, c.displayOrder ?? 0), -1);
      const { error: dbErr } = await getBrowserClient()
        .from('menu_categories')
        .insert({
          branch_id: branchId,
          name,
          icon_emoji: newEmoji.trim() || null,
          display_order: maxOrder + 1,
          is_active: true,
        });
      if (dbErr) {
        failed('create category', dbErr);
        return;
      }
      setNewName('');
      setNewEmoji('🍽️');
      done(t('categories.added', { name }));
      await onChanged();
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('categories.intro')}</p>

      {status && (
        <p role="status" className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {categories.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          {t('categories.empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {categories.map((cat) => {
            const count = counts.get(cat.id) ?? { total: 0, hidden: 0 };
            const others = categories.filter((c) => c.id !== cat.id);
            const renaming = renamingId === cat.id;
            const deleting = deletingId === cat.id;
            return (
              <li key={cat.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl" aria-hidden>
                    {cat.iconEmoji ?? '🍴'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{cat.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('categories.itemCount', { count: count.total })}
                      {count.hidden > 0 && ` · ${t('categories.hiddenCount', { count: count.hidden })}`}
                    </p>
                  </div>
                  <IconButton
                    label={t('categories.rename', { name: cat.name })}
                    size="sm"
                    onClick={() => (renaming ? setRenamingId(null) : startRename(cat))}
                    disabled={busy}
                  >
                    <Edit3 className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={t('categories.delete', { name: cat.name })}
                    size="sm"
                    className="text-danger"
                    onClick={() => (deleting ? setDeletingId(null) : startDelete(cat))}
                    disabled={busy}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>

                {renaming && (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    <EmojiAndName
                      emoji={draftEmoji}
                      name={draftName}
                      onEmoji={setDraftEmoji}
                      onName={setDraftName}
                      onSubmit={() => void saveRename(cat)}
                    />
                    <div className="flex gap-2">
                      <Button type="button" size="sm" onClick={() => void saveRename(cat)} loading={busy}>
                        {t('categories.save')}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRenamingId(null)} disabled={busy}>
                        {t('categories.cancel')}
                      </Button>
                    </div>
                  </div>
                )}

                {deleting && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3">
                    {count.total === 0 ? (
                      <p className="text-sm">{t('categories.deleteEmpty', { name: cat.name })}</p>
                    ) : others.length === 0 ? (
                      <p className="text-sm">
                        {t('categories.deleteNoTarget', { name: cat.name, count: count.total })}
                      </p>
                    ) : (
                      <>
                        <p className="text-sm">
                          {t('categories.deleteMove', { name: cat.name, count: count.total })}
                        </p>
                        <label className="block text-sm font-medium">
                          {t('categories.moveTo')}
                          <select
                            value={moveTargetFor(cat)?.id ?? ''}
                            onChange={(e) => setMoveTo(e.target.value)}
                            className="input mt-1 w-full"
                            disabled={busy}
                          >
                            {others.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.iconEmoji} {c.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="text-xs text-muted-foreground">{t('categories.deleteMoveHint')}</p>
                      </>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {(count.total === 0 || others.length > 0) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          onClick={() => void confirmDelete(cat, count.total)}
                          loading={busy}
                        >
                          {count.total === 0 ? t('categories.confirmDelete') : t('categories.confirmMoveDelete')}
                        </Button>
                      )}
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDeletingId(null)} disabled={busy}>
                        {t('categories.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
        <p className="text-sm font-semibold">{t('categories.addTitle')}</p>
        <EmojiAndName
          emoji={newEmoji}
          name={newName}
          onEmoji={setNewEmoji}
          onName={setNewName}
          onSubmit={() => void addCategory()}
        />
        <Button type="button" variant="soft" size="sm" onClick={() => void addCategory()} loading={busy} disabled={!newName.trim()}>
          {t('categories.add')}
        </Button>
      </div>
    </div>
  );
}

function EmojiAndName({
  emoji,
  name,
  onEmoji,
  onName,
  onSubmit,
}: {
  emoji: string;
  name: string;
  onEmoji: (value: string) => void;
  onName: (value: string) => void;
  onSubmit: () => void;
}) {
  const t = useTranslations('menu');
  return (
    <>
      <div className="flex items-center gap-2">
        <input
          value={emoji}
          onChange={(e) => onEmoji(e.target.value)}
          aria-label={t('categories.iconLabel')}
          maxLength={4}
          className="focus-ring h-11 w-14 shrink-0 rounded-xl border border-border bg-background text-center text-xl"
        />
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => {
            // Not while an input method is composing (Thai and Vietnamese keyboards), and not a held key.
            if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
          aria-label={t('categories.nameLabel')}
          placeholder={t('categories.namePlaceholder')}
          className="focus-ring h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base"
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CATEGORY_EMOJIS.map((em) => (
          <button
            key={em}
            type="button"
            onClick={() => onEmoji(em)}
            className={`h-8 w-8 rounded-lg border text-base ${emoji === em ? 'border-primary bg-primary/10' : 'border-border'}`}
          >
            {em}
          </button>
        ))}
      </div>
    </>
  );
}
