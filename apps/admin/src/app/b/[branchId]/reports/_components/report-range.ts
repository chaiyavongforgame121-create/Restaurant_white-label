// One vocabulary for the Reports range, shared by the URL parser, the server page and the
// client picker — the same shape as parseCustomerSort/customerSortQuery in @favornoms/shared.
//
// Dates here are BRANCH-LOCAL calendar dates (YYYY-MM-DD) and `to` is INCLUSIVE. The six
// report RPCs take (p_from date, p_to date) and resolve branches.timezone themselves, so
// nothing on this side ever does UTC offset arithmetic — which is what kept the old
// `?days=N` window drifting for any merchant whose host clock was not their own.

export const REPORT_PRESETS = ['day', 'week', 'month', 'custom'] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export interface ReportRange {
  preset: ReportPreset;
  /** Branch-local calendar date, inclusive. */
  from: string;
  /** Branch-local calendar date, inclusive. */
  to: string;
}

/** The branch's calendar date for an instant, e.g. '2026-09-08'. */
export function localDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Step whole days from a YYYY-MM-DD. Anchored at noon UTC so a daylight-saving shift
 * cannot push the result across a boundary — the same idiom the dashboard trend uses.
 */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Inclusive span in days, so 'day' is 1 and 'week' is 7. */
export function rangeDays(range: ReportRange): number {
  const from = Date.parse(`${range.from}T12:00:00Z`);
  const to = Date.parse(`${range.to}T12:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 1;
  return Math.round((to - from) / 86_400_000) + 1;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** How many days back each preset reaches, counting today as day one. */
const PRESET_SPAN: Record<Exclude<ReportPreset, 'custom'>, number> = {
  day: 1,
  week: 7,
  month: 30,
};

/**
 * Tolerant read of raw search params: a hand-edited, stale or truncated URL degrades to
 * the default week instead of throwing at a merchant mid-service.
 */
export function parseReportRange(
  input: { range?: string; from?: string; to?: string; days?: string },
  timezone: string,
  now: Date = new Date(),
): ReportRange {
  const today = localDay(now, timezone);

  // Back-compat with the old ?days=7|30|90 pills, which are still live in bookmarks and
  // in the e2e route sweep. An exact preset span keeps its pill selected; anything else
  // becomes an explicit custom range so the picker shows the window it really loaded.
  if (!input.range && input.days) {
    const n = Math.max(1, Math.min(366, Number(input.days) || 7));
    const from = addDays(today, -(n - 1));
    const preset =
      n === PRESET_SPAN.day ? 'day' : n === PRESET_SPAN.week ? 'week' : n === PRESET_SPAN.month ? 'month' : 'custom';
    return { preset, from, to: today };
  }

  const preset = (REPORT_PRESETS as readonly string[]).includes(input.range ?? '')
    ? (input.range as ReportPreset)
    : 'week';

  if (preset === 'custom') {
    if (ISO_DAY.test(input.from ?? '') && ISO_DAY.test(input.to ?? '')) {
      const from = input.from as string;
      const to = input.to as string;
      // Swapped, not rejected: someone who picks the end date first should still get a
      // report rather than an empty screen that looks like a data problem.
      return from <= to ? { preset, from, to } : { preset, from: to, to: from };
    }
    return { preset: 'week', from: addDays(today, -(PRESET_SPAN.week - 1)), to: today };
  }

  return { preset, from: addDays(today, -(PRESET_SPAN[preset] - 1)), to: today };
}

/** Query string for a range. Custom carries its dates; a preset stays a bare word. */
export function reportRangeQuery(range: ReportRange): string {
  const sp = new URLSearchParams();
  sp.set('range', range.preset);
  if (range.preset === 'custom') {
    sp.set('from', range.from);
    sp.set('to', range.to);
  }
  return `?${sp.toString()}`;
}

export function reportRangeLabel(range: ReportRange): string {
  if (range.preset === 'day') return 'Today';
  if (range.preset === 'week') return 'Last 7 days';
  if (range.preset === 'month') return 'Last 30 days';
  return range.from === range.to ? range.from : `${range.from} to ${range.to}`;
}

export const REPORT_PRESET_LABELS: ReadonlyArray<{ value: ReportPreset; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'custom', label: 'Custom' },
];

/** The range a preset pill selects, given the branch's today. */
export function presetRange(preset: ReportPreset, today: string, current: ReportRange): ReportRange {
  if (preset === 'custom') return { preset, from: current.from, to: current.to };
  return { preset, from: addDays(today, -(PRESET_SPAN[preset] - 1)), to: today };
}
