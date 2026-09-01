-- "Mark as delivered" failed for every delivery, and had done since 2026-08-30 18:47.
--
-- Rewriting accrue_driver_earnings to read pay from private.driver_pay_rates() also rewrote
-- its INSERT, and the INSERT was wrong in two independent ways. Both raise, so the AFTER
-- UPDATE trigger aborted the transaction and progress_delivery came back as a plain error —
-- which the rider app showed as "Couldn't update this delivery — please try again", a
-- message that invited a retry that could never work:
--
--   1. driver_earnings_ledger.total is GENERATED ALWAYS AS (base_pay + distance_pay + tip_net).
--      Writing it raises 428C9 "cannot insert a non-DEFAULT value into column total".
--   2. status was set to 'pending', which is not in
--      driver_earnings_ledger_status_check CHECK (status = ANY (ARRAY['accrued','paid'])).
--      Every ledger row written before this regression is 'accrued'.
--
-- total is now left to the generated column and status to its 'accrued' default, so neither
-- can drift from the table definition again. The last successful accrual was 13:39 that day;
-- no completed delivery has been paid since, and the backfill at the end repairs any that
-- reached 'delivered' by a path that skipped the trigger.
create or replace function public.accrue_driver_earnings()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_base_setting numeric; v_earnings numeric; v_base numeric; v_distance numeric;
  v_tip numeric; v_tip_net numeric; v_pstart date;
begin
  if new.driver_id is null then return new; end if;
  if new.status is distinct from 'delivered' then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  select base_pay into v_base_setting from private.driver_pay_rates();

  v_earnings := coalesce(new.driver_earnings, 0);
  v_base     := round(least(v_base_setting, v_earnings), 2);
  v_distance := round(v_earnings - v_base, 2);

  v_tip := coalesce(new.net_tip, 0);
  v_tip_net := round(greatest(0, v_tip), 2);

  v_pstart := date_trunc('week', coalesce(new.delivered_at, now()))::date;

  -- No `total` (generated) and no `status` (defaults to 'accrued').
  insert into public.driver_earnings_ledger
    (driver_id, branch_id, delivery_id, order_id, base_pay, distance_pay, tip_net,
     payout_period_start, payout_period_end, delivered_at)
  values
    (new.driver_id, new.branch_id, new.id, new.order_id, v_base, v_distance, v_tip_net,
     v_pstart, (v_pstart + 6), coalesce(new.delivered_at, now()))
  on conflict do nothing;

  return new;
end;
$function$;

insert into public.driver_earnings_ledger
  (driver_id, branch_id, delivery_id, order_id, base_pay, distance_pay, tip_net,
   payout_period_start, payout_period_end, delivered_at)
select d.driver_id, d.branch_id, d.id, d.order_id,
       round(least((select base_pay from private.driver_pay_rates()), coalesce(d.driver_earnings, 0)), 2),
       round(coalesce(d.driver_earnings, 0)
             - round(least((select base_pay from private.driver_pay_rates()), coalesce(d.driver_earnings, 0)), 2), 2),
       round(greatest(0, coalesce(d.net_tip, 0)), 2),
       date_trunc('week', coalesce(d.delivered_at, d.created_at))::date,
       date_trunc('week', coalesce(d.delivered_at, d.created_at))::date + 6,
       coalesce(d.delivered_at, d.created_at)
  from public.deliveries d
 where d.status = 'delivered'
   and d.driver_id is not null
   and not exists (select 1 from public.driver_earnings_ledger l where l.delivery_id = d.id)
on conflict do nothing;
