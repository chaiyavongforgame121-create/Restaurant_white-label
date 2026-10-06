-- Rider dispatch in the database (20261005100000_dispatch_in_database, docs/DISPATCH-FIXES-2026-10-05.md
-- D1-D6, D8), and the fixes after its review (20261006100000_dispatch_fixes: sections 13-20). A
-- rolled-back script, not a migration.
--
-- Run from the repo root once the migrations are applied:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/dispatch_in_database.sql
-- Before one is applied, put it after a "begin;" of your own and this file (without its own
-- "begin;" line) after it, in one transaction.
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script creates
-- for itself (two branches, and a branch of a second restaurant), with its own riders, staff and
-- orders. No existing row is used as a fixture, and the sweep and the expiry are run for the test
-- branch only (their p_branch_id), so no live delivery is touched. The test restaurant is on the
-- trial (every branch of a trial delivers), so its delivery orders pass the billing gates as a real
-- one's would; every trigger runs.
--
-- Two ways of acting as someone, as in the other suites:
--   pg_temp.try_as(uid, sqls[, admin])  as `authenticated`, in a subtransaction that is always rolled
--                                       back: for permission checks.
--   pg_temp.act_as(uid)                 sets only the JWT claims, so auth.uid() is that person while the
--                                       statements that follow keep their effect: a rider's decline, a
--                                       manager's "Find rider again". act_as(null) is the service role
--                                       again (no JWT), which is who pg_cron is.
--
-- The test branch sits at 30.0, -95.0. Riders (all KYC verified, fresh GPS, rating 4.5) by distance:
--   D1 0.22 km, D4 0.33 km (offline at first), D2 0.56 km, D3 1.0 km; D5 also rides for the second
--   restaurant's branch, D6 also for the restaurant's second branch (offline; for the cooldown rules).
--
-- The result is one row per check with PASS/FAIL, then a summary row.

begin; -- TEST-BEGIN

create temp table t_out (
  seq serial,
  check_name text,
  expected text,
  actual text,
  verdict text
) on commit drop;

create temp table t_fx (k text primary key, v uuid not null) on commit drop;

create or replace function pg_temp.try_as(p_uid uuid, p_sqls text[], p_admin boolean default false)
returns text
language plpgsql
as $$
declare
  s text;
  v_last text;
  v_msg text;
  v_det text;
begin
  begin
    if p_uid is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated',
                          'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
      perform set_config('request.jwt.claim.sub', p_uid::text, true);
      perform set_config('role', 'authenticated', true);
    else
      perform set_config('request.jwt.claims', '', true);
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('role', 'anon', true);
    end if;
    foreach s in array p_sqls loop
      execute s into v_last;
    end loop;
    raise exception using message = 'TRY_AS_OK', detail = coalesce(v_last, '');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail;
    if v_msg = 'TRY_AS_OK' then
      return 'ok' || case when coalesce(v_det, '') <> '' then ' ' || v_det else '' end;
    end if;
    return 'ERR ' || v_msg;
  end;
end $$;

-- p_expected ending in '%' is a LIKE pattern.
create or replace function pg_temp.expect(p_check text, p_expected text, p_actual text)
returns void
language plpgsql
as $$
begin
  insert into t_out (check_name, expected, actual, verdict)
  values (p_check, p_expected, coalesce(p_actual, '<null>'),
          case when coalesce(p_actual, '<null>') = p_expected
                 or (right(p_expected, 1) = '%' and coalesce(p_actual, '<null>') like p_expected)
               then 'PASS' else 'FAIL' end);
end $$;

-- Statements under the given JWT claims and database role, always rolled back: for the callers try_as
-- cannot be (signed in with no user id, the service role).
create or replace function pg_temp.try_claims(p_claims text, p_role text, p_sql text)
returns text
language plpgsql
as $$
declare
  v_last text;
  v_msg text;
  v_det text;
begin
  begin
    perform set_config('request.jwt.claims', p_claims, true);
    perform set_config('request.jwt.claim.sub', coalesce(nullif(p_claims, '')::jsonb ->> 'sub', ''), true);
    perform set_config('role', p_role, true);
    execute p_sql into v_last;
    raise exception using message = 'TRY_AS_OK', detail = coalesce(v_last, '');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail;
    if v_msg = 'TRY_AS_OK' then
      return 'ok' || case when coalesce(v_det, '') <> '' then ' ' || v_det else '' end;
    end if;
    return 'ERR ' || v_msg;
  end;
end $$;

create or replace function pg_temp.act_as(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
end $$;

create or replace function pg_temp.fx(p_key text)
returns uuid
language sql
as $$ select v from t_fx where k = p_key $$;

-- Whether a delivery is out of any stack.
create or replace function pg_temp.solo(p_delivery uuid)
returns text
language sql
as $$ select (batch_id is null and batch_seq is null)::text from public.deliveries where id = p_delivery $$;

-- The fixture label of a rider id ('-' for none), so expectations read as names.
create or replace function pg_temp.who(p_driver uuid)
returns text
language sql
as $$ select coalesce((select k from t_fx where v = p_driver and k like 'D_'), case when p_driver is null then '-' else '?' end) $$;

-- "status rider state" of a delivery.
create or replace function pg_temp.dsum(p_delivery uuid)
returns text
language sql
as $$
  select d.status::text || ' ' || pg_temp.who(d.driver_id) || ' ' || coalesce(d.dispatch_state, '-')
    from public.deliveries d where d.id = p_delivery
$$;

-- The last dispatch_history entry's type (and reason when it has one).
create or replace function pg_temp.last_entry(p_delivery uuid)
returns text
language sql
as $$
  select (d.dispatch_history -> -1 ->> 'type')
         || coalesce(' ' || (d.dispatch_history -> -1 ->> 'reason'), '')
    from public.deliveries d where d.id = p_delivery
$$;

create or replace function pg_temp.strikes(p_driver uuid, p_delivery uuid default null)
returns text
language sql
as $$
  select count(*)::text from public.driver_penalty_events e
   where e.driver_id = p_driver and (p_delivery is null or e.delivery_id = p_delivery)
$$;

-- A delivery order at the test branch, cooking, with its delivery row (pending). p_lat_off moves
-- the drop-off north of the branch.
create or replace function pg_temp.new_delivery(p_label text, p_lat_off double precision default 0.03)
returns uuid
language plpgsql
as $$
declare
  v_order uuid;
  v_delivery uuid;
begin
  insert into public.orders (order_number, branch_id, channel, status, status_history, subtotal, total,
                             tip_amount, held, source)
  values ('ZZ-DSP-' || p_label || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6),
          pg_temp.fx('B1'), 'delivery', 'preparing', '[]'::jsonb, 20, 24, 2.00, false, 'web')
  returning id into v_order;
  insert into public.deliveries (order_id, branch_id, status, distance_km, dropoff_lat, dropoff_lng)
  values (v_order, pg_temp.fx('B1'), 'pending', 3.2, 30.0 + p_lat_off, -95.0)
  returning id into v_delivery;
  insert into t_fx values ('o:' || p_label, v_order), ('d:' || p_label, v_delivery);
  return v_delivery;
end $$;

-- The kitchen marks the order ready (as the service role: the trigger is what is under test).
create or replace function pg_temp.ready(p_delivery uuid)
returns void
language sql
as $$
  update public.orders set status = 'ready'
   where id = (select order_id from public.deliveries where id = p_delivery);
$$;

create or replace function pg_temp.online(p_rider text, p_on boolean)
returns void
language sql
as $$
  update public.driver_branch_availability set is_online = p_on
   where driver_id = pg_temp.fx(p_rider) and branch_id = pg_temp.fx('B1');
$$;

-- Between sections: every test delivery still open is cancelled, the riders start clean (no strike,
-- no cooldown, no streak), D1-D3 online and D4 offline at the test branch, stacking off.
create or replace function pg_temp.reset()
returns void
language plpgsql
as $$
begin
  perform pg_temp.act_as(null);
  update public.deliveries set status = 'cancelled'
   where id in (select v from t_fx where k like 'd:%')
     and status in ('pending', 'dispatching', 'assigned', 'picked_up', 'in_transit');
  update public.drivers set cooldown_until = null, reject_streak = 0
   where id in (select v from t_fx where k like 'D_');
  delete from public.driver_penalty_events where driver_id in (select v from t_fx where k like 'D_');
  update public.driver_branch_availability set is_online = (driver_id <> pg_temp.fx('D4'))
   where branch_id = pg_temp.fx('B1') and driver_id in (pg_temp.fx('D1'), pg_temp.fx('D2'), pg_temp.fx('D3'), pg_temp.fx('D4'));
  update public.branches set settings = settings || '{"batch_enabled": false}'::jsonb where id = pg_temp.fx('B1');
end $$;

-- 0. Fixtures ----------------------------------------------------------------------------------------
do $fx$
declare
  v_sfx text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  v_uid uuid;
  v_rid uuid;
  v_rid2 uuid;
  v_label text;
  v_off double precision;
  v_drv uuid;
  i int;
begin
  foreach v_label in array array['owner', 'manager', 'kitchen', 'cashier', 'outsider', 'owner2', 'admin',
                                 'uD1', 'uD2', 'uD3', 'uD4', 'uD5', 'uD6'] loop
    v_uid := gen_random_uuid();
    insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (v_uid, 'dispatch-test-' || lower(v_label) || '-' || v_sfx || '@favornoms.test', 'authenticated',
            'authenticated', jsonb_build_object('is_platform_admin', v_label = 'admin'), '{}'::jsonb, now(), now());
    insert into t_fx values (v_label, v_uid);
  end loop;

  insert into public.restaurants (owner_user_id, slug, name)
  values (pg_temp.fx('owner'), 'zz-dsp-' || v_sfx, 'ZZ Dispatch Test') returning id into v_rid;
  insert into public.restaurants (owner_user_id, slug, name)
  values (pg_temp.fx('owner2'), 'zz-dsp2-' || v_sfx, 'ZZ Dispatch Test Two') returning id into v_rid2;
  insert into t_fx values ('R1', v_rid), ('R2', v_rid2);
  -- On the trial: three branch seats, and every branch delivers.
  perform private.billing_apply_selection(v_rid, 'trial', '{}'::uuid[], 3, 'trialing', null, null, null);
  perform private.billing_apply_selection(v_rid2, 'trial', '{}'::uuid[], 3, 'trialing', null, null, null);

  insert into public.branches (restaurant_id, slug, name, geo_location, settings)
  values (v_rid, 'one', 'Dispatch One', ST_SetSRID(ST_MakePoint(-95.0, 30.0), 4326)::geography,
          jsonb_build_object('delivery_mode', 'platform', 'offer_ttl_seconds', 75, 'driver_search_radius_km', 10,
                             'dispatch_max_gps_age_min', 5, 'batch_enabled', false, 'batch_max_detour_mi', 1,
                             'dispatch_search_window_min', 15, 'driver_max_attempts', 1))
  returning id into v_uid;
  insert into t_fx values ('B1', v_uid);
  insert into public.branches (restaurant_id, slug, name, geo_location, settings)
  values (v_rid, 'two', 'Dispatch Two', ST_SetSRID(ST_MakePoint(-95.1, 30.1), 4326)::geography, '{}'::jsonb)
  returning id into v_uid;
  insert into t_fx values ('B2', v_uid);
  insert into public.branches (restaurant_id, slug, name, geo_location, settings)
  values (v_rid2, 'one', 'Other One', ST_SetSRID(ST_MakePoint(-95.2, 30.2), 4326)::geography, '{}'::jsonb)
  returning id into v_uid;
  insert into t_fx values ('B3', v_uid);

  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status) values
    (pg_temp.fx('manager'), v_rid, pg_temp.fx('B1'), 'manager', 'active'),
    (pg_temp.fx('kitchen'), v_rid, pg_temp.fx('B1'), 'kitchen', 'active'),
    (pg_temp.fx('cashier'), v_rid, pg_temp.fx('B1'), 'cashier', 'active');

  for i in 1..6 loop
    v_off := case i when 1 then 0.002 when 2 then 0.005 when 3 then 0.009 when 4 then 0.003 else 0.004 end;
    insert into public.drivers (user_id, full_name, phone, vehicle_type, kyc_status, kyc_verified_at,
                                current_location, location_updated_at, reject_streak)
    values (pg_temp.fx('uD' || i), 'ZZ Rider ' || i, '+1555' || lpad((floor(random() * 9000000) + 1000000)::text, 7, '0'),
            'motorcycle', 'verified', now(), ST_SetSRID(ST_MakePoint(-95.0, 30.0 + v_off), 4326)::geography, now(), 0)
    returning id into v_drv;
    insert into t_fx values ('D' || i, v_drv);
    insert into public.driver_approvals (driver_id, branch_id, status) values (v_drv, pg_temp.fx('B1'), 'approved');
    insert into public.driver_branch_availability (driver_id, branch_id, is_online)
    values (v_drv, pg_temp.fx('B1'), i <= 3);
  end loop;
  insert into public.driver_approvals (driver_id, branch_id, status) values
    (pg_temp.fx('D5'), pg_temp.fx('B3'), 'approved'),
    (pg_temp.fx('D6'), pg_temp.fx('B2'), 'approved');

  perform pg_temp.expect('fixture: 13 people, 3 branches, 6 riders', '13 3 6',
    (select count(*) filter (where k not like 'D_' and k not like 'B_' and k not like 'R_')
            || ' ' || count(*) filter (where k like 'B_') || ' ' || count(*) filter (where k like 'D_') from t_fx));
  perform pg_temp.expect('fixture: the test branch is entitled to delivery', 'true',
    private.branch_has_feature(pg_temp.fx('B1'), 'delivery')::text);
  perform pg_temp.expect('fixture: the platform strike rule needs two strikes for a cooldown', 'true',
    (select (greatest(1, coalesce((penalty ->> 'threshold')::int, 2)) >= 2
             and coalesce((penalty ->> 'count_rejects')::boolean, true)
             and coalesce((penalty ->> 'count_timeouts')::boolean, true))::text
       from public.platform_settings where id = 1));
end
$fx$;

-- 1. The ready trigger offers the order, in the database ---------------------------------------------
do $t$
declare
  d uuid := pg_temp.new_delivery('A');
  v_queue bigint := (select count(*) from net.http_request_queue);
  v_base numeric;
  v_perkm numeric;
begin
  perform pg_temp.expect('new columns: dispatch_state is checked', 'true',
    (select exists (select 1 from pg_constraint where conname = 'deliveries_dispatch_state_check'))::text);

  perform pg_temp.ready(d);
  perform pg_temp.expect('ready: offered to the nearest rider at once', 'assigned D1 searching', pg_temp.dsum(d));
  perform pg_temp.expect('ready: no pg_net call was queued', '0',
    ((select count(*) from net.http_request_queue) - v_queue)::text);
  perform pg_temp.expect('ready: the round started and the offer lives 75 s', 'true true 1',
    (select (dispatch_round_started_at is not null)::text || ' '
            || (offer_expires_at between clock_timestamp() + interval '60 seconds'
                                     and clock_timestamp() + interval '76 seconds')::text || ' '
            || dispatch_attempts
       from public.deliveries where id = d));
  perform pg_temp.expect('ready: the offer is logged with its round', 'offered true',
    (select (dispatch_history -> -1 ->> 'type') || ' '
            || ((dispatch_history -> -1 ->> 'round')::timestamptz = dispatch_round_started_at)::text
       from public.deliveries where id = d));
  perform pg_temp.expect('ready: the rider''s turn carries the round', 'offered true',
    (select a.status || ' ' || (a.dispatch_round_started_at = x.dispatch_round_started_at)::text
       from public.delivery_assignments a join public.deliveries x on x.id = a.delivery_id
      where a.delivery_id = d and a.ended_at is null));
  select base_pay, per_km_pay into v_base, v_perkm from private.driver_pay_rates();
  perform pg_temp.expect('ready: pay is the platform rate for the trip, the tip goes to the rider', 'true 2.00',
    (select (driver_earnings = least(round(v_base + v_perkm * 3.2, 2), private.branch_driver_pay_cap(branch_id)))::text
            || ' ' || net_tip::text
       from public.deliveries where id = d));
  perform pg_temp.expect('ready: one offer push for the rider, with its life', 'D1 75 true',
    (select pg_temp.who(o.recipient_id) || ' ' || (o.variables ->> 'expires_in_seconds') || ' '
            || (o.variables ? 'offer_expires_at')::text
       from public.notifications_outbox o
      where o.template = 'new_dispatch' and o.variables ->> 'delivery_id' = d::text));

-- 2. A decline goes straight to the next rider, until nobody is left ---------------------------------
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('decline: rider 2 is offered it immediately', 'assigned D2 searching', pg_temp.dsum(d));
  perform pg_temp.act_as(pg_temp.fx('uD2'));
  perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('decline: then rider 3', 'assigned D3 searching', pg_temp.dsum(d));
  perform pg_temp.act_as(pg_temp.fx('uD3'));
  perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('decline: with everyone asked the round waits', 'dispatching - waiting', pg_temp.dsum(d));
  perform pg_temp.expect('decline: the history says why', 'waiting everyone_asked', pg_temp.last_entry(d));
  perform pg_temp.expect('decline: one strike each, none cooling down', '1 1 1 0',
    pg_temp.strikes(pg_temp.fx('D1'), d) || ' ' || pg_temp.strikes(pg_temp.fx('D2'), d) || ' '
    || pg_temp.strikes(pg_temp.fx('D3'), d) || ' '
    || (select count(*) from public.drivers where id in (pg_temp.fx('D1'), pg_temp.fx('D2'), pg_temp.fx('D3'))
                                              and cooldown_until > now())::text);
  perform pg_temp.expect('decline: driver_max_attempts (1 here) no longer ends the round', '3',
    (select count(*)::text from public.delivery_assignments where delivery_id = d));

-- 3. A rider asked once is not asked again in the round; the sweep finds a rider who comes online ----
  perform pg_temp.act_as(pg_temp.fx('manager'));
  perform pg_temp.expect('staff Find rider continues the round: still waiting, 3 asked',
    'waiting everyone_asked 3 3 0',
    (select (v ->> 'result') || ' ' || (v ->> 'reason') || ' ' || (v ->> 'asked_count') || ' '
            || (v -> 'diagnostics' ->> 'already_asked') || ' ' || (v -> 'diagnostics' ->> 'cooling_down')
       from public.staff_dispatch_delivery(d, false) v));
  perform pg_temp.act_as(null);
  perform pg_temp.expect('sweep: nobody new, nothing offered', '0 dispatching - waiting',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(d));
  perform pg_temp.expect('sweep: a waiting row is not rewritten every pass', 'waiting everyone_asked 1',
    (select pg_temp.last_entry(d) || ' '
            || (select count(*) from jsonb_array_elements(dispatch_history) e where e ->> 'type' = 'waiting')::text
       from public.deliveries where id = d));
  perform pg_temp.online('D4', true);
  perform pg_temp.expect('sweep: the rider who came online is offered it', '1 assigned D4 searching',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(d));
end
$t$;

-- 4. Expiry goes straight to the next rider -----------------------------------------------------------
do $t$
declare
  d uuid;
begin
  perform pg_temp.reset();
  d := pg_temp.new_delivery('B');
  perform pg_temp.ready(d);
  perform pg_temp.expect('expiry: offered to D1', 'assigned D1 searching', pg_temp.dsum(d));
  update public.deliveries set offer_expires_at = now() - interval '1 second' where id = d;
  perform private.expire_dispatch_offers(pg_temp.fx('B1'));
  perform pg_temp.expect('expiry: released and offered to the next rider at once', 'assigned D2 searching', pg_temp.dsum(d));
  perform pg_temp.expect('expiry: the lapsed turn and its timeout strike', 'expired offer_expired 1',
    (select a.status || ' ' || a.end_kind from public.delivery_assignments a
      where a.delivery_id = d and a.driver_id = pg_temp.fx('D1'))
    || ' ' || pg_temp.strikes(pg_temp.fx('D1'), d));
  perform pg_temp.expect('expiry: the lapsed rider is out of the round', 'true',
    (select pg_temp.fx('D1') = any (private.dispatch_asked_riders(array[d])))::text);
  -- The same lapsed offer, declined in the app a moment after the sweep took it: no second strike.
  perform private.record_driver_penalty(pg_temp.fx('D1'), 'reject', d);
  perform pg_temp.expect('one strike per delivery: a second event for the same order is not counted', '1 1',
    pg_temp.strikes(pg_temp.fx('D1'), d) || ' ' || (select reject_streak::text from public.drivers where id = pg_temp.fx('D1')));
end
$t$;

-- 5. The search window, and a staff restart --------------------------------------------------------------
do $t$
declare
  d uuid;
  v jsonb;
  v_round timestamptz;
begin
  perform pg_temp.reset();
  d := pg_temp.new_delivery('C');
  perform pg_temp.ready(d);
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(pg_temp.fx('uD2')); perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(pg_temp.fx('uD3')); perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('window: everyone asked, waiting', 'dispatching - waiting', pg_temp.dsum(d));

  -- 16 minutes later (the round and its turns move back together).
  select dispatch_round_started_at into v_round from public.deliveries where id = d;
  update public.delivery_assignments set dispatch_round_started_at = v_round - interval '16 minutes'
   where delivery_id = d and dispatch_round_started_at = v_round;
  update public.deliveries set dispatch_round_started_at = v_round - interval '16 minutes' where id = d;
  perform pg_temp.expect('window: the sweep ends the round', '1 dispatching - no_rider_found',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(d));
  perform pg_temp.expect('window: the history and the staff alert say why', 'no_rider_found everyone_asked 1',
    pg_temp.last_entry(d) || ' '
    || (select count(*)::text from public.notifications_outbox
         where template = 'dispatch_failed' and variables ->> 'delivery_id' = d::text
           and variables ->> 'reason' = 'no_rider_found'));
  perform pg_temp.expect('window: a closed round is left alone by the sweep and by auto', '0 no_rider_found',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' '
    || (private.dispatch_delivery(d, 'auto') ->> 'result'));

  perform pg_temp.expect('window: Find rider (no restart) on an ended round starts a new one', 'ok offered',
    pg_temp.try_as(pg_temp.fx('kitchen'), array[format('select public.staff_dispatch_delivery(%L, false) ->> ''result''', d)]));

  -- Find rider again, from the kitchen (kitchen.access): a new round in which everyone may be asked.
  perform pg_temp.act_as(pg_temp.fx('kitchen'));
  v := public.staff_dispatch_delivery(d, true);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('restart: a new round offers the riders asked before', 'offered D1 1 assigned D1 searching',
    (v ->> 'result') || ' ' || pg_temp.who((v ->> 'driver_id')::uuid) || ' ' || (v ->> 'asked_count') || ' '
    || pg_temp.dsum(d));
  perform pg_temp.expect('restart: the round is new', 'true',
    (select (dispatch_round_started_at > v_round)::text from public.deliveries where id = d));
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('restart: a second decline of the same order is not a second strike', '1 1 0',
    pg_temp.strikes(pg_temp.fx('D1'), d) || ' '
    || (select reject_streak::text || ' ' || (cooldown_until is not null)::int::text from public.drivers where id = pg_temp.fx('D1')));
  perform pg_temp.expect('restart: and the next rider of the new round is asked', 'assigned D2 searching', pg_temp.dsum(d));

  -- 6. A restart withdraws an open offer without a strike, and is refused once accepted --------------
  perform pg_temp.act_as(pg_temp.fx('manager'));
  v := public.staff_dispatch_delivery(d, true);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('withdraw: D2''s offer is withdrawn, no strike', 'reassigned reassigned_by_staff 1',
    (select a.status || ' ' || a.end_kind from public.delivery_assignments a
      where a.delivery_id = d and a.driver_id = pg_temp.fx('D2') and a.ended_at is not null
      order by a.seq desc limit 1)
    || ' ' || pg_temp.strikes(pg_temp.fx('D2'), d));
  perform pg_temp.expect('withdraw: logged as withdrawn, by whom', 'true',
    (select exists (select 1 from jsonb_array_elements(dispatch_history) e
                     where e ->> 'type' = 'withdrawn' and e ->> 'driver_id' = pg_temp.fx('D2')::text
                       and e ->> 'by_user' = pg_temp.fx('manager')::text)::text
       from public.deliveries where id = d));
  perform pg_temp.expect('withdraw: and the new round offers it again', 'offered assigned D1 searching',
    (v ->> 'result') || ' ' || pg_temp.dsum(d));
  perform pg_temp.expect('Find rider (no restart) while an offer is out changes nothing', 'not_dispatchable offer_open D1',
    (select (x ->> 'result') || ' ' || (x ->> 'reason') || ' ' || pg_temp.who((x ->> 'driver_id')::uuid)
       from private.dispatch_delivery(d, 'staff') x));

  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.accept_dispatch(d);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('accept: the job leaves its round', 'assigned D1 -', pg_temp.dsum(d));
  perform pg_temp.expect('restart after accept: refused, the rider keeps the job', 'already_accepted assigned D1 -',
    (select (x ->> 'result') from private.dispatch_delivery(d, 'staff_restart') x) || ' ' || pg_temp.dsum(d));
  perform pg_temp.expect('restart after accept, through the staff entry point', 'ok already_accepted',
    pg_temp.try_as(pg_temp.fx('manager'), array[
      format('select public.staff_dispatch_delivery(%L, true) ->> ''result''', d)]));
end
$t$;

-- 7. Two orders at once never give one rider two offers -------------------------------------------------
do $t$
declare
  d1 uuid;
  d2 uuid;
  d3 uuid;
begin
  perform pg_temp.reset();
  perform pg_temp.online('D3', false);
  d1 := pg_temp.new_delivery('D');
  d2 := pg_temp.new_delivery('E');
  d3 := pg_temp.new_delivery('F');
  perform pg_temp.ready(d1);
  perform pg_temp.ready(d2);
  perform pg_temp.ready(d3);
  perform pg_temp.expect('back to back: the first order to D1, the second to D2, the third waits',
    'assigned D1 searching | assigned D2 searching | dispatching - waiting',
    pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2) || ' | ' || pg_temp.dsum(d3));
  perform pg_temp.expect('back to back: the third waits because the riders are busy', 'waiting riders_busy',
    pg_temp.last_entry(d3));
  perform pg_temp.expect('back to back: no rider holds two offers', '0',
    (select count(*)::text from (select driver_id from public.deliveries
                                  where driver_id in (select v from t_fx where k like 'D_')
                                    and status in ('assigned', 'picked_up', 'in_transit')
                                  group by driver_id having count(*) > 1) x));
  perform pg_temp.expect('a manual assign cannot give a busy rider a second offer', 'ERR driver_busy',
    pg_temp.try_as(pg_temp.fx('manager'), array[format('select public.staff_assign_driver(%L, %L)::text', d3, pg_temp.fx('D2'))]));
  perform pg_temp.expect('the trigger''s Find rider on an offered order changes nothing', 'not_dispatchable assigned D1 searching',
    (private.dispatch_delivery(d1, 'auto') ->> 'result') || ' ' || pg_temp.dsum(d1));

  -- D1 declines the first: nobody un-asked is free for it. The sweep then gives D1 the oldest order
  -- D1 has not been asked: the third.
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d1, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('the declined order waits (D1 asked, D2 busy)', 'dispatching - waiting', pg_temp.dsum(d1));
  perform pg_temp.expect('the sweep gives the free rider the waiting order they were not asked', '1 assigned D1 searching | dispatching - waiting',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(d3) || ' | ' || pg_temp.dsum(d1));
end
$t$;

-- 8. A stack is offered, declined and restarted as one unit ----------------------------------------------
do $t$
declare
  d1 uuid;
  d2 uuid;
  v jsonb;
  v_batch uuid;
begin
  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  d1 := pg_temp.new_delivery('G', 0.03);
  d2 := pg_temp.new_delivery('H', 0.031);
  perform pg_temp.ready(d1);
  perform pg_temp.expect('stack: nobody online, the first order waits', 'waiting nobody_online', pg_temp.last_entry(d1));
  perform pg_temp.ready(d2);
  select batch_id into v_batch from public.deliveries where id = d1;
  perform pg_temp.expect('stack: the second order pairs with the first, both waiting', 'true waiting waiting',
    (select (v_batch is not null and batch_id = v_batch)::text from public.deliveries where id = d2)
    || ' ' || (select dispatch_state from public.deliveries where id = d1)
    || ' ' || (select dispatch_state from public.deliveries where id = d2));

  perform pg_temp.online('D1', true);
  perform pg_temp.online('D2', true);
  perform pg_temp.online('D3', true);
  perform pg_temp.expect('stack: the sweep offers both stops to one rider', '1 assigned D1 searching | assigned D1 searching',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2));
  perform pg_temp.expect('stack: one push, for two orders', '1 2',
    (select count(*)::text || ' ' || max(variables ->> 'batch_size') from public.notifications_outbox
      where template = 'new_dispatch' and variables ->> 'batch_id' = v_batch::text));

  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d2, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('stack decline: no strike, and the stack goes to the next rider', '0 assigned D2 searching | assigned D2 searching',
    pg_temp.strikes(pg_temp.fx('D1')) || ' ' || pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2));
  perform pg_temp.expect('stack decline: the decliner is out for both stops', 'true',
    (pg_temp.fx('D1') = any (private.dispatch_asked_riders(array[d1]))
     and pg_temp.fx('D1') = any (private.dispatch_asked_riders(array[d2])))::text);

  perform pg_temp.act_as(pg_temp.fx('manager'));
  v := public.staff_dispatch_delivery(d2, true);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('stack restart: both stops withdrawn without a strike, one new round, offered as a stack again',
    'offered_batch D1 0 true assigned D1 searching | assigned D1 searching',
    (v ->> 'result') || ' ' || pg_temp.who((v ->> 'driver_id')::uuid) || ' ' || pg_temp.strikes(pg_temp.fx('D2')) || ' '
    || (select (count(distinct dispatch_round_started_at) = 1 and count(*) = 2 and min(batch_id::text) = v_batch::text)::text
          from public.deliveries where id in (d1, d2))
    || ' ' || pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2));

  -- The stack lapses: one strike, not two, and it moves on as a unit.
  update public.deliveries set offer_expires_at = now() - interval '1 second' where id in (d1, d2);
  perform private.expire_dispatch_offers(pg_temp.fx('B1'));
  perform pg_temp.expect('stack expiry: one strike for the stack, and the next rider gets both', '1 assigned D2 searching | assigned D2 searching',
    pg_temp.strikes(pg_temp.fx('D1')) || ' ' || pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2));
end
$t$;

-- 9. Who may ask for a rider ---------------------------------------------------------------------------------
do $t$
declare
  d uuid;
begin
  perform pg_temp.reset();
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  d := pg_temp.new_delivery('P');
  perform pg_temp.ready(d);
  perform pg_temp.expect('staff_dispatch_delivery: the anon key cannot call it at all', 'ERR permission denied for function staff_dispatch_delivery',
    pg_temp.try_as(null, array[format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)]));
  perform pg_temp.expect('staff_dispatch_delivery: signed in with no user', 'ERR auth_required',
    pg_temp.try_claims('{"role":"authenticated"}', 'authenticated',
                       format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)));
  perform pg_temp.expect('staff_dispatch_delivery: a stranger', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('outsider'), array[format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)]));
  perform pg_temp.expect('staff_dispatch_delivery: a cashier (no kitchen.access)', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('cashier'), array[format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)]));
  perform pg_temp.expect('staff_dispatch_delivery: another restaurant''s owner', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('owner2'), array[format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)]));
  perform pg_temp.expect('staff_dispatch_delivery: the kitchen', 'ok waiting',
    pg_temp.try_as(pg_temp.fx('kitchen'), array[format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)]));
  perform pg_temp.expect('staff_dispatch_delivery: a manager', 'ok waiting',
    pg_temp.try_as(pg_temp.fx('manager'), array[format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)]));
  perform pg_temp.expect('staff_dispatch_delivery: a platform admin', 'ok waiting',
    pg_temp.try_as(pg_temp.fx('admin'), array[format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)], true));
  perform pg_temp.expect('staff_dispatch_delivery: an unknown delivery', 'ERR delivery_not_found',
    pg_temp.try_as(pg_temp.fx('manager'), array['select public.staff_dispatch_delivery(gen_random_uuid()) ->> ''result''']));
  perform pg_temp.expect('the waiting answer says nobody is online, with the old diagnostics', 'waiting nobody_online 0 10',
    (select (x ->> 'result') || ' ' || (x ->> 'reason') || ' ' || (x -> 'diagnostics' ->> 'online') || ' '
            || (x -> 'diagnostics' ->> 'radius_km')
       from private.dispatch_delivery(d, 'staff') x));
  perform pg_temp.expect('a bad mode is refused', 'ERR invalid_dispatch_mode',
    pg_temp.try_claims('', 'postgres', format('select private.dispatch_delivery(%L, ''x'') ->> ''result''', d)));
  perform pg_temp.expect('the safe wrapper never raises', 'error',
    private.dispatch_delivery_safely(gen_random_uuid(), 'auto') ->> 'result');

  -- The service role (dispatch-driver with the service key): no auth.uid(), JWT role service_role.
  perform pg_temp.expect('staff_dispatch_delivery: the service role', 'ok waiting',
    pg_temp.try_claims('{"role":"service_role"}', 'service_role',
                       format('select public.staff_dispatch_delivery(%L) ->> ''result''', d)));

  -- Riders online but cooling down: the reason says so, and how many.
  perform pg_temp.online('D1', true);
  perform pg_temp.online('D2', true);
  update public.drivers set cooldown_until = now() + interval '30 minutes'
   where id in (pg_temp.fx('D1'), pg_temp.fx('D2'));
  perform pg_temp.expect('waiting on cooled-down riders says so', 'waiting cooling_down 2 2',
    (select (x ->> 'result') || ' ' || (x ->> 'reason') || ' ' || (x -> 'diagnostics' ->> 'cooling_down') || ' '
            || (x -> 'diagnostics' ->> 'online')
       from private.dispatch_delivery(d, 'auto') x));
  perform pg_temp.expect('and the row reads waiting, with that reason', 'dispatching - waiting | waiting cooling_down',
    pg_temp.dsum(d) || ' | ' || pg_temp.last_entry(d));
end
$t$;

-- 9b. A rider who cancels an accepted job; a failed job requeued by staff ---------------------------------------
do $t$
declare
  d uuid;
  v_round timestamptz;
begin
  perform pg_temp.reset();
  d := pg_temp.new_delivery('Q');
  perform pg_temp.ready(d);
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.accept_dispatch(d);
  select dispatch_round_started_at into v_round from public.deliveries where id = d;
  perform public.driver_cancel_delivery(d, 'Flat tyre');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('driver cancel: the next rider is offered at once, in a new round', 'assigned D2 searching true',
    pg_temp.dsum(d) || ' ' || (select (dispatch_round_started_at > v_round)::text from public.deliveries where id = d));
  perform pg_temp.expect('driver cancel: the rider who cancelled is out of the new round, and cooling down 10 minutes', 'true true',
    (pg_temp.fx('D1') = any (private.dispatch_asked_riders(array[d])))::text || ' '
    || (select (cooldown_until between now() + interval '9 minutes' and now() + interval '11 minutes')::text
          from public.drivers where id = pg_temp.fx('D1')));
  perform pg_temp.expect('driver cancel: the turn keeps the reason', 'cancelled driver_cancelled Flat tyre',
    (select a.status || ' ' || a.end_kind || ' ' || a.end_reason from public.delivery_assignments a
      where a.delivery_id = d and a.driver_id = pg_temp.fx('D1')));

  perform pg_temp.act_as(pg_temp.fx('uD2'));
  perform public.accept_dispatch(d);
  perform pg_temp.act_as(null);
  update public.deliveries set status = 'picked_up' where id = d;
  update public.deliveries set status = 'failed', failed_reason = 'Nobody home' where id = d;
  perform pg_temp.expect('requeue: refused to the kitchen (delivery.manage)', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('kitchen'), array[format('select public.requeue_failed_delivery(%L)::text', d)]));
  perform pg_temp.act_as(pg_temp.fx('manager'));
  perform public.requeue_failed_delivery(d);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('requeue: a new round, offered at once', 'assigned searching true',
    (select status::text || ' ' || dispatch_state || ' ' || (driver_id is not null)::text from public.deliveries where id = d));
end
$t$;

-- 9c. An order cancelled while its offer is on a rider's screen -------------------------------------------------
do $t$
declare
  d uuid;
begin
  perform pg_temp.reset();
  d := pg_temp.new_delivery('R');
  perform pg_temp.ready(d);
  update public.orders set status = 'cancelled' where id = pg_temp.fx('o:R');
  perform pg_temp.expect('cancelled order: the delivery is cancelled with the rider still on it', 'cancelled D1 searching',
    pg_temp.dsum(d));
  perform pg_temp.expect('cancelled order: the rider cannot accept it', 'ERR offer_gone',
    pg_temp.try_as(pg_temp.fx('uD1'), array[format('select public.accept_dispatch(%L)::text', d)]));
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('cancelled order: a decline changes nothing, strikes nobody and offers it to nobody', 'cancelled D1 searching 0 1',
    pg_temp.dsum(d) || ' ' || pg_temp.strikes(pg_temp.fx('D1'), d) || ' '
    || (select count(*)::text from public.delivery_assignments where delivery_id = d));
  perform pg_temp.expect('cancelled order: the sweep leaves it alone', '0', private.dispatch_sweep(pg_temp.fx('B1'))::text);
end
$t$;

-- 10. Lift cooldown (D8) ---------------------------------------------------------------------------------------
do $t$
declare
  v_until timestamptz := date_trunc('second', now() + interval '40 minutes');
  v1 timestamptz;
  v2 timestamptz;
begin
  perform pg_temp.reset();
  update public.drivers set cooldown_until = v_until, reject_streak = 2
   where id in (pg_temp.fx('D1'), pg_temp.fx('D5'), pg_temp.fx('D6'));
  insert into public.driver_penalty_events (driver_id, type, delivery_id)
  values (pg_temp.fx('D1'), 'reject', null), (pg_temp.fx('D1'), 'timeout', null);

  perform pg_temp.expect('lift: the anon key cannot call it at all', 'ERR permission denied for function lift_driver_cooldown',
    pg_temp.try_as(null, array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D1'), pg_temp.fx('B1'))]));
  perform pg_temp.expect('lift: signed in with no user', 'ERR auth_required',
    pg_temp.try_claims('{"role":"authenticated"}', 'authenticated',
                       format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D1'), pg_temp.fx('B1'))));
  perform pg_temp.expect('lift: a stranger', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('outsider'), array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D1'), pg_temp.fx('B1'))]));
  perform pg_temp.expect('lift: the kitchen (no drivers.manage)', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('kitchen'), array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D1'), pg_temp.fx('B1'))]));
  perform pg_temp.expect('lift: a cashier', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('cashier'), array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D1'), pg_temp.fx('B1'))]));
  perform pg_temp.expect('lift: another restaurant''s owner', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('owner2'), array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D1'), pg_temp.fx('B1'))]));
  perform pg_temp.expect('lift: a rider who does not ride for the branch', 'ERR driver_not_at_branch',
    pg_temp.try_as(pg_temp.fx('owner'), array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D1'), pg_temp.fx('B2'))]));

  -- The cooldown is one value for every branch the rider works for: a manager of one branch may not
  -- lift it for a rider shared with another (the same rule as KYC).
  perform pg_temp.expect('lift: a manager, for a rider shared with a branch they do not run', 'ERR forbidden: cooldown_shared_with_other_branch',
    pg_temp.try_as(pg_temp.fx('manager'), array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D6'), pg_temp.fx('B1'))]));
  perform pg_temp.expect('lift: the owner of both branches may', 'ok true',
    pg_temp.try_as(pg_temp.fx('owner'), array[format('select (public.lift_driver_cooldown(%L, %L) = %L)::text', pg_temp.fx('D6'), pg_temp.fx('B1'), v_until)]));
  perform pg_temp.expect('lift: the owner, for a rider shared with another restaurant', 'ERR forbidden: cooldown_shared_with_other_branch',
    pg_temp.try_as(pg_temp.fx('owner'), array[format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D5'), pg_temp.fx('B1'))]));
  perform pg_temp.expect('lift: a platform admin may', 'ok true platform_admin',
    pg_temp.try_as(pg_temp.fx('admin'), array[
      format('select public.lift_driver_cooldown(%L, %L)::text', pg_temp.fx('D5'), pg_temp.fx('B1')),
      format('select ((select cooldown_until from public.drivers where id = %L) is null)::text || %L ||
                     (select actor_type from public.audit_logs where action = %L and entity_id = %L
                       order by created_at desc limit 1)', pg_temp.fx('D5'), ' ', 'driver_cooldown_lifted', pg_temp.fx('D5'))], true));

  -- The branch manager lifts their own rider's (kept, to look at what it changed).
  perform pg_temp.act_as(pg_temp.fx('manager'));
  v1 := public.lift_driver_cooldown(pg_temp.fx('D1'), pg_temp.fx('B1'), 'Rider called in');
  v2 := public.lift_driver_cooldown(pg_temp.fx('D1'), pg_temp.fx('B1'));
  perform pg_temp.act_as(null);
  perform pg_temp.expect('lift: the manager lifts it and gets the end it had; a second lift has nothing to do', 'true null',
    (v1 = v_until)::text || ' ' || coalesce(v2::text, 'null'));
  perform pg_temp.expect('lift: cooldown, streak and strike window cleared; the strikes are kept, consumed', 'null 0 0 2',
    (select coalesce(cooldown_until::text, 'null') || ' ' || reject_streak from public.drivers where id = pg_temp.fx('D1'))
    || ' ' || (select count(*) filter (where consumed_at is null) || ' ' || count(*)
                 from public.driver_penalty_events where driver_id = pg_temp.fx('D1')));
  perform pg_temp.expect('lift: written to the audit log with who, where and the note', '1',
    (select count(*)::text from public.audit_logs
      where action = 'driver_cooldown_lifted' and entity_type = 'driver' and entity_id = pg_temp.fx('D1')
        and actor_type = 'staff' and actor_id = pg_temp.fx('manager') and branch_id = pg_temp.fx('B1')
        and restaurant_id = pg_temp.fx('R1') and metadata ->> 'note' = 'Rider called in'
        and (metadata ->> 'was_until')::timestamptz = v_until));

  -- 11. list_branch_riders says until when -------------------------------------------------------------------
  perform pg_temp.expect('list_branch_riders: cooldown_until for a rider on cooldown, null for one who is not', 'ok true true null',
    pg_temp.try_as(pg_temp.fx('manager'), array[format(
      'select (select (cooldown_until = %L)::text || %L || cooling_down::text from public.list_branch_riders(%L) where driver_id = %L)
              || %L || (select coalesce(cooldown_until::text, %L) from public.list_branch_riders(%L) where driver_id = %L)',
      v_until, ' ', pg_temp.fx('B1'), pg_temp.fx('D6'), ' ', 'null', pg_temp.fx('B1'), pg_temp.fx('D2'))]));
  perform pg_temp.expect('list_branch_riders: still delivery.manage only', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('kitchen'), array[format('select count(*)::text from public.list_branch_riders(%L)', pg_temp.fx('B1'))]));

  -- 12. The 30-second job runs the expiry, then the sweep, without pg_net ---------------------------------------
  perform pg_temp.expect('cron: expire-dispatch-offers runs the expiry and the sweep every 30 s', '30 seconds true true',
    (select schedule || ' ' || (command like '%private.expire_dispatch_offers()%')::text || ' '
            || (command like '%private.dispatch_sweep()%')::text
       from cron.job where jobname = 'expire-dispatch-offers'));
  perform pg_temp.expect('no dispatch path calls pg_net any more', '0',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('public', 'orders_after_ready_dispatch'), ('public', 'reject_dispatch'),
                                       ('private', 'expire_dispatch_offers'), ('public', 'driver_cancel_delivery'),
                                       ('public', 'requeue_failed_delivery'))
        and pg_get_functiondef(p.oid) like '%http_post%'));
  perform pg_temp.expect('the private dispatch functions are not callable by app users', 'false false false',
    has_function_privilege('authenticated', 'private.dispatch_delivery(uuid, text)', 'execute')::text || ' '
    || has_function_privilege('authenticated', 'private.dispatch_sweep(uuid)', 'execute')::text || ' '
    || has_function_privilege('anon', 'public.staff_dispatch_delivery(uuid, boolean)', 'execute')::text);
end
$t$;

-- 13. DL-1 / CONC-1: a stop whose order is cancelled stays cancelled; a closed order is never offered -------
do $t$
declare
  d1 uuid;
  d2 uuid;
  du uuid;
  dv uuid;
begin
  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  d1 := pg_temp.new_delivery('S', 0.03);
  d2 := pg_temp.new_delivery('T', 0.031);
  perform pg_temp.ready(d1);
  perform pg_temp.ready(d2);
  perform pg_temp.online('D1', true);
  perform pg_temp.online('D2', true);
  perform pg_temp.online('D3', true);
  perform private.dispatch_sweep(pg_temp.fx('B1'));
  perform pg_temp.expect('cancel in a stack: the stack is offered to D1', 'false assigned D1 searching | assigned D1 searching',
    pg_temp.solo(d1) || ' ' || pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2));

  -- The second order is cancelled while the stack is on D1's screen, and D1 lets the offer lapse.
  update public.orders set status = 'cancelled' where id = pg_temp.fx('o:T');
  perform pg_temp.expect('cancel in a stack: the cancelled stop is cancelled with D1 still on it', 'cancelled D1 searching',
    pg_temp.dsum(d2));
  update public.deliveries set offer_expires_at = now() - interval '1 second' where id in (d1, d2) and status = 'assigned';
  perform private.expire_dispatch_offers(pg_temp.fx('B1'));
  perform pg_temp.expect('stack expiry: the cancelled stop stays cancelled, untouched by the expiry',
    'cancelled D1 searching false 1',
    pg_temp.dsum(d2) || ' '
    || (select exists (select 1 from jsonb_array_elements(dispatch_history) e where e ->> 'type' = 'offer_expired')::text
          from public.deliveries where id = d2) || ' '
    || (select count(*)::text from public.delivery_assignments where delivery_id = d2));
  perform pg_temp.expect('stack expiry: the live stop goes to the next rider on its own, the stack dissolved',
    'assigned D2 searching true true',
    pg_temp.dsum(d1) || ' ' || pg_temp.solo(d1) || ' ' || pg_temp.solo(d2));

  -- An order completed by hand while its delivery waits: never offered, never swept, never stacked.
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D3', false);
  du := pg_temp.new_delivery('U', 0.05);
  perform pg_temp.ready(du);
  perform pg_temp.expect('closed order: the delivery waits (nobody free)', 'dispatching - waiting', pg_temp.dsum(du));
  update public.orders set status = 'completed' where id = pg_temp.fx('o:U');
  perform pg_temp.online('D1', true);
  perform pg_temp.online('D3', true);
  perform pg_temp.expect('closed order: dispatch_delivery refuses it', 'not_dispatchable order_closed completed',
    (select (x ->> 'result') || ' ' || (x ->> 'reason') || ' ' || (x ->> 'order_status')
       from private.dispatch_delivery(du, 'staff') x));
  perform pg_temp.expect('closed order: the sweep does not look at it', '0 dispatching - waiting',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(du));
  dv := pg_temp.new_delivery('V', 0.051);
  perform pg_temp.ready(dv);
  perform pg_temp.expect('closed order: a new order on the way is not stacked with it', 'true true assigned D1 searching',
    pg_temp.solo(dv) || ' ' || pg_temp.solo(du) || ' ' || pg_temp.dsum(dv));
end
$t$;

-- 14. DL-4: a failed trip whose order was cancelled is not offered again ---------------------------------------
do $t$
declare
  d uuid;
begin
  perform pg_temp.reset();
  d := pg_temp.new_delivery('W');
  perform pg_temp.ready(d);
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.accept_dispatch(d);
  perform pg_temp.act_as(null);
  update public.deliveries set status = 'picked_up' where id = d;
  -- Staff cancel the order while the food is out (the delivery is not touched by that), then the rider
  -- gives up after pickup.
  update public.orders set status = 'cancelled' where id = pg_temp.fx('o:W');
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.driver_cancel_delivery(d, 'Customer not answering');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('requeue a closed order: the trip failed', 'failed D1 -', pg_temp.dsum(d));
  perform pg_temp.expect('requeue a closed order: refused', 'ERR order_closed',
    pg_temp.try_as(pg_temp.fx('manager'), array[format('select public.requeue_failed_delivery(%L)::text', d)]));
  perform pg_temp.expect('requeue a closed order: nobody is offered it', 'failed D1 - 1',
    pg_temp.dsum(d) || ' ' || (select count(*)::text from public.delivery_assignments where delivery_id = d));
  -- And dispatch itself refuses it, whatever its row says.
  update public.deliveries
     set status = 'dispatching', driver_id = null, accepted_at = null,
         dispatch_round_started_at = clock_timestamp(), dispatch_state = 'searching'
   where id = d;
  perform pg_temp.expect('a cancelled order''s delivery is never offered', 'not_dispatchable order_closed dispatching - searching',
    (select (x ->> 'result') || ' ' || (x ->> 'reason') from private.dispatch_delivery(d, 'auto') x)
    || ' ' || pg_temp.dsum(d));
end
$t$;

-- 15. DL-2: a stack never inherits another round's exclusions --------------------------------------------------
do $t$
declare
  da uuid;
  db uuid;
  dc uuid;
  dd uuid;
  de uuid;
  df uuid;
  v jsonb;
begin
  -- A fresh order next to one every rider has declined.
  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  da := pg_temp.new_delivery('X', 0.03);
  perform pg_temp.ready(da);
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(da, 'declined');
  perform pg_temp.act_as(pg_temp.fx('uD2')); perform public.reject_dispatch(da, 'declined');
  perform pg_temp.act_as(pg_temp.fx('uD3')); perform public.reject_dispatch(da, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('inherit: the first order has asked everyone', 'dispatching - waiting | waiting everyone_asked',
    pg_temp.dsum(da) || ' | ' || pg_temp.last_entry(da));
  db := pg_temp.new_delivery('Y', 0.031);
  perform pg_temp.ready(db);
  perform pg_temp.expect('inherit: a fresh order is not stacked with it, and is offered at once',
    'true true assigned D1 searching | dispatching - waiting',
    pg_temp.solo(db) || ' ' || pg_temp.solo(da) || ' ' || pg_temp.dsum(db) || ' | ' || pg_temp.dsum(da));

  -- Two waiting orders, each declined by a different rider, are not paired by the sweep.
  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  dc := pg_temp.new_delivery('Z1', 0.03);
  perform pg_temp.ready(dc);
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(dc, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', true);
  dd := pg_temp.new_delivery('Z2', 0.031);
  perform pg_temp.ready(dd);
  perform pg_temp.act_as(pg_temp.fx('uD2')); perform public.reject_dispatch(dd, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('inherit: two orders, each declined by a different rider, both waiting',
    'dispatching - waiting | dispatching - waiting', pg_temp.dsum(dc) || ' | ' || pg_temp.dsum(dd));
  perform pg_temp.online('D1', true);
  perform pg_temp.expect('inherit: the sweep offers each to the rider who has not declined it, unstacked',
    '2 assigned D2 searching | assigned D1 searching true true',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(dc) || ' | ' || pg_temp.dsum(dd)
    || ' ' || pg_temp.solo(dc) || ' ' || pg_temp.solo(dd));

  -- A stack whose rounds came apart (paired before this fix): broken up when it finds nobody, and the
  -- stop nobody was asked about goes to the free rider.
  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  de := pg_temp.new_delivery('Z3', 0.03);
  perform pg_temp.ready(de);
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(de, 'declined');
  perform pg_temp.act_as(pg_temp.fx('uD2')); perform public.reject_dispatch(de, 'declined');
  perform pg_temp.act_as(pg_temp.fx('uD3')); perform public.reject_dispatch(de, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  df := pg_temp.new_delivery('Z4', 0.031);
  perform pg_temp.ready(df);
  perform pg_temp.expect('broken stack: the fresh order waits on its own (nobody online)', 'true waiting nobody_online',
    pg_temp.solo(df) || ' ' || pg_temp.last_entry(df));
  update public.deliveries set batch_id = gen_random_uuid() where id = de;
  update public.deliveries
     set batch_id = (select batch_id from public.deliveries where id = de),
         batch_seq = case when id = de then 1 else 2 end
   where id in (de, df);
  perform pg_temp.online('D1', true);
  v := private.dispatch_delivery(de, 'auto');
  perform pg_temp.expect('broken stack: the stack finds nobody and is broken up; the other stop is offered alone',
    'waiting offered D1 | dispatching - waiting | assigned D1 searching | true true',
    (v ->> 'result') || ' ' || (v -> 'unstacked' -> 'others' -> 0 ->> 'result') || ' '
    || pg_temp.who((v -> 'unstacked' -> 'others' -> 0 ->> 'driver_id')::uuid) || ' | '
    || pg_temp.dsum(de) || ' | ' || pg_temp.dsum(df) || ' | ' || pg_temp.solo(de) || ' ' || pg_temp.solo(df));
  perform pg_temp.expect('broken stack: the waiting stop counts its own riders asked', '3 3',
    (select (dispatch_history -> -1 ->> 'asked') from public.deliveries where id = de) || ' ' || (v ->> 'asked_count'));
end
$t$;

-- 16. DL-3 / CONC-8: Find rider again moves on from the withdrawn rider; "free but not this step" is searching ---
do $t$
declare
  dg uuid;
  dh uuid;
  v jsonb;
begin
  perform pg_temp.reset();
  dg := pg_temp.new_delivery('Z5');
  perform pg_temp.ready(dg);
  perform pg_temp.expect('withdraw and move on: offered to D1', 'assigned D1 searching', pg_temp.dsum(dg));
  perform pg_temp.act_as(pg_temp.fx('manager'));
  v := public.staff_dispatch_delivery(dg, true);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('withdraw and move on: the next rider is offered, not the one just withdrawn',
    'offered D2 assigned D2 searching', (v ->> 'result') || ' ' || pg_temp.who((v ->> 'driver_id')::uuid) || ' ' || pg_temp.dsum(dg));
  perform pg_temp.expect('withdraw and move on: the withdrawn rider is not written into the new round', 'false 0',
    (pg_temp.fx('D1') = any (private.dispatch_asked_riders(array[dg])))::text || ' ' || pg_temp.strikes(pg_temp.fx('D1'), dg));

  -- Only the withdrawn rider is free: this step does not offer it to him again at once, and does not call
  -- him busy; the next sweep may come back to him.
  perform pg_temp.reset();
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  dh := pg_temp.new_delivery('Z6');
  perform pg_temp.ready(dh);
  perform pg_temp.act_as(pg_temp.fx('manager'));
  v := public.staff_dispatch_delivery(dh, true);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('only the withdrawn rider is free: still searching, not "busy", not re-offered at once',
    'waiting retry_shortly 0 | dispatching - searching | withdrawn',
    (v ->> 'result') || ' ' || (v ->> 'reason') || ' ' || (v ->> 'asked_count') || ' | ' || pg_temp.dsum(dh)
    || ' | ' || pg_temp.last_entry(dh));
  perform pg_temp.expect('only the withdrawn rider is free: the next sweep offers it to him', '1 assigned D1 searching',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' ' || pg_temp.dsum(dh));
end
$t$;

-- 17. BE-2 / CONC-2: an order taken back from ready ends its round ---------------------------------------------
do $t$
declare
  dk uuid;
  dl uuid;
  dm uuid;
  dn1 uuid;
  dn2 uuid;
  v_round timestamptz;
  v_hi uuid;
  v_hist integer;
begin
  -- Recall while an offer is out.
  perform pg_temp.reset();
  dk := pg_temp.new_delivery('K1');
  perform pg_temp.ready(dk);
  select dispatch_round_started_at into v_round from public.deliveries where id = dk;
  perform pg_temp.expect('recall: offered to D1', 'assigned D1 searching', pg_temp.dsum(dk));
  perform pg_temp.act_as(pg_temp.fx('kitchen'));
  perform public.recall_order(pg_temp.fx('o:K1'));
  perform pg_temp.act_as(null);
  perform pg_temp.expect('recall: the offer is withdrawn without a strike; the delivery waits for the kitchen, outside any round',
    'pending - - true 0',
    pg_temp.dsum(dk) || ' ' || (select (dispatch_round_started_at is null)::text from public.deliveries where id = dk)
    || ' ' || pg_temp.strikes(pg_temp.fx('D1')));
  perform pg_temp.expect('recall: the rider''s turn is closed as withdrawn by staff', 'reassigned reassigned_by_staff order_recalled',
    (select a.status || ' ' || a.end_kind || ' ' || a.end_reason from public.delivery_assignments a
      where a.delivery_id = dk and a.driver_id = pg_temp.fx('D1')));
  perform pg_temp.expect('recall: logged as withdrawn, then recalled', 'withdrawn order_recalled | recalled',
    (select (dispatch_history -> -2 ->> 'type') || ' ' || (dispatch_history -> -2 ->> 'reason') || ' | '
            || (dispatch_history -> -1 ->> 'type')
       from public.deliveries where id = dk));
  perform pg_temp.expect('recall: the sweep leaves it alone, and Find rider is refused while it cooks',
    '0 not_dispatchable kitchen_not_ready pending - -',
    private.dispatch_sweep(pg_temp.fx('B1'))::text || ' '
    || (select (x ->> 'result') || ' ' || (x ->> 'reason') from private.dispatch_delivery(dk, 'staff') x)
    || ' ' || pg_temp.dsum(dk));
  perform pg_temp.ready(dk);
  perform pg_temp.expect('ready again: a fresh round, offered at once', 'assigned D1 searching true',
    pg_temp.dsum(dk) || ' ' || (select (dispatch_round_started_at > v_round)::text from public.deliveries where id = dk));

  -- Undo (the kitchen's bare update) on a waiting delivery.
  perform pg_temp.reset();
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  dl := pg_temp.new_delivery('K2');
  perform pg_temp.ready(dl);
  perform pg_temp.expect('undo: the delivery was waiting', 'dispatching - waiting', pg_temp.dsum(dl));
  update public.orders set status = 'preparing' where id = pg_temp.fx('o:K2');
  perform pg_temp.expect('undo: back to pending, outside any round', 'pending - - true',
    pg_temp.dsum(dl) || ' ' || (select (dispatch_round_started_at is null)::text from public.deliveries where id = dl));

  -- A job a rider accepted stays his; Ready again does not lock it (CONC-4), and his pickup moves the order.
  perform pg_temp.reset();
  dm := pg_temp.new_delivery('K3');
  perform pg_temp.ready(dm);
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.accept_dispatch(dm);
  perform pg_temp.act_as(null);
  v_hist := (select jsonb_array_length(dispatch_history) from public.deliveries where id = dm);
  perform pg_temp.act_as(pg_temp.fx('kitchen'));
  perform public.recall_order(pg_temp.fx('o:K3'));
  perform pg_temp.act_as(null);
  perform pg_temp.expect('recall after accept: the rider keeps the job, the row is not written', 'assigned D1 - true true',
    pg_temp.dsum(dm) || ' ' || (select (accepted_at is not null)::text || ' '
                                       || (jsonb_array_length(dispatch_history) = v_hist)::text
                                  from public.deliveries where id = dm));
  perform pg_temp.ready(dm);
  perform pg_temp.expect('ready after accept: the rider keeps the job, the row is not written', 'assigned D1 - true',
    pg_temp.dsum(dm) || ' ' || (select (jsonb_array_length(dispatch_history) = v_hist)::text
                                  from public.deliveries where id = dm));
  -- Row locks cannot be watched from one session (this transaction's own locks never block it), so
  -- the order is read off the function: the accepted job is answered before any row is locked.
  perform pg_temp.expect('lock order: dispatch_delivery answers an accepted job before it locks a row', 'true',
    (select (position('''already_accepted''' in def) between 1 and position('for update' in def))::text
       from (select pg_get_functiondef('private.dispatch_delivery(uuid, text)'::regprocedure) as def) f));
  update public.deliveries set pickup_photo_url = 'test://pickup.jpg' where id = dm;
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.progress_delivery(dm, 'picked_up');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('pickup: the delivery and the order move on', 'picked_up D1 - out_for_delivery',
    pg_temp.dsum(dm) || ' ' || (select status::text from public.orders where id = pg_temp.fx('o:K3')));

  -- Recall one stop of a stack whose offer is out.
  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  dn1 := pg_temp.new_delivery('K4', 0.03);
  dn2 := pg_temp.new_delivery('K5', 0.031);
  perform pg_temp.ready(dn1);
  perform pg_temp.ready(dn2);
  perform pg_temp.online('D1', true);
  perform pg_temp.online('D2', true);
  perform pg_temp.online('D3', true);
  perform private.dispatch_sweep(pg_temp.fx('B1'));
  perform pg_temp.expect('recall in a stack: the stack is offered to D1', 'false assigned D1 searching | assigned D1 searching',
    pg_temp.solo(dn1) || ' ' || pg_temp.dsum(dn1) || ' | ' || pg_temp.dsum(dn2));
  perform pg_temp.act_as(pg_temp.fx('kitchen'));
  perform public.recall_order(pg_temp.fx('o:K4'));
  perform pg_temp.act_as(null);
  perform pg_temp.expect('recall in a stack: this stop goes back to the kitchen, the other goes to the next rider alone, no strike',
    'pending - - | assigned D2 searching | true true 0',
    pg_temp.dsum(dn1) || ' | ' || pg_temp.dsum(dn2) || ' | ' || pg_temp.solo(dn1) || ' ' || pg_temp.solo(dn2)
    || ' ' || pg_temp.strikes(pg_temp.fx('D1')));

  -- 18. CONC-3 / CONC-5: the rider's own writes, in either order ----------------------------------------------
  perform pg_temp.reset();
  dk := pg_temp.new_delivery('L1');
  perform pg_temp.ready(dk);
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.set_driver_location(pg_temp.fx('D1'), -95.0, 30.0021, 80);
  perform public.accept_dispatch(dk);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('a GPS ping on an open offer, then Accept: both go through', 'assigned D1 - 30.0021 30.0021',
    pg_temp.dsum(dk) || ' ' || (select driver_lat::text from public.deliveries where id = dk) || ' '
    || (select round(st_y(current_location::geometry)::numeric, 4)::text from public.drivers where id = pg_temp.fx('D1')));
  dl := pg_temp.new_delivery('L2');
  perform pg_temp.ready(dl);
  perform pg_temp.act_as(pg_temp.fx('uD2'));
  perform public.accept_dispatch(dl);
  perform public.set_driver_location(pg_temp.fx('D2'), -95.0, 30.0051, 70);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('Accept, then a GPS ping: both go through', 'assigned D2 - 30.0051 70',
    pg_temp.dsum(dl) || ' ' || (select driver_lat::text from public.deliveries where id = dl) || ' '
    || (select battery_level::text from public.drivers where id = pg_temp.fx('D2')));
  perform pg_temp.expect('another rider''s ping cannot write this rider''s row', 'ERR forbidden',
    pg_temp.try_as(pg_temp.fx('uD2'), array[format('select public.set_driver_location(%L, -95.0, 30.0, null)::text', pg_temp.fx('D1'))]));

  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  dn1 := pg_temp.new_delivery('L3', 0.03);
  dn2 := pg_temp.new_delivery('L4', 0.031);
  perform pg_temp.ready(dn1);
  perform pg_temp.ready(dn2);
  perform pg_temp.online('D1', true);
  perform private.dispatch_sweep(pg_temp.fx('B1'));
  v_hi := greatest(dn1, dn2);
  perform pg_temp.act_as(pg_temp.fx('uD1'));
  perform public.accept_dispatch(v_hi);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('a stack accepted through its higher-id stop: both stops are the rider''s', 'assigned D1 - | assigned D1 - | 2',
    pg_temp.dsum(dn1) || ' | ' || pg_temp.dsum(dn2) || ' | '
    || (select count(*)::text from public.deliveries where id in (dn1, dn2) and accepted_at is not null));

  perform pg_temp.expect('lock order: accept_dispatch takes the branch lock before any row lock', 'true',
    (select (position('private.dispatch_lock_branch' in def) between 1 and position('for update' in def))::text
       from (select pg_get_functiondef('public.accept_dispatch(uuid)'::regprocedure) as def) f));
  perform pg_temp.expect('lock order: set_driver_location writes deliveries (skipping locked ones) before the rider''s row', 'true true',
    (select (position('update public.deliveries' in def) between 1 and position('update public.drivers' in def))::text
            || ' ' || (def like '%skip locked%')::text
       from (select pg_get_functiondef('public.set_driver_location(uuid, double precision, double precision, integer)'::regprocedure) as def) f));
  perform pg_temp.expect('lock order: progress_delivery locks the order before the delivery', 'true',
    (select (position('from public.orders' in def) between 1 and position('for update;' in def))::text
       from (select pg_get_functiondef('public.progress_delivery(uuid, delivery_status)'::regprocedure) as def) f));
end
$t$;

-- 19. CONC-6: the expiry scan has its index ----------------------------------------------------------------------
do $t$
declare
  v_line text;
  v_plan text := '';
begin
  perform pg_temp.expect('the expiry index: open offers by expiry', 'true',
    (select (indexdef like '%(offer_expires_at)%' and indexdef like '%accepted_at IS NULL%'
             and indexdef like '%''assigned''%')::text
       from pg_indexes where schemaname = 'public' and indexname = 'deliveries_open_offer_expiry_idx'));
  perform set_config('enable_seqscan', 'off', true);
  for v_line in execute
    'explain select d.id from public.deliveries d
      where d.status = ''assigned'' and d.accepted_at is null
        and d.offer_expires_at is not null and d.offer_expires_at < now()'
  loop
    v_plan := v_plan || v_line || ' ';
  end loop;
  perform set_config('enable_seqscan', 'on', true);
  perform pg_temp.expect('the expiry index: the expiry''s query can use it', 'true',
    (v_plan like '%deliveries_open_offer_expiry_idx%')::text);

  perform pg_temp.expect('the new trigger functions are not callable by app users', 'false false',
    has_function_privilege('authenticated', 'private.orders_unready_withdraws_dispatch()', 'execute')::text || ' '
    || has_function_privilege('authenticated', 'private.notify_offer_kick()', 'execute')::text);
  perform pg_temp.expect('the rider''s RPCs keep their grants', 'true true true true false false',
    has_function_privilege('authenticated', 'public.set_driver_location(uuid, double precision, double precision, integer)', 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.progress_delivery(uuid, delivery_status)', 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.accept_dispatch(uuid)', 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.reject_dispatch(uuid, text)', 'execute')::text || ' '
    || has_function_privilege('anon', 'public.accept_dispatch(uuid)', 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.claim_batch_sibling(uuid)', 'execute')::text);
  perform pg_temp.expect('recall trigger: on an order leaving ready backwards', 'true',
    (select (pg_get_triggerdef(t.oid) like '%AFTER UPDATE OF status ON public.orders%'
             and pg_get_triggerdef(t.oid) like '%''ready''%')::text
       from pg_trigger t where t.tgname = 'orders_unready_withdraws_dispatch'
        and t.tgrelid = 'public.orders'::regclass));
end
$t$;

-- 20. A decline that lands once the offer has run out is the offer expiring ----------------------------------
do $t$
declare
  d uuid;
  d1 uuid;
  d2 uuid;
begin
  -- A live decline stays a decline.
  perform pg_temp.reset();
  d := pg_temp.new_delivery('T1');
  perform pg_temp.ready(d);
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('late decline: a decline in time is a reject', 'rejected declined | rejected rejected | reject | assigned D2 searching',
    (select h ->> 'type' || ' ' || (h ->> 'reason') from public.deliveries x
       cross join lateral jsonb_array_elements(x.dispatch_history) h
      where x.id = d and h ->> 'type' in ('rejected', 'offer_expired')) || ' | '
    || (select a.status || ' ' || a.end_kind from public.delivery_assignments a
         where a.delivery_id = d and a.driver_id = pg_temp.fx('D1')) || ' | '
    || (select string_agg(type, ',') from public.driver_penalty_events where driver_id = pg_temp.fx('D1')) || ' | '
    || pg_temp.dsum(d));

  -- The phone's countdown decline.
  perform pg_temp.reset();
  d := pg_temp.new_delivery('T2');
  perform pg_temp.ready(d);
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d, 'timeout');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('late decline: the countdown decline is an expiry, and the next rider is asked now',
    'offer_expired timeout | expired offer_expired | timeout | assigned D2 searching',
    (select h ->> 'type' || ' ' || (h ->> 'reason') from public.deliveries x
       cross join lateral jsonb_array_elements(x.dispatch_history) h
      where x.id = d and h ->> 'type' in ('rejected', 'offer_expired')) || ' | '
    || (select a.status || ' ' || a.end_kind from public.delivery_assignments a
         where a.delivery_id = d and a.driver_id = pg_temp.fx('D1')) || ' | '
    || (select string_agg(type, ',') from public.driver_penalty_events where driver_id = pg_temp.fx('D1')) || ' | '
    || pg_temp.dsum(d));

  -- Decline tapped after the deadline, before the sweep cleared it.
  perform pg_temp.reset();
  d := pg_temp.new_delivery('T3');
  perform pg_temp.ready(d);
  update public.deliveries set offer_expires_at = now() - interval '1 second' where id = d;
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d, 'declined');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('late decline: a decline past the deadline is an expiry too, one strike',
    'offer_expired declined | expired offer_expired | timeout | assigned D2 searching',
    (select h ->> 'type' || ' ' || (h ->> 'reason') from public.deliveries x
       cross join lateral jsonb_array_elements(x.dispatch_history) h
      where x.id = d and h ->> 'type' in ('rejected', 'offer_expired')) || ' | '
    || (select a.status || ' ' || a.end_kind from public.delivery_assignments a
         where a.delivery_id = d and a.driver_id = pg_temp.fx('D1')) || ' | '
    || (select string_agg(type, ',') from public.driver_penalty_events where driver_id = pg_temp.fx('D1')) || ' | '
    || pg_temp.dsum(d));

  -- A stack's countdown decline: both stops expire, one strike, the stack moves on as a unit.
  perform pg_temp.reset();
  update public.branches set settings = settings || '{"batch_enabled": true}'::jsonb where id = pg_temp.fx('B1');
  perform pg_temp.online('D1', false);
  perform pg_temp.online('D2', false);
  perform pg_temp.online('D3', false);
  d1 := pg_temp.new_delivery('T4', 0.03);
  d2 := pg_temp.new_delivery('T5', 0.031);
  perform pg_temp.ready(d1);
  perform pg_temp.ready(d2);
  perform pg_temp.online('D1', true);
  perform pg_temp.online('D2', true);
  perform private.dispatch_sweep(pg_temp.fx('B1'));
  perform pg_temp.expect('late decline: the stack is offered to D1', 'assigned D1 searching | assigned D1 searching',
    pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2));
  perform pg_temp.act_as(pg_temp.fx('uD1')); perform public.reject_dispatch(d2, 'timeout');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('late decline: a stack''s countdown decline expires both stops, one strike, the stack moves on',
    'offer_expired offer_expired | timeout | assigned D2 searching | assigned D2 searching',
    (select h ->> 'type' from public.deliveries x cross join lateral jsonb_array_elements(x.dispatch_history) h
      where x.id = d1 and h ->> 'type' in ('rejected', 'offer_expired')) || ' '
    || (select h ->> 'type' from public.deliveries x cross join lateral jsonb_array_elements(x.dispatch_history) h
      where x.id = d2 and h ->> 'type' in ('rejected', 'offer_expired')) || ' | '
    || (select string_agg(type, ',') from public.driver_penalty_events where driver_id = pg_temp.fx('D1')) || ' | '
    || pg_temp.dsum(d1) || ' | ' || pg_temp.dsum(d2));
end
$t$;

-- 21. CONC-7: a rider offer kicks the notify worker when its transaction commits ------------------------------
-- Last on purpose: SET CONSTRAINTS ... IMMEDIATE fires every deferred kick this transaction has queued
-- so far, and keeps the trigger immediate until the rollback.
-- The calls this transaction queued, found by the txid the kick writes into its body (other sessions
-- queue and the pg_net worker drains calls all the time, so a count of the whole queue would race).
create or replace function pg_temp.my_kicks()
returns setof net.http_request_queue
language sql
as $$
  select q.* from net.http_request_queue q
   where q.body is not null
     and convert_from(q.body, 'UTF8') like '%"txid": ' || txid_current()::text || ',%'
$$;

do $t$
declare
  v_url text := nullif(btrim(coalesce(private.get_setting('notify_worker_url'), '')), '');
  v_secret text := nullif(private.get_setting('notify_worker_secret'), '');
  v_req record;
  d uuid;
begin
  perform pg_temp.reset();
  perform pg_temp.expect('kick: a deferred trigger on the outbox, for rider offers only', 'true true true',
    (select t.tgdeferrable::text || ' ' || t.tginitdeferred::text || ' '
            || (pg_get_triggerdef(t.oid) like '%new_dispatch%')::text
       from pg_trigger t where t.tgname = 'notifications_outbox_kick_offer_push'
        and t.tgrelid = 'public.notifications_outbox'::regclass));
  d := pg_temp.new_delivery('M1');
  perform pg_temp.ready(d);
  perform pg_temp.expect('kick: an offer is queued, and nothing is sent before the commit', 'assigned D1 searching 0',
    pg_temp.dsum(d) || ' ' || (select count(*)::text from pg_temp.my_kicks()));

  -- As at commit: every offer this transaction queued (sections 1-20) fires its deferred kick now.
  set constraints public.notifications_outbox_kick_offer_push immediate;
  perform pg_temp.expect('kick: at commit, one call to the worker for the transaction''s offers (none without a worker URL)',
    case when v_url is null then '0' else '1' end, (select count(*)::text from pg_temp.my_kicks()));
  if v_url is not null then
    select * into v_req from pg_temp.my_kicks() limit 1;
    perform pg_temp.expect('kick: to notify_worker_url, POST, offers only', 'true POST offers new_dispatch',
      (v_req.url = v_url)::text || ' ' || v_req.method || ' '
      || (convert_from(v_req.body, 'UTF8')::jsonb ->> 'scope') || ' '
      || (convert_from(v_req.body, 'UTF8')::jsonb ->> 'source'));
    perform pg_temp.expect('kick: the worker secret is sent only when one is set', 'true',
      ((v_req.headers ? 'x-worker-secret') = (v_secret is not null))::text);
  end if;

  d := pg_temp.new_delivery('M2');
  perform pg_temp.ready(d);
  perform pg_temp.expect('kick: once per transaction', 'assigned D2 searching ' || case when v_url is null then '0' else '1' end,
    pg_temp.dsum(d) || ' ' || (select count(*)::text from pg_temp.my_kicks()));
end
$t$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
