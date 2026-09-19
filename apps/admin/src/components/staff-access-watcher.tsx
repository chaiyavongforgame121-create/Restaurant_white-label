'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ShieldAlert, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { getMyStaffAccessRows } from '@favornoms/database/queries';
import { useRealtime } from '@favornoms/database/realtime';
import {
  ACCESS_CHANGED_FLAG,
  ACCESS_RELOADED_AT,
  accessNoticeApplies,
  encodeAccessNotice,
  nextReloadDelay,
  reloadWait,
  rowChangesAccess,
  rowsInScope,
  staffAccessFingerprint,
  type StaffAccessRow,
} from './staff-access';

/** How long the "your access changed" note stays up unless it is dismissed first. */
const NOTICE_MS = 20_000;

/** A page still alive this long after reload() was asked for turned it down at a "Leave site?"
 *  prompt (unsaved work somewhere on it). */
const RELOAD_STUCK_MS = 5_000;

interface Props {
  userId: string;
  restaurantId: string;
  /** The branch this screen serves (the counter, the kitchen board). Only rows that reach it are
   *  compared, so a change to the person's row at another branch leaves this screen alone. The
   *  back office leaves it out: its branch switcher lists every branch the person works at. */
  branchId?: string;
  /** This person's rows at the restaurant, as the server read them for this render. Null when
   *  that read failed; the first browser read then becomes the baseline. */
  initialRows: StaffAccessRow[] | null;
}

/**
 * Reloads this screen when the restaurant changes the signed-in person's own access.
 *
 * Capabilities are worked out on the server for every request, so a cashier made kitchen, or
 * suspended, kept a counter that looked usable until they happened to reload, and every tap
 * then failed on RLS. Mounted once in each of the three shells (back office, counter, kitchen),
 * which never nest, it listens for changes to this person's staff rows and forces a full reload
 * when one changes role, status or branch, so the server renders the page again with what they
 * may do now, or AccessDenied. A note after the reload says why the screen changed.
 *
 * Realtime only delivers what RLS lets this person read (staff_self_read: their own rows, in any
 * status), and only INSERTs and UPDATEs are asked for. A DELETE skips RLS and carries only the
 * id, so listening for them would mean taking every staff delete on the platform; the app never
 * deletes a claimed row anyway. Realtime can also miss events (a sleeping tablet, a dropped
 * socket), so every (re)connect, tab wake and network return re-reads the rows and compares
 * them with what the page was rendered with, which also catches a row that was deleted.
 *
 * Changes to anyone else's rows are not this screen's business: the admin who pressed Apply
 * refreshes their own page, and this never reloads it for someone else's change.
 */
export function StaffAccessWatcher({ userId, restaurantId, branchId, initialRows }: Props) {
  const t = useTranslations('common.accessChanged');
  const scope = branchId ?? null;

  const serverFingerprint = initialRows
    ? staffAccessFingerprint(rowsInScope(initialRows, scope))
    : null;
  // Every row is kept, not only the ones in scope: a row moving here from another branch is
  // recognised by what it was before.
  const known = React.useRef<{ rows: StaffAccessRow[]; fingerprint: string } | null>(
    initialRows && serverFingerprint !== null
      ? { rows: initialRows, fingerprint: serverFingerprint }
      : null,
  );
  // A router.refresh() renders the shell and the page again from what the server sees now, so
  // that is what this screen shows from then on. Keyed on the fingerprint: the array is new on
  // every render.
  const rowsRef = React.useRef(initialRows);
  rowsRef.current = initialRows;
  React.useEffect(() => {
    if (rowsRef.current && serverFingerprint !== null) {
      known.current = { rows: rowsRef.current, fingerprint: serverFingerprint };
    }
  }, [serverFingerprint]);

  // When someone last tapped or typed, so a reload lands between actions rather than on one.
  const lastInputAt = React.useRef<number | null>(null);
  React.useEffect(() => {
    const mark = () => {
      lastInputAt.current = Date.now();
    };
    window.addEventListener('pointerdown', mark, { capture: true, passive: true });
    window.addEventListener('keydown', mark, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', mark, { capture: true });
      window.removeEventListener('keydown', mark, { capture: true });
    };
  }, []);

  const userIdRef = React.useRef(userId);
  userIdRef.current = userId;
  // Written as the page actually goes, not before reload() is asked for: a reload turned down at
  // a "Leave site?" prompt must not leave a note for some later reload. Stable, so adding it
  // twice is a no-op and unmounting can take it off.
  const noteOnLeave = React.useCallback(() => {
    try {
      window.sessionStorage.setItem(
        ACCESS_CHANGED_FLAG,
        encodeAccessNotice(userIdRef.current, Date.now()),
      );
    } catch {
      /* private mode: the reload still happens, only the note after it is lost */
    }
  }, []);

  const reload = React.useRef<{ pending: boolean; timer: number | null }>({
    pending: false,
    timer: null,
  });
  React.useEffect(() => {
    const state = reload.current;
    return () => {
      if (state.timer !== null) window.clearTimeout(state.timer);
      // A client-side move to another shell mounts a watcher with a fresh baseline; a later
      // reload there must not say this one's change happened.
      window.removeEventListener('pagehide', noteOnLeave);
    };
  }, [noteOnLeave]);

  const forceReload = () => {
    const state = reload.current;
    if (state.pending) return;
    state.pending = true;
    const requestedAt = Date.now();
    let lastAt: number | null = null;
    try {
      const stored = window.sessionStorage.getItem(ACCESS_RELOADED_AT);
      lastAt = stored === null ? null : Number(stored);
    } catch {
      /* storage blocked: reload without spacing */
    }
    const attempt = () => {
      const wait = reloadWait({
        modalOpen: document.querySelector('[aria-modal="true"]') !== null,
        lastInputAt: lastInputAt.current,
        requestedAt,
        now: Date.now(),
      });
      if (wait > 0) {
        state.timer = window.setTimeout(attempt, wait);
        return;
      }
      try {
        window.sessionStorage.setItem(ACCESS_RELOADED_AT, String(Date.now()));
      } catch {
        /* the spacing is lost, the reload is not */
      }
      window.addEventListener('pagehide', noteOnLeave, { once: true });
      window.location.reload();
      // Still here: the reload was turned down. The page is still out of date, so the next
      // change or re-check asks again rather than finding the latch shut for good. The note
      // stays armed: whenever this page does go, its access had changed.
      state.timer = window.setTimeout(() => {
        state.pending = false;
        state.timer = null;
      }, RELOAD_STUCK_MS);
    };
    state.timer = window.setTimeout(attempt, nextReloadDelay(lastAt, requestedAt));
  };

  const recheck = async () => {
    const supabase = getBrowserClient();
    // Signed out in another tab, or a token refresh that failed on wake: the read below then goes
    // out without a session and comes back empty with no error (both policies are for signed-in
    // users), which is not the restaurant taking the person's access away.
    const { data: auth } = await supabase.auth.getSession();
    if (auth.session?.user.id !== userId) return;
    const rows = await getMyStaffAccessRows(supabase, userId, restaurantId);
    // A failed read proves nothing either way; the next reconnect or wake asks again.
    if (!rows) return;
    const fingerprint = staffAccessFingerprint(rowsInScope(rows, scope));
    if (!known.current) {
      known.current = { rows, fingerprint };
      return;
    }
    if (fingerprint !== known.current.fingerprint) forceReload();
  };

  useRealtime({
    channel: `staff-access-${userId}`,
    tables: [
      { table: 'staff_members', event: 'INSERT', filter: `user_id=eq.${userId}` },
      { table: 'staff_members', event: 'UPDATE', filter: `user_id=eq.${userId}` },
    ],
    onChange: (payload) => {
      const row = payload.new as Partial<StaffAccessRow> & { id?: string; restaurant_id?: string };
      // A change at another restaurant does not touch what this one lets them do.
      if (row.restaurant_id !== restaurantId) return;
      // Nothing to compare with yet: the page may already be out of date, so any change in
      // scope takes the new state.
      if (rowChangesAccess(known.current?.rows ?? [], row, scope)) forceReload();
    },
    refetch: recheck,
  });

  const [notice, setNotice] = React.useState(false);
  React.useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(ACCESS_CHANGED_FLAG);
      if (raw === null) return;
      window.sessionStorage.removeItem(ACCESS_CHANGED_FLAG);
      if (accessNoticeApplies(raw, userId, Date.now())) setNotice(true);
    } catch {
      /* storage blocked: there is no note to show */
    }
  }, [userId]);
  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(false), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  // The start page sends each role to its own screen, which matters when the new role cannot
  // open this one: a cashier made kitchen is on the counter's AccessDenied now. It only reads
  // active memberships, though, and sends someone with none into the new-restaurant wizard, so a
  // person suspended or removed here gets the sentence alone; the screen behind it has Sign out.
  const hasActiveRow = initialRows?.some((r) => r.status === 'active') ?? false;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[130] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-warning/30 bg-card p-4 text-sm text-foreground shadow-2xl"
      >
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('title')}</p>
          <p className="mt-0.5 text-muted-foreground">{t('body')}</p>
          {hasActiveRow && (
            <Link
              href="/"
              className="mt-2 inline-block font-medium text-primary underline underline-offset-2 hover:no-underline"
            >
              {t('startPage')}
            </Link>
          )}
        </div>
        <button
          type="button"
          onClick={() => setNotice(false)}
          aria-label={t('dismiss')}
          className="focus-ring -m-1 shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
