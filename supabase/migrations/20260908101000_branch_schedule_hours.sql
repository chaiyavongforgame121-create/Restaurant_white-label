-- Scheduled ordering could not be scoped to the hours a shop actually takes bookings.
--
-- The times a diner may pick came from branch_hours alone: whenever the kitchen is open, it
-- is bookable. A shop open every day that wants pre-orders from 17:00 Monday to Saturday
-- but only 10:00-14:00 on Sunday had no way to say so, and scheduled-orders-card said as
-- much in a comment: "The window a diner may pick inside is NOT configured here."
--
-- Modelled as a TABLE, not a jsonb key on branches.settings, because:
--   * branch_delivery_hours already solved the identical problem (per-weekday windows
--     narrowing a broader open state) with a table, an atomic-replace RPC, a
--     timezone-correct evaluator and a BEFORE INSERT trigger. A second shape for the same
--     problem is how the two drift.
--   * the evaluator runs in a BEFORE INSERT trigger on every order. An index probe over
--     `time` columns beats jsonb_array_elements plus ::time casts on untrusted text, and a
--     bad '25:00' then fails at save time against a constraint instead of at order time.
--   * check (day_of_week between 0 and 6), not null and on delete cascade come free from a
--     table and cannot be had from a jsonb key.
--   * branches.settings is read-modify-written WHOLESALE from the browser by six admin
--     cards with no locking; a 7-day array is the worst available thing to add to that.
-- The ON/OFF switch stays a settings scalar (schedule_hours_enabled), exactly like
-- delivery_hours_enabled, so the feature is a strict no-op for every existing branch and
-- needs no backfill.
--
-- Fail-CLOSED once armed, the opposite of branch_hours: with the switch off, opening hours
-- alone decide; with it on, a day with no window is a day with no bookings. Copying
-- branch_hours' "no rows = always open" rule here would invert the merchant's intent the
-- first time they saved an empty day.
--
-- Everything is evaluated `at time zone b.timezone`, the same expression
-- is_delivery_available uses. A shop in Asia/Bangkok must not have its 17:00 window read as
-- 17:00 UTC, which is midnight where the kitchen is.

create table if not exists public.branch_schedule_hours (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references public.branches(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at    time not null,
  closes_at   time not null,
  created_at  timestamptz not null default now()
);

comment on table public.branch_schedule_hours is
  'Per-weekday windows a diner may SCHEDULE an order inside. Narrows branch_hours, never extends it. Inert unless branches.settings.schedule_hours_enabled is true.';

create index if not exists branch_schedule_hours_branch_day_idx
  on public.branch_schedule_hours (branch_id, day_of_week);

alter table public.branch_schedule_hours enable row level security;

-- Read by anonymous diners: the checkout picker has to know the windows before it can stop
-- offering times outside them.
drop policy if exists branch_schedule_hours_public_read on public.branch_schedule_hours;
create policy branch_schedule_hours_public_read on public.branch_schedule_hours
  for select to anon, authenticated using (true);

-- Capability tier, not the legacy staff_members.role list branch_hours still carries.
drop policy if exists branch_schedule_hours_manage on public.branch_schedule_hours;
create policy branch_schedule_hours_manage on public.branch_schedule_hours
  for all to authenticated
  using (private.staff_has_capability(branch_id, 'branch.settings'))
  with check (private.staff_has_capability(branch_id, 'branch.settings'));

-- Atomic replace, mirroring set_branch_delivery_hours: a half-written week is worse than
-- the old one, and an empty week here means "no bookings at all".
create or replace function public.set_branch_schedule_hours(p_branch_id uuid, p_windows jsonb)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare w jsonb;
begin
  if not private.staff_has_capability(p_branch_id, 'branch.settings') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  delete from public.branch_schedule_hours where branch_id = p_branch_id;

  for w in select * from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) loop
    insert into public.branch_schedule_hours (branch_id, day_of_week, opens_at, closes_at)
    values (p_branch_id, (w->>'day_of_week')::smallint, (w->>'opens_at')::time, (w->>'closes_at')::time);
  end loop;
end $$;

revoke execute on function public.set_branch_schedule_hours(uuid, jsonb) from public, anon;
grant  execute on function public.set_branch_schedule_hours(uuid, jsonb) to authenticated;

-- Is p_at inside a BOOKABLE window? True whenever the feature is off, so it can be ANDed
-- unconditionally. A window whose close is at or before its open crosses midnight and is
-- matched on both sides — the same three clauses as is_branch_open and
-- is_delivery_available, so the three cannot disagree about an overnight service.
--
-- `v_enabled is null` means no such branch: the coalesce inside the select only runs when a
-- row exists, so a missing branch leaves both locals null and we fail closed.
create or replace function public.is_schedule_window_open(p_branch_id uuid, p_at timestamptz default now())
returns boolean language plpgsql stable security definer set search_path to 'public','pg_temp' as $$
declare
  v_enabled boolean;
  v_tz      text;
  v_local   timestamp;
  v_dow     smallint;
  v_time    time;
begin
  select coalesce((b.settings->>'schedule_hours_enabled')::boolean, false), coalesce(b.timezone, 'UTC')
    into v_enabled, v_tz
    from public.branches b where b.id = p_branch_id;

  if v_enabled is null then return false; end if;   -- unknown branch
  if not v_enabled then return true; end if;        -- feature off => opening hours alone decide

  v_local := p_at at time zone v_tz;
  v_dow   := extract(dow from v_local)::smallint;
  v_time  := v_local::time;

  return exists (
    select 1 from public.branch_schedule_hours h
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

-- anon on purpose, like is_delivery_available: the diner asking is not signed in, and the
-- answer is already public information (the windows are readable and printed in checkout).
revoke execute on function public.is_schedule_window_open(uuid, timestamptz) from public;
grant  execute on function public.is_schedule_window_open(uuid, timestamptz) to anon, authenticated;

-- Everything the checkout slot picker needs that storefront_status does not already carry,
-- in one call rather than two round-trips on a screen a diner is waiting on.
--
-- Closures ride along because is_branch_open already refuses an instant inside one while
-- the picker knew nothing about them: a diner could pick a slot on a public holiday, fill
-- in the entire form, and be told 'branch_closed_at_scheduled_time' at submit — the precise
-- failure the slot picker replaced a free-form clock to remove.
--
-- schedule_hours_enabled is returned alongside the windows because the two readings of an
-- empty array are opposites: not armed means "opening hours alone decide", armed means
-- "nothing bookable all week". A client that cannot tell them apart would silently kill
-- scheduling for every branch on the platform.
--
-- Bounded at 400 days: schedule_max_days is capped at 365 by the admin card, and an
-- unbounded list would grow with every holiday the shop has ever recorded.
create or replace function public.branch_schedule_policy(p_branch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce((
    select jsonb_build_object(
      'schedule_hours_enabled', coalesce((b.settings->>'schedule_hours_enabled')::boolean, false),
      'schedule_windows', coalesce((
                            select jsonb_agg(jsonb_build_object(
                                     'day_of_week', h.day_of_week,
                                     'opens_at', to_char(h.opens_at,'HH24:MI'),
                                     'closes_at', to_char(h.closes_at,'HH24:MI'))
                                   order by h.day_of_week, h.opens_at)
                            from public.branch_schedule_hours h where h.branch_id = b.id
                          ), '[]'::jsonb),
      'closures', coalesce((
                    select jsonb_agg(jsonb_build_object(
                             'starts_at', c.starts_at,
                             'ends_at', c.ends_at)
                           order by c.starts_at)
                    from public.branch_closures c
                    where c.branch_id = b.id
                      and c.ends_at > now()
                      and c.starts_at < now() + interval '400 days'
                  ), '[]'::jsonb)
    )
    from public.branches b
    where b.id = p_branch_id
  ), jsonb_build_object('schedule_hours_enabled', false,
                        'schedule_windows', '[]'::jsonb,
                        'closures', '[]'::jsonb));
$$;

revoke execute on function public.branch_schedule_policy(uuid) from public;
grant  execute on function public.branch_schedule_policy(uuid) to anon, authenticated;

-- The gate lives in the DATA, not only in place-order. orders_public_insert lets anon
-- INSERT a pending order into any active branch, and the only BEFORE INSERT triggers today
-- are the billing gate and the delivery-hours gate — so a hand-crafted PostgREST request
-- can already book a pickup for 3am on a day the shop is shut, and only delivery is
-- protected. place-order's is_branch_open call is a courtesy to the UI; this is the rule.
--
-- Scoped to `scheduled_for is not null` deliberately. An ASAP order is judged by place-order
-- at check time and inserted a moment later, so a trigger re-judging now() could reject at a
-- closing-minute boundary and surface as a bare database error. A scheduled order's instant
-- is fixed, so both sides evaluate the SAME p_at and cannot disagree.
create or replace function public.tg_enforce_scheduled_time()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  if new.scheduled_for is null then return new; end if;

  if not public.is_branch_open(new.branch_id, new.scheduled_for) then
    raise exception 'branch_closed_at_scheduled_time' using errcode = 'P0001';
  end if;

  -- Staff surfaces are exempt from the bookable-window rule ONLY. It is a self-service
  -- policy for diners; a manager taking a phone booking at the till IS the override. They
  -- are not exempt from opening hours above, which place-order already enforces for them.
  -- place-order applies the same exemption; if the two diverge, a counter booking passes
  -- there and dies here as an unexplained failure.
  if coalesce(new.source, 'web') in ('counter', 'pos') then return new; end if;

  if not public.is_schedule_window_open(new.branch_id, new.scheduled_for) then
    raise exception 'outside_scheduling_window' using errcode = 'P0001';
  end if;

  return new;
end $$;

revoke execute on function public.tg_enforce_scheduled_time() from public, anon, authenticated;

drop trigger if exists orders_enforce_scheduled_time on public.orders;
create trigger orders_enforce_scheduled_time
  before insert on public.orders
  for each row execute function public.tg_enforce_scheduled_time();
