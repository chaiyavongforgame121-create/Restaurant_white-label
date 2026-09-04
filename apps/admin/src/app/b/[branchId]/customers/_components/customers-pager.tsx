import Link from 'next/link';
import { customerSortQuery, type CustomerSort } from '@favornoms/shared';

interface Props {
  basePath: string;
  sort: CustomerSort;
  page: number;
  pageSize: number;
  total: number;
}

const PILL =
  'focus-ring rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold';

/**
 * Plain links rather than a client component: the page is already a server render
 * per sort state, so paging is just another URL and needs no JavaScript to work.
 */
export function CustomersPager({ basePath, sort, page, pageSize, total }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const href = (target: number) => `${basePath}${customerSortQuery({ ...sort, page: target })}`;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <nav
      aria-label="Customer pages"
      className="mt-4 flex flex-wrap items-center justify-between gap-2 px-2 text-sm text-muted-foreground lg:px-0"
    >
      <span className="tabular-nums">
        Showing {first}–{last} of {total}
      </span>
      <span className="inline-flex items-center gap-2">
        {page <= 1 ? (
          <span className={`${PILL} opacity-40`}>Previous</span>
        ) : (
          <Link href={href(page - 1)} className={`${PILL} hover:bg-muted`}>
            Previous
          </Link>
        )}
        <span className="px-1 tabular-nums">
          Page {page} of {pages}
        </span>
        {page >= pages ? (
          <span className={`${PILL} opacity-40`}>Next</span>
        ) : (
          <Link href={href(page + 1)} className={`${PILL} hover:bg-muted`}>
            Next
          </Link>
        )}
      </span>
    </nav>
  );
}
