begin;

-- Prep time is when a booking reaches the kitchen (20261116200000_kitchen_lead_is_prep_time, the
-- owner's decision of 2026-11-16). A rolled-back script, not a migration. Pins:
-- private.branch_kitchen_lead_min answering the prep time (prep_time_min when it is a whole number
-- 0-10080, else 15) plus busy mode (busy_extra_prep_min when it is a whole number 0-10080, else 0),
-- at most 10080, and never reading schedule_lead_time_min; every row of the case table in
-- supabase/functions/place-order/kitchen-lead.cases.ts, which place-order's copy (deno test) and the
-- shared copy (vitest) run too; and the function keeping its live shape and grants. Section 0 checks
-- what the migration left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/kitchen_lead_is_prep_time.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, and nothing is written: the
-- function is pure, and section 0 only reads the catalog.
--   pg_temp.lead_case(label, settings, lead)  one row of the case table: the resolver's answer for
--                              the settings (JSON text) must be lead, and it must not raise.
--   packages/shared/src/utils/kitchen-lead.test.ts reads the lead_case lines of section 1 and fails
--   unless they are the case table's rows, in order: add a row there and here together.
--
-- Each section runs in its own block: one that breaks reports a FAIL row and the others still run.
-- The result is one row per check with PASS/FAIL, then a summary row.

create temp table t_out (
  seq serial,
  check_name text,
  expected text,
  actual text,
  verdict text
) on commit drop;

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

-- One row of the case table. The settings arrive as text and are cast at run time, as a stored
-- row's settings are read, and an error is reported as the answer instead of ending the section.
create or replace function pg_temp.lead_case(p_label text, p_settings text, p_lead integer)
returns void
language plpgsql
as $$
declare
  v_actual text;
begin
  begin
    v_actual := coalesce(private.branch_kitchen_lead_min(p_settings::jsonb)::text, '<null>');
  exception when others then
    v_actual := 'ERR ' || sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.expect('table: ' || p_label || ': ' || p_settings, p_lead::text, v_actual);
end $$;

-- Who may EXECUTE a function: PUBLIC (an explicit ACL entry), then the three API roles.
create or replace function pg_temp.grants(p_fn regprocedure)
returns text
language sql
stable
as $$
  select 'PUBLIC=' || (exists (select 1 from pg_proc p
                                cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                where p.oid = p_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text
      || ' anon=' || has_function_privilege('anon', p_fn::oid, 'execute')::text
      || ' authenticated=' || has_function_privilege('authenticated', p_fn::oid, 'execute')::text
      || ' service_role=' || has_function_privilege('service_role', p_fn::oid, 'execute')::text;
$$;

do $test$
declare
  c_fn constant text := 'private.branch_kitchen_lead_min(jsonb)';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  begin
    perform pg_temp.expect('one signature: (p_settings jsonb) returning integer',
      'private.branch_kitchen_lead_min(jsonb) p_settings jsonb integer',
      (select string_agg(p.oid::regprocedure::text || ' ' || pg_get_function_arguments(p.oid) || ' '
                           || format_type(p.prorettype, null), '|')
         from pg_proc p
        where p.pronamespace = 'private'::regnamespace and p.proname = 'branch_kitchen_lead_min'));
    -- As 20261025100000 made it and live has it: CREATE OR REPLACE keeps the owner and the ACL.
    perform pg_temp.expect('as live: owned by postgres, plpgsql, IMMUTABLE, PARALLEL SAFE, runs as its caller, search_path pinned',
      'postgres plpgsql i s false search_path=public, pg_temp',
      (select pg_get_userbyid(p.proowner)::text || ' ' || l.lanname || ' ' || p.provolatile::text || ' '
              || p.proparallel::text || ' ' || p.prosecdef::text || ' ' || coalesce(array_to_string(p.proconfig, ','), '-')
         from pg_proc p
         join pg_language l on l.oid = p.prolang
        where p.oid = to_regprocedure(c_fn)));
    -- PUBLIC, anon and authenticated were revoked by 20261025100000 (and again by this migration);
    -- nothing ever granted the service role, as for release_scheduled_orders, revoked the same way
    -- (scheduling_release.sql pins that one).
    perform pg_temp.expect('grants as live: neither PUBLIC nor any API role may call it',
      'PUBLIC=false anon=false authenticated=false service_role=false',
      pg_temp.grants(to_regprocedure(c_fn)));
    perform pg_temp.expect('the body reads prep_time_min, then busy_extra_prep_min, capped at 10080; not schedule_lead_time_min',
      'true false',
      (select (p.prosrc like '%p_settings -> ''prep_time_min''%p_settings -> ''busy_extra_prep_min''%'
                             || 'return least(v_prep + v_busy, 10080);%')::text || ' '
              || (p.prosrc like '%schedule_lead_time_min%')::text
         from pg_proc p
        where p.oid = to_regprocedure(c_fn)));
    perform pg_temp.expect('its comment states the rule',
      'true',
      (select (obj_description(p.oid, 'pg_proc') like
                 '%the prep time (settings.prep_time_min%else 15) plus busy mode (busy_extra_prep_min%else 0), at most 10080.'
                 || ' schedule_lead_time_min is not read.%')::text
         from pg_proc p
        where p.oid = to_regprocedure(c_fn)));
    perform pg_temp.expect('release_scheduled_orders still reads the lead through it, untouched by this migration',
      'true',
      (select (p.prosrc like '%private.branch_kitchen_lead_min(b.settings)%')::text
         from pg_proc p
        where p.oid = to_regprocedure('private.release_scheduled_orders()')));
  exception when others then
    perform pg_temp.expect('section 0 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 1. The case table (supabase/functions/place-order/kitchen-lead.cases.ts, row for row) ---------
  begin
    -- The rule: Prep time plus busy mode, at most a week.
    perform pg_temp.lead_case('nothing saved: the default prep time', '{}', 15);
    perform pg_temp.lead_case('prep 20', '{"prep_time_min": 20}', 20);
    perform pg_temp.lead_case('prep 20 plus busy 10', '{"prep_time_min": 20, "busy_extra_prep_min": 10}', 30);
    perform pg_temp.lead_case('busy 10 on the default prep time', '{"busy_extra_prep_min": 10}', 25);
    perform pg_temp.lead_case('prep 0: at the booked time', '{"prep_time_min": 0}', 0);
    perform pg_temp.lead_case('prep 0 plus busy 0', '{"prep_time_min": 0, "busy_extra_prep_min": 0}', 0);
    perform pg_temp.lead_case('prep 0 plus busy 10', '{"prep_time_min": 0, "busy_extra_prep_min": 10}', 10);
    perform pg_temp.lead_case('prep 15.0 is a whole number', '{"prep_time_min": 15.0}', 15);
    perform pg_temp.lead_case('prep 1e2 is 100', '{"prep_time_min": 1e2}', 100);
    perform pg_temp.lead_case('prep -0 is 0', '{"prep_time_min": -0}', 0);
    perform pg_temp.lead_case('prep -0 plus busy -0 is 0', '{"prep_time_min": -0, "busy_extra_prep_min": -0}', 0);
    perform pg_temp.lead_case('prep 10080, a week', '{"prep_time_min": 10080}', 10080);
    perform pg_temp.lead_case('prep 10000 plus busy 79', '{"prep_time_min": 10000, "busy_extra_prep_min": 79}', 10079);
    perform pg_temp.lead_case('prep 10000 plus busy 100: capped at a week', '{"prep_time_min": 10000, "busy_extra_prep_min": 100}', 10080);
    perform pg_temp.lead_case('prep 10080 plus busy 10: capped at a week', '{"prep_time_min": 10080, "busy_extra_prep_min": 10}', 10080);
    perform pg_temp.lead_case('busy 10080 on the default prep time: capped at a week', '{"busy_extra_prep_min": 10080}', 10080);

    -- "Send to kitchen (minutes before)" is not read any more, whatever it holds.
    perform pg_temp.lead_case('a saved lead of 5 beside prep 15 is ignored', '{"schedule_lead_time_min": 5, "prep_time_min": 15}', 15);
    perform pg_temp.lead_case('a saved lead of 0 beside prep 20 is ignored', '{"schedule_lead_time_min": 0, "prep_time_min": 20}', 20);
    perform pg_temp.lead_case('a saved lead alone is ignored', '{"schedule_lead_time_min": 60}', 15);
    perform pg_temp.lead_case('a saved lead beside prep 5 plus busy 10 is ignored', '{"schedule_lead_time_min": 45, "prep_time_min": 5, "busy_extra_prep_min": 10}', 15);

    -- A prep time that is not a whole number 0-10080 is skipped for the default, never coerced.
    perform pg_temp.lead_case('prep 7.5', '{"prep_time_min": 7.5}', 15);
    perform pg_temp.lead_case('prep "15"', '{"prep_time_min": "15"}', 15);
    perform pg_temp.lead_case('prep "15 "', '{"prep_time_min": "15 "}', 15);
    perform pg_temp.lead_case('prep -1', '{"prep_time_min": -1}', 15);
    perform pg_temp.lead_case('prep 10081', '{"prep_time_min": 10081}', 15);
    perform pg_temp.lead_case('prep 1e400', '{"prep_time_min": 1e400}', 15);
    perform pg_temp.lead_case('prep "abc"', '{"prep_time_min": "abc"}', 15);
    perform pg_temp.lead_case('prep ""', '{"prep_time_min": ""}', 15);
    perform pg_temp.lead_case('prep true', '{"prep_time_min": true}', 15);
    perform pg_temp.lead_case('prep null', '{"prep_time_min": null}', 15);
    perform pg_temp.lead_case('prep [5]', '{"prep_time_min": [5]}', 15);
    perform pg_temp.lead_case('prep {"m": 5}', '{"prep_time_min": {"m": 5}}', 15);
    perform pg_temp.lead_case('prep 7.5 plus busy 10: the default prep time plus busy', '{"prep_time_min": 7.5, "busy_extra_prep_min": 10}', 25);

    -- A busy extra that is not a whole number 0-10080 counts as no extra.
    perform pg_temp.lead_case('busy 7.5', '{"prep_time_min": 20, "busy_extra_prep_min": 7.5}', 20);
    perform pg_temp.lead_case('busy "10"', '{"prep_time_min": 20, "busy_extra_prep_min": "10"}', 20);
    perform pg_temp.lead_case('busy -1', '{"prep_time_min": 20, "busy_extra_prep_min": -1}', 20);
    perform pg_temp.lead_case('busy 10081', '{"prep_time_min": 20, "busy_extra_prep_min": 10081}', 20);
    perform pg_temp.lead_case('busy "abc"', '{"prep_time_min": 20, "busy_extra_prep_min": "abc"}', 20);
    perform pg_temp.lead_case('busy true', '{"prep_time_min": 20, "busy_extra_prep_min": true}', 20);
    perform pg_temp.lead_case('busy null', '{"prep_time_min": 20, "busy_extra_prep_min": null}', 20);
    perform pg_temp.lead_case('busy [5]', '{"prep_time_min": 20, "busy_extra_prep_min": [5]}', 20);
    perform pg_temp.lead_case('busy {"m": 5}', '{"prep_time_min": 20, "busy_extra_prep_min": {"m": 5}}', 20);
    perform pg_temp.lead_case('both bad: the default', '{"prep_time_min": "abc", "busy_extra_prep_min": -5}', 15);

    -- Settings that are not an object read as nothing saved.
    perform pg_temp.lead_case('JSON null', 'null', 15);
    perform pg_temp.lead_case('an empty array', '[]', 15);
    perform pg_temp.lead_case('an array of settings', '[{"prep_time_min": 5}]', 15);
    perform pg_temp.lead_case('a number', '5', 15);
    perform pg_temp.lead_case('a string', '"x"', 15);
    perform pg_temp.lead_case('a boolean', 'true', 15);
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. What only SQL can be handed ---------------------------------------------------------------
  begin
    perform pg_temp.expect('SQL NULL settings (a branch row without any) read as nothing saved', '15',
      private.branch_kitchen_lead_min(null)::text);
    -- A constant argument, so nothing defers the casts to run time: it must still not raise.
    perform pg_temp.expect('never raises, even for a constant it cannot cast', '15',
      (select private.branch_kitchen_lead_min('{"prep_time_min": "abc", "busy_extra_prep_min": "abc"}')::text));
    perform pg_temp.expect('every branch in this database resolves to a lead from 0 to 10080, none to null', '0',
      (select count(*)::text from public.branches b
        where private.branch_kitchen_lead_min(b.settings) is null
           or private.branch_kitchen_lead_min(b.settings) not between 0 and 10080));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
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
