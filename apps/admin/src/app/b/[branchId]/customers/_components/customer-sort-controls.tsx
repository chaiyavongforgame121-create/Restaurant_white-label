'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import { Segmented } from '@favornoms/ui';
import {
  CUSTOMER_SORT_OPTIONS,
  customerSortQuery,
  defaultDirFor,
  type CustomerSortKey,
  type SortDir,
} from '@favornoms/shared';

interface Props {
  sort: CustomerSortKey;
  dir: SortDir;
}

/**
 * Sort key and direction, kept in the URL with the same replace-not-push move as
 * orders/_components/order-filters.tsx, so a reload, the back button and a link
 * pasted to a colleague all show the same list.
 *
 * Picking a new key restarts it in that key's natural direction — a merchant
 * switching to "Name" wants A→Z, not Z→A inherited from a spend sort — and drops
 * `page`, because page 4 of the old order means nothing in the new one.
 */
export function CustomerSortControls({ sort, dir }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const push = (next: { sort?: CustomerSortKey; dir?: SortDir }) => {
    const nextSort = next.sort ?? sort;
    const nextDir =
      next.dir ?? (next.sort && next.sort !== sort ? defaultDirFor(next.sort) : dir);
    // Own the three params this control manages; leave anything else in the URL alone.
    const sp = new URLSearchParams(params);
    for (const key of ['sort', 'dir', 'page']) sp.delete(key);
    new URLSearchParams(customerSortQuery({ sort: nextSort, dir: nextDir })).forEach((v, k) =>
      sp.set(k, v),
    );
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const ascending = dir === 'asc';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-muted-foreground">Sort by</span>
      <div className="max-w-full overflow-x-auto">
        <Segmented<CustomerSortKey>
          value={sort}
          onChange={(next) => push({ sort: next })}
          options={CUSTOMER_SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
      <button
        type="button"
        onClick={() => push({ dir: ascending ? 'desc' : 'asc' })}
        aria-pressed={ascending}
        aria-label={
          ascending
            ? 'Sorted ascending; switch to descending'
            : 'Sorted descending; switch to ascending'
        }
        className="focus-ring inline-flex min-h-touch items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-muted"
      >
        {ascending ? (
          <ArrowUpNarrowWide className="h-4 w-4" />
        ) : (
          <ArrowDownWideNarrow className="h-4 w-4" />
        )}
        {ascending ? 'Ascending' : 'Descending'}
      </button>
    </div>
  );
}
