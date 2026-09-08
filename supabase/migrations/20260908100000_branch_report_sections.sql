-- Reports could answer exactly one question: "how much did we take in the last N days?"
--
-- get_branch_reports(p_branch_id, p_days) is a rolling `now() - N days` window with three
-- fixed pills (7/30/90), so nothing in the app could express "yesterday", "this month" or
-- "1–15 August". Everything else the merchant asked for — discounts, refunds, net sales,
-- cancel rate, combos, promotions, delivery timings, loyalty, and payments split by method
-- — is recorded somewhere already but was never read by any report. Three RPCs written for
-- this (get_sales_tax_report, get_cohort_retention, get_top_customers_ltv) are called from
-- nowhere and are wrong where they are called-able: get_sales_tax_report filters on
-- 'delivered', which is not a label of order_status, so it raises 22P02 for every caller;
-- get_cohort_retention takes min(created_at) INSIDE the window, so a five-year regular who
-- ordered this week is classified as brand new; get_top_customers_ltv reads lifetime
-- customers.total_spent and ignores the range entirely. They are superseded here and left
-- in place — dropping them would churn the generated types for no gain.
--
-- Four rules the money math in these functions depends on, all verified against live data:
--
--  1. REFUNDS LIVE IN audit_logs, NOT payments. refund_order() sets orders.status only when
--     the refund is for the full total, appends to orders.status_history, and inserts
--     audit_logs(action='refund'). It writes nothing to payments, so payments.status is
--     never 'refunded' or 'voided' on this project. Reading refunds off payments.status
--     would report 0.00 for ever. Section 6 returns refunded_on_payments alongside the real
--     figure so the gap is visible on screen instead of silently reading as "no refunds".
--
--  2. A REFUNDED ORDER STAYS IN GROSS. get_branch_reports excludes both 'cancelled' and
--     'refunded' from its base set. Doing that here and also subtracting the audit refund
--     would net the same sale twice; and a PARTIAL refund leaves orders.status untouched,
--     so it would be invisible either way. The money CTEs therefore filter on
--     status <> 'cancelled' only, and subtract the refund exactly once as its own line.
--
--  3. CANCELLED ORDERS COUNT IN "ORDERS" AND NOWHERE ELSE. Excluding them from the base set
--     is what makes today's "Completed" tile read 53% (26/49) where the honest completion
--     rate against all 65 orders is 40%. Section 2 counts every order and reports the
--     cancel rate; every revenue figure in it still filters cancelled out.
--
--  4. PENDING CARD PAYMENTS ARE EXPECTED, NOT FAILURES. 20260904160000_record_counter_payment
--     deliberately left card rows at 'pending' because no Stripe key is configured. Section 6
--     keeps 'pending' as its own column and surfaces unsettled_on_completed_orders as the
--     actionable number, rather than rolling it into anything that reads like lost money.
--
-- Authorisation moves too. get_branch_reports gates on private.user_branch_ids() — "are you
-- staff here" — so a cook or cashier with the URL can execute it, even though the sidebar
-- has always hidden Reports from them. All six of these gate on 'reports.view', the
-- capability the matrix actually maps to owner/admin/manager, plus platform admins.
--
-- p_from/p_to are BRANCH-LOCAL calendar dates and p_to is INCLUSIVE. Each function resolves
-- branches.timezone itself and converts to a half-open UTC window, so no client ever does
-- offset arithmetic and two clients can never disagree about where a day starts.

-- Sections 2 and 6 deliberately have no status predicate (a cancel rate needs the cancelled
-- rows; a payment grid needs every payment), and the only composite that exists is
-- (branch_id, status, created_at desc), whose leading status column cannot serve them.
create index if not exists orders_branch_created_idx
  on public.orders (branch_id, created_at desc);


-- 1. SALES & REVENUE --------------------------------------------------------
create or replace function public.get_branch_sales_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_tz     text;
  v_rest   uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not (private.user_is_platform_admin()
          or private.staff_has_capability(p_branch_id, 'reports.view')) then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC'), b.restaurant_id
    into v_tz, v_rest
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  -- Half-open in UTC, inclusive of the caller's last local day.
  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with sold as (
    -- Refunded orders STAY here; see rule 2 in the header.
    select o.id, o.subtotal, o.discount_amount, o.promo_discount, o.tax_amount,
           o.delivery_fee, o.service_fee, o.tip_amount, o.total, o.status,
           (o.created_at at time zone v_tz)::date as local_date
      from public.orders o
     where o.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
       and o.status <> 'cancelled'
  ),
  refunds as (
    -- Bucketed by the date the refund was issued: the order it reverses may predate
    -- the window, and the merchant is reconciling the day the money went back out.
    select (a.created_at at time zone v_tz)::date as local_date,
           coalesce(nullif(a.metadata->>'amount', '')::numeric, 0) as amount
      from public.audit_logs a
     where a.branch_id = p_branch_id
       and a.action = 'refund' and a.entity_type = 'order'
       and a.created_at >= v_from and a.created_at < v_to
  ),
  daily as (
    select d.local_date as day,
           count(*) as orders,
           round(coalesce(sum(d.subtotal), 0), 2)        as gross_sales,
           round(coalesce(sum(d.discount_amount), 0), 2) as discounts,
           round(coalesce((select sum(r.amount) from refunds r
                            where r.local_date = d.local_date), 0), 2) as refunds,
           round(coalesce(sum(d.total), 0), 2)           as gross_receipts
      from sold d
     group by d.local_date
  ),
  totals as (
    select count(*)                                                            as orders,
           round(coalesce((select sum(subtotal) from sold), 0), 2)             as gross_sales,
           round(coalesce((select sum(discount_amount) from sold), 0), 2)      as discounts,
           round(coalesce((select sum(promo_discount) from sold), 0), 2)       as promo_discounts,
           -- discount_amount = loyalty dollars off + promo_discount, and the counter
           -- overwrites it for a till discount, so "other" is everything not a promo.
           round(coalesce((select sum(discount_amount - coalesce(promo_discount, 0))
                             from sold), 0), 2)                                as other_discounts,
           round(coalesce((select sum(amount) from refunds), 0), 2)            as refunds,
           (select count(*) from refunds)                                      as refund_count,
           round(coalesce((select sum(subtotal) from sold), 0)
               - coalesce((select sum(discount_amount) from sold), 0)
               - coalesce((select sum(amount) from refunds), 0), 2)            as net_sales,
           round(coalesce((select sum(tax_amount) from sold), 0), 2)           as tax,
           round(coalesce((select sum(delivery_fee) from sold), 0), 2)         as delivery_fees,
           -- Card-only by construction: place-order computes the service fee after the
           -- payment gate and only for card.
           round(coalesce((select sum(service_fee) from sold), 0), 2)          as service_fees,
           round(coalesce((select sum(tip_amount) from sold), 0), 2)           as tips,
           round(coalesce((select sum(total) from sold), 0), 2)                as gross_receipts,
           round(coalesce((select avg(total) from sold), 0), 2)                as avg_order_value
      from sold
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'totals', (select to_jsonb(t) from totals t),
    'daily', coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from daily d), '[]'::jsonb),
    'refund_events', coalesce((select jsonb_agg(jsonb_build_object('day', r.local_date,
                                                                  'amount', r.amount))
                                 from refunds r), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_branch_sales_report(uuid, date, date) is
  'Gross sales = sum(orders.subtotal) after modifiers, before discount. Discounts = sum(discount_amount), split into promo_discounts and other_discounts (loyalty rewards + till discounts). Refunds come from audit_logs, the only place a partial refund is recorded. Net sales = gross - discounts - refunds. gross_receipts = sum(orders.total) and is what the old totals.revenue meant.';

revoke execute on function public.get_branch_sales_report(uuid, date, date) from public, anon;
grant  execute on function public.get_branch_sales_report(uuid, date, date) to authenticated;


-- 2. ORDERS -----------------------------------------------------------------
create or replace function public.get_branch_orders_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_tz     text;
  v_rest   uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not (private.user_is_platform_admin()
          or private.staff_has_capability(p_branch_id, 'reports.view')) then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC'), b.restaurant_id
    into v_tz, v_rest
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with all_orders as (
    -- EVERY order, cancelled and refunded included. A cancel rate computed over a set
    -- that already dropped the cancellations is the bug this section exists to fix.
    select o.id, o.channel, o.source, o.status, o.total, o.created_at,
           o.confirmed_at, o.completed_at, o.scheduled_for, o.customer_id,
           (o.created_at at time zone v_tz)::date                as local_date,
           extract(hour from o.created_at at time zone v_tz)::int as local_hour,
           to_char(o.created_at at time zone v_tz, 'Dy')          as local_dow
      from public.orders o
     where o.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
  ),
  earning as (select * from all_orders where status <> 'cancelled'),
  hours as (select generate_series(0, 23) as hour),
  by_hour as (
    -- Cross-joined against the 24 hours so a dead hour renders as a real zero rather
    -- than a hole the chart quietly closes up.
    select h.hour,
           coalesce((select count(*) from all_orders a where a.local_hour = h.hour), 0) as orders,
           round(coalesce((select sum(e.total) from earning e where e.local_hour = h.hour), 0), 2) as revenue
      from hours h
  ),
  by_channel as (
    select a.channel::text as channel, count(*) as orders,
           count(*) filter (where a.status = 'cancelled') as cancelled,
           round(coalesce(sum(a.total) filter (where a.status <> 'cancelled'), 0), 2) as revenue
      from all_orders a group by 1 order by 4 desc
  ),
  by_source as (
    select coalesce(a.source, 'unknown') as source, count(*) as orders,
           round(coalesce(sum(a.total) filter (where a.status <> 'cancelled'), 0), 2) as revenue
      from all_orders a group by 1 order by 3 desc
  ),
  by_status as (
    select a.status::text as status, count(*) as orders
      from all_orders a group by 1 order by 2 desc
  ),
  heat as (
    select a.local_dow as dow, a.local_hour as hour, count(*) as orders,
           round(coalesce(sum(a.total) filter (where a.status <> 'cancelled'), 0), 2) as revenue
      from all_orders a group by 1, 2
  ),
  sched as (
    select count(*)                                        as total,
           count(*) filter (where scheduled_for > now())    as upcoming,
           count(*) filter (where status = 'completed')     as fulfilled,
           count(*) filter (where status = 'cancelled')     as cancelled
      from all_orders where scheduled_for is not null
  ),
  totals as (
    select (select count(*) from all_orders)                                    as orders,
           (select count(*) from all_orders where status = 'completed')         as completed,
           (select count(*) from all_orders where status = 'cancelled')         as cancelled,
           (select count(*) from all_orders where status = 'refunded')          as refunded,
           (select count(*) from all_orders
             where status in ('pending','confirmed','preparing','ready','out_for_delivery')) as in_progress,
           round(coalesce((select count(*)::numeric from all_orders where status = 'cancelled')
                        / nullif((select count(*) from all_orders), 0) * 100, 0), 1) as cancel_rate_pct,
           round(coalesce((select count(*)::numeric from all_orders where status = 'completed')
                        / nullif((select count(*) from all_orders), 0) * 100, 0), 1) as completion_rate_pct,
           round(coalesce((select avg(total) from earning), 0), 2)              as avg_order_value,
           round(coalesce((select avg(extract(epoch from (completed_at - confirmed_at)) / 60)
                             from all_orders
                            where completed_at is not null and confirmed_at is not null), 0)::numeric, 1) as avg_fulfil_min
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'totals', (select to_jsonb(t) from totals t),
    'scheduled', (select to_jsonb(s) from sched s),
    'by_channel', coalesce((select jsonb_agg(to_jsonb(c)) from by_channel c), '[]'::jsonb),
    'by_source',  coalesce((select jsonb_agg(to_jsonb(s)) from by_source s), '[]'::jsonb),
    'by_status',  coalesce((select jsonb_agg(to_jsonb(s)) from by_status s), '[]'::jsonb),
    'by_hour',    coalesce((select jsonb_agg(to_jsonb(h) order by h.hour) from by_hour h), '[]'::jsonb),
    'hour_heatmap', coalesce((select jsonb_agg(to_jsonb(h)) from heat h), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_branch_orders_report(uuid, date, date) is
  'Counts every order in the window including cancelled ones, so cancel_rate_pct and completion_rate_pct have an honest denominator. Every revenue figure still excludes cancelled orders.';

revoke execute on function public.get_branch_orders_report(uuid, date, date) from public, anon;
grant  execute on function public.get_branch_orders_report(uuid, date, date) to authenticated;


-- 3. MENU -------------------------------------------------------------------
create or replace function public.get_branch_menu_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_tz     text;
  v_rest   uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not (private.user_is_platform_admin()
          or private.staff_has_capability(p_branch_id, 'reports.view')) then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC'), b.restaurant_id
    into v_tz, v_rest
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with base as (
    select o.id, o.promo_code, o.promo_discount, o.subtotal
      from public.orders o
     where o.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
       and o.status <> 'cancelled'
  ),
  lines as (
    select oi.item_name, oi.menu_item_id, oi.combo_id, oi.quantity,
           oi.subtotal, oi.modifier_total, oi.order_id
      from public.order_items oi join base b on b.id = oi.order_id
  ),
  by_item as (
    select l.item_name as name, min(l.menu_item_id::text) as menu_item_id,
           sum(l.quantity) as quantity,
           round(coalesce(sum(l.subtotal), 0), 2) as revenue,
           count(distinct l.order_id) as orders
      from lines l group by l.item_name order by 4 desc limit 100
  ),
  by_category as (
    -- LEFT JOIN, not INNER. get_branch_reports inner-joins menu_items, which silently
    -- drops every combo line (menu_item_id is null) and every line whose menu item was
    -- later deleted — 20% of item revenue on this project was invisible.
    select coalesce(mc.name,
             case when l.combo_id is not null then 'Combos' else 'Uncategorised' end) as category,
           sum(l.quantity) as quantity,
           round(coalesce(sum(l.subtotal), 0), 2) as revenue
      from lines l
      left join public.menu_items mi on mi.id = l.menu_item_id
      left join public.menu_categories mc on mc.id = mi.category_id
     group by 1 order by 3 desc
  ),
  by_combo as (
    select cs.id::text as combo_id, coalesce(cs.name, l.item_name) as name,
           sum(l.quantity) as quantity,
           round(coalesce(sum(l.subtotal), 0), 2) as revenue,
           count(distinct l.order_id) as orders
      from lines l
      left join public.combo_sets cs on cs.id = l.combo_id
     where l.combo_id is not null
     group by 1, 2 order by 4 desc limit 20
  ),
  promo_orders as (
    -- orders.promo_code / promo_discount, NOT promo_redemptions: place-order only writes
    -- a redemption row when the order has a customer, so guest promo use never reaches
    -- that table and it holds 0 rows on this project.
    select b.promo_code as code, count(*) as orders,
           round(coalesce(sum(b.subtotal), 0), 2) as gross_subtotal,
           round(coalesce(sum(b.promo_discount), 0), 2) as discount
      from base b where b.promo_code is not null group by 1 order by 2 desc
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'totals', jsonb_build_object(
      'items_sold', coalesce((select sum(quantity) from lines), 0),
      'item_revenue', round(coalesce((select sum(subtotal) from lines), 0), 2),
      'modifier_revenue', round(coalesce((select sum(modifier_total) from lines), 0), 2),
      'combo_revenue', round(coalesce((select sum(subtotal) from lines
                                        where combo_id is not null), 0), 2),
      'distinct_items', (select count(*) from by_item),
      'promo_orders', (select count(*) from base where promo_code is not null),
      'promo_discount', round(coalesce((select sum(promo_discount) from base), 0), 2),
      'promo_attributed_revenue', round(coalesce((select sum(subtotal) from base
                                                   where promo_code is not null), 0), 2)),
    'by_item', coalesce((select jsonb_agg(to_jsonb(i)) from by_item i), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(to_jsonb(c)) from by_category c), '[]'::jsonb),
    'by_combo', coalesce((select jsonb_agg(to_jsonb(c)) from by_combo c), '[]'::jsonb),
    'by_promo', coalesce((select jsonb_agg(to_jsonb(p)) from promo_orders p), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_branch_menu_report(uuid, date, date) is
  'Sales by item, category and combo. by_category LEFT JOINs menu_items so combo lines land in a Combos band instead of vanishing. Promotion revenue comes from orders.promo_code, because promo_redemptions is only written for signed-in diners.';

revoke execute on function public.get_branch_menu_report(uuid, date, date) from public, anon;
grant  execute on function public.get_branch_menu_report(uuid, date, date) to authenticated;


-- 4. DELIVERY ---------------------------------------------------------------
create or replace function public.get_branch_delivery_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_tz     text;
  v_rest   uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not (private.user_is_platform_admin()
          or private.staff_has_capability(p_branch_id, 'reports.view')) then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC'), b.restaurant_id
    into v_tz, v_rest
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with dlv as (
    -- Bucketed by when the ORDER was taken, so a delivery lines up with the sale it
    -- belongs to on the Sales section rather than drifting a day on a late drop-off.
    select d.id, d.status, d.driver_id, d.order_id, d.distance_km,
           d.offered_at, d.accepted_at, d.picked_up_at, d.delivered_at,
           d.surge_multiplier, o.created_at as ordered_at,
           -- orders.delivery_fee, NOT deliveries.delivery_fee: the two disagree on this
           -- project and orders is the row the diner was actually charged on.
           o.delivery_fee, o.tip_amount, o.status as order_status
      from public.deliveries d
      join public.orders o on o.id = d.order_id
     where d.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
  ),
  done as (select * from dlv where status = 'delivered'),
  rate as (
    -- order_ratings.delivery_stars, never deliveries.customer_rating: the latter is
    -- populated on 0 of 32 live rows and would yield a permanent, silent 0.00.
    select r.delivery_stars, r.driver_id
      from public.order_ratings r join dlv on dlv.order_id = r.order_id
     where r.delivery_stars is not null
  ),
  splits as (
    select s.driver_cut, s.house_cut, s.tip_amount
      from public.order_tip_splits s join dlv on dlv.order_id = s.order_id
  ),
  by_driver as (
    select d.driver_id::text as driver_id,
           coalesce(dr.full_name, 'Rider') as name,
           count(*) filter (where d.status = 'delivered') as delivered,
           round(coalesce(avg(extract(epoch from (d.delivered_at - d.picked_up_at)) / 60)
                    filter (where d.delivered_at is not null and d.picked_up_at is not null),
                    0)::numeric, 1) as avg_ride_min,
           round(coalesce(sum(d.tip_amount) filter (where d.status = 'delivered'), 0), 2) as tips,
           round(coalesce((select avg(x.delivery_stars) from rate x
                            where x.driver_id = d.driver_id), 0), 2) as avg_stars
      from dlv d left join public.drivers dr on dr.id = d.driver_id
     where d.driver_id is not null
     -- Grouped by the raw columns, not by output position: the correlated avg_stars
     -- subquery reads d.driver_id, and grouping on the ::text expression leaves the
     -- uuid column ungrouped (42803).
     group by d.driver_id, dr.full_name
     order by 3 desc
  ),
  stars as (
    select s.n as star,
           coalesce((select count(*) from rate r where r.delivery_stars = s.n), 0) as count
      from (select generate_series(1, 5) as n) s
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'totals', jsonb_build_object(
      'deliveries', (select count(*) from dlv),
      'completed',  (select count(*) from done),
      'failed',     (select count(*) from dlv where status = 'failed'),
      'cancelled',  (select count(*) from dlv where status = 'cancelled'),
      'in_flight',  (select count(*) from dlv
                      where status in ('pending','dispatching','assigned','picked_up','in_transit')),
      -- Two clocks: the ride itself, and door to door. On-time % is NOT computable —
      -- no promised-delivery-time column exists anywhere in this schema.
      'avg_ride_min', round(coalesce((select avg(extract(epoch from (delivered_at - picked_up_at)) / 60)
                                        from done where picked_up_at is not null), 0)::numeric, 1),
      'avg_total_min', round(coalesce((select avg(extract(epoch from (delivered_at - ordered_at)) / 60)
                                        from done), 0)::numeric, 1),
      'avg_accept_min', round(coalesce((select avg(extract(epoch from (accepted_at - offered_at)) / 60)
                                         from dlv
                                        where accepted_at is not null and offered_at is not null),
                                       0)::numeric, 1),
      'avg_distance_km', round(coalesce((select avg(distance_km) from done), 0), 2),
      'delivery_fees', round(coalesce((select sum(delivery_fee) from dlv
                                        where order_status <> 'cancelled'), 0), 2),
      'tips_charged',   round(coalesce((select sum(tip_amount) from done), 0), 2),
      'tips_to_riders', round(coalesce((select sum(driver_cut) from splits), 0), 2),
      'tips_to_house',  round(coalesce((select sum(house_cut) from splits), 0), 2),
      'rider_payouts',  round(coalesce((select sum(l.total) from public.driver_earnings_ledger l
                                         join dlv on dlv.id = l.delivery_id), 0), 2),
      'rating_count',   (select count(*) from rate),
      'avg_stars',      round(coalesce((select avg(delivery_stars) from rate), 0), 2)),
    'star_distribution', coalesce((select jsonb_agg(to_jsonb(s) order by s.star) from stars s), '[]'::jsonb),
    'by_driver', coalesce((select jsonb_agg(to_jsonb(b)) from by_driver b), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_branch_delivery_report(uuid, date, date) is
  'Delivery counts, timings, fees, tips and ratings for orders taken in the window. Ratings read order_ratings.delivery_stars. On-time percentage is not returned because no promised-delivery time is recorded anywhere in this schema.';

revoke execute on function public.get_branch_delivery_report(uuid, date, date) from public, anon;
grant  execute on function public.get_branch_delivery_report(uuid, date, date) to authenticated;


-- 5. CUSTOMERS & LOYALTY ----------------------------------------------------
create or replace function public.get_branch_customers_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_tz     text;
  v_rest   uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not (private.user_is_platform_admin()
          or private.staff_has_capability(p_branch_id, 'reports.view')) then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC'), b.restaurant_id
    into v_tz, v_rest
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with win as (
    select o.id, o.customer_id, o.total, o.promo_code, o.promo_discount, o.created_at
      from public.orders o
     where o.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
       and o.status <> 'cancelled'
  ),
  first_order as (
    -- Over ALL of this branch's history, not the window. get_cohort_retention takes
    -- min(created_at) INSIDE the window, which makes every returning regular look new.
    select o.customer_id, min(o.created_at) as first_at
      from public.orders o
     where o.branch_id = p_branch_id and o.customer_id is not null and o.status <> 'cancelled'
     group by o.customer_id
  ),
  per_cust as (
    select w.customer_id, count(*) as orders, round(coalesce(sum(w.total), 0), 2) as spend,
           max(w.created_at) as last_at
      from win w where w.customer_id is not null group by w.customer_id
  ),
  top_cust as (
    select p.customer_id::text as customer_id,
           coalesce(c.full_name, 'Guest') as name,
           p.orders, p.spend, p.last_at,
           c.total_orders as lifetime_orders, c.total_spent as lifetime_spent,
           -- Scalar subquery, not a join: a customer can hold both a branch-scoped and a
           -- brand-scoped loyalty_points row, and joining would list them twice.
           (select lp.tier::text from public.loyalty_points lp
             where lp.customer_id = c.id
               and (lp.branch_id = p_branch_id
                    or (lp.branch_id is null and lp.restaurant_id = v_rest))
             order by (lp.branch_id is null) limit 1) as tier
      from per_cust p
      join public.customers c on c.id = p.customer_id
     order by p.spend desc limit 20
  ),
  loy as (
    -- Loyalty is brand-wide by design: rows written under brand scope carry branch_id NULL
    -- and only restaurant_id, which is what made the loyalty CSV export download an empty
    -- file. Order-linked rows are attributed through the order's own branch. A manual
    -- adjustment has no order to hang on and is usually written brand-wide, so requiring
    -- branch_id = p_branch_id for it would make points_manual permanently zero — it is
    -- included here and reported on its own line, never folded into earned or redeemed.
    select lt.type, lt.points, lt.reference_type
      from public.loyalty_transactions lt
     where lt.restaurant_id = v_rest
       and lt.created_at >= v_from and lt.created_at < v_to
       and (
         (lt.reference_type = 'order'
          and lt.reference_id in (select id from public.orders where branch_id = p_branch_id))
         or (lt.reference_type is distinct from 'order'
             and (lt.branch_id = p_branch_id or lt.branch_id is null))
       )
  ),
  coupons as (
    select w.promo_code as code, count(*) as uses,
           round(coalesce(sum(w.promo_discount), 0), 2) as discount,
           count(distinct w.customer_id) as customers
      from win w where w.promo_code is not null group by 1 order by 2 desc
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'totals', jsonb_build_object(
      'total_customers',    (select count(*) from public.customers where branch_id = p_branch_id),
      'active_customers',   (select count(*) from per_cust),
      'new_customers',      (select count(*) from per_cust p join first_order f
                                                     on f.customer_id = p.customer_id
                              where f.first_at >= v_from and f.first_at < v_to),
      'returning_customers',(select count(*) from per_cust p join first_order f
                                                     on f.customer_id = p.customer_id
                              where f.first_at < v_from),
      -- Surfaced, never hidden: an unattributable order would otherwise make
      -- new + returning silently fail to add up to the order count.
      'guest_orders',       (select count(*) from win where customer_id is null),
      'repeat_customers',   (select count(*) from per_cust where orders >= 2),
      'avg_orders_per_customer',
        round(coalesce((select sum(orders)::numeric from per_cust)
                     / nullif((select count(*) from per_cust), 0), 0), 2),
      'avg_spend_per_customer',
        round(coalesce((select sum(spend) from per_cust)
                     / nullif((select count(*) from per_cust), 0), 0), 2),
      -- Disjoint on purpose: a manual redemption is a 'redeemed' row too, and counting it
      -- in both lines would make the loyalty card fail to reconcile against itself.
      'points_earned',   coalesce((select sum(points) from loy
                                    where type = 'earned' and reference_type = 'order'), 0),
      'points_redeemed', coalesce((select -sum(points) from loy
                                    where type = 'redeemed' and reference_type = 'order'), 0),
      'points_manual',   coalesce((select sum(points) from loy
                                    where reference_type is distinct from 'order'), 0),
      'coupon_uses',     (select count(*) from win where promo_code is not null),
      'coupon_discount', round(coalesce((select sum(promo_discount) from win), 0), 2)),
    'top_customers', coalesce((select jsonb_agg(to_jsonb(t) order by t.spend desc) from top_cust t), '[]'::jsonb),
    'by_coupon',     coalesce((select jsonb_agg(to_jsonb(c)) from coupons c), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_branch_customers_report(uuid, date, date) is
  'New vs returning is decided by the customer''s first ever order at this branch, not their first order inside the window. guest_orders is returned because orders with no customer_id can never be attributed and would otherwise look like a counting error.';

revoke execute on function public.get_branch_customers_report(uuid, date, date) from public, anon;
grant  execute on function public.get_branch_customers_report(uuid, date, date) to authenticated;


-- 6. PAYMENTS & REFUNDS -----------------------------------------------------
create or replace function public.get_branch_payments_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_tz     text;
  v_rest   uuid;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not (private.user_is_platform_admin()
          or private.staff_has_capability(p_branch_id, 'reports.view')) then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC'), b.restaurant_id
    into v_tz, v_rest
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with pay as (
    -- Bucketed by the ORDER's date, not paid_at: paid_at is null on every pending row,
    -- so a paid_at window would drop exactly the rows the merchant is chasing.
    select p.id, p.method, p.status, p.amount, p.paid_at,
           o.status as order_status, o.total, o.service_fee,
           (p.gateway_metadata->>'settled_via') as settled_via
      from public.payments p
      join public.orders o on o.id = p.order_id
     where p.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
  ),
  methods as (select unnest(array['card','cash','transfer']) as method),
  statuses as (select unnest(enum_range(null::public.payment_status))::text as status),
  grid as (
    -- Every method x status cell, so an empty bucket renders 0 instead of vanishing and
    -- the merchant can see that "refunded" really is empty rather than missing.
    select m.method, s.status,
           coalesce((select count(*) from pay p
                      where p.method = m.method and p.status::text = s.status), 0) as count,
           round(coalesce((select sum(p.amount) from pay p
                            where p.method = m.method and p.status::text = s.status), 0), 2) as amount
      from methods m cross join statuses s
  ),
  refunds as (
    select coalesce(nullif(a.metadata->>'amount', '')::numeric, 0) as amount,
           (a.created_at at time zone v_tz)::date as local_date
      from public.audit_logs a
     where a.branch_id = p_branch_id and a.action = 'refund' and a.entity_type = 'order'
       and a.created_at >= v_from and a.created_at < v_to
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'timezone', v_tz,
    'by_method_status', coalesce((select jsonb_agg(to_jsonb(g)) from grid g), '[]'::jsonb),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object(
        'method', m.method,
        'count',  (select count(*) from pay p where p.method = m.method),
        'amount', round(coalesce((select sum(p.amount) from pay p
                                   where p.method = m.method), 0), 2),
        'settled', round(coalesce((select sum(p.amount) from pay p
                                    where p.method = m.method and p.status = 'completed'), 0), 2)
      )) from methods m), '[]'::jsonb),
    'totals', jsonb_build_object(
      'payments', (select count(*) from pay),
      'settled',  round(coalesce((select sum(amount) from pay where status = 'completed'), 0), 2),
      'pending',  round(coalesce((select sum(amount) from pay where status = 'pending'), 0), 2),
      'failed',   round(coalesce((select sum(amount) from pay where status = 'failed'), 0), 2),
      -- Always 0.00 today: refund_order() never touches payments. Returned anyway so the
      -- gap shows on screen instead of silently reading as "no refunds happened".
      'refunded_on_payments', round(coalesce((select sum(amount) from pay
                                               where status = 'refunded'), 0), 2),
      'voided_on_payments',   round(coalesce((select sum(amount) from pay
                                               where status = 'voided'), 0), 2),
      -- The real refund figure. NOT subtracted from the method totals above: the money
      -- genuinely arrived by that method; the refund is its own line.
      'refunds',      round(coalesce((select sum(amount) from refunds), 0), 2),
      'refund_count', (select count(*) from refunds),
      'service_fee_collected', round(coalesce((select sum(service_fee) from pay
                                                where order_status <> 'cancelled'), 0), 2),
      -- The actionable number 20260904160000_record_counter_payment exists for.
      'unsettled_on_completed_orders',
        round(coalesce((select sum(amount) from pay
                         where status = 'pending' and order_status = 'completed'), 0), 2),
      'backfilled_settlements',
        (select count(*) from pay where settled_via like 'backfill\_%')),
    'refunds_daily', coalesce((select jsonb_agg(jsonb_build_object('day', r.local_date,
                                                                  'amount', r.amount))
                                 from refunds r), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_branch_payments_report(uuid, date, date) is
  'Method x status grid. `refunds` comes from audit_logs, not payments.status, because refund_order() never writes payments. Card rows sitting pending are expected while no Stripe key is configured, and must not be read as failures.';

revoke execute on function public.get_branch_payments_report(uuid, date, date) from public, anon;
grant  execute on function public.get_branch_payments_report(uuid, date, date) to authenticated;
