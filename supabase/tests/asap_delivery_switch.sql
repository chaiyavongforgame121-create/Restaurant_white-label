-- "Accept ASAP delivery orders" (20261026100000_asap_delivery_switch,
-- docs/ASAP-AND-SCHEDULING-2026-10-25.md §1). A rolled-back script, not a migration. Pins:
-- patch_branch_settings taking only a JSON boolean or null for asap_delivery_enabled (after its
-- permission checks, everything else as before), private.default_branch_settings seeding false,
-- and copy_branch_setup copying the switch, a source that never ticked it as an explicit false.
-- Section 0 checks what the migration left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/asap_delivery_switch.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script
-- creates for itself (section 0 only reads).
--   pg_temp.try_as(uid, sqls)  as the `authenticated` role, in a subtransaction that is always
--                              rolled back; reports 'ok <last value>' or 'ERR <sqlstate> <message>'.
--   pg_temp.patch_hint(uid, branch, patch)  the hint patch_branch_settings refuses the patch with,
--                              the same way.
--   pg_temp.copy_asap(uid, source, target)  copies the settings of source onto target as uid, in a
--                              subtransaction that is always rolled back, and reports the target's
--                              asap_delivery_enabled afterwards ('<missing>' when there is none).
--
-- People (auth.users rows made here):
--   owner    restaurants.owner_user_id of the test restaurant (branch.settings everywhere)
--   kitchen  kitchen at branch on (kitchen.access, no branch.settings)
--
-- Branches (settings written as the service role, as any value already stored could be):
--   on     asap_delivery_enabled true
--   off    asap_delivery_enabled false
--   none   no asap_delivery_enabled key (never ticked)
--   junk   asap_delivery_enabled "true" (a string, stored before this migration refused it)
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

-- Copy p_source's settings (only) onto p_target as p_uid and report the target's
-- asap_delivery_enabled afterwards, or 'ERR <sqlstate> <message>'. Always rolled back, so every
-- call starts from the fixtures.
create or replace function pg_temp.copy_asap(p_uid uuid, p_source uuid, p_target uuid)
returns text
language plpgsql
as $$
declare
  v_after text;
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
    perform public.copy_branch_setup(p_source, p_target, false, false, true, false, false);
    perform set_config('role', 'postgres', true);
    select coalesce((b.settings -> 'asap_delivery_enabled')::text, '<missing>') into v_after
      from public.branches b where b.id = p_target;
    raise exception using message = 'COPY_OK', detail = v_after;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail, v_state = returned_sqlstate;
    if v_msg = 'COPY_OK' then
      return v_det;
    end if;
    return 'ERR ' || v_state || ' ' || v_msg;
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
  values (v, 'asap-switch-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', false), '{}'::jsonb, now(), now());
  return v;
end $$;

do $test$
declare
  v_owner   uuid := pg_temp.new_user('owner');
  v_kitchen uuid := pg_temp.new_user('kitchen');
  v_sfx     text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_r uuid; v_on uuid; v_off uuid; v_none uuid; v_junk uuid;
  c_patch constant text := 'select public.patch_branch_settings(%L, %L::jsonb) ->> %L';
  c_hint  constant text := 'asap_delivery_enabled must be true or false.';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('patch_branch_settings: as live -- postgres, SECURITY DEFINER, search_path pinned, authenticated and service_role only',
    'postgres true search_path=public, pg_temp true false true',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'public.patch_branch_settings(uuid,jsonb)'::regprocedure));
  perform pg_temp.expect('default_branch_settings: as live -- postgres, SECURITY DEFINER, stable, search_path pinned, no API role may call it',
    'postgres true s search_path=public, pg_temp false false',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' '
              || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'private.default_branch_settings(uuid)'::regprocedure));
  perform pg_temp.expect('copy_branch_setup: as live -- postgres, SECURITY DEFINER, search_path pinned, authenticated and service_role only',
    'postgres true search_path=public, pg_temp true false true',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'public.copy_branch_setup(uuid,uuid,boolean,boolean,boolean,boolean,boolean)'::regprocedure));
  perform pg_temp.expect('one signature each for the three functions', '1,1,1',
    (select string_agg(n::text, ',' order by f)
       from (select p.proname as f, count(*) as n from pg_proc p
              where p.proname in ('patch_branch_settings', 'default_branch_settings', 'copy_branch_setup')
              group by p.proname) x));
  -- Meaningful when this runs in one transaction with the migration: now() is its start.
  perform pg_temp.expect('no backfill: the migration wrote no branch row',
    '0',
    (select count(*)::text from public.branches b
      where b.settings ? 'asap_delivery_enabled' and b.updated_at >= now()));

  -- Fixture: one restaurant on its trial, the four branches above, a kitchen user at `on`.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-asap-' || v_sfx, 'ZZ ASAP Switch') returning id into v_r;
  perform private.billing_apply_selection(v_r, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_r, 'on', 'ASAP On') returning id into v_on;
  insert into public.branches (restaurant_id, slug, name) values (v_r, 'off', 'ASAP Off') returning id into v_off;
  insert into public.branches (restaurant_id, slug, name) values (v_r, 'none', 'Never Ticked') returning id into v_none;
  insert into public.branches (restaurant_id, slug, name) values (v_r, 'junk', 'Junk Value') returning id into v_junk;
  update public.branches set settings = coalesce(settings, '{}'::jsonb) || '{"asap_delivery_enabled": true}'::jsonb
   where id = v_on;
  update public.branches set settings = coalesce(settings, '{}'::jsonb) || '{"asap_delivery_enabled": false}'::jsonb
   where id = v_off;
  update public.branches set settings = coalesce(settings, '{}'::jsonb) - 'asap_delivery_enabled'
   where id = v_none;
  update public.branches set settings = coalesce(settings, '{}'::jsonb) || '{"asap_delivery_enabled": "true"}'::jsonb
   where id = v_junk;
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_kitchen, v_r, v_on, 'kitchen', 'active');

  perform pg_temp.expect('fixture: the four branches hold true, false, nothing and "true"', 'true|false|<missing>|"true"',
    (select string_agg(coalesce((b.settings -> 'asap_delivery_enabled')::text, '<missing>'), '|'
                       order by array_position(array[v_on, v_off, v_none, v_junk], b.id))
       from public.branches b where b.id in (v_on, v_off, v_none, v_junk)));

  -- 1. patch_branch_settings takes only a boolean (§1) -------------------------------------------
  begin
    perform pg_temp.expect('patch: true and false are saved', 'ok true|ok false',
      pg_temp.try_as(v_owner, array[format(c_patch, v_none, '{"asap_delivery_enabled": true}', 'asap_delivery_enabled')])
        || '|' || pg_temp.try_as(v_owner, array[format(c_patch, v_none, '{"asap_delivery_enabled": false}', 'asap_delivery_enabled')]));
    perform pg_temp.expect('patch: a null removes the key (off)', 'ok false',
      pg_temp.try_as(v_owner, array[format('select (public.patch_branch_settings(%L, ''{"asap_delivery_enabled": null}''::jsonb) ? ''asap_delivery_enabled'')::text', v_on)]));
    perform pg_temp.expect('patch: a string, a number, an object and an array are refused, 22023 invalid_setting_value',
      'ERR 22023 invalid_setting_value|ERR 22023 invalid_setting_value|ERR 22023 invalid_setting_value|ERR 22023 invalid_setting_value|ERR 22023 invalid_setting_value|ERR 22023 invalid_setting_value',
      (select string_agg(pg_temp.try_as(v_owner, array[format(c_patch, v_none, jsonb_build_object('asap_delivery_enabled', v.x)::text,
                                                               'asap_delivery_enabled')]), '|' order by v.i)
         from (values (1, '"true"'::jsonb), (2, '"false"'), (3, '1'), (4, '0'), (5, '{"on": true}'), (6, '[true]')) v(i, x)));
    perform pg_temp.expect('patch: the hint names the rule', c_hint,
      pg_temp.patch_hint(v_owner, v_none, '{"asap_delivery_enabled": "yes"}'));
    perform pg_temp.expect('patch: a bad value refuses the whole patch, valid keys beside it included', 'ERR 22023 invalid_setting_value',
      pg_temp.try_as(v_owner, array[format(c_patch, v_none, '{"scheduling_enabled": false, "asap_delivery_enabled": "true"}', 'scheduling_enabled')]));
    perform pg_temp.expect('patch: ASAP and scheduling saved together, as the admin card saves them', 'ok true',
      pg_temp.try_as(v_owner, array[format('select (public.patch_branch_settings(%L, ''{"asap_delivery_enabled": true, "scheduling_enabled": false}''::jsonb) @> ''{"asap_delivery_enabled": true, "scheduling_enabled": false}''::jsonb)::text', v_none)]));
    perform pg_temp.expect('patch: the permission check still comes first (kitchen user, good and bad value)',
      'ERR 42501 not_authorized|ERR 42501 not_authorized',
      pg_temp.try_as(v_kitchen, array[format(c_patch, v_on, '{"asap_delivery_enabled": false}', 'asap_delivery_enabled')])
        || '|' || pg_temp.try_as(v_kitchen, array[format(c_patch, v_on, '{"asap_delivery_enabled": "x"}', 'asap_delivery_enabled')]));
    perform pg_temp.expect('patch: the kitchen still sets busy mode, and is not shown the switch', 'ok 10|ok false',
      pg_temp.try_as(v_kitchen, array[format('select public.patch_branch_settings(%L, ''{"busy_extra_prep_min": 10}''::jsonb) ->> ''busy_extra_prep_min''', v_on)])
        || '|' || pg_temp.try_as(v_kitchen, array[format('select (public.patch_branch_settings(%L, ''{}''::jsonb) ? ''asap_delivery_enabled'')::text', v_on)]));
    perform pg_temp.expect('patch: the other checks are unchanged (orders_paused, the lead time)',
      'ERR 22023 invalid_setting_value|ERR P0001 invalid_lead_time',
      pg_temp.try_as(v_owner, array[format(c_patch, v_on, '{"orders_paused": "yes"}', 'orders_paused')])
        || '|' || pg_temp.try_as(v_owner, array[format(c_patch, v_on, '{"schedule_lead_time_min": 7.5}', 'schedule_lead_time_min')]));
    perform pg_temp.expect('patch: a value already stored is left alone (junk keeps "true")', '"true"',
      (select (settings -> 'asap_delivery_enabled')::text from public.branches where id = v_junk));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. default_branch_settings seeds false (§2) ----------------------------------------------------
  begin
    perform pg_temp.expect('defaults: asap_delivery_enabled false, scheduling_enabled still true', 'false true',
      (select (s -> 'asap_delivery_enabled')::text || ' ' || (s -> 'scheduling_enabled')::text
         from (select private.default_branch_settings(v_r) as s) x));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. copy_branch_setup copies the switch (§3) ----------------------------------------------------
  begin
    perform pg_temp.expect('copy: true onto a branch that has false or nothing', 'true|true',
      pg_temp.copy_asap(v_owner, v_on, v_off) || '|' || pg_temp.copy_asap(v_owner, v_on, v_none));
    perform pg_temp.expect('copy: false onto a branch that has true', 'false',
      pg_temp.copy_asap(v_owner, v_off, v_on));
    perform pg_temp.expect('copy: a source that never ticked it is copied as false, not left as the target''s true', 'false',
      pg_temp.copy_asap(v_owner, v_none, v_on));
    perform pg_temp.expect('copy: a source holding the string "true" is off, and copied as false', 'false',
      pg_temp.copy_asap(v_owner, v_junk, v_on));
    perform pg_temp.expect('copy: the kitchen user still may not copy settings', 'ERR P0001 not_authorized',
      pg_temp.copy_asap(v_kitchen, v_off, v_on));
    perform pg_temp.expect('copy: without "settings" ticked the switch is not touched', 'ok true',
      pg_temp.try_as(v_owner, array[
        format('select (public.copy_branch_setup(%L, %L, false, true, false, false, false) ->> ''settings_copied'')', v_off, v_on),
        format('select (settings -> ''asap_delivery_enabled'')::text from public.branches where id = %L', v_on)]));
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
