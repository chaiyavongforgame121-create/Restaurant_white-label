-- Delivery hours outside opening hours (the owner's report of 2026-11-16, from the merchant of the
-- branch "Thai Burrito", America/Chicago). The shop is open 09:00-17:30 every day and wants diners to
-- order delivery only 08:00-09:00 and 18:00-19:00. Neither "Limit delivery to set hours"
-- (settings.delivery_hours_enabled + branch_delivery_hours) nor "Limit the times customers can book"
-- (settings.schedule_hours_enabled + branch_schedule_hours) could say so, and nothing could be
-- ordered: every check started from opening hours (public.is_branch_open) and only narrowed from
-- there, so windows outside opening hours left nothing. A delivery booked for 08:30 was refused by
-- place-order and by tg_enforce_scheduled_time (branch_closed_at_scheduled_time).
--
-- THE RULE (decided 2026-11-16):
--   R1  Pickup, dine-in and every channel but delivery: opening hours decide (is_branch_open), as
--       before.
--   R2  Delivery while "Limit delivery to set hours" is on: allowed at T when the branch exists, is
--       active and not paused (settings.orders_paused), no branch_closures row covers T, and T is
--       inside a delivery window (public.is_delivery_available, overnight windows included, in the
--       branch's zone). Opening hours do not apply: the delivery windows are delivery's own hours
--       and may lie before opening or after closing.
--   R3  Delivery while it is off: opening hours decide, exactly as for pickup.
--   R4  A booked delivery (scheduled_for set) is judged by R2/R3 at scheduled_for; a diner's (web)
--       booking also by the booking windows when those are on (is_schedule_window_open, unchanged),
--       plus place-order's lead time and horizon, unchanged.
--   R5  An ASAP delivery is judged by R2/R3 at now(), plus "Accept ASAP delivery orders"
--       (settings.asap_delivery_enabled, read by place-order), unchanged.
--
-- 1. public.is_branch_open_for(p_branch_id, p_channel, p_at default now()) -> boolean (new) is THE
--    judge of R1-R3. R2 when p_channel is 'delivery' and the branch's delivery_hours_enabled is true
--    (read as is_delivery_available reads it); otherwise exactly is_branch_open(p_branch_id, p_at).
--    The R2 branch reuses is_branch_open's own expressions for the pause and the closures, so a
--    paused, closed or hidden branch takes no delivery either way. An unknown branch is false.
--    Grants: exactly is_branch_open's, copied from its ACL (the diner's checkout, the admin and
--    place-order call one where they called the other).
--
-- 2. public.tg_enforce_scheduled_time() is re-created from its live definition (pg_get_functiondef,
--    2026-11-16) with one change: is_branch_open(new.branch_id, new.scheduled_for) becomes
--    is_branch_open_for(new.branch_id, new.channel::text, new.scheduled_for). The error codes, the
--    staff (counter, pos) exemption from the booking windows and the grants are as live.
--
-- 3. public.storefront_status(uuid) is re-created from its live definition (same day) with one key
--    added, in the answer and in the fallback for an unknown branch:
--      delivery_open_now  can a diner order delivery right now: entitled to delivery and
--                         is_branch_open_for(branch, 'delivery', now()).
--    Every other key is as live. 'delivery' keeps its meaning (entitled and inside a delivery window
--    now, opening hours aside), because the deployed storefront reads it.
--
-- 4. LEFT AS THEY ARE: tg_enforce_delivery_hours already judges only the delivery windows (at the
--    time the food is wanted, and true while delivery hours are off), which is R2's window half;
--    is_delivery_available, is_branch_open and is_schedule_window_open answer the questions they
--    always answered and are what the new function and the trigger call; release_scheduled_orders
--    lets a held booking out at its kitchen time and asks no open question, as the booking was
--    judged when it was placed.
--
-- No branch changes behaviour at deploy. Read live on 2026-11-16: no branch has
-- delivery_hours_enabled true, so every branch is R1/R3 today, which is what it was; only Thai
-- Burrito has delivery or booking windows outside its opening hours.
--
-- Deploy: this migration first, then place-order (it asks is_branch_open_for for the channel and
-- the time it is about to insert, instead of is_branch_open), then web and admin (they read
-- delivery_open_now and build slots with deliveryRangesForDay / effectiveBookableRanges from
-- packages/shared). An older place-order still asks is_branch_open first, so it refuses what it
-- refused before; an older web or admin ignores the new key.
--
-- Rolled-back checks: supabase/tests/delivery_hours_outside_opening.sql.

begin;

create or replace function public.is_branch_open_for(p_branch_id uuid, p_channel text, p_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_delivery_hours boolean;
begin
  if p_channel = 'delivery' then
    -- is_delivery_available's reading of the switch. No row (an unknown branch) leaves it null,
    -- and is_branch_open below answers false for it.
    select coalesce((b.settings->>'delivery_hours_enabled')::boolean, false)
      into v_delivery_hours
      from public.branches b
     where b.id = p_branch_id;

    if v_delivery_hours then
      -- R2: the delivery windows are delivery's own hours, so opening hours are not asked. A
      -- hidden or paused branch, or a closure, still stops it, with is_branch_open's expressions.
      return exists (select 1 from public.branches b
                      where b.id = p_branch_id
                        and b.is_active
                        and not coalesce((b.settings->>'orders_paused')::boolean, false))
         and not exists (select 1 from public.branch_closures
                          where branch_id = p_branch_id
                            and p_at between starts_at and ends_at)
         and public.is_delivery_available(p_branch_id, p_at);
    end if;
  end if;

  -- R1 and R3: opening hours decide.
  return public.is_branch_open(p_branch_id, p_at);
end $function$;

comment on function public.is_branch_open_for(uuid, text, timestamptz) is
  'Can an order on p_channel be placed for p_at? Delivery while "Limit delivery to set hours" (settings.delivery_hours_enabled) is on: the branch is active and not paused, no closure covers p_at, and p_at is inside a delivery window (is_delivery_available); opening hours do not apply. Every other case: is_branch_open(p_branch_id, p_at). An unknown branch is false.';

-- Exactly is_branch_open's grants, copied from its ACL rather than restated, so the two cannot
-- differ: everything the new function was created with goes first, then each role is_branch_open
-- grants EXECUTE to (PUBLIC included) gets it here. The owner keeps its own.
do $grants$
declare
  v_grantee text;
begin
  revoke all on function public.is_branch_open_for(uuid, text, timestamptz)
    from public, anon, authenticated, service_role;
  for v_grantee in
    select case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end
      from pg_proc p
     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = 'public.is_branch_open(uuid, timestamptz)'::regprocedure
       and a.privilege_type = 'EXECUTE'
       and a.grantee <> p.proowner
  loop
    execute format('grant execute on function public.is_branch_open_for(uuid, text, timestamptz) to %s', v_grantee);
  end loop;
end $grants$;

-- tg_enforce_scheduled_time as live, asking is_branch_open_for for the order's channel (section 2).
create or replace function public.tg_enforce_scheduled_time()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.scheduled_for is null then return new; end if;

  -- Opening hours; for a delivery while delivery hours are on, its delivery windows instead (a
  -- pause or a closure still closes it).
  if not public.is_branch_open_for(new.branch_id, new.channel::text, new.scheduled_for) then
    raise exception 'branch_closed_at_scheduled_time' using errcode = 'P0001';
  end if;

  -- Staff surfaces are exempt from the bookable-window rule ONLY. It is a self-service
  -- policy for diners; a manager taking a phone booking at the till IS the override. They
  -- are not exempt from the open check above, which place-order already enforces for them.
  -- place-order applies the same exemption; if the two diverge, a counter booking passes
  -- there and dies here as an unexplained failure.
  if coalesce(new.source, 'web') in ('counter', 'pos') then return new; end if;

  if not public.is_schedule_window_open(new.branch_id, new.scheduled_for) then
    raise exception 'outside_scheduling_window' using errcode = 'P0001';
  end if;

  return new;
end $function$;

-- As 20260908101000_branch_schedule_hours left it: a trigger function no API role calls.
revoke execute on function public.tg_enforce_scheduled_time() from public, anon, authenticated;

-- storefront_status as live, plus delivery_open_now (section 3).
create or replace function public.storefront_status(p_branch_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select jsonb_build_object(
      'entitled',           coalesce(b.entitled_through is not null and b.entitled_through > now(), false),
      'delivery',           coalesce(private.branch_has_feature(b.id, 'delivery')
                                     and public.is_delivery_available(b.id), false),
      'delivery_entitled',  coalesce(private.branch_has_feature(b.id, 'delivery'), false),
      'delivery_available', public.is_delivery_available(b.id),
      'delivery_hours_on',  coalesce((b.settings->>'delivery_hours_enabled')::boolean, false),
      -- Can a diner order delivery right now: the delivery windows alone while delivery hours are
      -- on, else opening hours; a pause or a closure stops it either way (is_branch_open_for).
      'delivery_open_now',  coalesce(private.branch_has_feature(b.id, 'delivery')
                                     and public.is_branch_open_for(b.id, 'delivery', now()), false),
      'delivery_mode',      coalesce(b.settings->>'delivery_mode', 'platform'),
      'delivery_windows',   coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_delivery_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      -- Sold with the base, so it stays restaurant-wide.
      'card_payment',       coalesce(b.entitled_through > now() and (be.features -> 'card_payment') = to_jsonb(true), false),
      -- The branch's own Stripe account can take charges. The checkout offers card only when
      -- card_payment AND card_ready are both true; the account id itself is never exposed.
      'card_ready',         private.branch_card_ready(b.id),

      'timezone',           coalesce(b.timezone, 'America/New_York'),
      -- Empty array means "no hours configured", which is_branch_open() treats as
      -- always-open. The client must read it the same way, so the distinction between
      -- "no hours" and "closed all week" is preserved rather than flattened to [].
      'opening_hours',      coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      'scheduling_enabled', coalesce((b.settings->>'scheduling_enabled')::boolean, true),
      'schedule_min_lead_min', greatest(0, coalesce((b.settings->>'schedule_min_lead_min')::int, 15)),
      'schedule_max_days',     greatest(0, coalesce((b.settings->>'schedule_max_days')::int, 14)),
      'schedule_slot_minutes', greatest(5, coalesce((b.settings->>'schedule_slot_minutes')::int, 15))
    )
    from public.branches b
    left join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    where b.id = p_branch_id
  ), jsonb_build_object('entitled', false, 'delivery', false, 'delivery_entitled', false,
                        'delivery_available', false, 'delivery_hours_on', false,
                        'delivery_open_now', false,
                        'delivery_mode', 'platform', 'delivery_windows', '[]'::jsonb,
                        'card_payment', false, 'card_ready', false,
                        'timezone', 'America/New_York', 'opening_hours', '[]'::jsonb,
                        'scheduling_enabled', false,
                        'schedule_min_lead_min', 15, 'schedule_max_days', 14,
                        'schedule_slot_minutes', 15));
$function$;

-- create or replace keeps the grants live has; restated as 20260923100000 last wrote them (the
-- unsigned-in diner's storefront reads it; PUBLIC has had none since 20260830094233).
grant execute on function public.storefront_status(uuid) to anon, authenticated, service_role;

-- The table's own description said booking windows narrow branch_hours; they narrow the branch's
-- delivery hours now, which may lie outside branch_hours.
comment on table public.branch_schedule_hours is
  'Per-weekday windows a diner may SCHEDULE a delivery inside. Narrows the branch''s delivery hours (branch_hours, or branch_delivery_hours on their own while settings.delivery_hours_enabled is true: is_branch_open_for), never extends them. Inert unless branches.settings.schedule_hours_enabled is true.';

commit;
