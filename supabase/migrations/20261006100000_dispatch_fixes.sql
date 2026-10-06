-- Rider dispatch fixes after the review of 20261005100000_dispatch_in_database
-- (docs/DISPATCH-FIXES-2026-10-05.md; review findings DL-1..4, CONC-1..8, BE-2).
--
-- What was wrong, on the live project on 2026-10-06:
--   DL-1 / CONC-1  The expiry of a stacked offer released every stop of the stack offered to that
--                  rider, whatever its status. A stop whose order had been cancelled while the offer
--                  was on the rider's screen (cancelled, rider still on it) was flipped back to
--                  'dispatching' and offered, with the live stop, to the next rider.
--   DL-4           Redispatch of a failed delivery offered it again even when its order had been
--                  cancelled or refunded during the trip.
--   BE-2 / CONC-2  An order taken back from 'ready' (Recall, Undo) kept its round and its rider's
--                  offer; the sweep went on offering food the kitchen was remaking, and the next
--                  Ready continued the old round instead of starting one. Nothing in dispatch read
--                  the order's status at all.
--   DL-2           A newly ready order could be stacked with one whose round had already asked
--                  every rider: the stack took the union of both rounds' exclusions and the new
--                  order was never offered to anyone, though every rider was free (the owner's
--                  complaint #5).
--   DL-3           "Find rider again" while an offer was out withdrew it and, in the same breath,
--                  offered the same unresponsive rider again (he was still the best candidate).
--   CONC-8         A free rider skipped because another transaction held his row for a moment (his
--                  own GPS write, another branch's dispatch) was reported as "every rider is busy",
--                  and on the first pass after the search window that closed the round.
--   CONC-3/4/5     Lock order. set_driver_location locked the rider's row, then his deliveries; the
--                  dispatch paths lock deliveries, then the rider. accept_dispatch took no branch lock
--                  and locked the row it was given before the rest of the stack. The ready trigger
--                  row-locked a delivery a rider had already accepted (the rider's "picked up" locks
--                  the delivery, then the order). Each pair could deadlock.
--   CONC-6         The 30-second expiry scanned the whole deliveries table.
--   CONC-7         A rider's offer push waited for the once-a-minute notify worker: on average 30 s
--                  of a 75-second offer, up to a minute, so a locked phone missed offers and earned
--                  timeout strikes.
--
-- What this does:
--   * One lock order everywhere: (the order row) -> the branch's dispatch lock -> the unit's
--     deliveries in id order -> the rider's row. accept_dispatch, reject_dispatch and
--     driver_cancel_delivery take the branch lock and then the whole stack in id order;
--     set_driver_location writes the deliveries first and skips one another transaction holds;
--     progress_delivery locks the order before the delivery when the step will move the order;
--     dispatch_delivery answers an accepted job from a plain read, before it locks any row.
--   * Only a ready order goes to a rider. dispatch_delivery refuses a stop whose order is closed
--     (cancelled, refunded, completed: 'order_closed') or not ready yet ('kitchen_not_ready'); a
--     requeued trip whose food is already out ('out_for_delivery') is the one exception. The sweep
--     only looks at ready orders, and claim_batch_sibling keeps or forms a stack only of live,
--     ready orders.
--   * An order leaving 'ready' backwards (Recall, Undo) withdraws an open offer without a strike,
--     ends the round and puts the delivery back to 'pending', so the next Ready starts a fresh round.
--     A stack is dissolved and its other stop offered on its own. A job a rider accepted is left alone.
--   * A stack never inherits exclusions: a new pair is formed only of two stops whose rounds have
--     asked nobody yet, and a stack that finds no rider while one of its stops has asked fewer riders
--     on its own is broken up and each stop dispatched alone.
--   * A staff restart that withdraws an open offer does not offer it to the withdrawn rider in the
--     same step. He is not written into the new round (a new round may ask everyone again), so the
--     next step can come back to him if nobody else answers.
--   * A rider who passes every gate but could not be taken this step (his row locked, or just
--     withdrawn) is "searching", not "busy": the round stays open and the next sweep tries again.
--   * A partial index for the expiry scan.
--   * An offer push kicks the notify worker (scope 'offers') when the transaction that queued it
--     commits, through pg_net, when private.app_settings.notify_worker_url is set.
--
-- Every function replaced here was read with pg_get_functiondef first; set_driver_location and
-- progress_delivery never lived in this directory and are copied from the live bodies. Each keeps
-- the live body except where a comment says otherwise. private.app_settings is not written here.

-- ---------------------------------------------------------------------------------------------
-- 1. The expiry's index (CONC-6)
-- ---------------------------------------------------------------------------------------------

-- What private.expire_dispatch_offers scans every 30 seconds: open offers past their expiry, across
-- every branch. The sweep's own scan is served by deliveries_dispatch_open_idx (20261005100000).
create index if not exists deliveries_open_offer_expiry_idx
  on public.deliveries (offer_expires_at)
  where status = 'assigned' and accepted_at is null and offer_expires_at is not null;

-- ---------------------------------------------------------------------------------------------
-- 2. Stacks: only live, ready orders, and never two rounds' exclusions (DL-1, DL-2, BE-2)
-- ---------------------------------------------------------------------------------------------

-- 20261005100000's body, except:
--   * an existing stack is honoured only while both stops' orders are still live (ready, or out for
--     delivery on a requeued trip); a stop whose order closed or went back to the kitchen dissolves it;
--   * a new pair is formed only of two READY orders, neither of which has asked a rider yet in its
--     current round. The stack's exclusion is the union of both stops' rounds (D5), so pairing with
--     a stop that had already asked riders took their exclusions on for the other stop as well: a
--     fresh order stacked with one every rider had declined was never offered to anyone (DL-2).
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

  -- Existing batch: honor it only while BOTH legs are still live and unassigned, and both orders
  -- are still with the dispatch (2026-10-06); a half-dissolved pair (cancel/requeue/order-cancel/
  -- recall of one leg) is cleaned up.
  if d.batch_id is not null then
    select count(*) into v_n
      from public.deliveries x
      join public.orders o on o.id = x.order_id
     where x.batch_id = d.batch_id and x.status = 'dispatching' and x.driver_id is null
       and o.status in ('ready', 'out_for_delivery');
    if v_n = 2 then
      return jsonb_build_object('batch_id', d.batch_id);
    end if;
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
    return null;
  end if;

  if d.status <> 'dispatching' or d.driver_id is not null then return null; end if;
  if d.dropoff_lat is null or d.dropoff_lng is null then return null; end if;
  -- 2026-10-06: a new stack starts only from a ready order whose round has asked nobody yet.
  if not exists (select 1 from public.orders o where o.id = d.order_id and o.status = 'ready') then
    return null;
  end if;
  if coalesce(array_length(private.dispatch_asked_riders(array[d.id]), 1), 0) > 0 then
    return null;
  end if;

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
    join public.orders o2 on o2.id = d2.order_id
    where d2.branch_id = d.branch_id
      and d2.id <> d.id
      and d2.status = 'dispatching'
      and d2.driver_id is null
      and d2.batch_id is null
      and d2.dropoff_lat is not null and d2.dropoff_lng is not null
      -- 2026-10-05: only a sibling whose own round is still looking for a rider.
      and d2.dispatch_round_started_at is not null
      and d2.dispatch_state in ('searching', 'waiting')
      -- 2026-10-06: whose order the kitchen has marked ready (a recalled one is cooking again),
      -- and whose round has asked nobody yet (its exclusions would become this order's).
      and o2.status = 'ready'
      and coalesce(array_length(private.dispatch_asked_riders(array[d2.id]), 1), 0) = 0
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

-- ---------------------------------------------------------------------------------------------
-- 3. One dispatch step
-- ---------------------------------------------------------------------------------------------

-- 20261005100000's body, except (2026-10-06):
--   * CONC-4: an accepted job is answered from a plain read under the branch lock, before any
--     delivery row is locked. The ready trigger holds the order row; a rider's "picked up" locks
--     the delivery and then the order; locking an accepted delivery here closed that circle.
--     accept_dispatch now takes the branch lock too, so under it the read cannot go stale.
--   * DL-1, DL-4, BE-2: the order must be ready (or out for delivery: a requeued trip). A closed
--     order answers not_dispatchable 'order_closed', one still cooking 'kitchen_not_ready'.
--   * DL-3: a staff restart that withdraws an open offer leaves the withdrawn rider out of this
--     step's search (not out of the new round).
--   * CONC-8: a rider who passed every gate but could not be taken (row locked by another
--     transaction, or the rider just withdrawn) is not "busy": the row stays searching, the round
--     is never closed on such a pass, and the answer is waiting / 'retry_shortly'.
--   * DL-2: a stack that finds no rider while one of its stops has asked fewer riders on its own is
--     broken up, and each stop is dispatched alone (the asked one first). Waiting and no-rider
--     entries carry each stop's own asked count.
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
  v_skip      uuid[] := '{}'::uuid[];
  v_order_st  text;
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
  v_res       jsonb;
  v_also      jsonb := '[]'::jsonb;
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

  -- The unit: this delivery, or both stops of its stack. batch_id only moves under the branch
  -- lock, so reading it first is safe.
  select * into d from public.deliveries where id = p_delivery_id;
  select array_agg(x.id order by x.batch_seq nulls first, x.id) into v_ids
    from public.deliveries x
   where x.id = d.id or (d.batch_id is not null and x.batch_id = d.batch_id);

  -- Already in a rider's hands. D6: a restart never takes an accepted job away. CONC-4: answered
  -- before any row is locked; accepted_at only moves under the branch lock, which this holds.
  select x.status::text as status into r
    from public.deliveries x
   where x.id = any (v_ids) and x.accepted_at is not null
     and x.status in ('assigned', 'picked_up', 'in_transit')
   limit 1;
  if found then
    return jsonb_build_object('ok', false, 'result', 'already_accepted', 'delivery_status', r.status,
                              'driver_id', d.driver_id, 'delivery_ids', to_jsonb(v_ids),
                              'asked_count', coalesce(array_length(private.dispatch_asked_riders(v_ids), 1), 0));
  end if;

  -- The unit locked in id order.
  perform 1 from public.deliveries x
    where x.id = any (v_ids)
    order by x.id
    for update;
  select * into d from public.deliveries where id = p_delivery_id;

  if d.status not in ('pending', 'dispatching', 'assigned') then
    return jsonb_build_object('ok', false, 'result', 'not_dispatchable', 'reason', d.status::text,
                              'delivery_status', d.status, 'delivery_ids', to_jsonb(v_ids), 'asked_count', 0);
  end if;

  -- Only a ready order goes to a rider (2026-10-06). A closed one never does, whatever its delivery
  -- row says (DL-1, DL-4); one the kitchen took back is cooking again (BE-2). A requeued trip whose
  -- food is already out ('out_for_delivery') still needs a rider.
  select o.status::text into v_order_st from public.orders o where o.id = d.order_id;
  if v_order_st in ('cancelled', 'refunded', 'completed') then
    return jsonb_build_object('ok', false, 'result', 'not_dispatchable', 'reason', 'order_closed',
                              'order_status', v_order_st, 'delivery_status', d.status,
                              'delivery_ids', to_jsonb(v_ids), 'asked_count', 0);
  end if;
  if v_order_st is distinct from 'ready' and v_order_st is distinct from 'out_for_delivery' then
    return jsonb_build_object('ok', false, 'result', 'not_dispatchable', 'reason', 'kitchen_not_ready',
                              'order_status', v_order_st, 'delivery_status', d.status,
                              'delivery_ids', to_jsonb(v_ids), 'asked_count', 0);
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

      -- DL-3: staff moved it on from this rider; this step asks someone else first.
      if not (r.driver_id = any (v_skip)) then
        v_skip := v_skip || r.driver_id;
      end if;
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
    -- No round yet (a row from before rounds, a staff tap before the ready trigger ran): one starts.
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

  -- The best rider not asked in this round (nor withdrawn by staff in this step). find_dispatch_
  -- candidates reads this transaction's own offers, so a rider offered a moment ago in this
  -- transaction is already busy to it.
  for c in select * from public.find_dispatch_candidates(v_branch, v_radius, v_asked || v_skip) loop
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
    -- The funnel counts the round's exclusions only: a rider withdrawn in this step (DL-3) or
    -- skipped because his row was locked (CONC-8) still counts as available.
    v_funnel := private.dispatch_funnel(v_branch, v_radius, v_asked);
    v_reason := v_funnel ->> 'reason';
    select max(x.dispatch_round_started_at) into v_latest
      from public.deliveries x where x.id = any (v_ids);

    if v_reason is null then
      -- Someone passed every gate but could not be taken this step. That is not "every rider is
      -- busy", and it never ends a round: the row reads searching and the next sweep (30 s) tries
      -- again.
      v_reason := 'retry_shortly';
      v_diag := coalesce(public.dispatch_candidate_diagnostics(v_branch, v_radius), '{}'::jsonb)
                || jsonb_build_object('cooling_down', (v_funnel ->> 'cooling_down')::int,
                                      'already_asked', v_asked_n,
                                      'available', (v_funnel ->> 'available')::int,
                                      'funnel', v_funnel - 'reason',
                                      'reason', v_reason);
      update public.deliveries
         set dispatch_state = 'searching'
       where id = any (v_ids) and status in ('pending', 'dispatching') and driver_id is null
         and dispatch_state is distinct from 'searching';
      return jsonb_build_object('ok', true, 'result', 'waiting', 'reason', v_reason,
                                'delivery_ids', to_jsonb(v_ids), 'batch_id', v_batch,
                                'asked_count', v_asked_n, 'diagnostics', v_diag,
                                'round_started_at', v_latest);
    end if;

    -- DL-2: a stack never keeps a stop from a rider it could have on its own. When one stop has
    -- asked fewer riders than the stack's union (a pair formed before 2026-10-06, or any other way
    -- the rounds came apart), the stack is broken up and each stop dispatched alone, this one first.
    if v_batch is not null and exists (
         select 1 from unnest(v_ids) s(id)
          where coalesce(array_length(private.dispatch_asked_riders(array[s.id]), 1), 0) < v_asked_n) then
      update public.deliveries set batch_id = null, batch_seq = null where batch_id = v_batch;
      v_res := private.dispatch_delivery(d.id, 'auto');
      for r in select s.id from unnest(v_ids) s(id) where s.id <> d.id order by s.id loop
        v_claim := private.dispatch_delivery(r.id, 'auto');
        v_also := v_also || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                    'delivery_id', r.id, 'result', v_claim ->> 'result', 'driver_id', v_claim -> 'driver_id',
                    'reason', v_claim -> 'reason')));
      end loop;
      return v_res || jsonb_build_object('unstacked', jsonb_build_object('batch_id', v_batch, 'others', v_also));
    end if;

    v_diag := coalesce(public.dispatch_candidate_diagnostics(v_branch, v_radius), '{}'::jsonb)
              || jsonb_build_object('cooling_down', (v_funnel ->> 'cooling_down')::int,
                                    'already_asked', v_asked_n,
                                    'available', (v_funnel ->> 'available')::int,
                                    'funnel', v_funnel - 'reason',
                                    'reason', v_reason);

    if v_latest is not null and v_latest + v_window * interval '1 minute' <= clock_timestamp() then
      -- The window is over and nobody is left to offer it to: the round ends. Staff are told as
      -- they were when max_attempts_reached (template dispatch_failed), once per stop.
      for r in
        select x.id, x.order_id, x.dispatch_round_started_at,
               coalesce(array_length(private.dispatch_asked_riders(array[x.id]), 1), 0) as asked
          from public.deliveries x
         where x.id = any (v_ids) and x.status in ('pending', 'dispatching') and x.driver_id is null
         order by x.id
      loop
        update public.deliveries
           set dispatch_state = 'no_rider_found',
               dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
                 'type', 'no_rider_found', 'at', clock_timestamp(), 'round', r.dispatch_round_started_at,
                 'reason', v_reason, 'asked', r.asked))
         where id = r.id and status in ('pending', 'dispatching') and driver_id is null;

        insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
        values (v_branch, 'staff', v_branch, 'in_app', 'dispatch_failed',
                jsonb_build_object('delivery_id', r.id, 'order_id', r.order_id,
                                   'reason', 'no_rider_found', 'detail', v_reason, 'asked', r.asked));
      end loop;

      return jsonb_build_object('ok', false, 'result', 'no_rider_found', 'reason', v_reason,
                                'delivery_ids', to_jsonb(v_ids), 'batch_id', v_batch,
                                'asked_count', v_asked_n, 'diagnostics', v_diag,
                                'round_started_at', v_latest);
    end if;

    -- Waiting: the sweep keeps looking. Written only when the state or the reason changes, so a
    -- 30-second sweep does not churn the row (and every realtime subscriber) for nothing.
    for r in
      select x.id, x.dispatch_state, x.dispatch_round_started_at, x.dispatch_history -> -1 as last,
             coalesce(array_length(private.dispatch_asked_riders(array[x.id]), 1), 0) as asked
        from public.deliveries x
       where x.id = any (v_ids) and x.status in ('pending', 'dispatching') and x.driver_id is null
       order by x.id
    loop
      if r.dispatch_state is distinct from 'waiting'
         or coalesce(r.last ->> 'type', '') <> 'waiting'
         or coalesce(r.last ->> 'reason', '') <> v_reason
         or coalesce((r.last ->> 'asked')::int, -1) <> r.asked then
        update public.deliveries
           set dispatch_state = 'waiting',
               dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
                 'type', 'waiting', 'at', clock_timestamp(), 'round', r.dispatch_round_started_at,
                 'reason', v_reason, 'asked', r.asked))
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
  'One dispatch step under the branch lock (docs/DISPATCH-FIXES-2026-10-05.md D1-D6; fixes 20261006100000). Modes auto / staff / staff_restart. Answers {ok, result: offered|offered_batch|waiting|no_rider_found|already_accepted|not_dispatchable, driver_id?, delivery_ids, batch_id?, offer_expires_at?, asked_count, diagnostics?, reason?}. not_dispatchable reasons include order_closed and kitchen_not_ready; waiting reason retry_shortly means a rider is free but could not be taken this step (the row stays searching).';

-- ---------------------------------------------------------------------------------------------
-- 4. The sweep: ready orders only (BE-2)
-- ---------------------------------------------------------------------------------------------

-- 20261005100000's body, except that a delivery whose order is not with the dispatch (still cooking
-- after a recall, or closed) is not looked at.
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
      join public.orders o on o.id = x.order_id
     where x.status in ('pending', 'dispatching')
       and x.driver_id is null
       and x.dispatch_round_started_at is not null
       and x.dispatch_state in ('searching', 'waiting')
       and o.status in ('ready', 'out_for_delivery')
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
  'pg_cron expire-dispatch-offers (every 30 s, after private.expire_dispatch_offers): one dispatch step for every delivery in an open round with no offer out whose order is ready (or out for delivery on a requeued trip), oldest round first; closes rounds past dispatch_search_window_min. Returns the number offered or closed.';

-- ---------------------------------------------------------------------------------------------
-- 5. The paths that release an offer
-- ---------------------------------------------------------------------------------------------

-- 20261005100000's body, except (DL-1 / CONC-1): a stack's expiry releases only the stops that are
-- still an open offer to that rider. A stop whose order was cancelled while the offer was on the
-- rider's screen is 'cancelled' with the rider still on it, and used to be flipped back to
-- 'dispatching' and offered, with the live stop, to the next rider. Every release is guarded the
-- way reject_dispatch's is.
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
      where id = v.id and status = 'assigned' and accepted_at is null and driver_id = v.driver_id;
      v_redispatch_id := v.id;
    else
      v_redispatch_id := null;
      for b in
        select id, batch_seq from public.deliveries
        where batch_id = v.batch_id and driver_id = v.driver_id and accepted_at is null
          and status = 'assigned'
        order by id
        for update
      loop
        update public.delivery_assignments
           set ended_at = now(), status = 'expired', end_kind = 'offer_expired'
         where delivery_id = b.id and driver_id = v.driver_id and ended_at is null;

        update public.deliveries
        set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
            dispatch_history = private.dispatch_history_append(dispatch_history,
              jsonb_build_object('type','offer_expired','driver_id', v.driver_id, 'at', now(), 'batch', true,
                                 'round', dispatch_round_started_at))
        where id = b.id and status = 'assigned' and accepted_at is null and driver_id = v.driver_id;
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

-- 20261005100000's body, except (CONC-5): after the branch lock, the whole stack is locked in id
-- order before the row the rider declined is read, as every dispatch path does.
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
  v_batch uuid;
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

  select batch_id into v_batch from public.deliveries where id = p_delivery_id;
  perform 1 from public.deliveries x
   where x.id = p_delivery_id or (v_batch is not null and x.batch_id = v_batch)
   order by x.id
   for update;

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

-- 20261005100000's body, except (CONC-5): the branch lock first, then the whole stack in id order,
-- then the rider's row (the streak reset at the end): the order every dispatch path takes them in.
-- It took no branch lock and locked the row it was handed before the rest of the stack, so an
-- Accept passing stop 2 could deadlock with a staff restart or the expiry locking stop 1 first.
-- Under the branch lock an accept also cannot slip between dispatch_delivery's plain read of
-- accepted_at and its row locks (CONC-4).
create or replace function public.accept_dispatch(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_driver_id uuid;
  v_branch uuid;
  v_batch uuid;
  v_row record;
  r record;
  v_accepted int := 0;
begin
  if v_user_id is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user_id;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select branch_id into v_branch from public.deliveries
   where id = p_delivery_id and driver_id = v_driver_id;
  if not found then raise exception 'forbidden'; end if;
  perform private.dispatch_lock_branch(v_branch);

  select batch_id into v_batch from public.deliveries where id = p_delivery_id;
  perform 1 from public.deliveries x
   where x.id = p_delivery_id or (v_batch is not null and x.batch_id = v_batch)
   order by x.id
   for update;

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

-- 20261005100000's body, except (CONC-5): after the branch lock, the whole stack is locked in id
-- order before this row is read (cancelling one stop dissolves the pair, which writes the other).
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
  v_batch uuid;
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

  select batch_id into v_batch from public.deliveries where id = p_delivery_id;
  perform 1 from public.deliveries x
   where x.id = p_delivery_id or (v_batch is not null and x.batch_id = v_batch)
   order by x.id
   for update;

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

-- 20261005100000's body, except (DL-4): a failed trip whose order has since been closed (cancelled
-- or refunded while the food was out, or completed by hand) is refused with 'order_closed' instead
-- of being offered to the next rider, who would be paid for delivering a refunded order; and the
-- unit is locked in id order after the branch lock.
create or replace function public.requeue_failed_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_branch uuid;
  v_batch uuid;
  v_round timestamptz;
  v_order_st text;
  d record;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select branch_id into v_branch from public.deliveries where id = p_delivery_id;
  if not found then raise exception 'not_found'; end if;

  if not private.staff_has_capability(v_branch, 'delivery.manage') then
    raise exception 'forbidden';
  end if;
  perform private.dispatch_lock_branch(v_branch);

  select batch_id into v_batch from public.deliveries where id = p_delivery_id;
  perform 1 from public.deliveries x
   where x.id = p_delivery_id or (v_batch is not null and x.batch_id = v_batch)
   order by x.id
   for update;

  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;
  if d.status <> 'failed' then raise exception 'not_failed'; end if;

  select o.status::text into v_order_st from public.orders o where o.id = d.order_id;
  if v_order_st in ('cancelled', 'refunded', 'completed') then
    raise exception 'order_closed'
      using errcode = 'P0001',
            detail = v_order_st,
            hint = 'The order is closed; there is nothing left to deliver.';
  end if;

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

-- ---------------------------------------------------------------------------------------------
-- 6. The order's status drives the round (BE-2, CONC-2)
-- ---------------------------------------------------------------------------------------------

-- 20261005100000's body, except: a delivery the dispatch had released before the kitchen was ready
-- (a rider handed back a job he had accepted early, a manual offer lapsed: 'dispatching', nobody on
-- it) starts its round now too. D2: a round starts when the order is ready. A delivery a rider has
-- accepted is not matched, so it is not row-locked here (CONC-4); dispatch_delivery answers it
-- already_accepted from a plain read.
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
   where id = v_delivery_id
     and (status = 'pending'
          or (status = 'dispatching' and driver_id is null and accepted_at is null));

  perform private.dispatch_delivery_safely(v_delivery_id, 'auto');

  return new;
end;
$function$;

-- An order leaving 'ready' backwards (the kitchen's Recall within 5 minutes, or Undo) is cooking
-- again: no rider should be riding to it, and the search should start over when it is ready again.
-- Under the branch lock, an offer that is out is withdrawn without a strike (end_kind
-- reassigned_by_staff, reason order_recalled), the round ends and the delivery goes back to
-- 'pending', so the next Ready opens a fresh round. A stack is dissolved and its other stop, still
-- ready, is offered on its own at once (the rider whose stack offer was withdrawn has had his turn
-- in that stop's round, as D2 says of any withdrawn offer). A job a rider has accepted is left with
-- him: the kitchen shows his name on the card.
create or replace function private.orders_unready_withdraws_dispatch()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_uid      uuid := auth.uid();
  v_delivery uuid;
  v_branch   uuid;
  v_batch    uuid;
  v_others   uuid[];
  v_other    uuid;
  r          record;
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if old.status is distinct from 'ready' or new.status not in ('pending', 'confirmed', 'preparing') then
    return new;
  end if;
  if new.channel is distinct from 'delivery' then return new; end if;

  select x.id, x.branch_id into v_delivery, v_branch
    from public.deliveries x where x.order_id = new.id limit 1;
  if v_delivery is null then return new; end if;

  -- Only a delivery the dispatch is working on: in a round, or with an offer out, and nobody has
  -- accepted it. A self-delivery row ('assigned', nobody on it, no round) is the branch's own.
  if not exists (select 1 from public.deliveries x
                  where x.id = v_delivery and x.accepted_at is null
                    and x.status in ('pending', 'dispatching', 'assigned')
                    and (x.dispatch_round_started_at is not null or x.driver_id is not null
                         or x.status = 'dispatching')) then
    return new;
  end if;

  perform private.dispatch_lock_branch(v_branch);

  select x.batch_id into v_batch from public.deliveries x where x.id = v_delivery;
  -- A rider accepted (this stop, or the stack) before the lock was ours: his job stands.
  if exists (select 1 from public.deliveries x
              where (x.id = v_delivery or (v_batch is not null and x.batch_id = v_batch))
                and x.accepted_at is not null
                and x.status in ('assigned', 'picked_up', 'in_transit')) then
    return new;
  end if;

  perform 1 from public.deliveries x
   where x.id = v_delivery or (v_batch is not null and x.batch_id = v_batch)
   order by x.id
   for update;

  -- The offer that is out (both stops of a stack were offered together): withdrawn, no strike.
  for r in
    select x.id, x.driver_id, x.dispatch_round_started_at
      from public.deliveries x
     where (x.id = v_delivery or (v_batch is not null and x.batch_id = v_batch))
       and x.status = 'assigned' and x.accepted_at is null and x.driver_id is not null
     order by x.id
  loop
    update public.delivery_assignments
       set ended_at = now(), status = 'reassigned', end_kind = 'reassigned_by_staff',
           end_reason = 'order_recalled'
     where delivery_id = r.id and driver_id = r.driver_id and ended_at is null;

    update public.deliveries
       set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
           dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
             'type', 'withdrawn', 'reason', 'order_recalled', 'driver_id', r.driver_id,
             'at', clock_timestamp(), 'round', r.dispatch_round_started_at, 'by_user', v_uid))
     where id = r.id and status = 'assigned' and accepted_at is null and driver_id = r.driver_id;
  end loop;

  -- The stack is over; its other stop goes on alone.
  if v_batch is not null then
    select array_agg(x.id order by x.id) into v_others
      from public.deliveries x where x.batch_id = v_batch and x.id <> v_delivery;
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = v_batch;
  end if;

  -- This stop waits for the kitchen again, outside any round.
  update public.deliveries
     set status = 'pending',
         dispatch_round_started_at = null,
         dispatch_state = null,
         dispatch_attempts = 0,
         dispatch_history = private.dispatch_history_append(dispatch_history, jsonb_build_object(
           'type', 'recalled', 'at', clock_timestamp(), 'round', dispatch_round_started_at,
           'order_status', new.status::text, 'by_user', v_uid))
   where id = v_delivery and status in ('pending', 'dispatching') and driver_id is null;

  foreach v_other in array coalesce(v_others, '{}'::uuid[]) loop
    perform private.dispatch_delivery_safely(v_other, 'auto');
  end loop;

  return new;
end;
$function$;

drop trigger if exists orders_unready_withdraws_dispatch on public.orders;
create trigger orders_unready_withdraws_dispatch
  after update of status on public.orders
  for each row
  when (old.status = 'ready' and new.status in ('pending', 'confirmed', 'preparing'))
  execute function private.orders_unready_withdraws_dispatch();

-- ---------------------------------------------------------------------------------------------
-- 7. The rider's own writes keep the same lock order (CONC-3, CONC-4)
-- ---------------------------------------------------------------------------------------------

-- Live body, except (CONC-3): the rider's deliveries are written first and his own row last, the
-- order every dispatch path locks them in; and a delivery another transaction holds right now (an
-- accept, a decline, the expiry, a dispatch) is skipped instead of waited on: that row gets the next
-- fix, three seconds later. The ping used to lock the rider's row and then wait on his open offer
-- while his own Accept held the offer and waited on his row: a deadlock, and the loser's write
-- (the ping, the accept, or the whole 30-second expiry tick) was rolled back.
create or replace function public.set_driver_location(p_driver_id uuid, p_lng double precision, p_lat double precision, p_battery integer default null::integer)
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
     and d.status in ('assigned', 'picked_up', 'in_transit')
     and d.id in (select x.id
                    from public.deliveries x
                   where x.driver_id = p_driver_id
                     and x.status in ('assigned', 'picked_up', 'in_transit')
                   order by x.id
                   for no key update skip locked);

  update public.drivers
     set current_location = v_point,
         location_updated_at = now(),
         battery_level = coalesce(p_battery, battery_level)
   where id = p_driver_id;
end;
$function$;

-- Live body, except (CONC-4): when this step moves the order too (picked up -> out for delivery,
-- delivered -> completed, through deliveries_sync_order_status), the order row is locked before the
-- delivery row, the order the kitchen's Ready and Recall, and an order's cancellation, take them in.
-- The other way round, "picked up" held the delivery and waited on the order while the kitchen held
-- the order and waited on the delivery.
create or replace function public.progress_delivery(p_delivery_id uuid, p_next delivery_status)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_driver_id uuid;
  v_order_id uuid;
  v_cur delivery_status;
  v_accepted timestamptz;
  v_pickup_photo text;
  v_pod_photo text;
begin
  if v_user_id is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user_id;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select order_id into v_order_id
    from public.deliveries
   where id = p_delivery_id and driver_id = v_driver_id;
  if not found then raise exception 'forbidden'; end if;
  if p_next in ('picked_up', 'delivered') then
    perform 1 from public.orders where id = v_order_id for no key update;
  end if;

  select status, accepted_at, pickup_photo_url, pod_photo_url
    into v_cur, v_accepted, v_pickup_photo, v_pod_photo
  from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;

  -- Idempotency: re-issuing the current status (e.g. a double-tap) is a no-op, not an error.
  if v_cur = p_next then return; end if;

  -- The job must actually be accepted before any stage progression.
  if v_accepted is null then raise exception 'not_accepted'; end if;

  -- Only legal forward transitions.
  if not (
       (v_cur = 'assigned'   and p_next = 'picked_up')
    or (v_cur = 'picked_up'  and p_next = 'in_transit')
    or (v_cur = 'in_transit' and p_next = 'delivered')
  ) then
    raise exception 'illegal_transition_% _to_%', v_cur, p_next;
  end if;

  -- Proof of pickup is mandatory before picked_up.
  if p_next = 'picked_up' and coalesce(v_pickup_photo, '') = '' then
    raise exception 'pickup_photo_required';
  end if;

  -- Proof of delivery is mandatory before delivered.
  if p_next = 'delivered' and coalesce(v_pod_photo, '') = '' then
    raise exception 'pod_photo_required';
  end if;

  update public.deliveries
     set status = p_next,
         picked_up_at = case when p_next = 'picked_up' then coalesce(picked_up_at, now()) else picked_up_at end,
         delivered_at = case when p_next = 'delivered' then coalesce(delivered_at, now()) else delivered_at end
   where id = p_delivery_id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. An offer's push goes out at once (CONC-7)
-- ---------------------------------------------------------------------------------------------

-- The notify worker ran once a minute, so an offer's push reached a locked phone 30 s into its 75 s
-- on average. A transaction that queues a rider offer ('new_dispatch') now kicks the worker as it
-- commits, through pg_net (which sends only after the commit, so the worker finds the row), with
-- {"scope": "offers"}: the worker sends rider offers only on that call. Once per transaction: the
-- run it starts sends every offer the transaction queued. Nothing happens while
-- private.app_settings.notify_worker_url is unset, the x-worker-secret header is sent only when
-- notify_worker_secret is set, and a failure is a warning: queuing an offer never fails because of
-- the kick (the minute tick still sends it).
--
-- A deferred constraint trigger, so it runs once the transaction's offers are all in, at commit; a
-- transaction that rolls back (a test, a failed dispatch step) kicks nothing.
create or replace function private.notify_offer_kick()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'pg_temp'
as $function$
declare
  v_url text;
  v_secret text;
  v_headers jsonb;
begin
  if new.template is distinct from 'new_dispatch' then return null; end if;
  if coalesce(current_setting('favornoms.offer_kick_sent', true), '') = '1' then return null; end if;
  begin
    v_url := nullif(btrim(coalesce(private.get_setting('notify_worker_url'), '')), '');
    if v_url is null then return null; end if;
    v_secret := nullif(private.get_setting('notify_worker_secret'), '');
    v_headers := jsonb_build_object('Content-Type', 'application/json');
    if v_secret is not null then
      v_headers := v_headers || jsonb_build_object('x-worker-secret', v_secret);
    end if;
    -- txid names the commit that kicked, for support (and for the test to find its own call).
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('scope', 'offers', 'source', 'new_dispatch', 'txid', txid_current()),
      headers := v_headers,
      timeout_milliseconds := 8000);
    perform set_config('favornoms.offer_kick_sent', '1', true);
  exception when others then
    raise warning 'notify_offer_kick: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end;
$function$;

comment on function private.notify_offer_kick() is
  'Deferred AFTER INSERT on notifications_outbox for template new_dispatch: once per transaction, at commit, POSTs {"scope":"offers"} to private.app_settings.notify_worker_url through pg_net (x-worker-secret only when notify_worker_secret is set), so a rider offer''s push goes out in seconds instead of at the next minute tick. Never fails the insert.';

drop trigger if exists notifications_outbox_kick_offer_push on public.notifications_outbox;
create constraint trigger notifications_outbox_kick_offer_push
  after insert on public.notifications_outbox
  deferrable initially deferred
  for each row
  when (new.template = 'new_dispatch')
  execute function private.notify_offer_kick();

-- ---------------------------------------------------------------------------------------------
-- 9. Grants. CREATE OR REPLACE keeps a function's grants; the new ones are closed, the replaced ones
--    restated for the record (set_driver_location and progress_delivery keep theirs untouched).
-- ---------------------------------------------------------------------------------------------

revoke all on function private.orders_unready_withdraws_dispatch() from public, anon, authenticated;
revoke all on function private.notify_offer_kick() from public, anon, authenticated;

revoke all on function private.dispatch_delivery(uuid, text) from public, anon, authenticated;
revoke all on function private.dispatch_sweep(uuid) from public, anon, authenticated;
revoke all on function private.expire_dispatch_offers(uuid) from public, anon, authenticated;

revoke all on function public.claim_batch_sibling(uuid) from public, anon, authenticated;
grant execute on function public.claim_batch_sibling(uuid) to service_role;
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
