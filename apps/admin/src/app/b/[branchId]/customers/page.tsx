import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  getBranchCustomerDetail,
  getLoyaltyProgram,
  listBranchCustomers,
  type BranchCustomerDetail,
} from '@favornoms/database/queries';
import { formatPhone,
  customerSortQuery,
  DEFAULT_CUSTOMER_SORT,
  DEFAULT_UI_LOCALE,
  defaultDirFor,
  formatCurrency,
  intlLocaleFor,
  isUiLocale,
  parseCustomerSort,
  type CustomerSort,
  type CustomerSortKey,
} from '@favornoms/shared';
import { Badge, Card, EmptyState, cn } from '@favornoms/ui';
import { AlertTriangle, ChevronDown, ChevronUp, Search, UserRound } from 'lucide-react';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { CustomerDrawer } from './_components/customer-drawer';
import { CustomerSortControls } from './_components/customer-sort-controls';
import { CustomersPager } from './_components/customers-pager';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ sort?: string; dir?: string; page?: string; q?: string; customer?: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The list URL for a state, with the drawer param added only when one customer is open. */
function listHref(
  basePath: string,
  state: CustomerSort & { page?: number; q?: string },
  customerId?: string,
): string {
  const qs = customerSortQuery(state);
  if (!customerId) return `${basePath}${qs}`;
  return `${basePath}${qs ? `${qs}&` : '?'}customer=${encodeURIComponent(customerId)}`;
}

export default async function CustomersPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const raw = await searchParams;
  const { sort, dir, page, q } = parseCustomerSort(raw);
  const openId = raw.customer && UUID_RE.test(raw.customer) ? raw.customer : null;
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

  const [list, program, detail] = await Promise.all([
    listBranchCustomers(supabase, branchId, { sort, dir, page, q }),
    // The branch's own tier names, so the badge here matches the one the diner sees.
    getLoyaltyProgram(supabase, branchId),
    openId ? getBranchCustomerDetail(supabase, branchId, openId) : Promise.resolve(null),
  ]);
  const { customers, total, pageSize, error } = list;
  // The raw database text is for the logs; the merchant gets a translated explanation.
  if (error) console.error('listBranchCustomers failed', error);
  if (detail?.error) console.error('getBranchCustomerDetail failed', detail.error);
  const tierLabels: Record<string, string> = Object.fromEntries(
    (program?.tiers ?? []).map((tier) => [tier.key, tier.label]),
  );
  const tierName = (key: string) => tierLabels[key] ?? key.replace(/^./, (c) => c.toUpperCase());

  const basePath = `/b/${branchId}/customers`;
  const state: CustomerSort = { sort, dir };
  const listState = { sort, dir, page, q };
  const closeHref = listHref(basePath, listState);
  const drawerState:
    | { kind: 'ok'; customer: BranchCustomerDetail }
    | { kind: 'notFound' }
    | { kind: 'error' }
    | null = !detail
    ? null
    : detail.error
      ? { kind: 'error' }
      : detail.customer
        ? { kind: 'ok', customer: detail.customer }
        : { kind: 'notFound' };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">
          {q ? t('summaryFiltered', { count: total, query: q }) : t('summary', { count: total })}
        </p>
      </header>

      <div className="mb-4 flex flex-col gap-3 px-2 lg:flex-row lg:items-center lg:justify-between lg:px-0">
        {/* A plain GET form: searching is just another URL, works before hydration, and a
            search result can be linked. Sorting is carried along; paging restarts. */}
        <form method="get" action={basePath} role="search" className="flex w-full max-w-md items-center gap-2">
          {sort !== DEFAULT_CUSTOMER_SORT || dir !== defaultDirFor(sort) ? (
            <>
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="dir" value={dir} />
            </>
          ) : null}
          <label className="relative flex-1">
            <span className="sr-only">{t('search.label')}</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ''}
              maxLength={80}
              placeholder={t('search.placeholder')}
              className="focus-ring h-10 w-full rounded-full border border-border bg-card pl-9 pr-3 text-sm"
            />
          </label>
          <button
            type="submit"
            className="focus-ring inline-flex h-10 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground"
          >
            {t('search.submit')}
          </button>
          {q ? (
            <Link
              href={listHref(basePath, { sort, dir })}
              className="focus-ring text-sm font-semibold text-primary hover:underline"
            >
              {t('search.clear')}
            </Link>
          ) : null}
        </form>
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
      ) : total === 0 && q ? (
        <EmptyState
          icon={<Search className="h-7 w-7" />}
          title={t('emptySearch.title')}
          description={t('emptySearch.description', { query: q })}
          action={
            <Link
              href={listHref(basePath, { sort, dir })}
              className="focus-ring text-sm font-semibold text-primary hover:underline"
            >
              {t('emptySearch.action')}
            </Link>
          }
        />
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
              href={listHref(basePath, { sort, dir, q })}
              className="focus-ring text-sm font-semibold text-primary hover:underline"
            >
              {t('emptyPage.action')}
            </Link>
          }
        />
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <SortHeader label={t('columns.name')} column="name" state={state} q={q} basePath={basePath} />
                  <th scope="col" className="px-5 py-3">{t('columns.phone')}</th>
                  {/* Deliberately not a SortHeader: every sort key is a real customers
                      column, which is what lets the database page the list. Address is
                      assembled from two other tables, so sorting on it would either be a
                      lie about the whole branch or force the paging into JavaScript. */}
                  <th scope="col" className="px-5 py-3">{t('columns.address')}</th>
                  <th scope="col" className="px-5 py-3 text-right">{t('columns.points')}</th>
                  <SortHeader label={t('columns.orders')} column="orders" state={state} q={q} basePath={basePath} align="right" />
                  <SortHeader label={t('columns.spent')} column="spent" state={state} q={q} basePath={basePath} align="right" />
                  <SortHeader label={t('columns.lastSeen')} column="last_seen" state={state} q={q} basePath={basePath} />
                  <SortHeader label={t('columns.joined')} column="joined" state={state} q={q} basePath={basePath} />
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} className="border-t border-border/40 hover:bg-muted/30">
                    <td className="px-5 py-3">
                      <div className="max-w-[16rem]">
                        <Link
                          href={listHref(basePath, listState, c.id)}
                          scroll={false}
                          className="focus-ring block truncate font-medium hover:text-primary hover:underline"
                          title={c.name ?? undefined}
                        >
                          {c.name ?? <span className="text-muted-foreground">{t('unnamed')}</span>}
                        </Link>
                        {c.name_source === 'order' ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {t('nameFromOrder')}
                          </span>
                        ) : c.email && c.name_source === 'profile' ? (
                          <span className="block truncate text-xs text-muted-foreground" title={c.email}>
                            {c.email}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {c.phone ? (
                        <>
                          <span className="whitespace-nowrap">{formatPhone(c.phone)}</span>
                          {c.phone_from_order ? (
                            <span className="block text-xs text-muted-foreground">{t('phoneFromOrder')}</span>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {c.address ? (
                        // The cap lives on this div, not the cell: an auto-layout table
                        // ignores max-width on a <td> and would simply grow the column
                        // until a pin-drop or a five-line Thai address pushed the spend
                        // columns off the screen. The full text stays in the tooltip.
                        <div className="max-w-[20rem]">
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
                    <td className="px-5 py-3 text-right">
                      {c.points_balance != null ? (
                        <div className="flex flex-col items-end gap-1">
                          <span className="tabular-nums">
                            {t('points', { points: c.points_balance })}
                          </span>
                          {c.tier ? <Badge variant="neutral">{tierName(c.tier)}</Badge> : null}
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
          <p className="mt-2 px-2 text-xs text-muted-foreground lg:px-0">{t('legend')}</p>
        </>
      )}

      <CustomersPager
        basePath={basePath}
        sort={state}
        q={q}
        page={page}
        pageSize={pageSize}
        total={total}
      />

      {drawerState ? (
        <CustomerDrawer
          state={drawerState}
          closeHref={closeHref}
          tierLabels={tierLabels}
          branchId={branchId}
          canAdjustPoints={can('loyalty.manage')}
        />
      ) : null}
    </div>
  );
}

/**
 * A column heading that is also its own sort link: clicking the active column flips
 * direction, clicking any other starts it in that column's natural direction. The
 * caret is the only marker of which column the list is actually ordered by, so
 * `aria-sort` carries the same fact for a screen reader. A search is kept; the page is not.
 */
function SortHeader({
  label,
  column,
  state,
  q,
  basePath,
  align = 'left',
}: {
  label: string;
  column: CustomerSortKey;
  state: CustomerSort;
  q?: string;
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
        href={`${basePath}${customerSortQuery({ sort: column, dir: nextDir, q })}`}
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
