-- 1. DELIVERY HOURS, separate from opening hours. branch_hours answers one
--    open/closed question for delivery, pickup and dine-in alike, so a kitchen open
--    09:00-22:00 that only wants to run deliveries 11:00-14:00 and 17:00-20:00 had no
--    way to say so, and the diner had no way to see it.
-- 2. Groundwork for SELF-DELIVERY (see the next migration).
--
-- Deliberately fail-CLOSED, unlike branch_hours (zero rows there means "always open").
-- Delivery hours only apply once the merchant turns them on, and once on, a window
-- must exist for the day or delivery is closed.

create table if not exists public.branch_delivery_hours (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references public.branches(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at    time not null,
  closes_at   time not null,
  created_at  timestamptz not null default now()
);

create index if not exists branch_delivery_hours_branch_day_idx
  on public.branch_delivery_hours (branch_id, day_of_week);

alter table public.branch_delivery_hours enable row level security;

drop policy if exists branch_delivery_hours_public_read on public.branch_delivery_hours;
create policy branch_delivery_hours_public_read on public.branch_delivery_hours
  for select to anon, authenticated using (true);

drop policy if exists branch_delivery_hours_manage on public.branch_delivery_hours;
create policy branch_delivery_hours_manage on public.branch_delivery_hours
  for all to authenticated
  using (private.staff_has_capability(branch_id, 'branch.settings'))
  with check (private.staff_has_capability(branch_id, 'branch.settings'));

-- Atomic replace, mirroring set_branch_hours: a half-written week is worse than the old one.
create or replace function public.set_branch_delivery_hours(p_branch_id uuid, p_windows jsonb)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare w jsonb;
begin
  if not private.staff_has_capability(p_branch_id, 'branch.settings') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  delete from public.branch_delivery_hours where branch_id = p_branch_id;

  for w in select * from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) loop
    insert into public.branch_delivery_hours (branch_id, day_of_week, opens_at, closes_at)
    values (p_branch_id, (w->>'day_of_week')::smallint, (w->>'opens_at')::time, (w->>'closes_at')::time);
  end loop;
end $$;

revoke execute on function public.set_branch_delivery_hours(uuid, jsonb) from anon;
grant execute on function public.set_branch_delivery_hours(uuid, jsonb) to authenticated;

-- Evaluated in the BRANCH's timezone, the same way is_branch_open does it: a New York
-- merchant on a UTC host would otherwise see their evening window roll over mid-service.
-- A window whose close <= open crosses midnight and is matched on both sides.
create or replace function public.is_delivery_available(p_branch_id uuid, p_at timestamptz default now())
returns boolean language plpgsql stable security definer set search_path to 'public','pg_temp' as $$
declare
  v_enabled boolean;
  v_tz      text;
  v_local   timestamp;
  v_dow     smallint;
  v_time    time;
begin
  select coalesce((b.settings->>'delivery_hours_enabled')::boolean, false), coalesce(b.timezone, 'UTC')
    into v_enabled, v_tz
    from public.branches b where b.id = p_branch_id;

  if v_enabled is null then return false; end if;   -- unknown branch
  if not v_enabled then return true; end if;        -- feature off => opening hours alone decide

  v_local := p_at at time zone v_tz;
  v_dow   := extract(dow from v_local)::smallint;
  v_time  := v_local::time;

  return exists (
    select 1 from public.branch_delivery_hours h
     where h.branch_id = p_branch_id
       and (
         (h.closes_at > h.opens_at and h.day_of_week = v_dow
          and v_time >= h.opens_at and v_time < h.closes_at)
         or (h.closes_at <= h.opens_at and h.day_of_week = v_dow and v_time >= h.opens_at)
         or (h.closes_at <= h.opens_at and h.day_of_week = ((v_dow + 6) % 7)::smallint
             and v_time < h.closes_at)
       )
  );
end $$;

grant execute on function public.is_delivery_available(uuid, timestamptz) to anon, authenticated;

-- The gate lives in the data, not in place-order: an edge function is not the only
-- possible writer of orders, and a rule that has to be redeployed to stay true is how
-- the two drift apart.
create or replace function public.tg_enforce_delivery_hours()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  if new.channel <> 'delivery' then return new; end if;
  -- Judged against the time the food is WANTED, not the time the order was typed.
  if not public.is_delivery_available(new.branch_id, coalesce(new.scheduled_for, now())) then
    raise exception 'delivery_not_available_at_that_time' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists orders_enforce_delivery_hours on public.orders;
create trigger orders_enforce_delivery_hours
  before insert on public.orders
  for each row execute function public.tg_enforce_delivery_hours();
