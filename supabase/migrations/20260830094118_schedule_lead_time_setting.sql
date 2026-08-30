-- Separate "how long before a booking should the kitchen see it" from "how long a dish
-- takes", which were the same number.
--
-- settings.prep_time_min is labelled to the merchant as "Baseline kitchen time used in
-- customer ETAs", and it was ALSO the release offset here. So a merchant tuning the ETA
-- shown at checkout silently moved when tomorrow's pre-orders hit the kitchen, and vice
-- versa. They are not the same quantity: a catering tray needs a day of lead time and still
-- quotes a 20-minute ETA.
--
-- settings.schedule_lead_time_min is the new, dedicated value. It falls back to
-- prep_time_min, so every existing branch keeps exactly today's behaviour until someone
-- sets it.
create or replace function private.release_scheduled_orders()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
begin
  for r in
    select o.id, o.branch_id, o.order_number, o.scheduled_for
    from public.orders o
    join public.branches b on b.id = o.branch_id
    where o.held = true
      and o.scheduled_for is not null
      and o.scheduled_for - make_interval(mins => coalesce(
            (b.settings->>'schedule_lead_time_min')::int,
            (b.settings->>'prep_time_min')::int,
            15)) <= now()
    for update of o skip locked
  loop
    update public.orders set held = false where id = r.id;
    insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
    values (r.branch_id, 'staff', r.branch_id, 'in_app', 'order_released',
            jsonb_build_object('order_id', r.id, 'order_number', r.order_number, 'scheduled_for', r.scheduled_for));
  end loop;
end;
$function$;

revoke execute on function private.release_scheduled_orders() from public, anon;
