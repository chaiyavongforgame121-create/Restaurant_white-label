-- A unit price is never rounded to the cent. Only a line is, once, and the order subtotal is the
-- exact sum of its lines.
--
-- The owner's report (Food Thai Thai, 2026-09): seven "SET A : Green Curry Chicken" during the
-- 50% happy hour on "Special SET". The list price is $15.99, so the happy-hour price is $7.995.
-- The cart line showed $55.97 (7 x 7.995 = 55.965), but the Subtotal, "Proceed to checkout" and
-- the saved bill all said $56.00, the bill as "7 x $8.00". "Never round when totalling; show it
-- exactly as it is."
--
-- Two places rounded the unit before it was multiplied: place-order computed each line as
-- r2(r2(price + options) x qty), and order_items.unit_price, numeric(10,2), would have rounded
-- 7.995 to 8.00 on the way in regardless. place-order v11.4 (same change) now works a line as
-- lineTotal(unit, options, qty): (unit + options) x qty rounded half-up to the cent once, 7 x
-- 7.995 -> $55.97, and stores the unit as it is. This migration is the SQL half:
--
--   1. order_items.unit_price widens to numeric(12,4), so 7.995 is stored as 7.995. subtotal and
--      modifier_total stay numeric(10,2): a line is money. Widening only; every stored value
--      fits. Nothing depends on the column but its own check constraint (unit_price >= 0): no
--      view, rule, policy or trigger column list (checked in pg_depend on 2026-09-22).
--   2. get_effective_prices returns the discounted price rounded to four decimals, the precision
--      the column keeps. It already returned it unrounded (15.99 * (1 - 50/100) =
--      7.99500000000000000000), so nothing a client sees changes for a whole or half percent;
--      the round only stops a percentage like 33.33 producing more decimals than can be stored
--      (15.99 * 0.6667 = 10.660533 -> 10.6605). Signature, security and everything else are as
--      before.
--
-- No other stored per-unit price is copied from a discounted one. The SQL that bills a line
-- (get_table_session_bill, issue_tax_invoice, get_branch_reports, get_branch_menu_report) already
-- sums or shows order_items.subtotal, never unit_price x quantity. issue_tax_invoice's own
-- snapshot of the unit (options included, four decimals) is rebuilt in
-- 20260922120000_order_lines_menu_order.sql.

alter table public.order_items
  alter column unit_price type numeric(12,4);

create or replace function public.get_effective_prices(p_branch_id uuid)
 returns table(menu_item_id uuid, list_price numeric, effective_price numeric, discount_label text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_now timestamptz := now();
  v_tz text;
  v_local_time time;
  v_dow int;
begin
  -- Use branch's timezone for the schedule comparison
  select timezone into v_tz from public.branches where id = p_branch_id;
  v_tz := coalesce(v_tz, 'America/New_York');
  v_local_time := (v_now at time zone v_tz)::time;
  v_dow := extract(dow from (v_now at time zone v_tz))::int;

  return query
  with items as (
    select id, price, branch_id, category_id from public.menu_items where branch_id = p_branch_id
  ), active_hh as (
    select * from public.happy_hours hh
     where hh.branch_id = p_branch_id
       and hh.is_active = true
       and v_dow = any(hh.days_of_week)
       and v_local_time between hh.start_time and hh.end_time
  ),
  per_item as (
    select i.id as item_id,
           i.price,
           hh.id as hh_id,
           hh.name as hh_name,
           hh.discount_type,
           hh.discount_value,
           -- A unit price, to the four decimals order_items.unit_price keeps. Never to the
           -- cent: half of 15.99 is 7.995, and place-order rounds only the line it is sold on.
           round(
             case hh.discount_type
               when 'percent' then i.price * (1 - hh.discount_value / 100)
               when 'fixed'   then greatest(0, i.price - hh.discount_value)
             end,
             4
           ) as eff_price
    from items i
    join active_hh hh on (
      (cardinality(hh.applies_to_item_ids) = 0 and cardinality(hh.applies_to_category_ids) = 0)
      or i.id = any(hh.applies_to_item_ids)
      or i.category_id = any(hh.applies_to_category_ids)
    )
  )
  -- For each item, pick the deepest discount.
  select
    coalesce(pi.item_id, i2.id) as menu_item_id,
    i2.price as list_price,
    coalesce(min(pi.eff_price), i2.price) as effective_price,
    (
      select hh_name
      from per_item pi2
      where pi2.item_id = i2.id
      order by pi2.eff_price asc
      limit 1
    ) as discount_label
  from items i2
  left join per_item pi on pi.item_id = i2.id
  group by i2.id, i2.price, pi.item_id;
end;
$function$;
