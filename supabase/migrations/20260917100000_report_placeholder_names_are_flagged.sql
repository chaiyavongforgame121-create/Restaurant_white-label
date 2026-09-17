-- Reports say which rows carry a placeholder name.
--
-- The back office now shows its interface in English, Spanish, Vietnamese and Thai. These reports
-- fill in 'Combos' / 'Uncategorised' for lines with no menu category, 'Rider' for a driver with no
-- name and 'Guest' for a customer with no name, and the only way the page could translate those
-- was to compare the text. A merchant category really called "Combos", or a customer whose name
-- is "Guest", was then translated too, and merchant content is never translated.
--
-- Additive: every existing column keeps its value, so a page still on the old code reads the
-- same payload. New columns:
--   get_branch_menu_report.by_category[].band        'combos' | 'uncategorised' | null
--   get_branch_delivery_report.by_driver[].has_name   boolean
--   get_branch_customers_report.top_customers[].has_name boolean
-- by_category also groups on band, so a merchant category named "Combos" is no longer summed into
-- the combo band's row.

CREATE OR REPLACE FUNCTION public.get_branch_menu_report(p_branch_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
           -- Set only on the two bands this report names itself, so the back office translates
           -- those and never a merchant category that happens to be called "Combos".
           case when mc.name is null
                then case when l.combo_id is not null then 'combos' else 'uncategorised' end
           end as band,
           sum(l.quantity) as quantity,
           round(coalesce(sum(l.subtotal), 0), 2) as revenue
      from lines l
      left join public.menu_items mi on mi.id = l.menu_item_id
      left join public.menu_categories mc on mc.id = mi.category_id
     group by 1, 2 order by 4 desc
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
$function$;

CREATE OR REPLACE FUNCTION public.get_branch_delivery_report(p_branch_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
           -- False when name is the report's own placeholder, not a rider's real name.
           (dr.full_name is not null) as has_name,
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
$function$;

CREATE OR REPLACE FUNCTION public.get_branch_customers_report(p_branch_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
           -- False when name is the report's own placeholder, not a customer's real name.
           (c.full_name is not null) as has_name,
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
$function$;
