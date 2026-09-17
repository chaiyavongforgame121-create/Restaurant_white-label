'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarX, Plus, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_UI_LOCALE, formatInZone, isUiLocale, localInputToUtcIso } from '@favornoms/shared';
import { Button, Card, IconButton, useConfirm } from '@favornoms/ui';

interface Closure {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

export function ClosuresManager({ branchId, timezone }: { branchId: string; timezone: string }) {
  const t = useTranslations('branch.closures');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const confirm = useConfirm();
  const [list, setList] = React.useState<Closure[]>([]);
  const [composing, setComposing] = React.useState(false);
  const [startsAt, setStartsAt] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Read after mount: the server renders in its own zone, so a clock printed during SSR is
  // wrong and a hydration mismatch. The list itself loads client-side for the same reason.
  const [shopNow, setShopNow] = React.useState<string | null>(null);
  React.useEffect(() => {
    setShopNow(formatInZone(new Date().toISOString(), timezone, {}, locale));
  }, [timezone, locale]);

  React.useEffect(() => {
    void refresh();
  }, [branchId]);

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('branch_closures')
      .select('id, starts_at, ends_at, reason')
      .eq('branch_id', branchId)
      .order('starts_at', { ascending: false });
    if (data) setList(data as Closure[]);
  };

  const create = async () => {
    // The pickers hand back wall-clock time with no zone. Sent raw, Postgres read it as UTC, so
    // a Chicago shop's "Christmas Day 12:01 AM" closure started at 6:01 PM on Christmas Eve and
    // customers could order through hours the merchant believed were blocked. These are the
    // SHOP's times — the same zone Opening hours are in — converted here to the instants
    // is_branch_open() compares against.
    const startsIso = localInputToUtcIso(startsAt, timezone);
    const endsIso = localInputToUtcIso(endsAt, timezone);
    if (!startsIso || !endsIso) {
      setError(t('unreadableTimes'));
      return;
    }
    // A closure that ends before it starts is accepted by the table and blocks nothing, which
    // looks to the merchant exactly like a closure that was ignored.
    if (Date.parse(endsIso) <= Date.parse(startsIso)) {
      setError(t('endBeforeStart'));
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('branch_closures').insert({
      branch_id: branchId,
      starts_at: startsIso,
      ends_at: endsIso,
      reason: reason || null,
    });
    setBusy(false);
    if (insErr) {
      console.error('Creating a closure failed', insErr);
      setError(insErr.code === '42501' ? t('noPermission') : t('saveFailed'));
      return;
    }
    setStartsAt(''); setEndsAt(''); setReason(''); setComposing(false);
    await refresh();
    router.refresh();
  };

  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: t('removeTitle'),
        body: t('removeBody'),
        confirmLabel: t('removeConfirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    await supabase.from('branch_closures').delete().eq('id', id);
    await refresh();
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
          {/* Named for the same reason as Opening hours: a merchant setting these from another
              country has no reason to suspect the fields mean a clock other than their own. */}
          <p className="mt-1 text-xs text-muted-foreground">
            {t.rich('zoneNotice', {
              zone: timezone.replace(/_/g, ' '),
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
            {shopNow && <> {t('shopClock', { time: shopNow })}</>}
          </p>
        </div>
        <Button onClick={() => setComposing((c) => !c)} variant={composing ? 'ghost' : 'soft'} size="md" leftIcon={<Plus className="h-4 w-4" />}>
          {composing ? t('cancel') : t('add')}
        </Button>
      </div>

      {composing && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="block sm:col-span-1">
            <span className="mb-1.5 block text-sm font-medium">{t('starts')}</span>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="input" />
          </label>
          <label className="block sm:col-span-1">
            <span className="mb-1.5 block text-sm font-medium">{t('ends')}</span>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="input" />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-sm font-medium">{t('reason')}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPlaceholder')} className="input" />
          </label>
          {error && <p className="sm:col-span-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button onClick={create} variant="gradient" loading={busy} disabled={!startsAt || !endsAt} className="sm:col-span-2">
            {t('create')}
          </Button>
        </div>
      )}

      <ul className="mt-3 divide-y divide-border/40">
        {list.length === 0 && (
          <li className="py-6 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <CalendarX className="h-6 w-6" /> {t('empty')}
          </li>
        )}
        {list.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2">
            <div>
              <p className="font-medium">
                {formatInZone(c.starts_at, timezone, {}, locale)} → {formatInZone(c.ends_at, timezone, {}, locale)}
                {/* Whether the block is actually on right now is the question a merchant asks
                    when a customer has just ordered through it. */}
                {Date.parse(c.starts_at) <= Date.now() && Date.now() <= Date.parse(c.ends_at) && (
                  <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
                    {t('closedNow')}
                  </span>
                )}
                {Date.parse(c.ends_at) < Date.now() && (
                  <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                    {t('ended')}
                  </span>
                )}
              </p>
              {c.reason && <p className="text-xs text-muted-foreground">{c.reason}</p>}
            </div>
            <IconButton label={t('delete')} size="sm" className="text-danger" onClick={() => remove(c.id)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </li>
        ))}
      </ul>

      <style jsx>{`
        .input { width: 100%; min-height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </Card>
  );
}
