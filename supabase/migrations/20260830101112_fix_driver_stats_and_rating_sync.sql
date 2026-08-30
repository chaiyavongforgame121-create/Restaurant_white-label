-- Three faults behind "the driver home screen shows the wrong numbers".
--
-- 1. get_my_driver_stats() raised on EVERY call. Its filters read
--    `status in ('picked_up','in_transit','delivered','completed')`, and delivery_status has
--    no 'completed' label — the enum is pending/dispatching/assigned/picked_up/in_transit/
--    delivered/failed/cancelled. Postgres casts an IN list to the column's enum type, so the
--    literal raised invalid_text_representation before a single row was counted. The client
--    does `(d.data as {...} | null)?.total_earnings_usd ?? 0`, which turned a hard failure
--    into a confident $0.
--
-- 2. Earnings were summed from deliveries.driver_earnings, which is base + distance only.
--    Tips live in driver_earnings_ledger.tip_net, and the Earnings and History screens
--    already read that table — so home disagreed with the other two screens by exactly the
--    tips. Measured on live data: one rider's home read $2.00 against a ledger total of
--    $7.00. The ledger is the payout record; it wins.
--
-- 3. "Today" and "This week" were p_days = 1 and 7, i.e. rolling 24h and 168h windows
--    measured in UTC. A delivery at 11pm last night counted as today's, and no boundary
--    ever matched a calendar day the driver would recognise. Both are now real calendar
--    windows in the timezone of the branch the driver last delivered for.
create or replace function public.get_my_driver_stats(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_since timestamptz := now() - (p_days || ' days')::interval;
  v_tz text;
  v_today_start timestamptz;
  v_week_start timestamptz;
  v_assigned int;
  v_accepted int;
  v_completed int;
  v_avg_rating numeric;
  v_rating_count int;
  v_total_earnings numeric;
  v_today_earnings numeric;
  v_week_earnings numeric;
  v_on_time int;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_uid;
  if v_driver_id is null then return jsonb_build_object('error','no_driver_profile'); end if;

  -- The zone the driver actually works in, taken from their most recent job. Nothing on
  -- drivers records a timezone, and a rider's "today" is the store's day, not UTC's.
  select coalesce(b.timezone, 'America/New_York') into v_tz
    from public.deliveries d
    join public.branches b on b.id = d.branch_id
   where d.driver_id = v_driver_id
   order by d.created_at desc
   limit 1;
  v_tz := coalesce(v_tz, 'America/New_York');

  v_today_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_week_start  := date_trunc('week', now() at time zone v_tz) at time zone v_tz;

  select count(*) into v_assigned
    from public.deliveries
    where driver_id = v_driver_id and assigned_at >= v_since;

  -- 'completed' removed: it is not a delivery_status. 'delivered' is the terminal success.
  select count(*) into v_accepted
    from public.deliveries
    where driver_id = v_driver_id and assigned_at >= v_since
      and status in ('picked_up','in_transit','delivered');

  select count(*) into v_completed
    from public.deliveries
    where driver_id = v_driver_id and assigned_at >= v_since
      and status = 'delivered';

  select avg(delivery_stars)::numeric, count(delivery_stars)
    into v_avg_rating, v_rating_count
    from public.order_ratings
    where driver_id = v_driver_id;

  -- Ledger, not deliveries: it is the payout record and it includes tip_net.
  select coalesce(sum(total), 0) into v_total_earnings
    from public.driver_earnings_ledger
    where driver_id = v_driver_id
      and coalesce(delivered_at, created_at) >= v_since;

  select coalesce(sum(total), 0) into v_today_earnings
    from public.driver_earnings_ledger
    where driver_id = v_driver_id
      and coalesce(delivered_at, created_at) >= v_today_start;

  select coalesce(sum(total), 0) into v_week_earnings
    from public.driver_earnings_ledger
    where driver_id = v_driver_id
      and coalesce(delivered_at, created_at) >= v_week_start;

  select count(*) into v_on_time
    from public.deliveries
    where driver_id = v_driver_id and delivered_at is not null and assigned_at >= v_since
      and extract(epoch from (delivered_at - assigned_at)) / 60 <= 45;

  return jsonb_build_object(
    'days', p_days,
    'timezone', v_tz,
    'assigned', coalesce(v_assigned, 0),
    'accepted', coalesce(v_accepted, 0),
    'completed', coalesce(v_completed, 0),
    'acceptance_rate', case when v_assigned > 0 then round((v_accepted::numeric / v_assigned) * 100, 1) else null end,
    'on_time_rate', case when v_completed > 0 then round((v_on_time::numeric / v_completed) * 100, 1) else null end,
    -- Lifetime, matching drivers.average_rating, so the home tile and the profile agree.
    'avg_rating', coalesce(round(v_avg_rating, 2), null),
    'rating_count', coalesce(v_rating_count, 0),
    'total_earnings_usd', round(coalesce(v_total_earnings, 0), 2),
    'today_earnings_usd', round(coalesce(v_today_earnings, 0), 2),
    'week_earnings_usd', round(coalesce(v_week_earnings, 0), 2)
  );
end;
$function$;

revoke execute on function public.get_my_driver_stats(integer) from public;
grant execute on function public.get_my_driver_stats(integer) to authenticated;

-- drivers.average_rating and total_deliveries were never written from anything. The customer
-- already rates the rider (order_ratings.delivery_stars, captured whenever the order had a
-- driver) but the number went into that table and stopped there, so every rider's profile
-- read as unrated no matter how many stars they had collected.
create or replace function private.sync_driver_rating()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_driver uuid := coalesce(new.driver_id, old.driver_id);
begin
  if v_driver is null then return null; end if;
  update public.drivers d
     set average_rating = (
           select round(avg(r.delivery_stars)::numeric, 2)
             from public.order_ratings r
            where r.driver_id = v_driver and r.delivery_stars is not null
         )
   where d.id = v_driver;
  return null;
end;
$function$;

drop trigger if exists order_ratings_sync_driver on public.order_ratings;
create trigger order_ratings_sync_driver
after insert or update or delete on public.order_ratings
for each row execute function private.sync_driver_rating();

-- Completed-delivery count, same story: displayed on the rider profile, never maintained.
create or replace function private.sync_driver_delivery_count()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.driver_id is null or new.status is not distinct from old.status then return null; end if;
  if new.status = 'delivered' then
    update public.drivers d
       set total_deliveries = (
             select count(*) from public.deliveries dl
              where dl.driver_id = new.driver_id and dl.status = 'delivered'
           )
     where d.id = new.driver_id;
  end if;
  return null;
end;
$function$;

drop trigger if exists deliveries_sync_driver_count on public.deliveries;
create trigger deliveries_sync_driver_count
after update of status on public.deliveries
for each row execute function private.sync_driver_delivery_count();

revoke execute on function private.sync_driver_rating() from public, anon;
revoke execute on function private.sync_driver_delivery_count() from public, anon;

-- Backfill both, so existing riders stop reading as brand new.
update public.drivers d
   set average_rating = sub.avg_stars,
       total_deliveries = coalesce(sub.n_delivered, d.total_deliveries)
  from (
    select dr.id,
           (select round(avg(r.delivery_stars)::numeric, 2) from public.order_ratings r
             where r.driver_id = dr.id and r.delivery_stars is not null) as avg_stars,
           (select count(*) from public.deliveries dl
             where dl.driver_id = dr.id and dl.status = 'delivered')     as n_delivered
      from public.drivers dr
  ) sub
 where d.id = sub.id;
