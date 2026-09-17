import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { listBranchCustomers } from '@favornoms/database/queries';
import { formatPhone,
  customerSortQuery,
  DEFAULT_UI_LOCALE,
  defaultDirFor,
  formatCurrency,
  intlLocaleFor,
  isUiLocale,
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

export default async function CustomersPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { sort, dir, page } = parseCustomerSort(await searchParams);
  const [t, locale] = await Promise.all([getTranslations('customers'), getLocale()]);
  const intlLocale = intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(intlLocale, { month: 'short', day: 'numeric', year: 'numeric' });

  // RLS already hides the rows from a cook or a server, but without this the page
  // answers them with "No customers yet", which reads as an empty branch rather
  // than as a door they may not open.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/customers`);
  if (!can('customers.view')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const { customers, total, pageSize, error } = await listBranchCustomers(supabase, branchId, {
    sort,
    dir,
    page,
  });
  // The raw database text is for the logs; the merchant gets a translated explanation.
  if (error) console.error('listBranchCustomers failed', error);

  const basePath = `/b/${branchId}/customers`;
  const state: CustomerSort = { sort, dir };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('summary', { count: total })}</p>
      </header>

      <div className="mb-4 px-2 lg:px-0">
        <CustomerSortControls sort={sort} dir={dir} />
      </div>

      {error ? (
        <Card className="mx-2 p-5 lg:mx-0">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-danger">
            <AlertTriangle className="h-5 w-5" /> {t('loadError.title')}
          </h2>
          <p className="mt-3 break-words rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
            {t('loadError.body')}
          </p>
        </Card>
      ) : total === 0 ? (
        <EmptyState
          icon={<UserRound className="h-7 w-7" />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : customers.length === 0 ? (
        <EmptyState
          icon={<UserRound className="h-7 w-7" />}
          title={t('emptyPage.title')}
          description={t('emptyPage.description', { total, page })}
          action={
            <Link
              href={`${basePath}${customerSortQuery(state)}`}
              className="focus-ring text-sm font-semibold text-primary hover:underline"
            >
              {t('emptyPage.action')}
            </Link>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <SortHeader label={t('columns.name')} column="name" state={state} basePath={basePath} />
                <th scope="col" className="px-5 py-3">{t('columns.phone')}</th>
                {/* Deliberately not a SortHeader: every sort key is a real customers
                    column, which is what lets the database page the list. Address is
                    assembled from two other tables, so sorting on it would either be a
                    lie about the whole branch or force the paging into JavaScript. */}
                <th scope="col" className="px-5 py-3">{t('columns.address')}</th>
                <SortHeader label={t('columns.orders')} column="orders" state={state} basePath={basePath} align="right" />
                <SortHeader label={t('columns.spent')} column="spent" state={state} basePath={basePath} align="right" />
                <SortHeader label={t('columns.lastSeen')} column="last_seen" state={state} basePath={basePath} />
                <SortHeader label={t('columns.joined')} column="joined" state={state} basePath={basePath} />
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
                            ? t('address.lastDelivered', { date: fmtDate(c.address_at) })
                            : t('address.saved')}
                          {c.saved_address_count > 1
                            ? ` · ${t('address.moreSaved', { count: c.saved_address_count - 1 })}`
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
                    {c.last_order_at ? fmtDate(c.last_order_at) : t('never')}
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
