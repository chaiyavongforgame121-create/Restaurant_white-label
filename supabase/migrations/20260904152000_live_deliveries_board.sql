-- The Live deliveries board showed the merchant garbage, and gave them nothing to do about it.
--
-- On the live project it read "19 in flight": every one a test run from June to September
-- parked at "Finding driver" or "Waiting kitchen", six of them belonging to orders that had
-- been cancelled or refunded weeks earlier, and one card announcing "ETA 37104 min". The
-- riders who were actually online never appeared, because the map only knew about a rider
-- through deliveries.driver_lat/lng, which set_driver_location maintains solely while that
-- rider holds a job. Three things below make the board honest and actionable; the client
-- half of the change (the board itself) lives in apps/admin/src/app/b/[branchId]/deliveries.
--
-- Deliberately NOT here: set_driver_location and the trigger that clears a delivery's
-- driver_lat/lng/current_eta_min/arriving_at when its rider changes. Those land in their own
-- migration alongside the driver app changes that exercise them.

-- 1. Riders of one branch, with positions ----------------------------------------------------
-- drivers.current_location is a geography (PostgREST hands it back as WKB hex) and drivers
-- is not in the supabase_realtime publication — on purpose, the row carries
-- national_id_encrypted and bank_account_encrypted. So the board polls this instead of
-- subscribing. The per-branch online flag comes from driver_branch_availability, the same
-- source find_dispatch_candidates reads, and active_delivery_id lets the board draw a rider
-- once (as the job puck) rather than twice while an offer is open.
--
-- security definer because drivers_staff_read only reaches riders who applied here and the
-- position columns are what the board exists to show; the capability check is the gate.
create or replace function public.list_branch_riders(p_branch_id uuid)
returns table (
  driver_id uuid,
  full_name text,
  phone text,
  vehicle_type text,
  online boolean,
  kyc_verified boolean,
  cooling_down boolean,
  lat double precision,
  lng double precision,
  location_updated_at timestamptz,
  battery_level integer,
  active_delivery_id uuid
)
language plpgsql stable security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  if not private.staff_has_capability(p_branch_id, 'delivery.manage') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  return query
    select d.id,
           d.full_name,
           d.phone,
           d.vehicle_type,
           coalesce(dba.is_online, false),
           d.kyc_status = 'verified',
           d.cooldown_until is not null and d.cooldown_until > now(),
           st_y(d.current_location::geometry),
           st_x(d.current_location::geometry),
           d.location_updated_at,
           d.battery_level,
           (select del.id
              from public.deliveries del
             where del.driver_id = d.id
               and del.status in ('assigned', 'picked_up', 'in_transit')
             order by del.assigned_at desc nulls last
             limit 1)
      from public.drivers d
      join public.driver_approvals da
        on da.driver_id = d.id
       and da.branch_id = p_branch_id
       and da.status = 'approved'
      left join public.driver_branch_availability dba
        on dba.driver_id = d.id
       and dba.branch_id = p_branch_id
     order by coalesce(dba.is_online, false) desc,
              d.location_updated_at desc nulls last,
              d.full_name;
end;
$function$;

revoke execute on function public.list_branch_riders(uuid) from public, anon;
grant  execute on function public.list_branch_riders(uuid) to authenticated;

-- 2. A cancelled or refunded order takes its undelivered delivery with it -------------------
-- cancel_order and the refund path only ever touched orders (and stock). The delivery row
-- stayed at pending/dispatching for ever, so the board kept advertising work for orders
-- nobody would cook, and dispatch kept offering them to riders.
--
-- picked_up and in_transit are left alone on purpose: the food is already with the rider and
-- has to come back, so staff resolve those from Orders (refund) with their eyes open.
-- driver_id is kept so the rider's app, whose RLS is scoped to driver_id, still receives the
-- update and clears the job from their screen.
create or replace function public.orders_cancel_syncs_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.status is not distinct from old.status then return new; end if;
  if new.status not in ('cancelled', 'refunded') then return new; end if;

  update public.deliveries
     set status = 'cancelled',
         offer_expires_at = null,
         dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
           || jsonb_build_object('type', 'order_' || new.status::text, 'at', now())
   where order_id = new.id
     and status in ('pending', 'dispatching', 'assigned', 'failed');

  return new;
end;
$function$;

revoke execute on function public.orders_cancel_syncs_delivery() from public, anon, authenticated;

drop trigger if exists orders_cancel_syncs_delivery on public.orders;
create trigger orders_cancel_syncs_delivery
  after update of status on public.orders
  for each row execute function public.orders_cancel_syncs_delivery();

-- Rows stranded by the old behaviour: six on the live project on 2026-09-06, all at branch
-- 4444… (A-2609-394677 refunded; A-2608-105056, -910605, -687878, -303185 and A-2608-211012
-- cancelled). The board already hides them by joining through the order's status; this makes
-- the data agree with what the board says.
update public.deliveries d
   set status = 'cancelled',
       offer_expires_at = null,
       dispatch_history = coalesce(d.dispatch_history, '[]'::jsonb)
         || jsonb_build_object('type', 'order_' || o.status::text, 'at', now(), 'backfill', true)
  from public.orders o
 where o.id = d.order_id
   and o.status in ('cancelled', 'refunded')
   and d.status in ('pending', 'dispatching', 'assigned', 'failed');

-- 3. Assigning a rider by hand is the way out of a stuck dispatch ---------------------------
-- A dispatching row whose candidate list keeps coming back empty never fails on its own when
-- driver_max_attempts is set high (the live branch has it at 9999999999), so nothing ever
-- surfaces it under "Delivery issues", and the only exits are to cancel the order or to put
-- a rider on it directly. The board now offers both — but staff_assign_driver authorised via
-- a staff_members row scoped to THIS branch, unlike advance_self_delivery next to it, which
-- asks private.staff_has_capability. A restaurant-wide staff row (branch_id null), the
-- restaurant's owner_user_id without a staff row, or a platform admin got 'forbidden' from a
-- button the sidebar had just shown them. Same predicate for both now.
--
-- Everything else is byte-for-byte the 20260830184754 body: the status and acceptance
-- rules, batch dissolution, eligibility, the busy check, platform pay rates, the tip split,
-- the offer stamp and the push.
create or replace function public.staff_assign_driver(p_delivery_id uuid, p_driver_id uuid)
returns void language plpgsql security definer
set search_path to 'public', 'net', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  d record; v_settings jsonb; v_ttl int; v_base numeric; v_perkm numeric;
  v_earnings numeric; v_now timestamptz := now(); v_expires timestamptz;
  v_tip numeric; v_pct numeric; v_net numeric; v_mode text; v_visible numeric;
begin
  if v_user is null then raise exception 'auth_required'; end if;

  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;

  if not private.staff_has_capability(d.branch_id, 'delivery.manage') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  if d.status not in ('pending','dispatching','assigned') then raise exception 'not_assignable'; end if;
  if d.accepted_at is not null then raise exception 'already_accepted'; end if;

  if d.batch_id is not null then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
  end if;

  perform 1
    from public.drivers dr
    join public.driver_approvals da on da.driver_id = dr.id and da.branch_id = d.branch_id
   where dr.id = p_driver_id and da.status = 'approved' and dr.kyc_status = 'verified';
  if not found then raise exception 'driver_not_eligible'; end if;

  if exists (
    select 1 from public.deliveries del
    where del.driver_id = p_driver_id and del.id <> p_delivery_id
      and del.status in ('assigned','picked_up','in_transit')
  ) then raise exception 'driver_busy'; end if;

  select settings into v_settings from public.branches where id = d.branch_id;
  v_ttl := coalesce((v_settings->>'offer_ttl_seconds')::int, 75);
  select base_pay, per_km_pay into v_base, v_perkm from private.driver_pay_rates();
  v_earnings := least(
    round((v_base + v_perkm * coalesce(d.distance_km, 0))::numeric, 2),
    private.branch_driver_pay_cap(d.branch_id)
  );
  v_expires := v_now + make_interval(secs => v_ttl);

  select coalesce(tip_amount, 0) into v_tip from public.orders where id = d.order_id;
  v_tip := greatest(0, coalesce(v_tip, 0));
  v_pct := greatest(0, least(100,
    coalesce((v_settings->'tip_config'->'delivery'->'distribution'->>'driver')::numeric, 100)));
  v_net := round(v_tip * v_pct / 100.0, 2);
  select tips->>'mode' into v_mode from public.platform_settings where id = 1;
  v_visible := case when v_mode = 'transparent' then round(v_tip, 2) else null end;

  update public.deliveries
  set driver_id = p_driver_id, status = 'assigned', offered_at = v_now,
      offer_expires_at = v_expires, accepted_at = null, driver_earnings = v_earnings,
      net_tip = v_net, tip_visible_total = v_visible,
      dispatch_attempts = coalesce(dispatch_attempts, 0) + 1,
      dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
        || jsonb_build_object('type','offered','manual',true,'driver_id',p_driver_id,'by_user',v_user,'at',v_now)
  where id = p_delivery_id;

  insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
  values (d.branch_id, 'driver', p_driver_id, 'push', 'new_dispatch',
          jsonb_build_object('delivery_id', d.id, 'order_id', d.order_id,
                             'distance_km', d.distance_km, 'earnings', v_earnings,
                             'net_tip', v_net, 'expires_in_seconds', v_ttl, 'manual', true));
end;
$function$;

revoke execute on function public.staff_assign_driver(uuid, uuid) from public, anon;
grant  execute on function public.staff_assign_driver(uuid, uuid) to authenticated;
