-- "No rider found" with riders demonstrably online. Three faults, compounding.
--
-- 1. Going online corrupted the GPS timestamp.
--    driver_set_branch_online and driver_set_all_branches_online both did
--    `location_updated_at = now()`, under a comment reading "Derived mirror (ping/stats
--    only; not a dispatch gate)". It IS a dispatch gate: find_dispatch_candidates requires
--    location_updated_at > now() - 5 minutes as its stale-GPS guard. So the column meant
--    "last time the rider touched anything", while the only reader treated it as "last GPS
--    fix". Live proof: +11234567890 had location_updated_at 5 minutes old and
--    current_location NULL — they had tapped Go online, never shared a position.
--
-- 2. The freshness window was a hardcoded 5 minutes.
--    The rider app only pings while the app is open, online, and GPS is granted. Lock the
--    phone and the rider is undispatchable within five minutes while every screen still
--    shows them online. The owner already widens driver_search_radius_km and
--    driver_max_attempts for testing; this belongs in the same place.
--
-- 3. The refusal explained nothing.
--    dispatch-driver returned `no_drivers_available` and the kitchen rendered "No rider
--    found — tap to retry", which is indistinguishable from "nobody is working today". The
--    new diagnostic says which gate emptied the list. Measured on the live branch at the
--    time of the report: approved 7, online 5, kyc 5, not busy 5 — and gps_fresh 0.

-- location_updated_at is a GPS-fix timestamp. Nothing but a GPS fix may set it.
create or replace function public.driver_set_branch_online(p_branch_id uuid, p_online boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_driver uuid;
  v_cooldown timestamptz;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select id, cooldown_until into v_driver, v_cooldown from public.drivers where user_id = v_user;
  if v_driver is null then raise exception 'driver_not_found'; end if;
  if not exists (
    select 1 from public.driver_approvals
    where driver_id = v_driver and branch_id = p_branch_id and status = 'approved'
  ) then raise exception 'not_approved'; end if;
  if p_online and v_cooldown is not null and v_cooldown > now() then raise exception 'cooldown_active'; end if;

  insert into public.driver_branch_availability (driver_id, branch_id, is_online, mode, updated_at)
  values (v_driver, p_branch_id, p_online, 'manual', now())
  on conflict (driver_id, branch_id) do update
    set is_online = excluded.is_online, mode = 'manual', updated_at = now();

  -- Derived mirror. location_updated_at is NOT touched here: it is the age of the last GPS
  -- fix and find_dispatch_candidates gates on it.
  update public.drivers
    set is_online = exists(select 1 from public.driver_branch_availability where driver_id = v_driver and is_online)
  where id = v_driver;

  return jsonb_build_object('branch_id', p_branch_id, 'is_online', p_online);
end;
$function$;

create or replace function public.driver_set_all_branches_online(p_online boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_driver uuid;
  v_cooldown timestamptz;
  v_count int;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select id, cooldown_until into v_driver, v_cooldown from public.drivers where user_id = v_user;
  if v_driver is null then raise exception 'driver_not_found'; end if;
  if p_online and v_cooldown is not null and v_cooldown > now() then raise exception 'cooldown_active'; end if;

  insert into public.driver_branch_availability (driver_id, branch_id, is_online, mode, updated_at)
  select v_driver, da.branch_id, p_online, 'manual', now()
    from public.driver_approvals da
   where da.driver_id = v_driver and da.status = 'approved'
  on conflict (driver_id, branch_id) do update
    set is_online = excluded.is_online, mode = 'manual', updated_at = now();
  get diagnostics v_count = row_count;

  -- Same rule as driver_set_branch_online: the GPS timestamp is left alone.
  update public.drivers
    set is_online = exists(select 1 from public.driver_branch_availability where driver_id = v_driver and is_online)
  where id = v_driver;

  return jsonb_build_object('branches', v_count, 'is_online', p_online);
end;
$function$;

-- Per-branch stale-GPS window, defaulting to the 5 minutes that was hardcoded.
create or replace function public.find_dispatch_candidates(p_branch_id uuid, p_radius_km numeric default 3, p_exclude uuid[] default '{}'::uuid[])
returns table(driver_id uuid, distance_km numeric, score numeric)
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  select
    d.id as driver_id,
    round((ST_Distance(d.current_location, b.geo_location) / 1000)::numeric, 2) as distance_km,
    round((
      (ST_Distance(d.current_location, b.geo_location) / 1000.0)
      + d.reject_streak * 0.5
      - coalesce(d.average_rating, 4.5) * 0.3
    )::numeric, 3) as score
  from public.drivers d
  join public.driver_approvals da on da.driver_id = d.id and da.branch_id = p_branch_id
  join public.driver_branch_availability dba
    on dba.driver_id = d.id and dba.branch_id = p_branch_id
  join public.branches b on b.id = p_branch_id
  where dba.is_online = true
    and d.kyc_status = 'verified'
    and da.status = 'approved'
    and (d.cooldown_until is null or d.cooldown_until < now())
    and d.current_location is not null
    and d.location_updated_at is not null
    -- Was a hardcoded 5 minutes. Configurable so a branch can widen it while testing, or
    -- tighten it once riders are reliably pinging.
    and d.location_updated_at > now() - make_interval(mins => greatest(1, coalesce(
          (b.settings->>'dispatch_max_gps_age_min')::int, 5)))
    and b.geo_location is not null
    and ST_DWithin(d.current_location, b.geo_location, (p_radius_km * 1000)::float)
    and not (d.id = any(coalesce(p_exclude, '{}'::uuid[])))
    and not exists (
      select 1 from public.deliveries del
      where del.driver_id = d.id
        and del.status in ('assigned','picked_up','in_transit')
    )
  order by score asc
  limit 10;
$function$;

-- Why the candidate list came back empty, gate by gate. "No rider found" on its own is
-- indistinguishable from "nobody is working", and sends the merchant looking in the wrong
-- place.
create or replace function public.dispatch_candidate_diagnostics(p_branch_id uuid, p_radius_km numeric default 3)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  with b as (
    select id, geo_location,
           greatest(1, coalesce((settings->>'dispatch_max_gps_age_min')::int, 5)) as max_age_min
    from public.branches where id = p_branch_id
  ),
  approved as (
    select d.*
    from public.drivers d
    join public.driver_approvals da on da.driver_id = d.id and da.branch_id = p_branch_id and da.status = 'approved'
  ),
  online as (
    select a.* from approved a
    join public.driver_branch_availability dba
      on dba.driver_id = a.id and dba.branch_id = p_branch_id and dba.is_online
  )
  select jsonb_build_object(
    'branch_has_pin',   (select geo_location is not null from b),
    'max_gps_age_min',  (select max_age_min from b),
    'radius_km',        p_radius_km,
    'approved',         (select count(*) from approved),
    'online',           (select count(*) from online),
    'kyc_verified',     (select count(*) from online where kyc_status = 'verified'),
    'not_cooling_down', (select count(*) from online where cooldown_until is null or cooldown_until < now()),
    'has_location',     (select count(*) from online where current_location is not null),
    'gps_fresh',        (select count(*) from online, b
                          where current_location is not null
                            and location_updated_at is not null
                            and location_updated_at > now() - make_interval(mins => b.max_age_min)),
    'in_radius',        (select count(*) from online, b
                          where current_location is not null and b.geo_location is not null
                            and ST_DWithin(current_location, b.geo_location, (p_radius_km * 1000)::float)),
    'not_busy',         (select count(*) from online o
                          where not exists (select 1 from public.deliveries del
                                             where del.driver_id = o.id
                                               and del.status in ('assigned','picked_up','in_transit')))
  );
$function$;

revoke execute on function public.dispatch_candidate_diagnostics(uuid, numeric) from public, anon;
grant execute on function public.dispatch_candidate_diagnostics(uuid, numeric) to authenticated, service_role;
revoke execute on function public.find_dispatch_candidates(uuid, numeric, uuid[]) from public, anon;
grant execute on function public.find_dispatch_candidates(uuid, numeric, uuid[]) to authenticated, service_role;
