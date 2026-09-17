'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronLeft, ShieldAlert, Store } from 'lucide-react';
import { Badge, Button, Card, useUiLocale } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import {
  applyToBranch,
  reapplyToBranch,
  withdrawDriverApplication,
  type DriverApproval,
} from '@favornoms/database/queries';
import { useDriverSession } from '@/components/driver-session';
import {
  APPLICATION_BADGE_VARIANT,
  applicationAction,
  compareApplications,
  formatApplicationDate,
  REAPPLY_COOLDOWN_DAYS,
  reapplyAvailableAt,
} from './applications';

interface BranchRow {
  id: string;
  name: string;
  restaurant: { name: string } | null;
}

// KYC docs a driver must upload before they may apply to a restaurant
// (mirrors DOC_KEYS in profile/_components/documents). A verified driver already has them.
// These are storage object names, not labels: the names shown for them are
// `profile.docs.{key}` in the catalogue.
const REQUIRED_DOCS = ['license', 'vehicle_reg', 'selfie'] as const;
type RequiredDoc = (typeof REQUIRED_DOCS)[number];

// How long the "tap again" confirmation stays armed before it reverts.
const CONFIRM_WINDOW_MS = 4000;

export function ApplyView() {
  const router = useRouter();
  const t = useTranslations('onboarding');
  const tDocs = useTranslations('profile.docs');
  const format = useFormatter();
  const locale = useUiLocale();
  const { driver, refresh } = useDriverSession();
  const [branches, setBranches] = React.useState<BranchRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  // All three are keyed by branch_id so the same handler serves the applications list and
  // the restaurant card for that branch — whichever one the rider happened to tap.
  const [busy, setBusy] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<Record<string, string>>({});
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const confirmTimer = React.useRef<number | null>(null);

  const kycVerified = (driver.kyc_status ?? 'pending') === 'verified';
  // null = still checking; true = all docs uploaded (or verified); false = missing docs.
  const [docsComplete, setDocsComplete] = React.useState<boolean | null>(kycVerified ? true : null);
  // Naming the missing documents is the difference between a rider finishing signup and a
  // rider quietly giving up: an application is never created until all three are uploaded,
  // so an incomplete rider is invisible to every restaurant and nobody can tell them why.
  const [missingDocs, setMissingDocs] = React.useState<RequiredDoc[]>([]);
  const [notice, setNotice] = React.useState(false);
  const noticeTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('branches')
        .select('id, name, restaurant:restaurants(name)')
        .eq('is_active', true)
        .order('name', { ascending: true });
      if (!cancelled) {
        setBranches((data ?? []) as unknown as BranchRow[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Are the required KYC documents all uploaded? (same check the profile page uses)
  React.useEffect(() => {
    if (kycVerified) return; // verified => docs already done
    let cancelled = false;
    const supabase = getBrowserClient();
    void supabase.storage
      .from('driver-kyc')
      .list(driver.id, { limit: 50 })
      .then(({ data }) => {
        if (cancelled) return;
        const uploaded = new Set((data ?? []).map((f) => f.name.split('.')[0]));
        const missing = REQUIRED_DOCS.filter((k) => !uploaded.has(k));
        setMissingDocs(missing);
        setDocsComplete(missing.length === 0);
      });
    return () => {
      cancelled = true;
    };
  }, [driver.id, kycVerified]);

  React.useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  // driver_approvals is not in the realtime publication and the session loads it once on
  // mount, so a rider watching this screen while the merchant decides would see the old
  // badge for ever. Refetch whenever the screen comes back to the front, or the phone
  // reconnects — the same wake-up trick useRealtime uses.
  React.useEffect(() => {
    const wake = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [refresh]);

  const applications = React.useMemo(
    () => [...(driver.approvals ?? [])].sort(compareApplications),
    [driver.approvals],
  );
  const approvedCount = applications.filter((a) => a.status === 'approved').length;
  const pendingCount = applications.filter((a) => a.status === 'pending').length;

  const approvalFor = (branchId: string): DriverApproval | null =>
    driver.approvals?.find((a) => a.branch_id === branchId) ?? null;

  const setError = (branchId: string, message: string) =>
    setRowError((m) => ({ ...m, [branchId]: message }));

  const clearError = (branchId: string) => setRowError((m) => ({ ...m, [branchId]: '' }));

  // A server message nobody mapped is not shown to the rider as-is: it is in whatever
  // language the database speaks. Keep it for the console, show a translated line.
  const setUnknownError = (branchId: string, raw: string) => {
    console.error('[apply]', raw);
    setError(branchId, t('apply.errors.generic'));
  };

  const armConfirm = (branchId: string) => {
    setConfirming(branchId);
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirming(null), CONFIRM_WINDOW_MS);
  };

  // Gate: can't apply until documents are uploaded. Tapping Apply warns, then
  // sends the driver to the profile page to upload.
  const requireDocs = () => {
    if (docsComplete === true) return true;
    setNotice(true);
    if ('vibrate' in navigator) navigator.vibrate([20, 40, 20]);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => router.push('/app/profile'), 1100);
    return false;
  };

  const apply = async (branchId: string) => {
    if (!requireDocs()) return;
    setBusy(branchId);
    clearError(branchId);
    const { error } = await applyToBranch(getBrowserClient(), driver.id, branchId);
    // A unique-violation just means we already applied — refresh shows the status.
    if (error && !/duplicate|unique/i.test(error.message)) {
      setUnknownError(branchId, error.message);
    }
    if ('vibrate' in navigator) navigator.vibrate(30);
    await refresh();
    setBusy(null);
  };

  const withdraw = async (approval: DriverApproval) => {
    setBusy(approval.branch_id);
    clearError(approval.branch_id);
    const { data, error } = await withdrawDriverApplication(getBrowserClient(), approval.id);
    setConfirming(null);
    if (error) {
      setUnknownError(approval.branch_id, error.message);
    } else if (!data || data.length === 0) {
      // Zero rows under RLS is reported as success, not an error: the policy only matches
      // pending rows, so the merchant decided while the rider was tapping.
      setError(approval.branch_id, t('apply.errors.tooLateToWithdraw'));
    }
    await refresh();
    setBusy(null);
  };

  const reapply = async (branchId: string) => {
    if (!requireDocs()) return;
    setBusy(branchId);
    clearError(branchId);
    const { error } = await reapplyToBranch(getBrowserClient(), branchId);
    if (error) {
      if (/reapply_too_soon/.test(error.message)) {
        setError(branchId, t('apply.errors.reapplyTooSoon', { days: REAPPLY_COOLDOWN_DAYS }));
      } else if (/not_rejected/.test(error.message)) {
        setError(branchId, t('apply.errors.changed'));
      } else {
        setUnknownError(branchId, error.message);
      }
    } else if ('vibrate' in navigator) {
      navigator.vibrate(30);
    }
    await refresh();
    setBusy(null);
  };

  const actionsFor = (approval: DriverApproval) => {
    const action = applicationAction(approval.status);
    if (action === 'none') return null;
    if (action === 'withdraw') {
      const armed = confirming === approval.branch_id;
      return (
        <Button
          size="sm"
          variant={armed ? 'danger' : 'ghost'}
          loading={busy === approval.branch_id}
          onClick={() => (armed ? void withdraw(approval) : armConfirm(approval.branch_id))}
        >
          {armed ? t('apply.confirmWithdraw') : t('apply.withdraw')}
        </Button>
      );
    }
    const availableAt = reapplyAvailableAt(approval);
    return (
      <div className="flex flex-col items-end gap-0.5">
        <Button
          size="sm"
          variant="soft"
          disabled={availableAt !== null}
          loading={busy === approval.branch_id}
          onClick={() => void reapply(approval.branch_id)}
        >
          {t('apply.applyAgain')}
        </Button>
        {availableAt && (
          <span className="text-[11px] text-muted-foreground">
            {t('apply.availableFrom', { date: formatApplicationDate(availableAt, locale) })}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="pb-6">
      <header className="flex items-center gap-2 px-4 pt-safe pt-5">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label={t('apply.back')}
          className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold">{t('apply.title')}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {applications.length === 0
              ? t('apply.subtitleEmpty')
              : pendingCount > 0
                ? t('apply.subtitleCountsWaiting', {
                    applied: applications.length,
                    approved: approvedCount,
                    waiting: pendingCount,
                  })
                : t('apply.subtitleCounts', {
                    applied: applications.length,
                    approved: approvedCount,
                  })}
          </p>
        </div>
      </header>

      {docsComplete === false && (
        <button
          type="button"
          onClick={() => router.push('/app/profile')}
          className="focus-ring mx-4 mt-4 flex w-[calc(100%-2rem)] items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-left text-warning"
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <span className="flex-1 text-sm">
            <span className="block font-semibold">
              {t('apply.docsBanner.title', { count: missingDocs.length || 3 })}
            </span>
            <span className="block text-xs">
              {t('apply.docsBanner.body', {
                docs:
                  missingDocs.length > 0
                    ? format.list(
                        missingDocs.map((k) => tDocs(`${k}.inline`)),
                        { type: 'conjunction' },
                      )
                    : t('apply.docsBanner.allDocs'),
              })}
            </span>
          </span>
        </button>
      )}

      {/* Built from driver.approvals rather than by joining the branch list below: an
          approval to a branch that has since been deactivated is not in that list, and
          silently dropping it is how a rider loses a restaurant with no explanation. */}
      {applications.length > 0 && (
        <section className="mt-5 px-4">
          <h2 className="px-1 pb-2 font-display text-lg font-semibold">
            {t('apply.yourApplications')}
          </h2>
          <div className="space-y-3">
            {applications.map((a) => {
              const error = rowError[a.branch_id];
              return (
                <Card key={a.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Store className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">
                        {a.branch?.restaurant?.name ??
                          a.branch?.name ??
                          t('apply.noLongerListed')}
                      </p>
                      {a.branch && (
                        <p className="truncate text-sm text-muted-foreground">{a.branch.name}</p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {a.reviewed_at
                          ? t('apply.appliedDecided', {
                              applied: formatApplicationDate(a.applied_at, locale),
                              decided: formatApplicationDate(a.reviewed_at, locale),
                            })
                          : t('apply.applied', {
                              applied: formatApplicationDate(a.applied_at, locale),
                            })}
                      </p>
                    </div>
                    <Badge variant={APPLICATION_BADGE_VARIANT[a.status]} className="shrink-0">
                      {t(`apply.status.${a.status}`)}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(`apply.explanation.${a.status}`)}
                  </p>
                  {a.notes && (
                    <p className="mt-2 line-clamp-4 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      {t.rich('apply.whatTheySaid', {
                        notes: a.notes,
                        label: (chunks) => (
                          <span className="font-semibold text-foreground">{chunks}</span>
                        ),
                      })}
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="mt-2 text-xs text-danger">
                      {error}
                    </p>
                  )}
                  <div className="mt-2 flex justify-end empty:hidden">{actionsFor(a)}</div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      <div className="mt-5 space-y-3 px-4">
        {applications.length > 0 && !loading && branches.length > 0 && (
          <h2 className="px-1 font-display text-lg font-semibold">{t('apply.allRestaurants')}</h2>
        )}
        {loading ? (
          <p className="px-1 text-sm text-muted-foreground">{t('apply.loading')}</p>
        ) : branches.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">{t('apply.empty')}</Card>
        ) : (
          branches.map((b) => {
            const approval = approvalFor(b.id);
            const error = rowError[b.id];
            return (
              <Card key={b.id} className="p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                    <Store className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">
                      {b.restaurant?.name ?? t('apply.restaurantFallback')}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{b.name}</p>
                  </div>
                  {approval ? (
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <Badge variant={APPLICATION_BADGE_VARIANT[approval.status]}>
                        {t(`apply.status.${approval.status}`)}
                      </Badge>
                      {actionsFor(approval)}
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant={docsComplete === true ? 'gradient' : 'soft'}
                      loading={busy === b.id}
                      onClick={() => void apply(b.id)}
                    >
                      {t('apply.apply')}
                    </Button>
                  )}
                </div>
                {error && (
                  // An applied branch already announces this error from the applications
                  // card above; alerting twice reads it out twice.
                  <p role={approval ? undefined : 'alert'} className="mt-2 text-xs text-danger">
                    {error}
                  </p>
                )}
              </Card>
            );
          })
        )}
      </div>

      {notice && (
        <div className="fixed inset-x-4 bottom-24 z-50 rounded-2xl bg-warning px-4 py-3 text-center text-sm font-semibold text-white shadow-warm">
          {t('apply.docsNotice')}
        </div>
      )}
    </div>
  );
}
