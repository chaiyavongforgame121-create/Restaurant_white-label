-- "Send to kitchen (minutes before)" really works (20261025100000_scheduling_release,
-- docs/ASAP-AND-SCHEDULING-2026-10-25.md §3). A rolled-back script, not a migration. Pins: the one
-- resolver private.branch_kitchen_lead_min (the lead, else the prep time, else 15; only whole
-- numbers 0-10080; it never raises), the release timing (a booking for 11:30 with a lead of 5 is
-- let out at 11:25 and not a second before), a branch with bad values no longer stopping every
-- other branch's releases, held orders that are cancelled, completed, refunded or out for delivery
-- staying held, patch_branch_settings refusing a lead or prep time that is not a whole number
-- 0-10080 (after its permission checks, everything else as before), and the release cron job
-- present exactly once. Section 0 checks what the migration left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/scheduling_release.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script
-- creates for itself (section 0 only reads). now() is the transaction's start for the whole
-- script, so "now" is the same instant for the orders made here and for every release run, and
-- the boundaries below are exact to the second. A release run also lets out any other held order
-- in the database whose time has come; the rollback puts them back.
--   pg_temp.try_as(uid, sqls)  as the `authenticated` role, in a subtransaction that is always
--                              rolled back; reports 'ok <last value>' or 'ERR <sqlstate> <message>'.
--   pg_temp.patch_hint(uid, branch, patch)  the hint patch_branch_settings refuses the patch with,
--                              the same way.
--
-- People (auth.users rows made here):
--   owner    restaurants.owner_user_id of the test restaurant (branch.settings everywhere)
--   kitchen  kitchen at branch b5 (kitchen.access, no branch.settings)
--
-- Branches:
--   b5    schedule_lead_time_min 5, prep_time_min 15   -> lead 5 (the owner's example)
--   bad   schedule_lead_time_min 7.5, prep_time_min "abc" -> lead 15 (both bad: the default)
--   bad2  schedule_lead_time_min "abc", prep_time_min 20 -> lead 20 (bad lead: the prep time)
--
-- Each section after the fixtures runs in its own block: one that breaks reports a FAIL row and
-- the others still run. The result is one row per check with PASS/FAIL, then a summary row.

begin;

create temp table t_out (
  seq serial,
  check_name text,
  expected text,
  actual text,
  verdict text
) on commit drop;

-- Run statements as p_uid and report 'ok <last value>' or 'ERR <sqlstate> <message>'. Always
-- rolled back.
create or replace function pg_temp.try_as(p_uid uuid, p_sqls text[])
returns text
language plpgsql
as $$
declare
  s text;
  v_last text;
  v_msg text;
  v_det text;
  v_state text;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
    perform set_config('role', 'authenticated', true);
    foreach s in array p_sqls loop
      execute s into v_last;
    end loop;
    raise exception using message = 'TRY_AS_OK', detail = coalesce(v_last, '');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail, v_state = returned_sqlstate;
    if v_msg = 'TRY_AS_OK' then
      return 'ok' || case when coalesce(v_det, '') <> '' then ' ' || v_det else '' end;
    end if;
    return 'ERR ' || v_state || ' ' || v_msg;
  end;
end $$;

-- The hint patch_branch_settings refuses p_patch with, as p_uid ('no error' when it is accepted).
-- Always rolled back.
create or replace function pg_temp.patch_hint(p_uid uuid, p_branch uuid, p_patch jsonb)
returns text
language plpgsql
as $$
declare
  v_msg text;
  v_hint text;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
    perform set_config('role', 'authenticated', true);
    perform public.patch_branch_settings(p_branch, p_patch);
    raise exception 'PATCH_OK';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    return case when v_msg = 'PATCH_OK' then 'no error' else coalesce(v_hint, '<no hint>') end;
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

create or replace function pg_temp.new_user(p_label text)
returns uuid
language plpgsql
as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v, 'scheduling-release-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', false), '{}'::jsonb, now(), now());
  return v;
end $$;

-- The resolver over a list of settings, in order, comma-separated.
create or replace function pg_temp.leads(p_settings jsonb[])
returns text
language sql
as $$
  select string_agg(coalesce(private.branch_kitchen_lead_min(u.s)::text, '<null>'), ',' order by u.i)
    from unnest(p_settings) with ordinality as u(s, i);
$$;

-- A held order at p_branch booked for p_at, in p_status.
create or replace function pg_temp.held_order(p_branch uuid, p_label text, p_at timestamptz,
                                              p_status public.order_status default 'pending')
returns uuid
language plpgsql
as $$
declare v uuid;
begin
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history,
                             scheduled_for, held)
  values ('T-SR-' || p_label || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8), p_branch, 'pickup',
          p_status, 10, 10, '[]', p_at, true)
  returning id into v;
  return v;
end $$;

-- Each order's held flag, in order: 'held' or 'out'.
create or replace function pg_temp.held_state(p_ids uuid[])
returns text
language sql
as $$
  select string_agg(case when o.held then 'held' else 'out' end, ',' order by u.i)
    from unnest(p_ids) with ordinality as u(id, i)
    left join public.orders o on o.id = u.id;
$$;

-- How many 'order_released' outbox rows name each order, in order.
create or replace function pg_temp.released_rows(p_ids uuid[])
returns text
language sql
as $$
  select string_agg((select count(*) from public.notifications_outbox n
                      where n.template = 'order_released' and n.variables ->> 'order_id' = u.id::text)::text,
                    ',' order by u.i)
    from unnest(p_ids) with ordinality as u(id, i);
$$;

do $test$
declare
  v_owner   uuid := pg_temp.new_user('owner');
  v_kitchen uuid := pg_temp.new_user('kitchen');
  v_sfx     text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_r uuid; v_b5 uuid; v_bad uuid; v_bad2 uuid;
  -- b5 (lead 5): the owner's 11:30 booking, "now" being 11:25.
  v_due uuid; v_early uuid; v_1124 uuid; v_missed uuid;
  v_confirmed uuid; v_preparing uuid; v_ready uuid;
  v_cancelled uuid; v_completed uuid; v_refunded uuid; v_out uuid;
  -- bad (lead 15) and bad2 (lead 20).
  v_bad_due uuid; v_bad_early uuid; v_bad2_due uuid; v_bad2_early uuid;
  c_patch constant text := 'select public.patch_branch_settings(%L, %L::jsonb) ->> %L';
  c_lead_hint constant text := 'schedule_lead_time_min must be a whole number of minutes from 0 to 10080.';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('resolver: immutable, parallel safe, runs as its caller, owned by postgres; no API role may call it',
    'postgres false i s false false',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' '
              || p.proparallel::text || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'private.branch_kitchen_lead_min(jsonb)'::regprocedure));
  perform pg_temp.expect('release: as live -- postgres, SECURITY DEFINER, search_path pinned, no API role may call it',
    'postgres true search_path=public, pg_temp false false false',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'private.release_scheduled_orders()'::regprocedure));
  perform pg_temp.expect('release: reads the lead through the resolver, with no raw ::int cast left', 'true false',
    (select (p.prosrc like '%private.branch_kitchen_lead_min(b.settings)%')::text || ' ' || (regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') like '%::int%')::text
       from pg_proc p where p.oid = 'private.release_scheduled_orders()'::regprocedure));
  perform pg_temp.expect('patch_branch_settings: as live -- postgres, SECURITY DEFINER, search_path pinned, authenticated and service_role only',
    'postgres true search_path=public, pg_temp true false true',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'public.patch_branch_settings(uuid,jsonb)'::regprocedure));
  perform pg_temp.expect('patch_branch_settings: one signature', '1',
    (select count(*)::text from pg_proc p
      where p.proname = 'patch_branch_settings' and p.pronamespace = 'public'::regnamespace));
  perform pg_temp.expect('cron: release-scheduled-orders exists once, every minute, running the release, switched on',
    '1|* * * * *|select private.release_scheduled_orders()|true',
    (select count(*)::text || '|' || coalesce(min(schedule), '') || '|' || coalesce(min(btrim(command)), '') || '|'
              || coalesce(bool_and(active)::text, '')
       from cron.job where jobname = 'release-scheduled-orders'));
  perform pg_temp.expect('cron: no other job runs the release', '0',
    (select count(*)::text from cron.job
      where command ilike '%release_scheduled_orders%' and jobname is distinct from 'release-scheduled-orders'));

  -- 1. The resolver (§3) --------------------------------------------------------------------------
  begin
    perform pg_temp.expect('resolver: the lead when it is a whole number 0-10080; 0 is an answer, not a gap',
      '5,0,10080,15',
      pg_temp.leads(array['{"schedule_lead_time_min": 5, "prep_time_min": 20}',
                          '{"schedule_lead_time_min": 0, "prep_time_min": 20}',
                          '{"schedule_lead_time_min": 10080}',
                          '{"schedule_lead_time_min": 15.0}']::jsonb[]));
    perform pg_temp.expect('resolver: else the prep time (0 included), else 15',
      '20,20,0,15,15',
      pg_temp.leads(array['{"prep_time_min": 20}',
                          '{"schedule_lead_time_min": null, "prep_time_min": 20}',
                          '{"prep_time_min": 0}',
                          '{}',
                          null]::jsonb[]));
    perform pg_temp.expect('resolver: a lead that is a fraction, negative, over a week, text, a boolean, an array or an object is skipped for the prep time',
      '20,20,20,20,20,20,20,20,20',
      pg_temp.leads(array['{"schedule_lead_time_min": 7.5, "prep_time_min": 20}',
                          '{"schedule_lead_time_min": -1, "prep_time_min": 20}',
                          '{"schedule_lead_time_min": 10081, "prep_time_min": 20}',
                          '{"schedule_lead_time_min": "15", "prep_time_min": 20}',
                          '{"schedule_lead_time_min": "15 ", "prep_time_min": 20}',
                          '{"schedule_lead_time_min": "abc", "prep_time_min": 20}',
                          '{"schedule_lead_time_min": true, "prep_time_min": 20}',
                          '{"schedule_lead_time_min": [5], "prep_time_min": 20}',
                          '{"schedule_lead_time_min": {"m": 5}, "prep_time_min": 20}']::jsonb[]));
    perform pg_temp.expect('resolver: both bad is the default',
      '15,15,15,15',
      pg_temp.leads(array['{"schedule_lead_time_min": 7.5, "prep_time_min": "abc"}',
                          '{"schedule_lead_time_min": "abc", "prep_time_min": 15.5}',
                          '{"schedule_lead_time_min": -5, "prep_time_min": 99999}',
                          '{"schedule_lead_time_min": "", "prep_time_min": false}']::jsonb[]));
    perform pg_temp.expect('resolver: settings that are not an object are the default; -0 is 0',
      '15,15,15,0',
      pg_temp.leads(array['[{"schedule_lead_time_min": 5}]', '5', '"x"',
                          '{"schedule_lead_time_min": -0}']::jsonb[]));
    -- A constant argument, so nothing defers the casts to run time: it must still not raise.
    perform pg_temp.expect('resolver: never raises, even for a constant it cannot cast', '15',
      (select private.branch_kitchen_lead_min('{"schedule_lead_time_min": "abc", "prep_time_min": "abc"}')::text));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- Fixture: one restaurant on its trial, three branches with the leads above, a kitchen user at b5.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-sr-' || v_sfx, 'ZZ Scheduling Release') returning id into v_r;
  perform private.billing_apply_selection(v_r, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_r, 'b5', 'Lead Five') returning id into v_b5;
  insert into public.branches (restaurant_id, slug, name) values (v_r, 'bad', 'Bad Values') returning id into v_bad;
  insert into public.branches (restaurant_id, slug, name) values (v_r, 'bad2', 'Bad Lead') returning id into v_bad2;
  -- Written as the service role (no JWT), as any value already stored could be.
  update public.branches set settings = settings || '{"schedule_lead_time_min": 5, "prep_time_min": 15}'::jsonb
   where id = v_b5;
  update public.branches set settings = settings || '{"schedule_lead_time_min": 7.5, "prep_time_min": "abc"}'::jsonb
   where id = v_bad;
  update public.branches set settings = settings || '{"schedule_lead_time_min": "abc", "prep_time_min": 20}'::jsonb
   where id = v_bad2;
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_kitchen, v_r, v_b5, 'kitchen', 'active');

  perform pg_temp.expect('fixture: the three branches resolve to 5, 15 and 20', '5,15,20',
    (select string_agg(private.branch_kitchen_lead_min(b.settings)::text, ',' order by array_position(array[v_b5, v_bad, v_bad2], b.id))
       from public.branches b where b.id in (v_b5, v_bad, v_bad2)));

  -- 2. Release timing, bad values, status filter (§3) ---------------------------------------------
  begin
    -- b5, lead 5. "Now" is 11:25: the 11:30 booking's kitchen time is exactly now.
    v_due    := pg_temp.held_order(v_b5, 'DUE', now() + interval '5 minutes');
    v_early  := pg_temp.held_order(v_b5, 'EARLY', now() + interval '5 minutes 1 second');
    v_1124   := pg_temp.held_order(v_b5, '1124', now() + interval '6 minutes');
    v_missed := pg_temp.held_order(v_b5, 'MISSED', now() - interval '1 hour');
    v_confirmed := pg_temp.held_order(v_b5, 'CONF', now() + interval '5 minutes', 'confirmed');
    v_preparing := pg_temp.held_order(v_b5, 'PREP', now() + interval '5 minutes', 'preparing');
    v_ready     := pg_temp.held_order(v_b5, 'READY', now() + interval '5 minutes', 'ready');
    v_cancelled := pg_temp.held_order(v_b5, 'CANC', now() - interval '1 hour', 'cancelled');
    v_completed := pg_temp.held_order(v_b5, 'DONE', now() - interval '1 hour', 'completed');
    v_refunded  := pg_temp.held_order(v_b5, 'REF', now() - interval '1 hour', 'refunded');
    v_out       := pg_temp.held_order(v_b5, 'OUT', now() - interval '1 hour', 'out_for_delivery');
    -- bad (lead 15) and bad2 (lead 20): their own default, exactly at and one minute before.
    v_bad_due    := pg_temp.held_order(v_bad, 'BAD-DUE', now() + interval '15 minutes');
    v_bad_early  := pg_temp.held_order(v_bad, 'BAD-EARLY', now() + interval '16 minutes');
    v_bad2_due   := pg_temp.held_order(v_bad2, 'BAD2-DUE', now() + interval '20 minutes');
    v_bad2_early := pg_temp.held_order(v_bad2, 'BAD2-EARLY', now() + interval '21 minutes');

    perform pg_temp.expect('fixture: every test order starts held', 'held,held,held,held,held,held,held,held,held,held,held,held,held,held,held',
      pg_temp.held_state(array[v_due, v_early, v_1124, v_missed, v_confirmed, v_preparing, v_ready,
                               v_cancelled, v_completed, v_refunded, v_out,
                               v_bad_due, v_bad_early, v_bad2_due, v_bad2_early]));

    -- The old job raised here (invalid input syntax for type integer: "7.5") and released nothing.
    perform private.release_scheduled_orders();

    perform pg_temp.expect('timing: the 11:30 booking with lead 5 is out at 11:25', 'out',
      pg_temp.held_state(array[v_due]));
    perform pg_temp.expect('timing: not a second before (11:24:59), nor at 11:24', 'held,held',
      pg_temp.held_state(array[v_early, v_1124]));
    perform pg_temp.expect('timing: a booking whose kitchen time has passed is let out at the next run', 'out',
      pg_temp.held_state(array[v_missed]));
    perform pg_temp.expect('status: every active status is let out (confirmed, preparing, ready)', 'out,out,out',
      pg_temp.held_state(array[v_confirmed, v_preparing, v_ready]));
    perform pg_temp.expect('status: cancelled, completed, refunded and out-for-delivery bookings stay held', 'held,held,held,held',
      pg_temp.held_state(array[v_cancelled, v_completed, v_refunded, v_out]));
    perform pg_temp.expect('bad values: the run did not fail, and b5 was released beside them (above); bad reads 15, bad2 reads 20',
      'out,held,out,held',
      pg_temp.held_state(array[v_bad_due, v_bad_early, v_bad2_due, v_bad2_early]));
    perform pg_temp.expect('outbox: one order_released row for each order let out, none for the rest',
      '1,0,0,1,1,1,1,0,0,0,0,1,0,1,0',
      pg_temp.released_rows(array[v_due, v_early, v_1124, v_missed, v_confirmed, v_preparing, v_ready,
                                  v_cancelled, v_completed, v_refunded, v_out,
                                  v_bad_due, v_bad_early, v_bad2_due, v_bad2_early]));
    perform pg_temp.expect('outbox: the row is for the branch''s staff, in_app, with the order''s number and booked time',
      'staff in_app true true',
      (select n.recipient_type || ' ' || n.channel || ' ' || (n.recipient_id = v_b5)::text || ' '
                || (n.variables ->> 'order_number' = o.order_number
                    and (n.variables ->> 'scheduled_for')::timestamptz = o.scheduled_for)::text
         from public.notifications_outbox n
         join public.orders o on o.id = v_due
        where n.template = 'order_released' and n.variables ->> 'order_id' = v_due::text));
    perform pg_temp.expect('release: only held changes; the status stays as it was', 'pending confirmed',
      (select (select status::text from public.orders where id = v_due) || ' '
                || (select status::text from public.orders where id = v_confirmed)));

    -- A second run lets out nothing more and queues no second row.
    perform private.release_scheduled_orders();
    perform pg_temp.expect('release: a second run changes nothing', 'held,held,held,held,held,held,held|1,1,1',
      pg_temp.held_state(array[v_early, v_1124, v_cancelled, v_completed, v_refunded, v_out, v_bad_early])
        || '|' || pg_temp.released_rows(array[v_due, v_missed, v_bad_due]));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. patch_branch_settings refuses a bad lead or prep time (§3) --------------------------------
  begin
    perform pg_temp.expect('patch: a lead of 5, 0 and 10080 is saved', 'ok 5|ok 0|ok 10080',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"schedule_lead_time_min": 5}', 'schedule_lead_time_min')])
        || '|' || pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"schedule_lead_time_min": 0}', 'schedule_lead_time_min')])
        || '|' || pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"schedule_lead_time_min": 10080}', 'schedule_lead_time_min')]));
    perform pg_temp.expect('patch: 15.0 is a whole number', 'ok 15.0',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"schedule_lead_time_min": 15.0}', 'schedule_lead_time_min')]));
    perform pg_temp.expect('patch: a lead over a week is refused, P0001 invalid_lead_time', 'ERR P0001 invalid_lead_time',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"schedule_lead_time_min": 10081}', 'schedule_lead_time_min')]));
    perform pg_temp.expect('patch: so are a fraction, a negative, a numeric string, text, a boolean, an array and an object',
      'ERR P0001 invalid_lead_time|ERR P0001 invalid_lead_time|ERR P0001 invalid_lead_time|ERR P0001 invalid_lead_time|ERR P0001 invalid_lead_time|ERR P0001 invalid_lead_time|ERR P0001 invalid_lead_time',
      (select string_agg(pg_temp.try_as(v_owner, array[format(c_patch, v_b5, jsonb_build_object('schedule_lead_time_min', v.x)::text,
                                                               'schedule_lead_time_min')]), '|' order by v.i)
         from (values (1, '7.5'::jsonb), (2, '-1'), (3, '"15"'), (4, '"abc"'), (5, 'true'), (6, '[5]'), (7, '{"m": 5}')) v(i, x)));
    perform pg_temp.expect('patch: the hint names the rule', c_lead_hint,
      pg_temp.patch_hint(v_owner, v_b5, '{"schedule_lead_time_min": 7.5}'));
    perform pg_temp.expect('patch: and names the prep time for the prep time',
      'prep_time_min must be a whole number of minutes from 0 to 10080.',
      pg_temp.patch_hint(v_owner, v_b5, '{"prep_time_min": -3}'));
    perform pg_temp.expect('patch: a null lead removes the key (the prep time then answers)', 'ok false',
      pg_temp.try_as(v_owner, array[format('select (public.patch_branch_settings(%L, ''{"schedule_lead_time_min": null}''::jsonb) ? ''schedule_lead_time_min'')::text', v_b5)]));
    perform pg_temp.expect('patch: a prep time of 20 and of 0 is saved', 'ok 20|ok 0',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"prep_time_min": 20}', 'prep_time_min')])
        || '|' || pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"prep_time_min": 0}', 'prep_time_min')]));
    perform pg_temp.expect('patch: a bad prep time is refused, P0001 invalid_prep_time',
      'ERR P0001 invalid_prep_time|ERR P0001 invalid_prep_time|ERR P0001 invalid_prep_time',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"prep_time_min": 15.5}', 'prep_time_min')])
        || '|' || pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"prep_time_min": "abc"}', 'prep_time_min')])
        || '|' || pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"prep_time_min": 10081}', 'prep_time_min')]));
    perform pg_temp.expect('patch: a bad value refuses the whole patch, valid keys beside it included', 'ERR P0001 invalid_prep_time',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"schedule_max_days": 9, "prep_time_min": 7.5}', 'schedule_max_days')]));
    perform pg_temp.expect('patch: other keys are unchanged (any value still saved as before)', 'ok 9',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"schedule_max_days": 9}', 'schedule_max_days')]));
    perform pg_temp.expect('patch: busy_extra_prep_min keeps its own rule and code', 'ERR 22023 invalid_setting_value',
      pg_temp.try_as(v_owner, array[format(c_patch, v_b5, '{"busy_extra_prep_min": 7.5}', 'busy_extra_prep_min')]));
    perform pg_temp.expect('patch: the permission check still comes first (kitchen user, bad prep time)', 'ERR 42501 not_authorized',
      pg_temp.try_as(v_kitchen, array[format(c_patch, v_b5, '{"prep_time_min": "abc"}', 'prep_time_min')]));
    perform pg_temp.expect('patch: the kitchen still sets busy mode', 'ok 10',
      pg_temp.try_as(v_kitchen, array[format(c_patch, v_b5, '{"busy_extra_prep_min": 10}', 'busy_extra_prep_min')]));
    perform pg_temp.expect('patch: values already stored are left alone (bad keeps 7.5)', '7.5',
      (select settings ->> 'schedule_lead_time_min' from public.branches where id = v_bad));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;
end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
