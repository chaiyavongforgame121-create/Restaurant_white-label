-- Rider dispatch runs in the database (docs/DISPATCH-FIXES-2026-10-05.md D1-D6, D8).
--
-- What was wrong, on the live project on 2026-10-05:
--   * Nothing dispatched on the server. Every path that should offer an order to a rider (the ready
--     trigger, reject_dispatch, the 30-second expiry, driver_cancel_delivery, requeue_failed_delivery)
--     called the dispatch-driver edge function through pg_net with a service-role key read from
--     private.app_settings, which is empty, so each returned before the call. Every offer that day
--     came from a staff tap.
--   * Choosing the rider (find_dispatch_candidates) and stamping the offer were two separate calls
--     with no lock between them: two runs 254 ms apart gave one rider three offers at once.
--   * The kitchen's only retry wiped dispatch_history, so the rider who had just declined was asked
--     again; two declines in 24 hours is a 60-minute cooldown, which is how two riders were "banned".
--   * A search that found nobody was never retried, and driver_max_attempts ended a search after
--     three tries whether or not anyone was left to ask.
--
-- What this does:
--   D1. private.dispatch_delivery() picks the rider and stamps the offer in one transaction. The
--       triggers and RPCs above call it directly; no pg_net and no key stored in the database. A
--       dispatch they start never fails what they were doing (marking an order ready, a rider's
--       decline): errors are caught, logged, and left for the sweep. dispatch-driver becomes a thin
--       authenticated door over public.staff_dispatch_delivery().
--   D2. Rounds. deliveries.dispatch_round_started_at starts when the order is ready (or when staff
--       start a new round); deliveries.dispatch_state says where it stands (searching / waiting /
--       no_rider_found). Within a round a rider is asked a delivery at most once: every rider offered
--       it in the round is excluded (declined, expired, withdrawn, reassigned), across both stops of
--       a stack. delivery_assignments rows carry the round they were offered in, so the exclusion is
--       read from the turn table rather than from dispatch_history, which is trimmed. On a decline or
--       an expiry the next rider is offered at once. With nobody un-asked eligible the round waits;
--       private.dispatch_sweep() (every 30 s, with the expiry) offers it to a rider who becomes
--       eligible later. Once dispatch_search_window_min (branch setting, default 15) has passed and
--       nobody is left to offer it to, the round ends as no_rider_found. driver_max_attempts is no
--       longer read.
--   D3. A rider is struck at most once per delivery (a stack counts once), so a new round never
--       strikes them again for the same order. The strikes that trip a cooldown are marked consumed
--       instead of deleted, which is what lets that rule remember them.
--   D4. A per-branch advisory transaction lock around every dispatch, the chosen rider's drivers row
--       locked FOR UPDATE SKIP LOCKED and re-checked (no open offer, no active job) before the offer,
--       and every status write guarded. Every caller takes the branch lock before it locks a delivery
--       row, so the lock order is always branch, then deliveries, then the rider. The sweep and the
--       expiry, which touch many branches in one transaction, only try the lock and skip a busy
--       branch until the next pass, so they never wait on one.
--   D5. A stack is dispatched and restarted as one unit.
--   D6. A staff restart is refused once a rider has accepted, and withdraws an open offer without a
--       strike.
--   D8. public.lift_driver_cooldown(), and list_branch_riders returns cooldown_until.
--
-- Live bodies were read with pg_get_functiondef before each replacement (several of them never lived
-- in this directory: accept_dispatch, record_driver_penalty, claim_batch_sibling, stamp_batch_offer)
-- and are kept except where a comment says otherwise. private.app_settings is not written here.

-- ---------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------

alter table public.deliveries
  add column if not exists dispatch_round_started_at timestamptz,
  add column if not exists dispatch_state text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'deliveries_dispatch_state_check'
                    and conrelid = 'public.deliveries'::regclass) then
    alter table public.deliveries
      add constraint deliveries_dispatch_state_check
      check (dispatch_state in ('searching', 'waiting', 'no_rider_found'));
  end if;
end $$;

comment on column public.deliveries.dispatch_round_started_at is
  'When the current dispatch round started: the order became ready, or staff started a new round (Find rider again). Within a round each rider is offered the delivery at most once; the round ends as no_rider_found once branches.settings.dispatch_search_window_min (default 15) has passed with nobody left to ask. Null before the first round (and on rows from before 2026-10-05).';
comment on column public.deliveries.dispatch_state is
  'Where the round stands, written only by private.dispatch_delivery and the paths that call it: searching (an offer is out or about to be), waiting (nobody un-asked is eligible now; the 30-second sweep keeps looking), no_rider_found (the round ended; staff can start a new one). Null outside a round, and once a rider accepts. The boards read this instead of a client timer.';

-- The round an offer was made in. Exclusions are "every rider with a turn in this round", read from
-- here because dispatch_history is trimmed and a busy round would forget its first riders.
alter table public.delivery_assignments
  add column if not exists dispatch_round_started_at timestamptz;

comment on column public.delivery_assignments.dispatch_round_started_at is
  'deliveries.dispatch_round_started_at when this turn was offered. A rider with a turn in the delivery''s current round is not offered it again in that round.';

-- A strike that tripped a cooldown used to be deleted; it is kept, marked consumed, so a rider is
-- never struck twice for one delivery (D3) and support can still see why a cooldown happened.
alter table public.driver_penalty_events
  add column if not exists consumed_at timestamptz;

comment on column public.driver_penalty_events.consumed_at is
  'Set when this strike stopped counting: it tripped a cooldown (the next window starts fresh) or staff lifted the cooldown. Unconsumed strikes inside platform_settings.penalty.window_hours count towards the threshold.';

create index if not exists driver_penalty_events_driver_delivery_idx
  on public.driver_penalty_events (driver_id, delivery_id);

-- What the sweep reads every 30 seconds.
create index if not exists deliveries_dispatch_open_idx
  on public.deliveries (dispatch_round_started_at)
  where dispatch_state in ('searching', 'waiting') and driver_id is null;

-- ---------------------------------------------------------------------------------------------
-- 2. Small helpers
-- ---------------------------------------------------------------------------------------------

-- One dispatch at a time per branch. Every path that offers, withdraws or releases an offer takes
-- this before it locks a delivery row.
create or replace function private.dispatch_lock_branch(p_branch_id uuid)
returns void
language sql
volatile
set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select pg_advisory_xact_lock(hashtextextended('favornoms.dispatch:' || p_branch_id::text, 0));
$function$;

-- The same lock without waiting, for the multi-branch passes (the sweep, the expiry): a branch that
-- is dispatching right now is skipped until the next pass instead of waited on.
create or replace function private.dispatch_try_lock_branch(p_branch_id uuid)
returns boolean
language sql
volatile
set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select pg_try_advisory_xact_lock(hashtextextended('favornoms.dispatch:' || p_branch_id::text, 0));
$function$;

-- dispatch_history with one more entry, keeping the last 30. The exclusions no longer depend on the
-- history (delivery_assignments carries them), so the trim only bounds the row.
create or replace function private.dispatch_history_append(p_history jsonb, p_entry jsonb)
returns jsonb
language sql
immutable
set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select coalesce((
      select jsonb_agg(t.e order by t.ord)
        from (select e, ord
                from jsonb_array_elements(case when jsonb_typeof(p_history) = 'array' then p_history
                                               else '[]'::jsonb end) with ordinality as h(e, ord)
               order by ord desc
               limit 29) t
    ), '[]'::jsonb) || jsonb_build_array(p_entry);
$function$;

-- A number from branches.settings, or the default when the key is missing or not a number. A stray
-- string in a setting must not make dispatch raise for the whole branch.
create or replace function private.dispatch_setting(p_settings jsonb, p_key text, p_default numeric)
returns numeric
language sql
immutable
set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select case
    when jsonb_typeof(p_settings -> p_key) = 'number' then (p_settings ->> p_key)::numeric
    when jsonb_typeof(p_settings -> p_key) = 'string'
         and btrim(p_settings ->> p_key) ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(p_settings ->> p_key)::numeric
    else p_default
  end;
$function$;

-- Every rider asked in the current round of any of these deliveries (both stops of a stack): a turn
-- offered in the round, or a history entry stamped with the round (a rider who cancelled a job they
-- had accepted is written into the new round that cancel starts, so they are not asked it again).
create or replace function private.dispatch_asked_riders(p_delivery_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(array_agg(distinct x.driver_id), '{}'::uuid[])
    from (
      select a.driver_id
        from public.deliveries d
        join public.delivery_assignments a
          on a.delivery_id = d.id
         and a.dispatch_round_started_at = d.dispatch_round_started_at
       where d.id = any (p_delivery_ids)
         and d.dispatch_round_started_at is not null
      union
      select case when (h.e ->> 'driver_id') ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
                  then (h.e ->> 'driver_id')::uuid end
        from public.deliveries d
        cross join lateral jsonb_array_elements(
                     case when jsonb_typeof(d.dispatch_history) = 'array' then d.dispatch_history
                          else '[]'::jsonb end) as h(e)
       where d.id = any (p_delivery_ids)
         and d.dispatch_round_started_at is not null
         and (case when (h.e ->> 'round') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                   then (h.e ->> 'round')::timestamptz end) = d.dispatch_round_started_at
    ) x
   where x.driver_id is not null;
$function$;

-- Why nobody can be offered a delivery right now: the branch's riders through each gate in turn
-- (find_dispatch_candidates' gates, in that order), and the first gate that leaves nobody. The
-- counts in dispatch_candidate_diagnostics are each independent of the others, so they cannot say
-- which gate emptied the list; and neither of them knew about cooldowns or riders already asked,
-- which is how "no rider available" appeared while three riders were online.
create or replace function private.dispatch_funnel(p_branch_id uuid, p_radius_km numeric, p_exclude uuid[])
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  with b as (
    select br.geo_location,
           greatest(1, coalesce(private.dispatch_setting(br.settings, 'dispatch_max_gps_age_min', 5), 5))::int as max_age_min
      from public.branches br
     where br.id = p_branch_id
  ),
  r as (
    select coalesce(dba.is_online, false) as online,
           d.kyc_status = 'verified' as kyc,
           (d.cooldown_until is null or d.cooldown_until < now()) as not_cooling,
           (d.current_location is not null and d.location_updated_at is not null
            and d.location_updated_at > now() - make_interval(mins => b.max_age_min)) as gps_fresh,
           (b.geo_location is not null and d.current_location is not null
            and ST_DWithin(d.current_location, b.geo_location, (p_radius_km * 1000)::float)) as in_radius,
           not exists (select 1 from public.deliveries x
                        where x.driver_id = d.id
                          and x.status in ('assigned', 'picked_up', 'in_transit')) as not_busy,
           not (d.id = any (coalesce(p_exclude, '{}'::uuid[]))) as not_asked
      from public.drivers d
      join public.driver_approvals da
        on da.driver_id = d.id and da.branch_id = p_branch_id and da.status = 'approved'
      left join public.driver_branch_availability dba
        on dba.driver_id = d.id and dba.branch_id = p_branch_id
     cross join b
  ),
  f as (
    select coalesce((select b.geo_location is not null from b), false) as pin,
           count(*) as approved,
           count(*) filter (where online) as online,
           count(*) filter (where online and kyc) as kyc_verified,
           count(*) filter (where online and kyc and not_cooling) as not_cooling_down,
           count(*) filter (where online and kyc and not_cooling and gps_fresh) as gps_fresh,
           count(*) filter (where online and kyc and not_cooling and gps_fresh and in_radius) as in_radius,
           count(*) filter (where online and kyc and not_cooling and gps_fresh and in_radius and not_busy) as not_busy,
           count(*) filter (where online and kyc and not_cooling and gps_fresh and in_radius and not_busy
                              and not_asked) as available,
           count(*) filter (where online and not not_cooling) as cooling_down
      from r
  )
  select jsonb_build_object(
           'approved', approved, 'online', online, 'kyc_verified', kyc_verified,
           'not_cooling_down', not_cooling_down, 'gps_fresh', gps_fresh, 'in_radius', in_radius,
           'not_busy', not_busy, 'available', available, 'cooling_down', cooling_down,
           'reason', case
             when not pin               then 'no_branch_pin'
             when approved = 0          then 'none_approved'
             when online = 0            then 'nobody_online'
             when kyc_verified = 0      then 'kyc_not_verified'
             when not_cooling_down = 0  then 'cooling_down'
             when gps_fresh = 0         then 'no_fresh_gps'
             when in_radius = 0         then 'out_of_radius'
             when not_busy = 0          then 'riders_busy'
             when available = 0         then 'everyone_asked'
           end)
    from f;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 3. The live batching functions, with the round
-- ---------------------------------------------------------------------------------------------

-- Live body, except: a sibling must be in an active round (searching or waiting). A delivery whose
-- round ended as no_rider_found waits for staff, not for a stranger's order to drag it back into a
-- search; and a row parked in 'dispatching' from before rounds existed (June test runs, still on the
-- live project) is never paired with a real order.
create or replace function public.claim_batch_sibling(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  d record;
  sib record;
  v_settings jsonb;
  v_max_detour_mi numeric;
  v_branch_geo geography;
  v_d_geo geography;
  v_d_m numeric;
  v_s_m numeric;
  v_first uuid;
  v_batch uuid;
  v_n int;
begin
  select * into d from public.deliveries where id = p_delivery_id;
  if not found then return null; end if;

  -- Existing batch: honor it only while BOTH legs are still live and unassigned;
  -- a half-dissolved pair (cancel/requeue/order-cancel of one leg) is cleaned up.
  if d.batch_id is not null then
    select count(*) into v_n from public.deliveries
    where batch_id = d.batch_id and status = 'dispatching' and driver_id is null;
    if v_n = 2 then
      return jsonb_build_object('batch_id', d.batch_id);
    end if;
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
    return null;
  end if;

  if d.status <> 'dispatching' or d.driver_id is not null then return null; end if;
  if d.dropoff_lat is null or d.dropoff_lng is null then return null; end if;

  select settings, geo_location into v_settings, v_branch_geo
  from public.branches where id = d.branch_id;
  if not coalesce((v_settings->>'batch_enabled')::boolean, false) then return null; end if;
  -- The same-direction gate is a detour test and needs the branch location; without it
  -- we can't tell "close together" from "same route". Geo-less branches don't batch
  -- (they can't dispatch either — find_dispatch_candidates requires geo_location).
  if v_branch_geo is null then return null; end if;
  v_max_detour_mi := greatest(0.05, coalesce((v_settings->>'batch_max_detour_mi')::numeric, 1.0));

  v_d_geo := ST_SetSRID(ST_MakePoint(d.dropoff_lng, d.dropoff_lat), 4326)::geography;

  -- Pick the same-branch READY sibling that adds the LEAST detour for the second
  -- customer, among those under the cap. Replaces the old dropoff-proximity gate.
  select s.id, s.created_at, s.dropoff_lat, s.dropoff_lng into sib
  from (
    select d2.id, d2.created_at, d2.dropoff_lat, d2.dropoff_lng,
      ( ST_Distance(v_d_geo, ST_SetSRID(ST_MakePoint(d2.dropoff_lng, d2.dropoff_lat), 4326)::geography)
        - abs(
            ST_Distance(v_branch_geo, v_d_geo)
            - ST_Distance(v_branch_geo, ST_SetSRID(ST_MakePoint(d2.dropoff_lng, d2.dropoff_lat), 4326)::geography)
          )
      ) as detour_m
    from public.deliveries d2
    where d2.branch_id = d.branch_id
      and d2.id <> d.id
      and d2.status = 'dispatching'          -- READY orders only (kitchen has flipped it)
      and d2.driver_id is null
      and d2.batch_id is null
      and d2.dropoff_lat is not null and d2.dropoff_lng is not null
      -- 2026-10-05: only a sibling whose own round is still looking for a rider.
      and d2.dispatch_round_started_at is not null
      and d2.dispatch_state in ('searching', 'waiting')
  ) s
  where s.detour_m <= (v_max_detour_mi * 1609.344)
  order by s.detour_m asc, s.created_at asc
  limit 1;
  if sib.id is null then return null; end if;

  -- Sequence: deliver the dropoff NEARER the branch first; FIFO tie-break under 800 m.
  v_d_m := ST_Distance(v_branch_geo, v_d_geo);
  v_s_m := ST_Distance(v_branch_geo, ST_SetSRID(ST_MakePoint(sib.dropoff_lng, sib.dropoff_lat), 4326)::geography);
  if abs(v_d_m - v_s_m) < 800 then
    v_first := case when sib.created_at <= d.created_at then sib.id else d.id end;
  else
    v_first := case when v_s_m < v_d_m then sib.id else d.id end;
  end if;

  v_batch := gen_random_uuid();
  update public.deliveries
     set batch_id = v_batch,
         batch_seq = case when id = v_first then 1 else 2 end
   where id in (d.id, sib.id)
     and status = 'dispatching'
     and driver_id is null
     and batch_id is null;
  get diagnostics v_n = row_count;
  if v_n <> 2 then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = v_batch;
    return null;
  end if;
  return jsonb_build_object('batch_id', v_batch, 'sibling_id', sib.id);
end;
$function$;

-- Live body, except: each leg's history entry is stamped with that leg's own round, the history is
-- trimmed like every other write, and dispatch_state reads 'searching' while the offer is out.
create or replace function public.stamp_batch_offer(p_batch_id uuid, p_driver_id uuid, p_offered_at timestamptz,
                                                    p_expires_at timestamptz, p_rows jsonb, p_history_entry jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  r jsonb;
  v_n int := 0;
  v_total int;
begin
  select count(*) into v_total from public.deliveries where batch_id = p_batch_id;
  for r in select * from jsonb_array_elements(p_rows) loop
    update public.deliveries
       set driver_id = p_driver_id,
           status = 'assigned',
           offered_at = p_offered_at,
           offer_expires_at = p_expires_at,
           accepted_at = null,
           driver_earnings = (r->>'earnings')::numeric,
           net_tip = (r->>'net_tip')::numeric,
           tip_visible_total = nullif(r->>'tip_visible_total','')::numeric,
           dispatch_attempts = coalesce(dispatch_attempts,0) + 1,
           dispatch_state = 'searching',
           dispatch_history = private.dispatch_history_append(dispatch_history,
             p_history_entry || jsonb_build_object('round', dispatch_round_started_at))
     where id = (r->>'id')::uuid
       and batch_id = p_batch_id
       and status in ('pending','dispatching')
       and driver_id is null;
    v_n := v_n + 1;
    if not found then
      raise exception 'batch_offer_conflict'; -- rolls back the whole stamp
    end if;
  end loop;
  if v_n <> v_total then raise exception 'batch_offer_incomplete'; end if;
  return v_n;
end;
$function$;

-- Live body, except: the turn records the round it was offered in (the exclusion source, §1).
create or replace function public.deliveries_sync_assignments()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_seq int;
begin
  if new.driver_id is distinct from old.driver_id then
    -- The RPCs below stamp end_kind/end_reason BEFORE they move driver_id, so coalesce keeps
    -- whatever a human actually said; this branch only catches the paths that say nothing
    -- (a dispatch-driver reset, a bare reassign). Closing every other open turn on the
    -- delivery — not just old.driver_id's — is what keeps delivery_assignments_one_live safe.
    update public.delivery_assignments
       set ended_at = coalesce(ended_at, now()),
           status   = case when status in ('offered','accepted') then 'reassigned' else status end,
           end_kind = coalesce(end_kind, 'reassigned_by_staff')
     where delivery_id = new.id
       and ended_at is null
       and driver_id is distinct from new.driver_id;

    if new.driver_id is not null
       and not exists (
         select 1 from public.delivery_assignments
          where delivery_id = new.id and driver_id = new.driver_id and ended_at is null
       ) then
      select coalesce(max(seq), 0) + 1 into v_seq
        from public.delivery_assignments where delivery_id = new.id;
      insert into public.delivery_assignments
        (delivery_id, order_id, branch_id, driver_id, seq, status, offered_at, earnings, dispatch_round_started_at)
      values (new.id, new.order_id, new.branch_id, new.driver_id, v_seq, 'offered', now(), new.driver_earnings,
              new.dispatch_round_started_at);
    end if;
  end if;

  if new.accepted_at is not null and old.accepted_at is null and new.driver_id is not null then
    update public.delivery_assignments
       set accepted_at = new.accepted_at, status = 'accepted'
     where delivery_id = new.id and driver_id = new.driver_id and ended_at is null;
  end if;

  if new.status is distinct from old.status and new.status in ('delivered','failed','cancelled') then
    update public.delivery_assignments
       set ended_at   = coalesce(ended_at, now()),
           status     = new.status::text,
           end_kind   = coalesce(end_kind, case new.status
                                             when 'delivered' then 'delivered'
                                             when 'failed'    then 'failed_at_door'
                                             else 'order_cancelled' end),
           end_reason = coalesce(end_reason, new.failed_reason),
           earnings   = coalesce(earnings, new.driver_earnings)
     where delivery_id = new.id and ended_at is null;
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. One dispatch step
-- ---------------------------------------------------------------------------------------------

-- The decision logic of dispatch-driver v2.5 (index.ts), ported, with rounds, the lock and the
-- re-check added. Modes:
--   'auto'           the ready trigger, reject/expiry cascades, the sweep. Continues the round,
--                    starting one if the delivery has none; never reopens a round that ended.
--   'staff'          a staff "Find rider": continues the round, or starts one when none is running
--                    (no round yet, or it ended as no_rider_found).
--   'staff_restart'  a staff "Find rider again": a new round for the delivery and the other stop of
--                    its stack, in which every rider may be asked again; an open offer is withdrawn
--                    without a strike; refused once a rider has accepted.
-- Answers {ok, result, ...}: result is offered | offered_batch | waiting | no_rider_found |
-- already_accepted | not_dispatchable. Raises only for a delivery that does not exist or a bad mode.
create or replace function private.dispatch_delivery(p_delivery_id uuid, p_mode text default 'auto')
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  c_km_per_mile constant numeric := 1.609344;
  v_mode      text := coalesce(p_mode, 'auto');
  v_uid       uuid := auth.uid();
  v_branch    uuid;
  d           public.deliveries%rowtype;
  v_ids       uuid[];
  r           record;
  c           record;
  v_settings  jsonb;
  v_radius    numeric;
  v_ttl       integer;
  v_window    numeric;
  v_round     timestamptz;
  v_latest    timestamptz;
  v_claim     jsonb;
  v_batch     uuid;
  v_asked     uuid[];
  v_asked_n   integer;
  v_driver    uuid;
  v_dist      numeric;
  v_score     numeric;
  v_now       timestamptz;
  v_expires   timestamptz;
  v_base      numeric;
  v_perkm     numeric;
  v_cap       numeric;
  v_pct       numeric;
  v_tip_mode  text;
  v_tip       numeric;
  v_earn      numeric;
  v_net       numeric;
  v_visible   numeric;
  v_rows      jsonb;
  v_first_id  uuid;
  v_first_ord uuid;
  v_funnel    jsonb;
  v_diag      jsonb;
  v_reason    text;
  v_n         integer;
begin
  if v_mode not in ('auto', 'staff', 'staff_restart') then
    raise exception 'invalid_dispatch_mode' using errcode = '22023';
  end if;

  select x.branch_id into v_branch from public.deliveries x where x.id = p_delivery_id;
  if not found then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  -- D4: one dispatch at a time per branch. Taken before any delivery row is locked, as every
  -- other dispatch path does, so the lock order is always branch, then deliveries, then rider.
  perform private.dispatch_lock_branch(v_branch);

  -- The unit: this delivery, or both stops of its stack, locked in id order. batch_id only moves
  -- under the branch lock, so reading it first is safe.
  select * into d from public.deliveries where id = p_delivery_id;
  perform 1 from public.deliveries x
    where x.id = d.id or (d.batch_id is not null and x.batch_id = d.batch_id)
    order by x.id
    for update;
  select * into d from public.deliveries where id = p_delivery_id;
  select array_agg(x.id order by x.batch_seq nulls first, x.id) into v_ids
    from public.deliveries x
   where x.id = d.id or (d.batch_id is not null and x.batch_id = d.batch_id);

  -- Already in a rider's hands. D6: a restart never takes an accepted job away.
  select x.status::text into r
    from public.deliveries x
   where x.id = any (v_ids) and x.accepted_at is not null
     and x.status in ('assigned', 'picked_up', 'in_transit')
   limit 1;
  if found then
    return jsonb_build_object('ok', false, 'result', 'already_accepted', 'delivery_status', r.status,
                              'driver_id', d.driver_id, 'delivery_ids', to_jsonb(v_ids),
                              'asked_count', coalesce(array_length(private.dispatch_asked_riders(v_ids), 1), 0));
  end if;

  if d.status not in ('pending', 'dispatching', 'assigned') then
    return jsonb_build_object('ok', false, 'result', 'not_dispatchable', 'reason', d.status::text,
                              'delivery_status', d.status, 'delivery_ids', to_jsonb(v_ids), 'asked_count', 0);
  end if;

  -- A self-delivery branch marks a ready order 'assigned' with no rider: its own staff carry it.
  if exists (select 1 from public.deliveries x
              where x.id = any (v_ids) and x.status = 'assigned' and x.driver_id is null) then
    return jsonb_build_object('ok', false, 'result', 'not_dispatchable', 'reason', 'self_delivery',
                              'delivery_status', 'assigned', 'delivery_ids', to_jsonb(v_ids), 'asked_count', 0);
  end if;

  -- An offer is out.
  if exists (select 1 from public.deliveries x
              where x.id = any (v_ids) and x.status = 'assigned' and x.accepted_at is null
                and x.driver_id is not null) then
    if v_mode <> 'staff_restart' then
      return jsonb_strip_nulls(jsonb_build_object(
        'ok', false, 'result', 'not_dispatchable', 'reason', 'offer_open', 'delivery_status', 'assigned',
        'driver_id', d.driver_id, 'offer_expires_at', d.offer_expires_at, 'delivery_ids', to_jsonb(v_ids),
        'asked_count', coalesce(array_length(private.dispatch_asked_riders(v_ids), 1), 0)));
    end if;
    -- D6: withdrawn without a strike. The turn is closed before driver_id moves so the trigger
    -- keeps this end_kind; the rider's app hears it through delivery_assignments.
    for r in
      select x.id, x.driver_id, x.dispatch_round_started_at
        from public.deliveries x
       where x.id = any (v_ids) and x.status = 'assigned' and x.accepted_at is null
         and x.driver_id is not null
       order by x.id
    loop
      update public.delivery_assignments
         set ended_at = now(), status = 'reassigned', end_kind = 'reassigned_by_staff'
       where delivery_id = r.id and driver_id = r.driver_id and ended_at is null;

      update public.deliveries
         set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
             dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
               'type', 'withdrawn', 'driver_id', r.driver_id, 'at', clock_timestamp(),
               'round', r.dispatch_round_started_at, 'by_user', v_uid))
       where id = r.id and status = 'assigned' and accepted_at is null and driver_id = r.driver_id;
    end loop;
  end if;

  select * into d from public.deliveries where id = p_delivery_id;

  -- The round (D2).
  if v_mode = 'staff_restart' or (v_mode = 'staff' and d.dispatch_state = 'no_rider_found') then
    v_round := clock_timestamp();
    update public.deliveries
       set dispatch_round_started_at = v_round, dispatch_state = 'searching', dispatch_attempts = 0
     where id = any (v_ids) and status in ('pending', 'dispatching');
  elsif d.dispatch_state = 'no_rider_found' then
    -- 'auto' never reopens a round that ended; only staff start a new one.
    return jsonb_build_object('ok', false, 'result', 'no_rider_found', 'reason', 'round_over',
                              'delivery_ids', to_jsonb(v_ids),
                              'asked_count', coalesce(array_length(private.dispatch_asked_riders(v_ids), 1), 0));
  else
    -- No round yet (a row from before rounds, a staff tap before the order was ready): one starts.
    v_round := clock_timestamp();
    update public.deliveries
       set dispatch_round_started_at = v_round, dispatch_state = 'searching', dispatch_attempts = 0
     where id = any (v_ids) and dispatch_round_started_at is null and status in ('pending', 'dispatching');
  end if;

  -- Stacking (D5). claim_batch_sibling honours a stack whose stops are both still waiting for a
  -- rider, dissolves a half-live one, or pairs this delivery with a sibling on the way.
  v_claim := public.claim_batch_sibling(d.id);
  v_batch := case when v_claim ? 'batch_id' then (v_claim ->> 'batch_id')::uuid end;
  if v_batch is not null then
    perform 1 from public.deliveries x where x.batch_id = v_batch order by x.id for update;
    select array_agg(x.id order by x.batch_seq, x.id) into v_ids
      from public.deliveries x where x.batch_id = v_batch;
    if coalesce(array_length(v_ids, 1), 0) < 2 then
      v_batch := null;
      v_ids := array[d.id];
    end if;
  else
    v_ids := array[d.id];
  end if;

  select settings into v_settings from public.branches where id = v_branch;
  v_radius := greatest(0.1, private.dispatch_setting(v_settings, 'driver_search_radius_km', 3 * c_km_per_mile));
  v_ttl    := greatest(15, round(private.dispatch_setting(v_settings, 'offer_ttl_seconds', 75)))::int;
  v_window := greatest(1, private.dispatch_setting(v_settings, 'dispatch_search_window_min', 15));

  v_asked   := private.dispatch_asked_riders(v_ids);
  v_asked_n := coalesce(array_length(v_asked, 1), 0);

  -- The best rider not asked in this round. find_dispatch_candidates reads this transaction's own
  -- offers, so a rider offered a moment ago in this transaction is already busy to it.
  for c in select * from public.find_dispatch_candidates(v_branch, v_radius, v_asked) loop
    -- D4: another branch's dispatch may be offering this rider right now; skip rather than wait.
    perform 1 from public.drivers dr where dr.id = c.driver_id for update skip locked;
    continue when not found;
    -- Re-checked under the rider's lock, with a fresh snapshot: an offer another branch committed
    -- after the candidate list was read, a cooldown a decline just set, an "offline" tap.
    continue when exists (select 1 from public.deliveries x
                           where x.driver_id = c.driver_id
                             and x.status in ('assigned', 'picked_up', 'in_transit'));
    continue when exists (select 1 from public.drivers dr
                           where dr.id = c.driver_id and dr.cooldown_until is not null
                             and dr.cooldown_until >= now());
    continue when not exists (select 1 from public.driver_branch_availability a
                               where a.driver_id = c.driver_id and a.branch_id = v_branch and a.is_online);
    v_driver := c.driver_id;
    v_dist   := c.distance_km;
    v_score  := c.score;
    exit;
  end loop;

  if v_driver is null then
    v_funnel := private.dispatch_funnel(v_branch, v_radius, v_asked);
    -- Someone passed every gate but could not be taken (another branch had them locked).
    v_reason := coalesce(v_funnel ->> 'reason', 'riders_busy');
    v_diag := coalesce(public.dispatch_candidate_diagnostics(v_branch, v_radius), '{}'::jsonb)
              || jsonb_build_object('cooling_down', (v_funnel ->> 'cooling_down')::int,
                                    'already_asked', v_asked_n,
                                    'available', (v_funnel ->> 'available')::int,
                                    'funnel', v_funnel - 'reason',
                                    'reason', v_reason);
    select max(x.dispatch_round_started_at) into v_latest
      from public.deliveries x where x.id = any (v_ids);

    if v_latest is not null and v_latest + v_window * interval '1 minute' <= clock_timestamp() then
      -- The window is over and nobody is left to offer it to: the round ends. Staff are told as
      -- they were when max_attempts_reached (template dispatch_failed), once per stop.
      for r in
        select x.id, x.order_id, x.dispatch_round_started_at
          from public.deliveries x
         where x.id = any (v_ids) and x.status in ('pending', 'dispatching') and x.driver_id is null
         order by x.id
      loop
        update public.deliveries
           set dispatch_state = 'no_rider_found',
               dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
                 'type', 'no_rider_found', 'at', clock_timestamp(), 'round', r.dispatch_round_started_at,
                 'reason', v_reason, 'asked', v_asked_n))
         where id = r.id and status in ('pending', 'dispatching') and driver_id is null;

        insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
        values (v_branch, 'staff', v_branch, 'in_app', 'dispatch_failed',
                jsonb_build_object('delivery_id', r.id, 'order_id', r.order_id,
                                   'reason', 'no_rider_found', 'detail', v_reason, 'asked', v_asked_n));
      end loop;

      return jsonb_build_object('ok', false, 'result', 'no_rider_found', 'reason', v_reason,
                                'delivery_ids', to_jsonb(v_ids), 'batch_id', v_batch,
                                'asked_count', v_asked_n, 'diagnostics', v_diag,
                                'round_started_at', v_latest);
    end if;

    -- Waiting: the sweep keeps looking. Written only when the state or the reason changes, so a
    -- 30-second sweep does not churn the row (and every realtime subscriber) for nothing.
    for r in
      select x.id, x.dispatch_state, x.dispatch_round_started_at, x.dispatch_history -> -1 as last
        from public.deliveries x
       where x.id = any (v_ids) and x.status in ('pending', 'dispatching') and x.driver_id is null
       order by x.id
    loop
      if r.dispatch_state is distinct from 'waiting'
         or coalesce(r.last ->> 'type', '') <> 'waiting'
         or coalesce(r.last ->> 'reason', '') <> v_reason
         or coalesce((r.last ->> 'asked')::int, -1) <> v_asked_n then
        update public.deliveries
           set dispatch_state = 'waiting',
               dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
                 'type', 'waiting', 'at', clock_timestamp(), 'round', r.dispatch_round_started_at,
                 'reason', v_reason, 'asked', v_asked_n))
         where id = r.id;
      end if;
    end loop;

    return jsonb_build_object('ok', true, 'result', 'waiting', 'reason', v_reason,
                              'delivery_ids', to_jsonb(v_ids), 'batch_id', v_batch,
                              'asked_count', v_asked_n, 'diagnostics', v_diag,
                              'round_started_at', v_latest);
  end if;

  -- The offer. Pay is staff_assign_driver's: the platform's rates, capped per branch. The driver's
  -- share of the tip and what they may see of it are dispatch-driver v2.2's rule.
  v_now     := clock_timestamp();
  v_expires := v_now + make_interval(secs => v_ttl);
  select base_pay, per_km_pay into v_base, v_perkm from private.driver_pay_rates();
  v_cap := private.branch_driver_pay_cap(v_branch);
  v_pct := greatest(0, least(100, private.dispatch_setting(
             v_settings -> 'tip_config' -> 'delivery' -> 'distribution', 'driver', 100)));
  select ps.tips ->> 'mode' into v_tip_mode from public.platform_settings ps where ps.id = 1;

  if v_batch is null then
    select greatest(0, coalesce(o.tip_amount, 0)) into v_tip from public.orders o where o.id = d.order_id;
    v_tip     := coalesce(v_tip, 0);
    v_earn    := least(round((v_base + v_perkm * coalesce(d.distance_km, 0))::numeric, 2), v_cap);
    v_net     := round(v_tip * v_pct / 100.0, 2);
    v_visible := case when v_tip_mode = 'transparent' then round(v_tip, 2) end;

    update public.deliveries
       set driver_id = v_driver, status = 'assigned', offered_at = v_now, offer_expires_at = v_expires,
           accepted_at = null, driver_earnings = v_earn, net_tip = v_net, tip_visible_total = v_visible,
           dispatch_attempts = coalesce(dispatch_attempts, 0) + 1,
           dispatch_state = 'searching',
           dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
             'type', 'offered', 'driver_id', v_driver, 'driver_distance_km', v_dist, 'score', v_score,
             'at', v_now, 'round', dispatch_round_started_at))
     where id = d.id and status in ('pending', 'dispatching') and driver_id is null;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      -- Cannot happen under the locks above; answered rather than raised so a cascade never fails.
      return jsonb_build_object('ok', false, 'result', 'not_dispatchable', 'reason', 'offer_conflict',
                                'delivery_ids', to_jsonb(v_ids), 'asked_count', v_asked_n);
    end if;

    insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
    values (v_branch, 'driver', v_driver, 'push', 'new_dispatch',
            jsonb_build_object('delivery_id', d.id, 'order_id', d.order_id, 'distance_km', v_dist,
                               'earnings', v_earn, 'net_tip', v_net, 'expires_in_seconds', v_ttl,
                               'offer_expires_at', v_expires));

    return jsonb_build_object('ok', true, 'result', 'offered', 'driver_id', v_driver,
                              'delivery_ids', jsonb_build_array(d.id), 'offer_expires_at', v_expires,
                              'driver_distance_km', v_dist, 'earnings', v_earn, 'net_tip', v_net,
                              'asked_count', v_asked_n + 1,
                              'round_started_at', (select dispatch_round_started_at from public.deliveries where id = d.id));
  end if;

  -- A stack: one rider, both stops, in one stamp; pay and tip per stop, the push carries the sums.
  select jsonb_agg(jsonb_build_object(
           'id', x.id,
           'earnings', least(round((v_base + v_perkm * coalesce(x.distance_km, 0))::numeric, 2), v_cap),
           'net_tip', round(greatest(0, coalesce(o.tip_amount, 0)) * v_pct / 100.0, 2),
           'tip_visible_total', case when v_tip_mode = 'transparent'
                                     then round(greatest(0, coalesce(o.tip_amount, 0)), 2) end)
         order by x.batch_seq, x.id)
    into v_rows
    from public.deliveries x
    join public.orders o on o.id = x.order_id
   where x.id = any (v_ids);

  perform public.stamp_batch_offer(v_batch, v_driver, v_now, v_expires, v_rows,
    jsonb_build_object('type', 'offered', 'driver_id', v_driver, 'driver_distance_km', v_dist,
                       'score', v_score, 'at', v_now, 'batch', true));

  select x.id, x.order_id into v_first_id, v_first_ord
    from public.deliveries x where x.id = any (v_ids) order by x.batch_seq, x.id limit 1;
  v_earn := (select sum((e ->> 'earnings')::numeric) from jsonb_array_elements(v_rows) e);
  v_net  := (select sum((e ->> 'net_tip')::numeric) from jsonb_array_elements(v_rows) e);

  insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
  values (v_branch, 'driver', v_driver, 'push', 'new_dispatch',
          jsonb_build_object('delivery_id', v_first_id, 'order_id', v_first_ord, 'batch_id', v_batch,
                             'batch_size', array_length(v_ids, 1), 'distance_km', v_dist,
                             'earnings', v_earn, 'net_tip', v_net, 'expires_in_seconds', v_ttl,
                             'offer_expires_at', v_expires));

  return jsonb_build_object('ok', true, 'result', 'offered_batch', 'driver_id', v_driver,
                            'batch_id', v_batch, 'delivery_ids', to_jsonb(v_ids),
                            'offer_expires_at', v_expires, 'driver_distance_km', v_dist,
                            'earnings', v_earn, 'net_tip', v_net, 'asked_count', v_asked_n + 1);
end;
$function$;

comment on function private.dispatch_delivery(uuid, text) is
  'One dispatch step under the branch lock (docs/DISPATCH-FIXES-2026-10-05.md D1-D6). Modes auto / staff / staff_restart. Answers {ok, result: offered|offered_batch|waiting|no_rider_found|already_accepted|not_dispatchable, driver_id?, delivery_ids, batch_id?, offer_expires_at?, asked_count, diagnostics?, reason?}.';

-- What the triggers, the cascades and the sweep call: a dispatch they start must never fail what
-- they were doing (marking an order ready, a rider's decline, the expiry of other offers). The
-- error is logged, written on the row for the boards and support, and the row is left where the
-- sweep will try again.
create or replace function private.dispatch_delivery_safely(p_delivery_id uuid, p_mode text default 'auto')
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_msg   text;
  v_state text;
begin
  if p_delivery_id is null then return null; end if;
  begin
    return private.dispatch_delivery(p_delivery_id, p_mode);
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    raise warning 'dispatch_delivery(%, %) failed: % (%)', p_delivery_id, p_mode, v_msg, v_state;
    begin
      update public.deliveries
         set dispatch_round_started_at = coalesce(dispatch_round_started_at, clock_timestamp()),
             dispatch_state = coalesce(dispatch_state, 'searching'),
             dispatch_history = case
               when (dispatch_history -> -1 ->> 'type') = 'dispatch_error' then dispatch_history
               else private.dispatch_history_append(dispatch_history, jsonb_build_object(
                      'type', 'dispatch_error', 'at', clock_timestamp(), 'error', left(v_msg, 200),
                      'round', dispatch_round_started_at))
             end
       where id = p_delivery_id and status in ('pending', 'dispatching') and driver_id is null;
    exception when others then
      null;  -- the trace is a courtesy; the caller's own work must still go through
    end;
    return jsonb_build_object('ok', false, 'result', 'error', 'error', left(v_msg, 200), 'sqlstate', v_state);
  end;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. The sweep (D2)
-- ---------------------------------------------------------------------------------------------

-- Every 30 seconds, after the expiry: every delivery in an open round with no offer out gets one
-- more dispatch step, oldest round first, so a rider who came online, finished a job or came off
-- cooldown is offered the longest-waiting order; and a round past its window with nobody left to
-- ask ends as no_rider_found. Rows with no round (before rounds existed) are never touched.
-- A branch that is dispatching right now is skipped until the next pass rather than waited on.
-- Returns how many deliveries it offered or closed. p_branch_id limits a pass to one branch (a test,
-- or support looking at one branch); the cron passes nothing.
create or replace function private.dispatch_sweep(p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  v jsonb;
  v_n integer := 0;
begin
  for r in
    select x.id, x.branch_id
      from public.deliveries x
     where x.status in ('pending', 'dispatching')
       and x.driver_id is null
       and x.dispatch_round_started_at is not null
       and x.dispatch_state in ('searching', 'waiting')
       and (p_branch_id is null or x.branch_id = p_branch_id)
     order by x.dispatch_round_started_at, x.id
  loop
    -- The other stop of a stack handled earlier in this pass, or a staff tap since.
    perform 1 from public.deliveries x
     where x.id = r.id and x.status in ('pending', 'dispatching') and x.driver_id is null
       and x.dispatch_state in ('searching', 'waiting');
    continue when not found;
    continue when not private.dispatch_try_lock_branch(r.branch_id);

    v := private.dispatch_delivery_safely(r.id, 'auto');
    if v ->> 'result' in ('offered', 'offered_batch', 'no_rider_found') then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$function$;

comment on function private.dispatch_sweep(uuid) is
  'pg_cron expire-dispatch-offers (every 30 s, after private.expire_dispatch_offers): one dispatch step for every delivery in an open round with no offer out, oldest round first; closes rounds past dispatch_search_window_min. Returns the number offered or closed.';

-- ---------------------------------------------------------------------------------------------
-- 6. The paths that release an offer, now cascading directly
-- ---------------------------------------------------------------------------------------------

-- Live body, except: the branch lock comes first (D4); every entry carries its round; the next
-- rider is offered at once through dispatch_delivery instead of a pg_net call that never ran; and
-- only an open offer is released. A delivery whose order was cancelled while the offer was on the
-- rider's screen keeps driver_id (orders_cancel_syncs_delivery) and used to be flipped back to
-- 'dispatching' by the decline — harmless while nothing dispatched, a cancelled order offered to
-- the next rider now. Declining it is a no-op.
create or replace function public.reject_dispatch(p_delivery_id uuid, p_reason text default 'declined')
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_driver_id uuid;
  v_branch uuid;
  v_row record;
  r record;
  v_redispatch_id uuid;
begin
  if v_user_id is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user_id;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select branch_id into v_branch from public.deliveries
   where id = p_delivery_id and driver_id = v_driver_id;
  if not found then raise exception 'forbidden'; end if;
  perform private.dispatch_lock_branch(v_branch);

  select * into v_row from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;
  if v_row.accepted_at is not null then return; end if;
  if v_row.status <> 'assigned' then return; end if;

  if v_row.batch_id is null then
    update public.delivery_assignments
       set ended_at = now(), status = 'rejected', end_kind = 'rejected', end_reason = p_reason
     where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

    update public.deliveries
    set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
        dispatch_history = private.dispatch_history_append(dispatch_history,
          jsonb_build_object('type','rejected','at',now(),'reason',p_reason,'driver_id',v_driver_id,
                             'round',dispatch_round_started_at))
    where id = p_delivery_id;
    v_redispatch_id := p_delivery_id;
    perform private.record_driver_penalty(v_driver_id, 'reject', p_delivery_id);
  else
    for r in
      select id, batch_seq from public.deliveries
      where batch_id = v_row.batch_id and driver_id = v_driver_id and accepted_at is null
        and status = 'assigned'
      order by id
      for update
    loop
      update public.delivery_assignments
         set ended_at = now(), status = 'rejected', end_kind = 'rejected', end_reason = p_reason
       where delivery_id = r.id and driver_id = v_driver_id and ended_at is null;

      update public.deliveries
      set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
          dispatch_history = private.dispatch_history_append(dispatch_history,
            jsonb_build_object('type','rejected','at',now(),'reason',p_reason,'driver_id',v_driver_id,
                               'batch',true,'round',dispatch_round_started_at))
      where id = r.id;
      -- The cascade starts from stop 1 when it was released, else from any stop that was.
      if r.batch_seq = 1 or v_redispatch_id is null then v_redispatch_id := r.id; end if;
    end loop;
    v_redispatch_id := coalesce(v_redispatch_id, p_delivery_id);
    -- Explicit DECLINE of a stacked offer: penalty-free (bigger ask; Deliveroo model).
    -- TIMEOUT (client countdown lapsed): counts once — ignoring an offer strands
    -- customers regardless of batch-ness, matching the server sweep.
    if p_reason = 'timeout' then
      perform private.record_driver_penalty(v_driver_id, 'timeout', p_delivery_id);
    end if;
  end if;

  -- D2: the next rider, now. The stack stays a stack (claim_batch_sibling honours it).
  perform private.dispatch_delivery_safely(v_redispatch_id, 'auto');
end;
$function$;

-- Live body, except: per row, the branch lock is tried first (D4; a branch dispatching right now is
-- left for the next pass, 30 s later), the row is re-read under it, entries carry their round, and
-- the next rider is offered at once. p_branch_id limits a pass to one branch, like the sweep's; the
-- cron passes nothing (the old no-argument function is replaced, not overloaded).
drop function if exists private.expire_dispatch_offers();
create or replace function private.expire_dispatch_offers(p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  r record;
  v record;
  b record;
  v_redispatch_id uuid;
begin
  for r in
    select d.id, d.branch_id
    from public.deliveries d
    where d.status = 'assigned' and d.accepted_at is null
      and d.offer_expires_at is not null and d.offer_expires_at < now()
      and (p_branch_id is null or d.branch_id = p_branch_id)
    order by d.offer_expires_at, d.id
  loop
    continue when not private.dispatch_try_lock_branch(r.branch_id);

    -- A batch-mate processed earlier in this loop may have released this row already; a rider
    -- accepting it right now holds its lock, and is left alone.
    select d.id, d.driver_id, d.order_id, d.branch_id, d.batch_id into v
      from public.deliveries d
     where d.id = r.id and d.status = 'assigned' and d.accepted_at is null
       and d.offer_expires_at is not null and d.offer_expires_at < now()
       for update skip locked;
    continue when not found;

    if v.batch_id is null then
      update public.delivery_assignments
         set ended_at = now(), status = 'expired', end_kind = 'offer_expired'
       where delivery_id = v.id and driver_id = v.driver_id and ended_at is null;

      update public.deliveries
      set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
          dispatch_history = private.dispatch_history_append(dispatch_history,
            jsonb_build_object('type','offer_expired','driver_id', v.driver_id, 'at', now(),
                               'round', dispatch_round_started_at))
      where id = v.id;
      v_redispatch_id := v.id;
    else
      v_redispatch_id := null;
      for b in
        select id, batch_seq from public.deliveries
        where batch_id = v.batch_id and driver_id = v.driver_id and accepted_at is null
        order by id
      loop
        update public.delivery_assignments
           set ended_at = now(), status = 'expired', end_kind = 'offer_expired'
         where delivery_id = b.id and driver_id = v.driver_id and ended_at is null;

        update public.deliveries
        set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
            dispatch_history = private.dispatch_history_append(dispatch_history,
              jsonb_build_object('type','offer_expired','driver_id', v.driver_id, 'at', now(), 'batch', true,
                                 'round', dispatch_round_started_at))
        where id = b.id;
        if b.batch_seq = 1 then v_redispatch_id := b.id; end if;
      end loop;
      v_redispatch_id := coalesce(v_redispatch_id, v.id);
    end if;

    if v.driver_id is not null then
      perform private.record_driver_penalty(v.driver_id, 'timeout', v.id);
    end if;

    perform private.dispatch_delivery_safely(v_redispatch_id, 'auto');
  end loop;
end;
$function$;

-- Live body, except: the branch lock first; a job the rider had ACCEPTED goes back into a new round
-- (the search that found them succeeded; this is a new one, with its own window), and the rider who
-- cancelled is written into that round so they are not offered it again; an offer they had not
-- accepted yet continues its round. Then the next rider at once.
create or replace function public.driver_cancel_delivery(p_delivery_id uuid, p_reason text default 'driver_cancelled')
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_driver_id uuid;
  v_branch uuid;
  d record;
  v_round timestamptz;
  v_new_round boolean;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select branch_id into v_branch from public.deliveries
   where id = p_delivery_id and driver_id = v_driver_id;
  if not found then raise exception 'forbidden'; end if;
  perform private.dispatch_lock_branch(v_branch);

  select * into d from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;

  -- Cancelling any leg dissolves the pair: the other leg continues as a solo job
  -- and this one re-dispatches as a solo job.
  if d.batch_id is not null then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
  end if;

  if d.status = 'assigned' then
    -- Stamped BEFORE driver_id moves, so the trigger's coalesce keeps what the rider typed
    -- rather than overwriting it with the generic 'reassigned_by_staff'.
    update public.delivery_assignments
       set ended_at = now(), status = 'cancelled',
           end_kind = 'driver_cancelled', end_reason = v_reason
     where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

    v_new_round := d.accepted_at is not null or d.dispatch_round_started_at is null;
    v_round := case when v_new_round then clock_timestamp() else d.dispatch_round_started_at end;

    update public.deliveries
    set driver_id = null,
        status = 'dispatching',
        offered_at = null,
        offer_expires_at = null,
        accepted_at = null,
        dispatch_round_started_at = v_round,
        dispatch_state = 'searching',
        dispatch_attempts = case when v_new_round then 0 else dispatch_attempts end,
        dispatch_history = private.dispatch_history_append(dispatch_history,
          jsonb_build_object('type','driver_cancelled','driver_id', v_driver_id, 'reason', v_reason, 'at', now(),
                             'round', v_round))
    where id = p_delivery_id;

    update public.drivers
    set cooldown_until = now() + interval '10 minutes',
        reject_streak = reject_streak + 1
    where id = v_driver_id;

    perform private.dispatch_delivery_safely(p_delivery_id, 'auto');
  elsif d.status in ('picked_up','in_transit') then
    update public.delivery_assignments
       set ended_at = now(), status = 'failed',
           end_kind = 'driver_cancelled_after_pickup', end_reason = v_reason
     where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

    update public.deliveries
    set status = 'failed',
        failed_reason = v_reason,
        dispatch_history = private.dispatch_history_append(dispatch_history,
          jsonb_build_object('type','driver_cancelled_after_pickup','driver_id', v_driver_id, 'reason', v_reason, 'at', now()))
    where id = p_delivery_id;

    insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
    values (d.branch_id, 'staff', d.branch_id, 'in_app', 'delivery_returned',
            jsonb_build_object('delivery_id', d.id, 'order_id', d.order_id, 'reason', v_reason));
  else
    raise exception 'not_cancellable';
  end if;
end;
$function$;

-- Live body, except: the capability check, then the branch lock (D4); the requeued job starts a new
-- round (staff decided to try again) and is offered at once.
create or replace function public.requeue_failed_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_branch uuid;
  v_round timestamptz;
  d record;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select branch_id into v_branch from public.deliveries where id = p_delivery_id;
  if not found then raise exception 'not_found'; end if;

  if not private.staff_has_capability(v_branch, 'delivery.manage') then
    raise exception 'forbidden';
  end if;
  perform private.dispatch_lock_branch(v_branch);

  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;
  if d.status <> 'failed' then raise exception 'not_failed'; end if;

  -- A requeued job restarts solo; any old pairing is dissolved.
  if d.batch_id is not null then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
  end if;

  update public.delivery_assignments
     set ended_at   = coalesce(ended_at, now()),
         status     = 'failed',
         end_kind   = coalesce(end_kind, 'requeued_by_staff'),
         end_reason = coalesce(end_reason, d.failed_reason)
   where delivery_id = p_delivery_id and ended_at is null;

  v_round := clock_timestamp();
  update public.deliveries
  set status = 'dispatching',
      driver_id = null,
      accepted_at = null,
      offered_at = null,
      offer_expires_at = null,
      failed_reason = null,
      failed_photo_url = null,
      dispatch_round_started_at = v_round,
      dispatch_state = 'searching',
      dispatch_attempts = 0,
      dispatch_history = private.dispatch_history_append(dispatch_history,
        jsonb_build_object('type','requeued_by_staff','at', now(), 'round', v_round))
  where id = p_delivery_id;

  perform private.dispatch_delivery_safely(p_delivery_id, 'auto');
end;
$function$;

-- Live body, except: the delivery's round starts here, and the dispatch runs in this transaction
-- instead of over pg_net. The branch lock is taken before the delivery row is touched (D4). A
-- dispatch that fails is caught inside dispatch_delivery_safely: marking an order ready never fails
-- because of dispatch, and the row is left 'searching' for the sweep.
create or replace function public.orders_after_ready_dispatch()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_delivery_id uuid;
  v_branch uuid;
  v_mode text;
begin
  if (TG_OP <> 'UPDATE') then return new; end if;
  if new.status is not distinct from old.status then return new; end if;
  if new.status <> 'ready' then return new; end if;
  if new.channel <> 'delivery' then return new; end if;
  if new.held then return new; end if;

  select id, branch_id into v_delivery_id, v_branch from public.deliveries where order_id = new.id limit 1;
  if v_delivery_id is null then return new; end if;

  select coalesce(b.settings->>'delivery_mode', 'platform') into v_mode
    from public.branches b where b.id = new.branch_id;

  -- Self-delivery: mark it ready to go out and stop. Nothing is offered to the rider
  -- pool, and staff move it along from the Deliveries screen. Leaving it in
  -- 'dispatching' would show the merchant a job that is for ever waiting for a rider
  -- who is never coming.
  if v_mode = 'self' then
    update public.deliveries
       set status = 'assigned'
     where id = v_delivery_id and status in ('pending', 'dispatching');
    return new;
  end if;

  perform private.dispatch_lock_branch(v_branch);

  update public.deliveries
     set status = 'dispatching',
         dispatch_round_started_at = clock_timestamp(),
         dispatch_state = 'searching',
         dispatch_attempts = 0
   where id = v_delivery_id and status = 'pending';

  perform private.dispatch_delivery_safely(v_delivery_id, 'auto');

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 7. The other offer paths keep the same rules
-- ---------------------------------------------------------------------------------------------

-- Live body (20260904152000), except: the branch lock first, and the chosen rider's row locked
-- before the busy check (D4) — without both, a manual assign and an automatic offer could give one
-- rider two offers. The offer is stamped with the round (one is started if none is running) and
-- dispatch_state reads 'searching' while it is out.
create or replace function public.staff_assign_driver(p_delivery_id uuid, p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_branch uuid;
  d record; v_settings jsonb; v_ttl int; v_base numeric; v_perkm numeric;
  v_earnings numeric; v_now timestamptz := now(); v_expires timestamptz;
  v_tip numeric; v_pct numeric; v_net numeric; v_mode text; v_visible numeric;
  v_round timestamptz;
begin
  if v_user is null then raise exception 'auth_required'; end if;

  select branch_id into v_branch from public.deliveries where id = p_delivery_id;
  if not found then raise exception 'not_found'; end if;

  if not private.staff_has_capability(v_branch, 'delivery.manage') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  perform private.dispatch_lock_branch(v_branch);

  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;

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

  -- Waits for another branch's dispatch that is offering this rider right now, then sees its offer.
  perform 1 from public.drivers where id = p_driver_id for update;

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
  v_round := coalesce(d.dispatch_round_started_at, clock_timestamp());

  update public.deliveries
  set driver_id = p_driver_id, status = 'assigned', offered_at = v_now,
      offer_expires_at = v_expires, accepted_at = null, driver_earnings = v_earnings,
      net_tip = v_net, tip_visible_total = v_visible,
      dispatch_attempts = coalesce(dispatch_attempts, 0) + 1,
      dispatch_round_started_at = v_round,
      dispatch_state = 'searching',
      dispatch_history = private.dispatch_history_append(dispatch_history,
        jsonb_build_object('type','offered','manual',true,'driver_id',p_driver_id,'by_user',v_user,'at',v_now,
                           'round', v_round))
  where id = p_delivery_id;

  insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
  values (d.branch_id, 'driver', p_driver_id, 'push', 'new_dispatch',
          jsonb_build_object('delivery_id', d.id, 'order_id', d.order_id,
                             'distance_km', d.distance_km, 'earnings', v_earnings,
                             'net_tip', v_net, 'expires_in_seconds', v_ttl, 'manual', true));
end;
$function$;

-- Live body, except: an accepted job is out of its round (dispatch_state null), so the boards stop
-- reading it as a search; and only an open offer can be accepted. An offer whose order was cancelled
-- on the rider's screen keeps driver_id and loses its expiry (orders_cancel_syncs_delivery), so it
-- used to be accepted as a job; it now answers 'offer_gone', which FavorGO already reads as "this
-- offer moved on".
create or replace function public.accept_dispatch(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_driver_id uuid;
  v_row record;
  r record;
  v_accepted int := 0;
begin
  if v_user_id is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user_id;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select * into v_row from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;
  -- Repeated accept (client retry after a lost response) is a no-op.
  if v_row.accepted_at is not null then return; end if;
  if v_row.status <> 'assigned' then raise exception 'offer_gone'; end if;
  if v_row.offer_expires_at is not null and v_row.offer_expires_at <= now() then
    raise exception 'offer_expired';
  end if;

  if v_row.batch_id is null then
    update public.deliveries
    set dispatch_history = coalesce(dispatch_history, '[]'::jsonb) || jsonb_build_object('type','accepted','at',now()),
        assigned_at = now(), accepted_at = now(), offer_expires_at = null, dispatch_state = null
    where id = p_delivery_id;
  else
    for r in
      select id from public.deliveries
      where batch_id = v_row.batch_id and driver_id = v_driver_id and accepted_at is null
        and status = 'assigned'
      order by id
      for update
    loop
      update public.deliveries
      set dispatch_history = coalesce(dispatch_history, '[]'::jsonb) || jsonb_build_object('type','accepted','at',now(),'batch',true),
          assigned_at = now(), accepted_at = now(), offer_expires_at = null, dispatch_state = null
      where id = r.id;
      v_accepted := v_accepted + 1;
    end loop;

    -- Honest seq-2 ETA: first-stop leg added exactly once, and only for a full
    -- 2-leg batch acceptance.
    if v_accepted >= 2 then
      update public.deliveries s2
         set estimated_duration_min = coalesce(s2.estimated_duration_min, 0) + 4 +
             ceil(((ST_Distance(
               ST_SetSRID(ST_MakePoint(s1.dropoff_lng, s1.dropoff_lat), 4326)::geography,
               ST_SetSRID(ST_MakePoint(s2.dropoff_lng, s2.dropoff_lat), 4326)::geography
             ) / 1000.0) / 24.0) * 60.0)::int
        from public.deliveries s1
       where s2.batch_id = v_row.batch_id and s2.batch_seq = 2
         and s1.batch_id = v_row.batch_id and s1.batch_seq = 1
         and s1.dropoff_lat is not null and s1.dropoff_lng is not null
         and s2.dropoff_lat is not null and s2.dropoff_lng is not null;
    end if;
  end if;

  update public.drivers set reject_streak = 0 where id = v_driver_id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. Fair penalties (D3)
-- ---------------------------------------------------------------------------------------------

-- Live body, except: a rider is struck at most once per delivery, and a stack counts once — an
-- earlier strike for this delivery or the other stop of its stack, consumed or not, means no new
-- one. So a new round, or the same offer declined in the app and then expired by the sweep, never
-- strikes twice. The strikes that trip a cooldown are marked consumed instead of deleted: they
-- still stop counting towards the next cooldown, and this rule can still see them.
create or replace function private.record_driver_penalty(p_driver_id uuid, p_type text, p_delivery_id uuid default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_cfg jsonb := private.platform_json('penalty');
  v_threshold int := greatest(1, coalesce((v_cfg->>'threshold')::int, 2));
  v_window_hours numeric := greatest(1, coalesce((v_cfg->>'window_hours')::numeric, 24));
  v_cooldown_minutes numeric := greatest(1, coalesce((v_cfg->>'cooldown_minutes')::numeric, 60));
  v_count_rejects boolean := coalesce((v_cfg->>'count_rejects')::boolean, true);
  v_count_timeouts boolean := coalesce((v_cfg->>'count_timeouts')::boolean, true);
  v_count int;
begin
  if p_driver_id is null then return; end if;
  -- Only counted event types affect the penalty AND the flaky-driver score.
  if not ((p_type = 'reject' and v_count_rejects) or (p_type = 'timeout' and v_count_timeouts)) then return; end if;

  if p_delivery_id is not null and exists (
    select 1
      from public.driver_penalty_events e
     where e.driver_id = p_driver_id
       and e.delivery_id in (
             select p_delivery_id
             union
             select s.id
               from public.deliveries x
               join public.deliveries s on s.batch_id = x.batch_id
              where x.id = p_delivery_id and x.batch_id is not null)
  ) then
    return;
  end if;

  insert into public.driver_penalty_events (driver_id, type, delivery_id) values (p_driver_id, p_type, p_delivery_id);
  update public.drivers set reject_streak = reject_streak + 1 where id = p_driver_id;

  select count(*) into v_count from public.driver_penalty_events e
  where e.driver_id = p_driver_id
    and e.consumed_at is null
    and e.created_at >= now() - (v_window_hours * interval '1 hour')
    and ((e.type = 'reject' and v_count_rejects) or (e.type = 'timeout' and v_count_timeouts));

  if v_count >= v_threshold then
    update public.drivers
      set cooldown_until = greatest(coalesce(cooldown_until, now()), now() + (v_cooldown_minutes * interval '1 minute')),
          reject_streak = 0
    where id = p_driver_id;
    -- Consume the bucket so the next window starts fresh (needs `threshold` new
    -- strikes to re-trip, instead of 1 leftover + 1 new).
    update public.driver_penalty_events
       set consumed_at = now()
     where driver_id = p_driver_id and consumed_at is null;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 9. Staff entry point (D1, D6)
-- ---------------------------------------------------------------------------------------------

-- What dispatch-driver calls with the caller's own JWT, so the database sees who asked: delivery.manage
-- or kitchen.access at the delivery's branch (the edge function's my_capabilities rule; owners and
-- platform admins pass). The service role (no auth.uid(), JWT role service_role) is the trusted
-- internal caller. p_restart is "Find rider again".
create or replace function public.staff_dispatch_delivery(p_delivery_id uuid, p_restart boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_branch uuid;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select branch_id into v_branch from public.deliveries where id = p_delivery_id;
  if not found then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  if auth.uid() is not null
     and not (private.staff_has_capability(v_branch, 'delivery.manage')
              or private.staff_has_capability(v_branch, 'kitchen.access')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return private.dispatch_delivery(p_delivery_id,
                                   case when coalesce(p_restart, false) then 'staff_restart' else 'staff' end);
end;
$function$;

comment on function public.staff_dispatch_delivery(uuid, boolean) is
  'Staff "Find rider" (p_restart false: continue the round, or start one when none is running) and "Find rider again" (p_restart true: a new round, refused with result already_accepted once a rider accepted). delivery.manage or kitchen.access at the delivery''s branch, or the service role. Answers private.dispatch_delivery''s verdict.';

-- ---------------------------------------------------------------------------------------------
-- 10. Lift cooldown (D8)
-- ---------------------------------------------------------------------------------------------

-- drivers.cooldown_until is one value for the whole platform: dispatch at every branch the rider
-- works for reads it. So, like a KYC decision (set_driver_kyc_status), staff lift it only when they
-- hold drivers.manage at every branch where the rider is not rejected; a rider shared with a branch
-- they do not run is lifted by that branch's owner or a platform admin. Lifting clears the cooldown,
-- the streak (which demotes the rider in the ranking) and the strike window, so the rider starts
-- clean, and is written to audit_logs. Returns the cooldown end that was cleared, or null when
-- there was nothing to lift (it already ended, or someone lifted it first).
create or replace function public.lift_driver_cooldown(p_driver_id uuid, p_branch_id uuid, p_note text default null)
returns timestamptz
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_until timestamptz;
  v_admin boolean := private.user_is_platform_admin();
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if not private.staff_has_capability(p_branch_id, 'drivers.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.driver_approvals
                  where driver_id = p_driver_id and branch_id = p_branch_id and status <> 'rejected') then
    raise exception 'driver_not_at_branch' using errcode = 'P0002';
  end if;
  if not v_admin and exists (
       select 1 from public.driver_approvals da
        where da.driver_id = p_driver_id
          and da.status <> 'rejected'
          and not private.staff_has_capability(da.branch_id, 'drivers.manage')) then
    raise exception 'forbidden: cooldown_shared_with_other_branch'
      using errcode = '42501',
            hint = 'This rider also works with a branch you do not manage; that branch''s owner or a platform admin lifts it.';
  end if;

  select cooldown_until into v_until from public.drivers where id = p_driver_id for update;
  if v_until is null or v_until <= now() then
    return null;
  end if;

  update public.drivers set cooldown_until = null, reject_streak = 0 where id = p_driver_id;
  update public.driver_penalty_events set consumed_at = now()
   where driver_id = p_driver_id and consumed_at is null;

  insert into public.audit_logs (restaurant_id, branch_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  select b.restaurant_id, b.id, case when v_admin then 'platform_admin' else 'staff' end, auth.uid(),
         'driver_cooldown_lifted', 'driver', p_driver_id,
         jsonb_build_object('was_until', v_until, 'note', left(nullif(btrim(coalesce(p_note, '')), ''), 300))
    from public.branches b
   where b.id = p_branch_id;

  return v_until;
end;
$function$;

comment on function public.lift_driver_cooldown(uuid, uuid, text) is
  'Lift a rider''s cooldown early (docs/DISPATCH-FIXES-2026-10-05.md D8): a platform admin, or drivers.manage at every branch where the rider is not rejected. Clears cooldown_until, reject_streak and the strike window; writes audit_logs. Returns the cleared end, or null when there was nothing to lift.';

-- list_branch_riders gains cooldown_until (D7/D8: the board says until when). Everything else is the
-- live body; the return type changes, so it is dropped and created again.
drop function if exists public.list_branch_riders(uuid);
create function public.list_branch_riders(p_branch_id uuid)
returns table (
  driver_id uuid,
  full_name text,
  phone text,
  vehicle_type text,
  online boolean,
  kyc_verified boolean,
  cooling_down boolean,
  cooldown_until timestamptz,
  lat double precision,
  lng double precision,
  location_updated_at timestamptz,
  battery_level integer,
  active_delivery_id uuid
)
language plpgsql
stable
security definer
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
           case when d.cooldown_until > now() then d.cooldown_until end,
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

-- ---------------------------------------------------------------------------------------------
-- 11. The 30-second job: expire, then sweep
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from cron.job where jobname = 'expire-dispatch-offers') then
    perform cron.unschedule('expire-dispatch-offers');
  end if;
end $$;
select cron.schedule('expire-dispatch-offers', '30 seconds',
                     $$select private.expire_dispatch_offers(); select private.dispatch_sweep();$$);

-- ---------------------------------------------------------------------------------------------
-- 12. Grants. CREATE OR REPLACE keeps a function's grants; they are restated for the record.
-- ---------------------------------------------------------------------------------------------

revoke all on function private.dispatch_lock_branch(uuid) from public, anon, authenticated;
revoke all on function private.dispatch_try_lock_branch(uuid) from public, anon, authenticated;
revoke all on function private.dispatch_history_append(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.dispatch_setting(jsonb, text, numeric) from public, anon, authenticated;
revoke all on function private.dispatch_asked_riders(uuid[]) from public, anon, authenticated;
revoke all on function private.dispatch_funnel(uuid, numeric, uuid[]) from public, anon, authenticated;
revoke all on function private.dispatch_delivery(uuid, text) from public, anon, authenticated;
revoke all on function private.dispatch_delivery_safely(uuid, text) from public, anon, authenticated;
revoke all on function private.dispatch_sweep(uuid) from public, anon, authenticated;
revoke all on function private.expire_dispatch_offers(uuid) from public, anon, authenticated;
revoke all on function private.record_driver_penalty(uuid, text, uuid) from public, anon, authenticated;

revoke all on function public.claim_batch_sibling(uuid) from public, anon, authenticated;
grant execute on function public.claim_batch_sibling(uuid) to service_role;
revoke all on function public.stamp_batch_offer(uuid, uuid, timestamptz, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.stamp_batch_offer(uuid, uuid, timestamptz, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.deliveries_sync_assignments() from public, anon, authenticated;
revoke all on function public.orders_after_ready_dispatch() from public, anon, authenticated;
grant execute on function public.orders_after_ready_dispatch() to service_role;

revoke all on function public.reject_dispatch(uuid, text) from public, anon;
grant execute on function public.reject_dispatch(uuid, text) to authenticated, service_role;
revoke all on function public.accept_dispatch(uuid) from public, anon;
grant execute on function public.accept_dispatch(uuid) to authenticated, service_role;
revoke all on function public.driver_cancel_delivery(uuid, text) from public, anon;
grant execute on function public.driver_cancel_delivery(uuid, text) to authenticated, service_role;
revoke all on function public.requeue_failed_delivery(uuid) from public, anon;
grant execute on function public.requeue_failed_delivery(uuid) to authenticated, service_role;
revoke all on function public.staff_assign_driver(uuid, uuid) from public, anon;
grant execute on function public.staff_assign_driver(uuid, uuid) to authenticated, service_role;

revoke all on function public.staff_dispatch_delivery(uuid, boolean) from public, anon;
grant execute on function public.staff_dispatch_delivery(uuid, boolean) to authenticated, service_role;
revoke all on function public.lift_driver_cooldown(uuid, uuid, text) from public, anon;
grant execute on function public.lift_driver_cooldown(uuid, uuid, text) to authenticated;
revoke all on function public.list_branch_riders(uuid) from public, anon;
grant execute on function public.list_branch_riders(uuid) to authenticated, service_role;
