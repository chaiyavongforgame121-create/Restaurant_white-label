'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import {
  DEFAULT_UI_LOCALE,
  billingErrorMessage,
  describeBillingError,
  isUiLocale,
  type MenuCategory,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { getSupabaseEnv } from '@favornoms/database/env';
import { Badge, Button, Card, IconButton } from '@favornoms/ui';
import { CsvImportCard } from './csv-import-card';

interface ProposedItem {
  category: string;
  name: string;
  description?: string;
  price: number;
  station?: 'hot' | 'cold' | 'bar' | 'dessert' | 'expo';
  _accepted?: boolean;
}

/** Kitchen stations the importer knows; anything else the AI returns is shown as it came. */
const STATION_KEYS = ['hot', 'cold', 'bar', 'dessert', 'expo'] as const;
function isKnownStation(value: string): value is (typeof STATION_KEYS)[number] {
  return (STATION_KEYS as readonly string[]).includes(value);
}

type DbErrorKey = 'permissionDenied' | 'network' | 'duplicate' | 'inUse' | 'invalidValue' | 'generic';

/** Raw PostgREST text never reaches the merchant: known codes get a translated sentence. */
function dbErrorKey(err: { code?: string; message?: string }): DbErrorKey {
  const message = err.message ?? '';
  if (err.code === '42501' || /row-level security|permission denied/i.test(message)) return 'permissionDenied';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'network';
  if (err.code === '23505') return 'duplicate';
  if (err.code === '23503') return 'inUse';
  if (err.code && /^(22|23)/.test(err.code)) return 'invalidValue';
  return 'generic';
}

/** Storage upload failures, as a message key under `menuExtras`. */
function uploadErrorKey(message: string): string {
  if (/maximum allowed size|too large|413/i.test(message)) return 'import.errors.fileTooLarge';
  if (/mime|file type|not supported/i.test(message)) return 'import.errors.fileTypeNotAllowed';
  if (/row-level security|permission|unauthorized|403/i.test(message)) return 'errors.permissionDenied';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'errors.network';
  return 'import.errors.uploadFailed';
}

/** Error codes returned by the import-menu edge function, as a message key under `menuExtras`. */
function analyzeErrorKey(code: string | undefined): string {
  switch (code) {
    case 'auth_required':
      return 'import.errors.signedOut';
    case 'not_authorized':
      return 'import.errors.notAllowed';
    case 'anthropic_not_configured':
      return 'import.errors.aiUnavailable';
    case 'rate_limited':
      return 'import.errors.rateLimited';
    default:
      return 'import.errors.analyzeFailed';
  }
}

export function MenuImportView({
  branchId,
  categories,
}: {
  branchId: string;
  categories: MenuCategory[];
}) {
  const t = useTranslations('menuExtras');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const [hint, setHint] = React.useState('');
  const [items, setItems] = React.useState<ProposedItem[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedCount, setSavedCount] = React.useState<number | null>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setItems([]);
    setSavedCount(null);
    try {
      const supabase = getBrowserClient();
      const path = `imports/${branchId}/${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
      const { error: upErr } = await supabase.storage.from('branch-assets').upload(path, file, {
        upsert: false,
        contentType: file.type,
      });
      if (upErr) {
        console.error('[menu-import] upload failed', upErr);
        setError(t(uploadErrorKey(upErr.message)));
        return;
      }
      const { data: pub } = supabase.storage.from('branch-assets').getPublicUrl(path);
      setImageUrl(pub.publicUrl);
    } catch (err) {
      console.error('[menu-import] upload failed', err);
      setError(t(uploadErrorKey((err as Error)?.message ?? '')));
    } finally {
      setBusy(false);
    }
  };

  const analyze = async () => {
    if (!imageUrl) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        setError(t('import.errors.signedOut'));
        return;
      }

      const { url } = getSupabaseEnv();
      const res = await fetch(`${url}/functions/v1/import-menu`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ image_url: imageUrl, branch_id: branchId, hint }),
      });
      const body = (await res.json()) as { items?: ProposedItem[]; error?: string };
      if (!res.ok || body.error) {
        console.error('[menu-import] analyze failed', res.status, body);
        const billing = describeBillingError(body.error ?? '');
        setError(billing ? billingErrorMessage(billing, locale) : t(analyzeErrorKey(body.error)));
        return;
      }
      setItems((body.items ?? []).map((i) => ({ ...i, _accepted: true })));
    } catch (err) {
      console.error('[menu-import] analyze failed', err);
      const key = dbErrorKey({ message: (err as Error)?.message });
      setError(key === 'network' ? t('errors.network') : t('import.errors.analyzeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const importAccepted = async () => {
    const accepted = items.filter((i) => i._accepted);
    if (accepted.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const catMap = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
      const newCatNames = new Set<string>();
      for (const item of accepted) {
        if (!catMap.has(item.category.toLowerCase())) newCatNames.add(item.category);
      }
      for (const catName of newCatNames) {
        const { data: created } = await supabase
          .from('menu_categories')
          .insert({ branch_id: branchId, name: catName, display_order: 999 })
          .select('id, name')
          .single();
        if (created) catMap.set(created.name.toLowerCase(), created.id);
      }

      const rows = accepted.map((i, idx) => ({
        branch_id: branchId,
        category_id: catMap.get(i.category.toLowerCase())!,
        name: i.name,
        description: i.description ?? null,
        price: i.price,
        station: i.station ?? 'expo',
        is_active: true,
        display_order: idx,
      }));
      const { error: insErr, count } = await supabase
        .from('menu_items')
        .insert(rows, { count: 'exact' });
      if (insErr) {
        console.error('[menu-import] insert failed', insErr);
        setError(t(`errors.${dbErrorKey(insErr)}`));
        return;
      }
      setSavedCount(count ?? rows.length);
      setItems([]);
      setImageUrl(null);
      setFile(null);
      router.refresh();
    } catch (err) {
      console.error('[menu-import] import failed', err);
      setError(t(`errors.${dbErrorKey({ message: (err as Error)?.message })}`));
    } finally {
      setBusy(false);
    }
  };

  const acceptedCount = items.filter((i) => i._accepted).length;

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('import.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('import.subtitle')}</p>
      </header>

      <Card className="mb-6 space-y-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1.5 block text-sm font-medium">{t('import.menuImage')}</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-primary file:px-4 file:py-2.5 file:text-primary-foreground"
            />
          </label>
          <Button
            variant="gradient"
            onClick={upload}
            disabled={!file || busy}
            loading={busy && !!file && !imageUrl}
            leftIcon={<Upload className="h-4 w-4" />}
          >
            {t('import.upload')}
          </Button>
        </div>

        <label>
          <span className="mb-1.5 block text-sm font-medium">{t('import.hint')}</span>
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder={t('import.hintPlaceholder')}
            className="input"
          />
        </label>

        {imageUrl && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('import.uploaded')}</p>
            <Button
              variant="gradient"
              onClick={analyze}
              disabled={busy}
              loading={busy && items.length === 0}
              leftIcon={<Sparkles className="h-4 w-4" />}
            >
              {t('import.analyze')}
            </Button>
          </div>
        )}

        {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {savedCount !== null && (
          <p className="rounded-xl bg-success/10 px-4 py-3 text-sm text-success">
            {t('import.imported', { count: savedCount })}
          </p>
        )}

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
      </Card>

      {/* CSV import — alternative for users who already have a spreadsheet */}
      <CsvImportCard
        branchId={branchId}
        categories={categories}
        onImported={(n) => {
          setSavedCount(n);
          router.refresh();
        }}
      />

      {items.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">
              {t('import.selected', { selected: acceptedCount, total: items.length })}
            </h2>
            <Button
              variant="gradient"
              onClick={importAccepted}
              disabled={busy || acceptedCount === 0}
              loading={busy}
              leftIcon={<Check className="h-4 w-4" />}
            >
              {t('import.importSelected')}
            </Button>
          </div>

          <Card className="divide-y divide-border/40">
            {items.map((item, idx) => (
              <div key={idx} className="flex items-start gap-3 p-3">
                <input
                  type="checkbox"
                  checked={!!item._accepted}
                  onChange={(e) =>
                    setItems((curr) =>
                      curr.map((it, i) => (i === idx ? { ...it, _accepted: e.target.checked } : it)),
                    )
                  }
                  className="mt-1.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <input
                      value={item.name}
                      onChange={(e) =>
                        setItems((curr) =>
                          curr.map((it, i) => (i === idx ? { ...it, name: e.target.value } : it)),
                        )
                      }
                      className="flex-1 bg-transparent font-medium outline-none"
                    />
                    <input
                      type="number"
                      value={item.price}
                      onChange={(e) =>
                        setItems((curr) =>
                          curr.map((it, i) =>
                            i === idx ? { ...it, price: Number(e.target.value) } : it,
                          ),
                        )
                      }
                      className="w-24 bg-transparent text-right font-display font-bold text-primary outline-none"
                    />
                  </div>
                  <input
                    value={item.description ?? ''}
                    onChange={(e) =>
                      setItems((curr) =>
                        curr.map((it, i) =>
                          i === idx ? { ...it, description: e.target.value } : it,
                        ),
                      )
                    }
                    placeholder={t('import.descriptionPlaceholder')}
                    className="w-full bg-transparent text-sm text-muted-foreground outline-none"
                  />
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="muted">{item.category}</Badge>
                    {item.station && (
                      <Badge variant="muted">
                        {isKnownStation(item.station) ? t(`import.stations.${item.station}`) : item.station}
                      </Badge>
                    )}
                  </div>
                </div>
                <IconButton
                  label={t('import.remove')}
                  size="sm"
                  className="text-danger"
                  onClick={() =>
                    setItems((curr) => curr.filter((_, i) => i !== idx))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            ))}
          </Card>
        </div>
      )}

      {busy && items.length === 0 && imageUrl && (
        <Card className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('import.analyzing')}
        </Card>
      )}
    </div>
  );
}
