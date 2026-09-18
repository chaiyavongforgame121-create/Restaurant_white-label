'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';

/** my_open_shift answers `{ shift_id, clock_in_at, role, staff_member_id }`, or null. */
function readShiftId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).shift_id;
  return typeof id === 'string' && id ? id : null;
}

/** clock_in / clock_out codes that have a sentence of their own under `counter.header`. In
 *  order: `not_staff_at_branch` has to be tried before the `not_staff` it contains. */
const CLOCK_ERRORS = new Map<string, string>([
  ['not_staff_at_branch', 'clockNotStaff'],
  ['not_staff', 'clockNotStaff'],
  ['clocked_in_elsewhere', 'clockElsewhere'],
  // clock_out: the shift this screen was holding is not the caller's, or no longer exists.
  ['shift_not_found', 'clockShiftGone'],
  ['auth_required', 'clockSignIn'],
]);

function clockErrorKey(message: string): string | null {
  for (const [code, key] of CLOCK_ERRORS) if (message.includes(code)) return key;
  return null;
}

/**
 * Clock in and out from the till.
 *
 * The button looked the caller up with `staff_members.branch_id = this branch`, and clock_in did
 * the same. Every owner row is pinned to one branch, so at Food Thai Thai the owner reached the
 * till but could never clock in, and the only sign of it was a tooltip nobody hovers on a touch
 * screen. The open shift now comes from my_open_shift(branch), which resolves the caller's staff
 * row the way every other branch check does, and a failure is written out under the button.
 */
export function ClockButton({ branchId }: { branchId: string }) {
  const t = useTranslations('counter');
  const [openShiftId, setOpenShiftId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; code: string | null } | null>(null);

  const loadOpenShift = React.useCallback(async (): Promise<string | null> => {
    const { data, error: rpcErr } = await getBrowserClient().rpc('my_open_shift', {
      p_branch_id: branchId,
    });
    if (rpcErr) {
      console.error('counter: my_open_shift failed', rpcErr.message);
      return null;
    }
    return readShiftId(data);
  }, [branchId]);

  React.useEffect(() => {
    let cancelled = false;
    void loadOpenShift().then((id) => {
      if (!cancelled) setOpenShiftId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [loadOpenShift]);

  const fail = (message: string, what: 'clock_in' | 'clock_out') => {
    // The database's own wording is logged; the screen says what to do about it, and shows
    // the code for anything it has no sentence for, so a photo of the till is enough.
    console.error(`counter: ${what} failed`, message);
    const key = clockErrorKey(message);
    setError({
      message: t(`header.${key ?? 'clockError'}`),
      code: key ? null : (/^[a-z_]+$/.exec(message)?.[0] ?? null),
    });
  };

  const handle = async () => {
    setLoading(true);
    setError(null);
    const supabase = getBrowserClient();
    try {
      if (openShiftId) {
        const { error: rpcErr } = await supabase.rpc('clock_out', { p_shift_id: openShiftId });
        if (rpcErr) {
          fail(rpcErr.message, 'clock_out');
          // The shift this screen remembered is gone (closed elsewhere, or someone else's on a
          // shared till). Re-read the caller's own, or the button fails the same way on every tap.
          if (rpcErr.message.includes('shift_not_found')) setOpenShiftId(await loadOpenShift());
        } else {
          setOpenShiftId(null);
        }
      } else {
        const { data, error: rpcErr } = await supabase.rpc('clock_in', {
          p_branch_id: branchId,
          p_shift_role: 'cashier',
        });
        if (rpcErr?.message.includes('already_clocked_in')) {
          // Clocked in on another screen since this one loaded: show the shift, not an error.
          setOpenShiftId(await loadOpenShift());
        } else if (rpcErr) {
          fail(rpcErr.message, 'clock_in');
        } else {
          setOpenShiftId(data || (await loadOpenShift()));
        }
      }
    } catch (err) {
      fail((err as Error)?.message ?? String(err), openShiftId ? 'clock_out' : 'clock_in');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handle}
        disabled={loading}
        aria-describedby={error ? 'counter-clock-error' : undefined}
        className={`focus-ring inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-60 ${
          openShiftId
            ? 'bg-success/15 text-success hover:bg-success/25'
            : 'bg-muted hover:bg-muted/70'
        }`}
      >
        🕒 {openShiftId ? t('header.clockOut') : t('header.clockIn')}
      </button>
      {error && (
        <div
          id="counter-clock-error"
          role="alert"
          className="bg-card border-danger/40 text-danger shadow-soft absolute left-0 top-full z-30 mt-1.5 flex w-72 items-start gap-2 rounded-xl border px-3 py-2 text-xs"
        >
          <p className="flex-1">
            {error.message}
            {error.code && (
              <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">
                ({error.code})
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label={t('header.clockDismiss')}
            className="focus-ring text-muted-foreground hover:bg-muted -m-1 rounded-full p-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
