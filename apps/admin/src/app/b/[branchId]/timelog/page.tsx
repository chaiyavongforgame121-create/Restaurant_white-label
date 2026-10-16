import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { branchDayKey } from '@favornoms/database/queries';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale, isValidTimeZone } from '@favornoms/shared';
import { Badge, Card, EmptyState, cn } from '@favornoms/ui';
import { AlertTriangle, Clock } from 'lucide-react';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import {
  MAX_RANGE_DAYS,
  MAX_SHIFTS,
  SHIFT_SELECT,
  STAFF_ROSTER_SELECT,
  TIMELOG_PRESETS,
  filterableMembers,
  groupShiftsByDay,
  isLongOpenShift,
  parseStaffFilter,
  parseTimelogRange,
  presetQuery,
  rangeBoundsUtc,
  shiftDurationMs,
  splitDuration,
  staffName,
  totalsByPerson,
  type RosterMember,
  type ShiftRow,
} from './_components/timelog-model';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string; staff?: string }>;
}

/** Roles with a label under staff.roleNames; anything else is shown as stored. */
const KNOWN_ROLES = new Set(['owner', 'admin', 'manager', 'cashier', 'server', 'kitchen', 'driver', 'staff']);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('timelog');
  return { title: t('metaTitle') };
}

/**
 * Staff time log: who clocked in and out at this branch, for how long, day by day.
 *
 * staff.timelog (owner, admin, manager) had been seeded, and staff_shifts RLS already let its
 * holders read every shift of the branch, but no screen showed them: the counter's Clock in/out
 * button wrote shifts nobody could see. Read-only; shifts are opened and closed by clock_in and
 * clock_out on the till.
 */
export default async function TimelogPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const sp = await searchParams;
  const basePath = `/b/${branchId}/timelog`;

  const { supabase, branch, can, user } = await getBranchAccess(branchId, basePath);
  const t = await getTranslations('timelog');
  if (!can('staff.timelog')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const [tStaff, locale, { data: detail }] = await Promise.all([
    getTranslations('staff'),
    getLocale(),
    supabase.from('branches').select('timezone').eq('id', branchId).maybeSingle(),
  ]);
  const intlLocale = intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);
  // The branch's own clock: a shift belongs to the merchant's day, not the server's.
  const timezone = isValidTimeZone(detail?.timezone) ? (detail?.timezone as string) : 'America/New_York';

  const nowMs = Date.now();
  const today = branchDayKey(new Date(nowMs), timezone);
  const range = parseTimelogRange(sp, today);
  const staffFilter = parseStaffFilter(sp.staff);
  const { startIso, endIso } = rangeBoundsUtc(range, timezone);

  let shiftsQuery = supabase
    .from('staff_shifts')
    .select(SHIFT_SELECT)
    .eq('branch_id', branchId)
    .gte('clocked_in_at', startIso)
    .lt('clocked_in_at', endIso)
    .order('clocked_in_at', { ascending: false })
    .limit(MAX_SHIFTS + 1);
  // Who is clocked in right now, whenever they started: a shift opened days ago and never closed
  // is exactly what a manager needs to see, and it is outside most ranges.
  let openQuery = supabase
    .from('staff_shifts')
    .select(SHIFT_SELECT)
    .eq('branch_id', branchId)
    .is('clocked_out_at', null)
    .order('clocked_in_at', { ascending: true })
    .limit(50);
  if (staffFilter) {
    shiftsQuery = shiftsQuery.eq('staff_member_id', staffFilter);
    openQuery = openQuery.eq('staff_member_id', staffFilter);
  }

  const [shiftsRes, openRes, rosterRes] = await Promise.all([
    shiftsQuery,
    openQuery,
    supabase
      .from('staff_members')
      .select(STAFF_ROSTER_SELECT)
      .eq('restaurant_id', branch.restaurant_id),
  ]);
  if (shiftsRes.error) console.error('timelog: shifts read failed', shiftsRes.error.message);
  if (openRes.error) console.error('timelog: open shifts read failed', openRes.error.message);
  if (rosterRes.error) console.error('timelog: roster read failed', rosterRes.error.message);

  const fetched = (shiftsRes.data ?? []) as ShiftRow[];
  const truncated = fetched.length > MAX_SHIFTS;
  const shifts = truncated ? fetched.slice(0, MAX_SHIFTS) : fetched;
  const openShifts = (openRes.data ?? []) as ShiftRow[];
  const roster = (rosterRes.data ?? []) as RosterMember[];
  const byId = new Map(roster.map((m) => [m.id, m]));

  const days = groupShiftsByDay(shifts, timezone, nowMs);
  const people = totalsByPerson(shifts, nowMs);
  const totalMs = people.reduce((sum, p) => sum + p.totalMs, 0);
  const options = filterableMembers(roster, branchId, [...shifts, ...openShifts].map((s) => s.staff_member_id));

  const nameOf = (id: string) => staffName(byId.get(id), user) ?? tStaff('unnamed');
  const roleOf = (id: string) => {
    const role = byId.get(id)?.role;
    if (!role) return null;
    return KNOWN_ROLES.has(role) ? tStaff(`roleNames.${role}`) : role;
  };
  const duration = (ms: number) => t('duration', splitDuration(ms));
  const timeFmt = new Intl.DateTimeFormat(intlLocale, { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  const time = (iso: string) => timeFmt.format(new Date(iso));
  // Calendar days are formatted at noon UTC so no offset can move them to the next or previous date.
  const dayLong = (day: string) =>
    new Intl.DateTimeFormat(intlLocale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${day}T12:00:00Z`));
  const dayShort = (day: string) =>
    new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

  const sortedOptions = [...options].sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)));
  const pill = (active: boolean) =>
    cn(
      'focus-ring rounded-full px-4 py-1.5 text-xs font-semibold transition-colors',
      active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted',
    );
  const field = 'focus-ring h-10 rounded-full border border-border bg-card px-3 text-sm';

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subtitle', { branch: branch.name, timezone })}</p>
      </header>

      <div className="mb-6 flex flex-col gap-3 px-2 lg:px-0">
        <nav aria-label={t('filters.presets')} className="inline-flex w-fit flex-wrap rounded-full border border-border bg-card p-1">
          {TIMELOG_PRESETS.map((p) => (
            <Link
              key={p}
              href={`${basePath}${presetQuery(p, staffFilter)}`}
              aria-current={range.preset === p ? 'page' : undefined}
              className={pill(range.preset === p)}
            >
              {t(`filters.preset.${p}`)}
            </Link>
          ))}
        </nav>
        {/* A plain GET form: a range is just a URL, works before hydration, and can be shared. */}
        <form method="get" action={basePath} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {t('filters.from')}
            <input type="date" name="from" defaultValue={range.from} max={today} required className={cn(field, 'tabular-nums text-foreground')} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {t('filters.to')}
            <input type="date" name="to" defaultValue={range.to} max={today} required className={cn(field, 'tabular-nums text-foreground')} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground">
            {t('filters.staff')}
            <select name="staff" defaultValue={staffFilter ?? ''} className={cn(field, 'max-w-[16rem] text-foreground')}>
              <option value="">{t('filters.everyone')}</option>
              {sortedOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {nameOf(m.id)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="focus-ring inline-flex h-10 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground"
          >
            {t('filters.apply')}
          </button>
        </form>
        {range.clamped && <p className="text-xs text-muted-foreground">{t('filters.clamped', { days: MAX_RANGE_DAYS })}</p>}
      </div>

      {shiftsRes.error ? (
        <Card className="mx-2 p-5 lg:mx-0">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-danger">
            <AlertTriangle className="h-5 w-5" /> {t('loadError.title')}
          </h2>
          <p className="mt-3 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">{t('loadError.body')}</p>
        </Card>
      ) : (
        <div className="space-y-6">
          <section aria-label={t('summary.label')} className="grid grid-cols-1 gap-3 px-2 sm:grid-cols-3 lg:px-0">
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('summary.hours')}</p>
              <p className="mt-1 font-display text-2xl font-bold tabular-nums">{duration(totalMs)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('summary.shifts')}</p>
              <p className="mt-1 font-display text-2xl font-bold tabular-nums">{shifts.length}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('summary.people')}</p>
              <p className="mt-1 font-display text-2xl font-bold tabular-nums">{people.length}</p>
            </Card>
          </section>

          {truncated && (
            <p className="mx-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning lg:mx-0">
              {t('truncated', { count: MAX_SHIFTS })}
            </p>
          )}

          {openShifts.length > 0 && (
            <Card className="mx-2 p-5 lg:mx-0">
              <h2 className="font-display text-lg font-semibold">{t('onShift.title')}</h2>
              <ul className="mt-3 divide-y divide-border/40">
                {openShifts.map((s) => {
                  const startDay = branchDayKey(new Date(s.clocked_in_at), timezone);
                  return (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium" title={nameOf(s.staff_member_id)}>{nameOf(s.staff_member_id)}</p>
                        <p className="text-xs text-muted-foreground">
                          {startDay === today
                            ? t('onShift.since', { time: time(s.clocked_in_at) })
                            : t('onShift.sinceDay', { day: dayShort(startDay), time: time(s.clocked_in_at) })}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {isLongOpenShift(s, nowMs) && (
                          <Badge variant="warning">{t('onShift.long', { hours: Math.floor(shiftDurationMs(s, nowMs) / 3600_000) })}</Badge>
                        )}
                        <span className="font-semibold tabular-nums">{duration(shiftDurationMs(s, nowMs))}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {days.length === 0 ? (
            <EmptyState
              icon={<Clock className="h-7 w-7" />}
              title={t('empty.title')}
              description={t('empty.description')}
            />
          ) : (
            <>
              {days.map((d) => (
                <Card key={d.day} className="mx-2 overflow-hidden lg:mx-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/40 px-5 py-3">
                    <h2 className="font-display text-base font-semibold">{dayLong(d.day)}</h2>
                    <p className="text-sm text-muted-foreground">
                      {t('dayTotal', { count: d.shifts.length, duration: duration(d.totalMs) })}
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th scope="col" className="px-5 py-2.5">{t('columns.person')}</th>
                          <th scope="col" className="px-5 py-2.5">{t('columns.clockIn')}</th>
                          <th scope="col" className="px-5 py-2.5">{t('columns.clockOut')}</th>
                          <th scope="col" className="px-5 py-2.5 text-right">{t('columns.duration')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.shifts.map((s) => {
                          const role = roleOf(s.staff_member_id);
                          return (
                            <tr key={s.id} className="border-t border-border/40 align-top">
                              <td className="px-5 py-2.5">
                                <div className="max-w-[18rem]">
                                  <span className="block truncate font-medium" title={nameOf(s.staff_member_id)}>
                                    {nameOf(s.staff_member_id)}
                                  </span>
                                  {role && <span className="block text-xs text-muted-foreground">{role}</span>}
                                  {s.notes && (
                                    <span className="block truncate text-xs italic text-muted-foreground" title={s.notes}>
                                      {t('note', { note: s.notes })}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-5 py-2.5 tabular-nums">{time(s.clocked_in_at)}</td>
                              <td className="whitespace-nowrap px-5 py-2.5 tabular-nums">
                                {s.open ? (
                                  <Badge variant="success">{t('stillOn')}</Badge>
                                ) : s.outDay && s.outDay !== d.day ? (
                                  t('outOnDay', { time: time(s.clocked_out_at as string), day: dayShort(s.outDay) })
                                ) : (
                                  time(s.clocked_out_at as string)
                                )}
                              </td>
                              <td className="whitespace-nowrap px-5 py-2.5 text-right font-semibold tabular-nums">
                                {duration(s.durationMs)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}

              <Card className="mx-2 overflow-hidden lg:mx-0">
                <h2 className="border-b border-border/40 px-5 py-3 font-display text-base font-semibold">{t('people.title')}</h2>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-5 py-2.5">{t('columns.person')}</th>
                        <th scope="col" className="px-5 py-2.5 text-right">{t('people.shifts')}</th>
                        <th scope="col" className="px-5 py-2.5 text-right">{t('people.hours')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((p) => {
                        const role = roleOf(p.staffMemberId);
                        return (
                          <tr key={p.staffMemberId} className="border-t border-border/40">
                            <td className="px-5 py-2.5">
                              <div className="max-w-[18rem]">
                                <span className="block truncate font-medium" title={nameOf(p.staffMemberId)}>
                                  {nameOf(p.staffMemberId)}
                                </span>
                                {role && <span className="block text-xs text-muted-foreground">{role}</span>}
                              </div>
                            </td>
                            <td className="px-5 py-2.5 text-right tabular-nums">{p.shifts}</td>
                            <td className="whitespace-nowrap px-5 py-2.5 text-right font-semibold tabular-nums">{duration(p.totalMs)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
