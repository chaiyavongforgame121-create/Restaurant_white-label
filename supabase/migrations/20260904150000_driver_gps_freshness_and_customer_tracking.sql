-- The rider's pin: what it means, how long it survives its rider, and who gets to read it.
--
-- Three defects, all of them visible on the live project on 2026-09-04:
--
-- 1. A delivery kept the LAST rider's position for ever. reject_dispatch,
--    driver_cancel_delivery, requeue_failed_delivery, private.expire_dispatch_offers,
--    accept_dispatch and dispatch-driver's own offer UPDATE all clear driver_id and the
--    offer columns and nothing else. Row 678d139d-1e8c-400a-9dd4-da5630448a7f sat in
--    'dispatching' with driver_id null, a pin at 30.1567,-95.4889 and arriving_at stamped;
--    row 51ea0349… sat in 'dispatching' with current_eta_min 37104. The diner then saw the
--    previous rider's pin — and "Arriving now" — the moment the next rider accepted, and the
--    merchant's live board drew a puck for a delivery nobody was carrying.
--
-- 2. current_eta_min measured the CURRENT LEG. While the rider was still riding to the
--    restaurant that is time-to-restaurant, and the customer's page printed it as an ETA:
--    it read 3 minutes, then jumped to 18 the moment the food was collected. Stop 2 of a
--    stacked trip was measured to its own door while the rider was driving to stop 1. And
--    nothing clamped it, which is where 37104 minutes came from — a test rider in Bangkok
--    against a Texas branch, straight-line at 24 km/h.
--
-- 3. deliveries_customer_read is row-level and granted to PUBLIC, so the diner's page could
--    read every column of the row: driver_earnings, net_tip, tip_visible_total,
--    dispatch_history, pickup_photo_url, failed_reason. This codebase goes to lengths in the
--    other direction (get_driver_order exists so a rider cannot see the restaurant's tip
--    cut); the same care had never been applied here.
--
-- On (3), what this migration can and cannot do. Column privileges in Postgres are per-ROLE,
-- and staff, riders and diners all arrive as `authenticated` — the admin board and the rider
-- app select driver_earnings from this same table. So revoking those columns is not
-- available, and neither is narrowing the postgres_changes payload, which Realtime builds
-- from exactly those role-level column privileges. What lands here is the honest half: the
-- policy is scoped to `authenticated` instead of PUBLIC, and public.delivery_customer_tracking
-- is the column-narrow surface the tracking page reads through. The customer's realtime
-- subscription keeps its `order_id=eq.<uuid>` filter on public.deliveries and still receives
-- the whole row on the wire; closing that needs either a customer-facing mirror table in the
-- publication or Realtime broadcast-from-database, both of which change every reader of
-- deliveries and belong in their own change.

-- 1. A delivery's position belongs to its rider ---------------------------------------------
-- One BEFORE UPDATE trigger on driver_id covers every writer, present and future — cheaper
-- than patching six functions and an edge function, and it cannot be forgotten by the
-- seventh. When a rider is put ON the row, the pin is seeded from drivers.current_location
-- if that fix is fresh, so the diner has a position at acceptance instead of staring at an
-- empty map until the next heartbeat.
--
-- Self-delivery (20260827203151) never sets driver_id, so it is untouched. accept_dispatch
-- does not write driver_id either, so acceptance keeps the seeded pin.
create or replace function private.clear_driver_position_on_reassign()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  if tg_op <> 'UPDATE' or new.driver_id is not distinct from old.driver_id then
    return new;
  end if;

  new.driver_lat := null;
  new.driver_lng := null;
  new.driver_location_updated_at := null;
  new.current_eta_min := null;
  -- arriving_at is one-shot per rider: clearing it is what lets the NEXT rider's 300 m
  -- geofence stamp it again (and send the 'order_arriving' push once per rider, not once
  -- per delivery).
  new.arriving_at := null;

  if new.driver_id is not null then
    select st_y(d.current_location::geometry),
           st_x(d.current_location::geometry),
           d.location_updated_at
      into new.driver_lat, new.driver_lng, new.driver_location_updated_at
      from public.drivers d
     where d.id = new.driver_id
       and d.current_location is not null
       and d.location_updated_at > now() - interval '5 minutes';
  end if;

  return new;
end;
$function$;

revoke execute on function private.clear_driver_position_on_reassign() from public, anon, authenticated;

drop trigger if exists deliveries_clear_driver_position on public.deliveries;
create trigger deliveries_clear_driver_position
  before update of driver_id on public.deliveries
  for each row execute function private.clear_driver_position_on_reassign();

-- Rows already stranded by the old behaviour (678d139d… and 51ea0349… among them).
update public.deliveries
   set driver_lat = null,
       driver_lng = null,
       driver_location_updated_at = null,
       current_eta_min = null,
       arriving_at = null
 where driver_id is null
   and status in ('pending', 'dispatching', 'failed')
   and (driver_lat is not null
        or driver_lng is not null
        or current_eta_min is not null
        or arriving_at is not null);

-- 2. current_eta_min means "minutes until it reaches the customer" ---------------------------
-- Same signature, same grants, same auth checks, same 300 m arrival geofence as the function
-- this replaces (which pre-dates the repo). Only the ETA arithmetic changes:
--   * riding to the restaurant  -> rider→restaurant + restaurant→door + one handover
--   * stop 2 of a stacked trip  -> rider→stop 1's door + stop 1→stop 2 + one handover
--   * otherwise                 -> the leg in front of them, as before
-- and every result is clamped to 1..600 minutes so no screen can print a four-figure ETA.
--
-- Both the merchant board and the 'driver_assigned' push read this column and both label it
-- as the customer's wait, so their numbers become larger — and true — while a rider is still
-- on their way to collect.

-- A four-figure ETA is never information, so the clamp lives next to the arithmetic rather
-- than in each of the three screens that print it. NULL in, NULL out: a delivery with no
-- coordinates has no ETA, and greatest(1, null) would have quietly called that one minute.
create or replace function private.clamp_eta_min(p_minutes double precision)
returns integer
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case
           when p_minutes is null then null
           else least(600, greatest(1, ceil(p_minutes)))::int
         end;
$function$;

revoke execute on function private.clamp_eta_min(double precision) from public, anon, authenticated;

create or replace function public.set_driver_location(
  p_driver_id uuid,
  p_lng double precision,
  p_lat double precision,
  p_battery integer default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
  v_point geography;
  -- The same flat heuristic the function has always used: no traffic model, no road network.
  v_speed_kmh constant double precision := 24;
  -- Parking, walking to the counter, waiting for the bag, finding the door.
  v_handover_min constant double precision := 4;
begin
  if v_user_id is null then
    raise exception 'auth_required';
  end if;

  select user_id into v_owner_id from public.drivers where id = p_driver_id;
  if v_owner_id is null then
    raise exception 'driver_not_found';
  end if;
  if v_owner_id <> v_user_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  v_point := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;

  update public.drivers
     set current_location = v_point,
         location_updated_at = now(),
         battery_level = coalesce(p_battery, battery_level)
   where id = p_driver_id;

  update public.deliveries d
     set driver_lat = p_lat,
         driver_lng = p_lng,
         driver_location_updated_at = now(),
         current_eta_min = private.clamp_eta_min(
           case
             -- Still riding to the restaurant: the diner's wait is both legs.
             when d.status = 'assigned'
                  and d.pickup_location is not null
                  and d.delivery_location is not null
               then (st_distance(v_point, d.pickup_location)
                     + st_distance(d.pickup_location, d.delivery_location))
                    / 1000.0 / v_speed_kmh * 60.0 + v_handover_min
             -- Stop 2 of a stacked trip, stop 1 still on board: measured via stop 1's door,
             -- because that is the order the rider actually drives them in. The exists()
             -- guard keeps solo jobs — nearly all of them — out of the subquery entirely.
             when d.batch_seq = 2
                  and d.status in ('picked_up', 'in_transit')
                  and d.delivery_location is not null
                  and exists (
                    select 1 from public.deliveries m
                     where m.batch_id = d.batch_id
                       and m.batch_seq = 1
                       and m.id <> d.id
                       and m.status in ('picked_up', 'in_transit')
                       and m.delivery_location is not null)
               then (select (st_distance(v_point, m.delivery_location)
                             + st_distance(m.delivery_location, d.delivery_location))
                            / 1000.0 / v_speed_kmh * 60.0 + v_handover_min
                       from public.deliveries m
                      where m.batch_id = d.batch_id
                        and m.batch_seq = 1
                        and m.id <> d.id
                        and m.status in ('picked_up', 'in_transit')
                        and m.delivery_location is not null
                      limit 1)
             -- Carrying it: straight to the door.
             when d.status in ('picked_up', 'in_transit')
                  and d.delivery_location is not null
               then st_distance(v_point, d.delivery_location) / 1000.0 / v_speed_kmh * 60.0
             when coalesce(d.pickup_location, d.delivery_location) is not null
               then st_distance(v_point, coalesce(d.pickup_location, d.delivery_location))
                    / 1000.0 / v_speed_kmh * 60.0
             else null
           end
         ),
         arriving_at = case
           when d.arriving_at is null
                and d.status = 'in_transit'
                and d.delivery_location is not null
                and st_dwithin(v_point, d.delivery_location, 300)
             then now()
           else d.arriving_at
         end
   where d.driver_id = p_driver_id
     and d.status in ('assigned', 'picked_up', 'in_transit');
end;
$function$;

revoke execute on function public.set_driver_location(uuid, double precision, double precision, integer)
  from public, anon;
grant  execute on function public.set_driver_location(uuid, double precision, double precision, integer)
  to authenticated;

-- 3. The diner's read of a delivery ----------------------------------------------------------
-- Same predicate as before (their own orders), but scoped to authenticated: the storefront
-- has been login-gated since f16f317, so nothing anonymous has any business here.
drop policy if exists deliveries_customer_read on public.deliveries;
create policy deliveries_customer_read on public.deliveries
  for select to authenticated
  using (order_id in (select private.order_ids_for_customer()));

-- The column-narrow surface the tracking page reads through. security_invoker keeps the
-- policy above in charge of WHICH rows — this view only decides which columns exist, so a
-- future `select *` on the diner's path cannot quietly widen into the rider's pay. The
-- coordinates are additionally gated on driver_id so a row mid-reassignment shows no pin
-- even if something writes one back.
create or replace view public.delivery_customer_tracking
with (security_invoker = true, security_barrier = true) as
select d.id,
       d.order_id,
       d.status,
       d.driver_id,
       d.assigned_at,
       d.accepted_at,
       d.picked_up_at,
       d.delivered_at,
       d.distance_km,
       d.estimated_duration_min,
       d.batch_seq,
       d.dropoff_lat,
       d.dropoff_lng,
       case when d.driver_id is null then null else d.driver_lat end                    as driver_lat,
       case when d.driver_id is null then null else d.driver_lng end                    as driver_lng,
       case when d.driver_id is null then null else d.driver_location_updated_at end    as driver_location_updated_at,
       case when d.driver_id is null then null else d.current_eta_min end               as current_eta_min,
       case when d.driver_id is null then null else d.arriving_at end                   as arriving_at
  from public.deliveries d;

revoke all on public.delivery_customer_tracking from public, anon;
grant select on public.delivery_customer_tracking to authenticated;

comment on view public.delivery_customer_tracking is
  'Order-tracking columns only. The diner never needs driver_earnings, net_tip, tip_visible_total, dispatch_history, pickup_photo_url or failed_reason; realtime still delivers the full deliveries row because Realtime filters columns by role privilege and staff share the authenticated role.';
