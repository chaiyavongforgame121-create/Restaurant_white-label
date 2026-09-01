-- The 0.2 mi arrival gate needs an escape hatch, and the escape hatch needs a record.
--
-- The gate blocks "I'm at the restaurant" and "I've arrived" until the rider is within
-- ARRIVAL_RADIUS_MI. That is right for the normal case and wrong for two real ones: GPS
-- that never resolves (indoors, an urban canyon, a denied permission) and a branch whose
-- pin is off. Blocking a rider who is genuinely standing at the counter, with no way past
-- it, strands the job and the customer's food with it.
--
-- So the override exists — but silently allowing "delivered" from anywhere would remove the
-- only thing the gate was protecting. Every use is appended to the delivery's own event log,
-- with the distance at the moment it was used, so a merchant can see it.
create or replace function public.record_arrival_override(
  p_delivery_id uuid,
  p_stage text,
  p_miles numeric default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_driver uuid;
begin
  select driver_id into v_driver from public.deliveries where id = p_delivery_id;
  if v_driver is null or v_driver is distinct from private.driver_id_for_user() then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  update public.deliveries
     set dispatch_history = coalesce(dispatch_history, '[]'::jsonb) || jsonb_build_object(
           'type', 'arrival_override',
           'stage', p_stage,
           -- null means "no fix at all", which is a different story from "0.4 mi away".
           'miles_away', p_miles,
           'at', now()
         )
   where id = p_delivery_id;
end;
$function$;

revoke execute on function public.record_arrival_override(uuid, text, numeric) from public, anon;
grant execute on function public.record_arrival_override(uuid, text, numeric) to authenticated;
