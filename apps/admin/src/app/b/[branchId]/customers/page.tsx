import Link from 'next/link';
import { listBranchCustomers } from '@favornoms/database/queries';
import { formatPhone,
  customerSortQuery,
  defaultDirFor,
  formatCurrency,
  parseCustomerSort,
  type CustomerSort,
  type CustomerSortKey,
} from '@favornoms/shared';
import { Card, EmptyState, cn } from '@favornoms/ui';
import { AlertTriangle, ChevronDown, ChevronUp, UserRound } from 'lucide-react';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { CustomerSortControls } from './_components/customer-sort-controls';
import { CustomersPager } from './_components/customers-pager';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ sort?: string; dir?: string; page?: string }>;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default async function CustomersPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { sort, dir, page } = parseCustomerSort(await searchParams);

  // RLS already hides the rows from a cook or a server, but without this the page
  // answers them with "No customers yet", which reads as an empty branch rather
  // than as a door they may not open.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/customers`);
  if (!can('customers.view')) {
    return (
      <AccessDenied
        title="No customer access"
        reason={`Only owners, admins, managers and cashiers can see the customer list at ${branch.name}.`}
      />
    );
  }

  const { customers, total, pageSize, error } = await listBranchCustomers(supabase, branchId, {
    sort,
    dir,
    page,
  });

  const basePath = `/b/${branchId}/customers`;
  const state: CustomerSort = { sort, dir };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Customers</h1>
        <p className="mt-1 text-muted-foreground">
          {total} customer{total === 1 ? '' : 's'} at this branch
        </p>
      </header>

      <div className="mb-4 px-2 lg:px-0">
        <CustomerSortControls sort={sort} dir={dir} />
      </div>

      {error ? (
        <Card className="mx-2 p-5 lg:mx-0">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-danger">
            <AlertTriangle className="h-5 w-5" /> Customers could not be loaded
          </h2>
          <p className="mt-3 break-words rounded-xl bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
            {error}
          </p>
        </Card>
      ) : total === 0 ? (
        <EmptyState
          icon={<UserRound className="h-7 w-7" />}
          title="No customers yet"
          description="Once people order via the customer web app they'll appear here."
        />
      ) : customers.length === 0 ? (
        <EmptyState
          icon={<UserRound className="h-7 w-7" />}
          title="Nothing on this page"
          description={`This branch has ${total} customers, but none on page ${page}.`}
          action={
            <Link
              href={`${basePath}${customerSortQuery(state)}`}
              className="focus-ring text-sm font-semibold text-primary hover:underline"
            >
              Back to the first page
            </Link>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <SortHeader label="Name" column="name" state={state} basePath={basePath} />
                <th scope="col" className="px-5 py-3">Phone</th>
                {/* Deliberately not a SortHeader: every sort key is a real customers
                    column, which is what lets the database page the list. Address is
                    assembled from two other tables, so sorting on it would either be a
                    lie about the whole branch or force the paging into JavaScript. */}
                <th scope="col" className="px-5 py-3">Address</th>
                <SortHeader label="Orders" column="orders" state={state} basePath={basePath} align="right" />
                <SortHeader label="Lifetime spend" column="spent" state={state} basePath={basePath} align="right" />
                <SortHeader label="Last seen" column="last_seen" state={state} basePath={basePath} />
                <SortHeader label="Joined" column="joined" state={state} basePath={basePath} />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-t border-border/40 hover:bg-muted/30">
                  <td className="px-5 py-3 font-medium">{c.full_name ?? '—'}</td>
                  <td className="px-5 py-3">{c.phone ? formatPhone(c.phone) : '—'}</td>
                  <td className="px-5 py-3">
                    {c.address ? (
                      // The cap lives on this div, not the cell: an auto-layout table
                      // ignores max-width on a <td> and would simply grow the column
                      // until a pin-drop or a five-line Thai address pushed Lifetime
                      // spend off the screen. The full text stays in the tooltip.
                      <div className="max-w-[22rem]">
                        <span className="block truncate" title={c.address}>
                          {c.address}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.address_source === 'delivered' && c.address_at
                            ? `Last delivered ${fmtDate(c.address_at)}`
                            : 'Saved address'}
                          {c.saved_address_count > 1
                            ? ` · +${c.saved_address_count - 1} more saved`
                            : ''}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{c.total_orders}</td>
                  <td className="px-5 py-3 text-right font-semibold text-primary">
                    {formatCurrency(c.total_spent)}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {c.last_order_at ? fmtDate(c.last_order_at) : 'Never'}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{fmtDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}

      <CustomersPager
        basePath={basePath}
        sort={state}
        page={page}
        pageSize={pageSize}
        total={total}
      />
    </div>
  );
}

/**
 * A column heading that is also its own sort link: clicking the active column flips
 * direction, clicking any other starts it in that column's natural direction. The
 * caret is the only marker of which column the list is actually ordered by, so
 * `aria-sort` carries the same fact for a screen reader.
 */
function SortHeader({
  label,
  column,
  state,
  basePath,
  align = 'left',
}: {
  label: string;
  column: CustomerSortKey;
  state: CustomerSort;
  basePath: string;
  align?: 'left' | 'right';
}) {
  const active = state.sort === column;
  const ascending = state.dir === 'asc';
  const nextDir = active ? (ascending ? 'desc' : 'asc') : defaultDirFor(column);

  return (
    <th
      scope="col"
      className={cn('px-5 py-3', align === 'right' && 'text-right')}
      aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}
    >
      <Link
        href={`${basePath}${customerSortQuery({ sort: column, dir: nextDir })}`}
        className={cn(
          'focus-ring inline-flex items-center gap-1 hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {label}
        {active &&
          (ascending ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </Link>
    </th>
  );
}
