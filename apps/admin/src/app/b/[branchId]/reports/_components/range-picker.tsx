'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  REPORT_PRESETS,
  presetRange,
  reportRangeQuery,
  type ReportPreset,
  type ReportRange,
} from './report-range';

/**
 * Day / Week / Month / Custom, written straight to the URL so a range survives a refresh
 * and can be shared. Deliberately not <Segmented> from @favornoms/ui: that component
 * animates a shared `layoutId`, so a second one anywhere on the page would slide into it.
 *
 * `today` is the branch's calendar date, computed on the server. Deriving it here would
 * make the rendered `max` depend on the reader's clock and mismatch on hydration.
 */
export function RangePicker({ range, today }: { range: ReportRange; today: string }) {
  const t = useTranslations('reports.range');
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = React.useState({ from: range.from, to: range.to });

  React.useEffect(() => {
    setDraft({ from: range.from, to: range.to });
  }, [range.from, range.to]);

  const go = (next: ReportRange) => router.replace(`${pathname}${reportRangeQuery(next)}`);

  const choose = (preset: ReportPreset) => {
    const next = presetRange(preset, today, range);
    // Custom re-uses whatever window is on screen, so the first click never blanks the
    // report — it just reveals the two dates that produced it.
    go(next);
  };

  const commit = (from: string, to: string) => {
    setDraft({ from, to });
    if (!from || !to) return;
    go({ preset: 'custom', from, to });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-full border border-border bg-card p-1">
        {REPORT_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => choose(p)}
            aria-pressed={range.preset === p}
            className={`focus-ring rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              range.preset === p
                ? 'bg-primary text-primary-foreground'
                : 'text-foreground hover:bg-muted'
            }`}
          >
            {t(`preset.${p}`)}
          </button>
        ))}
      </div>

      {range.preset === 'custom' ? (
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
          <label className="sr-only" htmlFor="report-from">
            {t('fromDate')}
          </label>
          <input
            id="report-from"
            type="date"
            value={draft.from}
            max={today}
            onChange={(e) => commit(e.target.value, draft.to)}
            className="focus-ring rounded-lg bg-transparent px-1 py-0.5 text-xs tabular-nums"
          />
          <span className="text-xs text-muted-foreground">{t('between')}</span>
          <label className="sr-only" htmlFor="report-to">
            {t('toDate')}
          </label>
          <input
            id="report-to"
            type="date"
            value={draft.to}
            max={today}
            onChange={(e) => commit(draft.from, e.target.value)}
            className="focus-ring rounded-lg bg-transparent px-1 py-0.5 text-xs tabular-nums"
          />
        </div>
      ) : null}
    </div>
  );
}
