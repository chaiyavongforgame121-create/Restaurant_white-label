-- Customers report: every kind of loyalty ledger row gets its own line.
--
-- The branch customers report (Reports > Customers > Loyalty points) split this branch's ledger
-- into Earned, Redeemed and "Manual adjustments", where manual was every row whose reference_type
-- is not 'order'. Since the per-branch loyalty work (20260918120000_loyalty_per_branch) the ledger
-- carries three more kinds of row, and all of them landed in "Manual adjustments":
--
--   * 'order_return' (type 'adjusted'): points a diner spent on an order, given back when the order
--     is cancelled or refunded (private.return_loyalty_for_order, positive), or taken again when
--     that order is reopened (private.reclaim_loyalty_for_order, negative). Hamburger already has
--     two live rows (+150). They are not staff corrections; they undo a redemption.
--   * 'birthday' (type 'adjusted'): issue_birthday_rewards' gifts.
--   * 'manual' (type 'adjusted'): a staff correction through adjust_loyalty_points, with its
--     reason. These are the only rows "Manual adjustments" was meant for.
--
-- And a legacy 'manual' row of type 'redeemed' ("Redeemed 1000 points", 2026-05-31, written by the
-- since-dropped redeem_loyalty_points) is a redemption, not a correction.
--
-- The totals are now five disjoint lines that together cover every ledger row of this branch in
-- the range, so earned - redeemed + returned + birthday + manual is exactly the net change of this
-- branch's balances:
--   points_earned    type 'earned' (order awards)
--   points_redeemed  type 'redeemed', any reference (reported as a positive number)
--   points_returned  NEW: reference 'order_return', signed (given back minus taken again)
--   points_birthday  NEW: reference 'birthday'
--   points_manual    everything else: staff corrections (reference 'manual'), and any other kind
--                    of row, so nothing can drop out of the card unseen
-- Keys only gain members, so an admin build that predates this keeps working (it simply shows the
-- smaller "manual" figure). Only this branch's rows are read, exactly as before: its own branch_id,
-- plus the legacy NULL-branch order rows of its own orders (none are left live; kept as the safety
-- net the previous version had). Everything else in the function is unchanged from the live body
-- (20260918130000_customers_per_branch).

create or replace function public.get_branch_customers_report(p_branch_id uuid, p_from date, p_to date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tz     text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
  d_from   date := least(p_from, p_to);
  d_to     date := greatest(p_from, p_to);
begin
  if not private.staff_has_capability(p_branch_id, 'reports.view') then
    raise exception 'not authorized to read reports for this branch'
      using errcode = '42501';
  end if;

  if d_from is null or d_to is null then
    raise exception 'range_required' using errcode = 'P0001';
  end if;
  if d_to - d_from > 366 then
    raise exception 'range_too_wide' using errcode = 'P0001';
  end if;

  select coalesce(nullif(b.timezone, ''), 'UTC')
    into v_tz
    from public.branches b where b.id = p_branch_id;
  if v_tz is null then v_tz := 'UTC'; end if;

  v_from := (d_from::timestamp) at time zone v_tz;
  v_to   := ((d_to + 1)::timestamp) at time zone v_tz;

  with win as (
    -- Order-level lines (guest orders, coupons) follow the rest of the reports: every order in
    -- the range that was not cancelled.
    select o.id, o.customer_id, o.total, o.promo_code, o.promo_discount, o.created_at, o.status
      from public.orders o
     where o.branch_id = p_branch_id
       and o.created_at >= v_from and o.created_at < v_to
       and o.status <> 'cancelled'
  ),
  first_order as (
    -- Over ALL of this branch's history, not the window, so a returning regular never looks new.
    select o.customer_id, min(o.created_at) as first_at
      from public.orders o
     where o.branch_id = p_branch_id and o.customer_id is not null and o.status <> 'cancelled'
     group by o.customer_id
  ),
  per_cust as (
    -- Per-diner figures count COMPLETED orders, the Customers page's rule
    -- (customers_refresh_order_stats): an order still being made, or one refunded, is not money
    -- the diner spent here. So a range figure can never exceed the lifetime one beside it.
    select w.customer_id, count(*) as orders, round(coalesce(sum(w.total), 0), 2) as spend,
           max(w.created_at) as last_at
      from win w
     where w.customer_id is not null and w.status = 'completed'
     group by w.customer_id
  ),
  top_cust as (
    select p.customer_id::text as customer_id,
           coalesce(n.name, 'Guest') as name,
           -- False when name is the report's own placeholder, not a customer's real name.
           (n.name is not null) as has_name,
           p.orders, p.spend, p.last_at,
           -- The customer row is this branch's, so these are this branch's completed orders:
           -- the same figures as the Customers page.
           c.total_orders as lifetime_orders, c.total_spent as lifetime_spent,
           (select lp.tier::text from public.loyalty_points lp
             where lp.customer_id = c.id and lp.branch_id = p_branch_id
             limit 1) as tier
      from per_cust p
      join public.customers c on c.id = p.customer_id
      cross join lateral (
        select coalesce(
          nullif(btrim(c.full_name), ''),
          (select btrim(o.customer_name) from public.orders o
            where o.customer_id = c.id and o.branch_id = p_branch_id
              and not private.is_placeholder_customer_name(o.customer_name)
            order by o.created_at desc limit 1),
          case when private.is_synthetic_email(c.email) then null else nullif(btrim(c.email), '') end
        ) as name
      ) n
     order by p.spend desc limit 20
  ),
  loy as (
    -- This branch's points only. Order-linked rows still carrying a NULL branch (written under the
    -- retired brand scope) count by their order's branch until the loyalty backfill stamps them.
    -- Each row falls in exactly one bucket, so the lines below add up to the net change.
    select lt.points,
           case
             when lt.reference_type = 'order_return' then 'returned'
             when lt.reference_type = 'birthday'     then 'birthday'
             when lt.type = 'earned'                 then 'earned'
             when lt.type = 'redeemed'               then 'redeemed'
             else 'manual'
           end as bucket
      from public.loyalty_transactions lt
     where lt.created_at >= v_from and lt.created_at < v_to
       and (lt.branch_id = p_branch_id
            or (lt.branch_id is null and lt.reference_type = 'order'
                and lt.reference_id in (select id from public.orders where branch_id = p_branch_id)))
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
      -- Customer records of this branch: every diner who signed in or ordered here.
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
      -- Disjoint on purpose (see loy): earned - redeemed + returned + birthday + manual is the
      -- net change of this branch's balances over the range.
      'points_earned',   coalesce((select sum(points) from loy where bucket = 'earned'), 0),
      'points_redeemed', coalesce((select -sum(points) from loy where bucket = 'redeemed'), 0),
      -- Signed: points given back on cancelled or refunded orders, less any taken again when
      -- such an order was reopened.
      'points_returned', coalesce((select sum(points) from loy where bucket = 'returned'), 0),
      'points_birthday', coalesce((select sum(points) from loy where bucket = 'birthday'), 0),
      -- Staff corrections (adjust_loyalty_points), signed.
      'points_manual',   coalesce((select sum(points) from loy where bucket = 'manual'), 0),
      'coupon_uses',     (select count(*) from win where promo_code is not null),
      'coupon_discount', round(coalesce((select sum(promo_discount) from win), 0), 2)),
    'top_customers', coalesce((select jsonb_agg(to_jsonb(t) order by t.spend desc) from top_cust t), '[]'::jsonb),
    'by_coupon',     coalesce((select jsonb_agg(to_jsonb(c)) from coupons c), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.get_branch_customers_report(uuid, date, date) from public, anon;
grant execute on function public.get_branch_customers_report(uuid, date, date) to authenticated, service_role;
