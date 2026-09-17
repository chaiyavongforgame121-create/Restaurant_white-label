'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, Tag, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_UI_LOCALE, formatInZone, isUiLocale, localInputToUtcIso } from '@favornoms/shared';
import { Badge, Button, Card, EmptyState, IconButton, useConfirm } from '@favornoms/ui';

interface Promo {
  id: string;
  branch_id: string;
  code: string;
  kind: 'percent_off' | 'fixed_off' | 'free_delivery';
  value: number;
  min_subtotal: number;
  max_redemptions: number | null;
  redemption_count: number;
  per_customer_limit: number;
  starts_at: string;
  ends_at: string | null;
  is_active: boolean;
}

export function PromosManager({
  branchId,
  timezone,
  initialPromos,
}: {
  branchId: string;
  /** The branch's zone — what the Ends at picker's wall-clock value means. */
  timezone: string;
  initialPromos: Promo[];
}) {
  const t = useTranslations('promos');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const [list, setList] = React.useState(initialPromos);
  const [composing, setComposing] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [kind, setKind] = React.useState<Promo['kind']>('percent_off');
  const [value, setValue] = React.useState('10');
  const [minSubtotal, setMinSubtotal] = React.useState('0');
  const [maxRedemptions, setMaxRedemptions] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const confirm = useConfirm();

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase.from('promos').select('*').eq('branch_id', branchId).order('created_at', { ascending: false });
    if (data) setList(data as Promo[]);
  };

  const create = async () => {
    // Same trap as the Closures card: datetime-local has no zone, and a raw value was stored
    // as UTC, so a promo set to end at 6:51 PM at the shop ended five or six hours early.
    const endsAtIso = endsAt ? localInputToUtcIso(endsAt, timezone) : null;
    if (endsAt && !endsAtIso) {
      setError(t('errors.unreadableEnd'));
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('promos').insert({
      branch_id: branchId,
      code: code.trim().toUpperCase(),
      kind,
      value: Number(value),
      min_subtotal: Number(minSubtotal) || 0,
      max_redemptions: maxRedemptions ? Number(maxRedemptions) : null,
      ends_at: endsAtIso,
    });
    setBusy(false);
    if (insErr) {
      // Raw constraint and policy text is for the console, not the merchant.
      console.error('Creating a promo failed', insErr);
      setError(
        insErr.code === '23505'
          ? t('errors.duplicateCode')
          : insErr.code === '42501'
            ? t('errors.permission')
            : insErr.code === '23514' || insErr.code === '22P02'
              ? t('errors.invalid')
              : t('errors.saveFailed'),
      );
      return;
    }
    setCode(''); setValue('10'); setMinSubtotal('0'); setMaxRedemptions(''); setEndsAt('');
    setComposing(false);
    void refresh();
  };

  const toggleActive = async (p: Promo) => {
    const supabase = getBrowserClient();
    await supabase.from('promos').update({ is_active: !p.is_active }).eq('id', p.id);
    void refresh();
  };

  const remove = async (p: Promo) => {
    if (
      !(await confirm({
        title: t('deleteDialog.title', { code: p.code }),
        body: t('deleteDialog.body'),
        confirmLabel: t('deleteDialog.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    await supabase.from('promos').delete().eq('id', p.id);
    void refresh();
  };

  const formatKind = (p: Promo) => {
    if (p.kind === 'percent_off') return t('describe.percentOff', { value: p.value });
    if (p.kind === 'fixed_off') return t('describe.fixedOff', { value: p.value });
    return t('describe.freeDelivery');
  };

  const describePromo = (p: Promo) => {
    const parts = [
      formatKind(p),
      t('describe.minimum', { amount: p.min_subtotal }),
      p.max_redemptions
        ? t('describe.usedOf', { used: p.redemption_count, max: p.max_redemptions })
        : t('describe.used', { used: p.redemption_count }),
    ];
    if (p.ends_at) parts.push(t('describe.ends', { date: formatInZone(p.ends_at, timezone, {}, locale) }));
    return parts.join(' · ');
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button onClick={() => setComposing((c) => !c)} variant={composing ? 'ghost' : 'gradient'} leftIcon={<Plus className="h-4 w-4" />}>
          {composing ? t('cancel') : t('new')}
        </Button>
      </header>

      {composing && (
        <Card className="mb-6 space-y-3 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('fields.code')}>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="input" placeholder={t('fields.codePlaceholder')} />
            </Field>
            <Field label={t('fields.kind')}>
              <select value={kind} onChange={(e) => setKind(e.target.value as Promo['kind'])} className="input">
                <option value="percent_off">{t('kinds.percent_off')}</option>
                <option value="fixed_off">{t('kinds.fixed_off')}</option>
                <option value="free_delivery">{t('kinds.free_delivery')}</option>
              </select>
            </Field>
            {kind !== 'free_delivery' && (
              <Field label={kind === 'percent_off' ? t('fields.percent') : t('fields.amount')}>
                <input value={value} onChange={(e) => setValue(e.target.value)} className="input" inputMode="decimal" />
              </Field>
            )}
            <Field label={t('fields.minSubtotal')}>
              <input value={minSubtotal} onChange={(e) => setMinSubtotal(e.target.value.replace(/[^0-9.]/g, ''))} className="input" inputMode="decimal" />
            </Field>
            <Field label={t('fields.maxRedemptions')}>
              <input value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value.replace(/\D/g, ''))} className="input" inputMode="numeric" placeholder={t('fields.maxRedemptionsPlaceholder')} />
            </Field>
            <Field label={t('fields.endsAt', { zone: timezone.replace(/_/g, ' ') })}>
              <input value={endsAt} onChange={(e) => setEndsAt(e.target.value)} type="datetime-local" className="input" />
            </Field>
          </div>
          {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button variant="gradient" onClick={create} disabled={!code} loading={busy}>{t('create')}</Button>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState icon={<Tag className="h-7 w-7" />} title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <Card className="divide-y divide-border/40">
          {list.map((p) => (
            <div key={p.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-mono text-lg font-bold">{p.code}</p>
                <p className="text-xs text-muted-foreground">{describePromo(p)}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={p.is_active ? 'success' : 'muted'}>{p.is_active ? t('status.active') : t('status.paused')}</Badge>
                <button onClick={() => toggleActive(p)} className="text-xs text-muted-foreground underline">
                  {p.is_active ? t('pause') : t('activate')}
                </button>
                <IconButton label={t('delete')} size="sm" className="text-danger" onClick={() => remove(p)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          ))}
        </Card>
      )}

      <style jsx>{`
        .input { width: 100%; min-height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-sm font-medium">{label}</span>{children}</label>;
}
