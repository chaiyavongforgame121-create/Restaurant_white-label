'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Minus, Plus, SlidersHorizontal } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { adjustLoyaltyPoints } from '@favornoms/database/queries';
import { Button, Segmented } from '@favornoms/ui';
import {
  ADJUST_MAX_POINTS,
  ADJUST_REASON_MAX,
  adjustPointsErrorKey,
  parseAdjustPoints,
  type AdjustPointsError,
} from './adjust-points-model';

interface Props {
  branchId: string;
  customerId: string;
  /** This branch's balance, or null when the member has no wallet here yet. */
  balance: number | null;
}

/**
 * A staff correction to one member's points at THIS branch (adjust_loyalty_points). Only rendered
 * for loyalty.manage; the function checks the same capability, so hiding it is courtesy, not the
 * lock. The reason is required because the member reads it in their own points history.
 */
export function AdjustPoints({ branchId, customerId, balance }: Props) {
  const t = useTranslations('customers.detail.loyalty.adjust');
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [direction, setDirection] = React.useState<'add' | 'remove'>('add');
  const [points, setPoints] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<AdjustPointsError | null>(null);
  const [done, setDone] = React.useState<number | null>(null);
  const reasonId = React.useId();
  const pointsId = React.useId();

  const reset = () => {
    setDirection('add');
    setPoints('');
    setReason('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const amount = parseAdjustPoints(points);
    if (amount === null) {
      setError('badDelta');
      return;
    }
    const why = reason.trim();
    if (!why || why.length > ADJUST_REASON_MAX) {
      setError('badReason');
      return;
    }
    if (direction === 'remove' && amount > (balance ?? 0)) {
      setError('insufficient');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await adjustLoyaltyPoints(
      getBrowserClient(),
      branchId,
      customerId,
      direction === 'add' ? amount : -amount,
      why,
    );
    setBusy(false);
    if (!res.ok) {
      if (res.error) console.error('adjust_loyalty_points failed', res.error);
      setError(adjustPointsErrorKey(res.error));
      return;
    }
    reset();
    setOpen(false);
    setDone(res.pointsBalance ?? null);
    // The drawer is read on the server; this re-reads the balance, the ledger and the list row.
    router.refresh();
  };

  if (!open) {
    return (
      <div className="mt-3 space-y-2">
        {done !== null ? (
          <p role="status" className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
            {t('done', { points: done })}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<SlidersHorizontal className="h-4 w-4" />}
          onClick={() => {
            setDone(null);
            setOpen(true);
          }}
        >
          {t('open')}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-border p-3" noValidate>
      <p className="text-sm font-semibold">{t('title')}</p>
      <Segmented<'add' | 'remove'>
        value={direction}
        onChange={(v) => {
          setDirection(v);
          setError(null);
        }}
        options={[
          { value: 'add', label: t('add'), icon: <Plus className="h-4 w-4" /> },
          { value: 'remove', label: t('remove'), icon: <Minus className="h-4 w-4" /> },
        ]}
      />
      <label htmlFor={pointsId} className="block">
        <span className="mb-1.5 block text-sm font-medium">{t('pointsLabel')}</span>
        <input
          id={pointsId}
          value={points}
          onChange={(e) => {
            setPoints(e.target.value.replace(/\D/g, ''));
            setError(null);
          }}
          inputMode="numeric"
          maxLength={7}
          autoComplete="off"
          className="input"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          {t('balanceNow', { points: balance ?? 0 })}
        </span>
      </label>
      <label htmlFor={reasonId} className="block">
        <span className="mb-1.5 block text-sm font-medium">{t('reasonLabel')}</span>
        <input
          id={reasonId}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          maxLength={ADJUST_REASON_MAX}
          placeholder={t('reasonPlaceholder')}
          autoComplete="off"
          className="input"
        />
        <span className="mt-1 block text-xs text-muted-foreground">{t('reasonHint')}</span>
      </label>
      {error ? (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {t(`error.${error}`, { max: ADJUST_MAX_POINTS, length: ADJUST_REASON_MAX })}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          {direction === 'add' ? t('submitAdd') : t('submitRemove')}
        </Button>
      </div>
    </form>
  );
}
