-- A branch's web address (20261026120000_branch_public_slugs, docs/SHORT-STOREFRONT-URLS-2026-10-26.md
-- §1–§3). A rolled-back script, not a migration. Pins: branches.public_slug's format and its
-- case-insensitive platform-wide uniqueness; the one namespace with restaurant slugs and
-- restaurant-level aliases, enforced both ways (a web address may not be a restaurant slug, a
-- restaurant alias or a reserved word; a restaurant slug may not be a web address or an old one,
-- create_restaurant_with_branch and a rename included); set_branch_public_slug (branch.settings
-- at that branch, precise errors, nothing written when unchanged, an audit row and a storefront
-- version bump when changed) and check_public_slug; the branch guard refusing every other API
-- write to the column, platform admins included, while writes with no JWT role still meet the
-- rules; an old web address becoming an alias that follows the branch, which no other branch may
-- take (only the branch that gave it up may take it back); and
-- public.resolve_storefront_path answering live / short / redirect / none with public_base and
-- segments. Section 0 checks what the migration left behind, the showcase backfill included.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/branch_public_slugs.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on two restaurants this script
-- creates for itself (section 0 only reads).
--   pg_temp.try_as(role, uid, sqls[, admin])  as `anon` (uid null) or `authenticated`, in a
--                                    subtransaction that is always rolled back; reports
--                                    'ok <last value>' or 'ERR <sqlstate> <message>'.
--   pg_temp.try_sql(sqls[, jwt_role]) as the script itself with no JWT (a migration, the SQL
--                                    editor) or, given jwt_role, with only that role in the claims
--                                    (the service role's key), the same way.
--   pg_temp.call_as(uid, sql[, admin]) with uid's JWT claims (the role stays the script's), KEPT
--                                    when it succeeds: how the fixture changes a web address
--                                    through the RPC. Reports the same way; the claims are cleared
--                                    afterwards either way.
--   pg_temp.hint_as(uid, sql) / pg_temp.detail_as(uid, sql)  the hint / detail sql is refused
--                                    with as uid (`authenticated`); always rolled back.
--   pg_temp.resolve(first, second)   resolve_storefront_path's one row as
--                                    'status restaurant branch public_slug public_base segments'
--                                    ('-' for a null).
--
-- People (auth.users rows made here):
--   owner     restaurants.owner_user_id of A (branch.settings at every branch of A)
--   owner_b   restaurants.owner_user_id of B
--   admin     admin of every branch of A (branch.settings)
--   manager   manager at A's main (no branch.settings)
--   stranger  no membership anywhere
--   platform  a platform admin (app_metadata.is_platform_admin)
--
-- Restaurants and branches (slugs carry a random suffix <s>; web addresses are zz-w<n>-<s>):
--   A  zz-bps-a-<s>   main, second, closed (switched off)
--   B  zz-bps-b-<s>   main            (renamed to zz-bps-b2-<s> in section 2)
--
-- Each section after the fixtures runs in its own block: one that breaks reports a FAIL row and
-- the others still run. Later sections build on earlier ones; the state each one starts from is
-- written above it. The result is one row per check with PASS/FAIL, then a summary row.

begin;

create temp table t_out (
  seq serial,
  check_name text,
  expected text,
  actual text,
  verdict text
) on commit drop;

-- Run statements as p_role (p_uid's JWT when given) and report 'ok <last value>' or
-- 'ERR <sqlstate> <message>'. Always rolled back.
create or replace function pg_temp.try_as(p_role text, p_uid uuid, p_sqls text[], p_admin boolean default false)
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
      json_build_object('sub', p_uid, 'role', p_role,
                        'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('role', p_role, true);
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

-- Run statements as the script's own database role, with no JWT claims or, given p_jwt_role, claims
-- carrying only that role. Reports like try_as. Always rolled back.
create or replace function pg_temp.try_sql(p_sqls text[], p_jwt_role text default null)
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
      case when p_jwt_role is null then '' else json_build_object('role', p_jwt_role)::text end, true);
    perform set_config('request.jwt.claim.sub', '', true);
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

-- Run one statement with p_uid's JWT claims (role 'authenticated' in the claims; the database
-- role stays the script's) and KEEP what it did when it succeeds. 'ok <value>' or
-- 'ERR <sqlstate> <message>' (then nothing it did is kept). The claims are cleared afterwards.
create or replace function pg_temp.call_as(p_uid uuid, p_sql text, p_admin boolean default false)
returns text
language plpgsql
as $$
declare
  v_last text;
  v_msg text;
  v_state text;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    execute p_sql into v_last;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ok' || case when coalesce(v_last, '') <> '' then ' ' || v_last else '' end;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ERR ' || v_state || ' ' || v_msg;
  end;
end $$;

-- The hint (hint_as) or the detail (detail_as) p_sql is refused with as p_uid (`authenticated`),
-- or null when it is not refused (detail_as: 'not refused'). Always rolled back.
create or replace function pg_temp.hint_as(p_uid uuid, p_sql text, p_admin boolean default false)
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
                        'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('role', 'authenticated', true);
    execute p_sql;
    raise exception 'HINT_AS_OK';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    if v_msg = 'HINT_AS_OK' then
      return null;
    end if;
    return nullif(v_hint, '');
  end;
end $$;

create or replace function pg_temp.detail_as(p_uid uuid, p_sql text)
returns text
language plpgsql
as $$
declare
  v_msg text;
  v_detail text;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('role', 'authenticated', true);
    execute p_sql;
    raise exception 'DETAIL_AS_OK';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    if v_msg = 'DETAIL_AS_OK' then
      return 'not refused';
    end if;
    return nullif(v_detail, '');
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

create or replace function pg_temp.new_user(p_label text, p_admin boolean default false)
returns uuid
language plpgsql
as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v, 'branch-public-slugs-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', p_admin), '{}'::jsonb, now(), now());
  return v;
end $$;

-- resolve_storefront_path's row, '-' for a null.
create or replace function pg_temp.resolve(p_first text, p_second text)
returns text
language sql
as $$
  select string_agg(x.status || ' ' || coalesce(x.restaurant_slug, '-') || ' ' || coalesce(x.branch_slug, '-') || ' '
                    || coalesce(x.public_slug, '-') || ' ' || coalesce(x.public_base, '-') || ' '
                    || coalesce(x.segments::text, '-'), ' | ')
    from public.resolve_storefront_path(p_first, p_second) x;
$$;

do $test$
declare
  v_owner    uuid := pg_temp.new_user('owner');
  v_owner_b  uuid := pg_temp.new_user('owner-b');
  v_admin    uuid := pg_temp.new_user('admin');
  v_manager  uuid := pg_temp.new_user('manager');
  v_stranger uuid := pg_temp.new_user('stranger');
  v_platform uuid := pg_temp.new_user('platform', true);
  v_sfx text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_a  text := 'zz-bps-a-' || v_sfx;
  v_b  text := 'zz-bps-b-' || v_sfx;
  v_b2 text := 'zz-bps-b2-' || v_sfx;
  v_w1 text := 'zz-w1-' || v_sfx;
  v_w2 text := 'zz-w2-' || v_sfx;
  v_w3 text := 'zz-w3-' || v_sfx;
  v_w4 text := 'zz-w4-' || v_sfx;
  v_w5 text := 'zz-w5-' || v_sfx;
  v_w6 text := 'zz-w6-' || v_sfx;
  v_ra uuid; v_rb uuid;
  v_main uuid; v_second uuid; v_closed uuid; v_bmain uuid;
  v_version bigint;
  -- '<public_slug or -> <path>' from the RPC's answer.
  c_set constant text :=
    'select coalesce(x ->> ''public_slug'', ''-'') || '' '' || (x ->> ''path'') from public.set_branch_public_slug(%L, %L) x';
  -- '<slug or -> <available> <error or -> <current>' from the RPC's answer.
  c_check constant text :=
    'select coalesce(x ->> ''slug'', ''-'') || '' '' || (x ->> ''available'') || '' '' || coalesce(x ->> ''error'', ''-'') || '' '' || (x ->> ''current'') from public.check_public_slug(%L, %L) x';
  c_resolve constant text :=
    'select status || '' '' || restaurant_slug || '' '' || branch_slug || '' '' || coalesce(public_slug, ''-'') || '' '' || public_base || '' '' || segments from public.resolve_storefront_path(%L, %L)';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('column: branches.public_slug, text, nullable, no default',
    'text YES <none>',
    (select c.data_type || ' ' || c.is_nullable || ' ' || coalesce(c.column_default, '<none>')
       from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'branches' and c.column_name = 'public_slug'));
  perform pg_temp.expect('column: the slug rule, 2 to 64 characters, null allowed',
    'CHECK (((public_slug IS NULL) OR ((public_slug ~ ''^[a-z0-9](-?[a-z0-9])*$''::text) AND (length(public_slug) >= 2) AND (length(public_slug) <= 64))))',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.branches'::regclass and conname = 'branches_public_slug_check'));
  perform pg_temp.expect('column: unique platform-wide, case-insensitively',
    'CREATE UNIQUE INDEX branches_public_slug_uidx ON public.branches USING btree (lower(public_slug)) WHERE (public_slug IS NOT NULL)',
    (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'branches_public_slug_uidx'));
  perform pg_temp.expect('aliases: a branch_slug needs a branch_id, a branch_id no longer needs a branch_slug (the old pair check is gone)',
    'storefront_path_aliases_branch_slug_needs_branch:CHECK (((branch_slug IS NULL) OR (branch_id IS NOT NULL)))',
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), ' || ' order by conname) from pg_constraint
      where conrelid = 'public.storefront_path_aliases'::regclass and contype = 'c'));
  perform pg_temp.expect('set_branch_public_slug: postgres, SECURITY DEFINER, search_path pinned; authenticated only',
    'postgres true search_path=public, pg_temp true false false',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'public.set_branch_public_slug(uuid,text)'::regprocedure));
  perform pg_temp.expect('check_public_slug: postgres, SECURITY DEFINER, stable, search_path pinned; authenticated only',
    'postgres true s search_path=public, pg_temp true false false',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' '
              || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'public.check_public_slug(uuid,text)'::regprocedure));
  perform pg_temp.expect('resolve_storefront_path: postgres, SECURITY DEFINER, stable, search_path pinned; anon, authenticated and service_role may call it',
    'postgres true s search_path=public, pg_temp true true true',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' '
              || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'public.resolve_storefront_path(text,text)'::regprocedure));
  perform pg_temp.expect('resolve_storefront_path: p_second optional; the six result columns',
    'p_first text, p_second text DEFAULT NULL::text -> TABLE(status text, restaurant_slug text, branch_slug text, public_slug text, public_base text, segments integer)',
    (select pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid)
       from pg_proc p where p.oid = 'public.resolve_storefront_path(text,text)'::regprocedure));
  perform pg_temp.expect('one signature each for the three RPCs', '1,1,1',
    (select string_agg(n::text, ',' order by f)
       from (select p.proname as f, count(*) as n from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('set_branch_public_slug', 'check_public_slug', 'resolve_storefront_path')
              group by p.proname) x));
  perform pg_temp.expect('private helpers: postgres, SECURITY DEFINER, search_path pinned; no API role may call them',
    'private.public_slug_problem(text,uuid) postgres true search_path=public, pg_temp false false|private.record_storefront_path_alias() postgres true search_path=public, pg_temp false false|private.tg_branches_public_slug() postgres true search_path=public, pg_temp false false|private.tg_restaurants_slug_namespace() postgres true search_path=public, pg_temp false false',
    (select string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
                       || array_to_string(p.proconfig, ',') || ' '
                       || has_function_privilege('anon', p.oid, 'execute')::text || ' '
                       || has_function_privilege('authenticated', p.oid, 'execute')::text,
                       '|' order by p.oid::regprocedure::text)
       from pg_proc p
      where p.oid in ('private.public_slug_problem(text,uuid)'::regprocedure, 'private.record_storefront_path_alias()'::regprocedure,
                      'private.tg_branches_public_slug()'::regprocedure, 'private.tg_restaurants_slug_namespace()'::regprocedure)));
  perform pg_temp.expect('branch guard: as live (postgres, SECURITY DEFINER, search_path pinned) plus the public_slug flag; its old rules still there',
    'postgres true search_path=public, pg_temp true true true true',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || (p.prosrc like '%favornoms.public_slug_write%')::text || ' '
              || (p.prosrc like '%branch_privileged_column_forbidden%Only the restaurant owner can change a branch slug%')::text || ' '
              || (p.prosrc like '%branch_settings_required%')::text || ' '
              || (p.prosrc like '%branch_manager_required%')::text
       from pg_proc p where p.oid = 'private.guard_branch_privileged_columns()'::regprocedure));
  perform pg_temp.expect('triggers: the rules on branches, the namespace on restaurants, the web-address alias, the old alias trigger untouched',
    'branches_public_slug_rules:CREATE TRIGGER branches_public_slug_rules BEFORE INSERT OR UPDATE OF public_slug ON public.branches FOR EACH ROW WHEN ((new.public_slug IS NOT NULL)) EXECUTE FUNCTION private.tg_branches_public_slug()'
    || ' || restaurants_slug_namespace:CREATE TRIGGER restaurants_slug_namespace BEFORE INSERT OR UPDATE OF slug ON public.restaurants FOR EACH ROW EXECUTE FUNCTION private.tg_restaurants_slug_namespace()'
    || ' || trg_storefront_path_alias:CREATE TRIGGER trg_storefront_path_alias AFTER UPDATE OF slug, restaurant_id ON public.branches FOR EACH ROW WHEN (((old.slug IS DISTINCT FROM new.slug) OR (old.restaurant_id IS DISTINCT FROM new.restaurant_id))) EXECUTE FUNCTION private.record_storefront_path_alias()'
    || ' || trg_storefront_public_slug_alias:CREATE TRIGGER trg_storefront_public_slug_alias AFTER UPDATE OF public_slug ON public.branches FOR EACH ROW WHEN ((old.public_slug IS DISTINCT FROM new.public_slug)) EXECUTE FUNCTION private.record_storefront_path_alias(''public_slug'')',
    (select string_agg(t.tgname || ':' || pg_get_triggerdef(t.oid), ' || ' order by t.tgname)
       from pg_trigger t
      where not t.tgisinternal
        and (t.tgname in ('branches_public_slug_rules', 'restaurants_slug_namespace', 'trg_storefront_public_slug_alias')
             or (t.tgname = 'trg_storefront_path_alias' and t.tgrelid = 'public.branches'::regclass))));
  perform pg_temp.expect('triggers: the storefront version also moves with public_slug',
    '%UPDATE OF name, slug, address, timezone, theme_override, settings, is_active, custom_domain, brand_id, sales_tax_rate, geo_lat, geo_lng, open_hours, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, app_icon, public_slug ON public.branches%',
    (select pg_get_triggerdef(t.oid) from pg_trigger t
      where t.tgname = 'trg_bump_storefront_version' and t.tgrelid = 'public.branches'::regclass));
  -- The showcase backfill (live only; a local stack without those branches skips this).
  if exists (select 1 from public.branches where id = '44444444-4444-4444-4444-444444444444') then
    perform pg_temp.expect('backfill: Hamburger has the web address hamburger',
      'hamburger', (select public_slug from public.branches where id = '44444444-4444-4444-4444-444444444444'));
    if exists (select 1 from public.branches where id = '44444444-4444-4444-4444-444444444444' and is_active) then
      perform pg_temp.expect('backfill: /r/hamburger is its short form; the long form and coastal-grill go there',
        'short|redirect /r/hamburger 2|redirect /r/hamburger 2',
        (select status from public.resolve_storefront_path('hamburger', null)) || '|'
          || (select status || ' ' || public_base || ' ' || segments from public.resolve_storefront_path(
                (select r.slug from public.restaurants r join public.branches b on b.restaurant_id = r.id
                  where b.id = '44444444-4444-4444-4444-444444444444'),
                (select slug from public.branches where id = '44444444-4444-4444-4444-444444444444'))) || '|'
          || coalesce((select status || ' ' || public_base || ' ' || segments
                         from public.resolve_storefront_path('coastal-grill',
                                (select slug from public.branches where id = '44444444-4444-4444-4444-444444444444'))),
                      'redirect /r/hamburger 2'));
    end if;
  end if;
  if exists (select 1 from public.branches where id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083') then
    perform pg_temp.expect('backfill: Food Thai Thai has the web address food-thai-thai',
      'food-thai-thai', (select public_slug from public.branches where id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083'));
  end if;
  perform pg_temp.expect('backfill: no other branch was given a web address',
    '0',
    (select count(*)::text from public.branches
      where public_slug is not null
        and id not in ('44444444-4444-4444-4444-444444444444', 'd0b26b93-4539-4065-8b16-bcfa1e5b8083')));

  -- Fixture: A (owner) with main, second and a switched-off branch; B (owner_b) with main. An
  -- admin of every branch of A, a manager at A's main.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, v_a, 'ZZ Public Slugs A') returning id into v_ra;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner_b, v_b, 'ZZ Public Slugs B') returning id into v_rb;
  perform private.billing_apply_selection(v_rb, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'main', 'Main') returning id into v_main;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'second', 'Second') returning id into v_second;
  insert into public.branches (restaurant_id, slug, name, is_active) values (v_ra, 'closed', 'Closed', false)
  returning id into v_closed;
  insert into public.branches (restaurant_id, slug, name) values (v_rb, 'main', 'B Main') returning id into v_bmain;
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_admin, v_ra, null, 'admin', 'active'),
         (v_manager, v_ra, v_main, 'manager', 'active');

  perform pg_temp.expect('fixture: no web address and no alias row for the new restaurants yet', '0|0',
    (select count(*)::text from public.branches where restaurant_id in (v_ra, v_rb) and public_slug is not null) || '|'
      || (select count(*)::text from public.storefront_path_aliases where restaurant_id in (v_ra, v_rb)));

  -- 1. set_branch_public_slug: who may, and what it writes. Starts: no web addresses. -------------
  begin
    v_version := coalesce((select version from public.storefront_versions where branch_id = v_main), 0);
    perform pg_temp.expect('set: the owner sets a web address; typed in capitals with spaces, it is saved lower case',
      'ok ' || v_w1 || ' /r/' || v_w1,
      pg_temp.call_as(v_owner, format(c_set, v_main, '  ' || upper(v_w1) || ' ')));
    perform pg_temp.expect('set: it is on the branch', v_w1, (select public_slug from public.branches where id = v_main));
    perform pg_temp.expect('set: an audit row by the owner says from null to the address',
      '1|staff|true|null|' || v_w1,
      (select count(*)::text || '|' || max(l.actor_type) || '|' || bool_and(l.actor_id = v_owner)::text || '|'
                || coalesce(max(l.metadata ->> 'from'), 'null') || '|' || max(l.metadata ->> 'to')
         from public.audit_logs l where l.branch_id = v_main and l.action = 'branch_public_slug_changed'));
    perform pg_temp.expect('set: the storefront version moved (the cached tenant carries the address)', 'true',
      ((select version from public.storefront_versions where branch_id = v_main) > v_version)::text);

    v_version := (select version from public.storefront_versions where branch_id = v_main);
    perform pg_temp.expect('set: the same address again answers the same and writes nothing',
      'ok ' || v_w1 || ' /r/' || v_w1 || '|1|0|' || v_version,
      pg_temp.call_as(v_owner, format(c_set, v_main, v_w1)) || '|'
        || (select count(*)::text from public.audit_logs where branch_id = v_main and action = 'branch_public_slug_changed') || '|'
        || (select count(*)::text from public.storefront_path_aliases where branch_id = v_main) || '|'
        || (select version from public.storefront_versions where branch_id = v_main));

    perform pg_temp.expect('set: an admin of every branch, and a platform admin, may',
      'ok ' || v_w2 || ' /r/' || v_w2 || '|ok ' || v_w2 || ' /r/' || v_w2,
      pg_temp.try_as('authenticated', v_admin, array[format(c_set, v_main, v_w2)]) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_set, v_main, v_w2)], true));
    perform pg_temp.expect('set: a platform admin''s change is audited as one',
      'ok platform_admin',
      pg_temp.try_as('authenticated', v_platform, array[format(c_set, v_main, v_w2),
        format('select actor_type from public.audit_logs where branch_id = %L and action = %L and metadata ->> %L = %L',
               v_main, 'branch_public_slug_changed', 'to', v_w2)], true));
    perform pg_temp.expect('set: a manager (no branch.settings), a stranger and another restaurant''s owner may not',
      'ERR 42501 not_authorized|ERR 42501 not_authorized|ERR 42501 not_authorized',
      pg_temp.try_as('authenticated', v_manager, array[format(c_set, v_main, v_w2)]) || '|'
        || pg_temp.try_as('authenticated', v_stranger, array[format(c_set, v_main, v_w2)]) || '|'
        || pg_temp.try_as('authenticated', v_owner_b, array[format(c_set, v_main, v_w2)]));
    perform pg_temp.expect('set: anon may not call it; a token without a user is asked to sign in',
      'ERR 42501 permission denied for function set_branch_public_slug|ERR 42501 sign_in_required',
      pg_temp.try_as('anon', null, array[format(c_set, v_main, v_w2)]) || '|'
        || pg_temp.try_as('authenticated', null, array[format(c_set, v_main, v_w2)]));
    perform pg_temp.expect('set: an unknown branch is branch_not_found (for a platform admin, who passes the permission check)',
      'ERR P0002 branch_not_found',
      pg_temp.try_as('authenticated', v_platform, array[format(c_set, gen_random_uuid(), v_w2)], true));
    perform pg_temp.expect('set: nothing above was kept', v_w1, (select public_slug from public.branches where id = v_main));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. Precise errors, and the namespace from the branch side. Starts: A main = w1; B is zz-bps-b
  --    with main. -------------------------------------------------------------------------------
  begin
    perform pg_temp.expect('errors: too short, a space, edge or double hyphens, an underscore, an accent, 65 characters: 22023 slug_invalid',
      'ERR 22023 slug_invalid|ERR 22023 slug_invalid|ERR 22023 slug_invalid|ERR 22023 slug_invalid|ERR 22023 slug_invalid|ERR 22023 slug_invalid|ERR 22023 slug_invalid|ERR 22023 slug_invalid',
      (select string_agg(pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v.x)]), '|' order by v.i)
         from (values (1, 'a'), (2, 'bad slug'), (3, '-abc'), (4, 'abc-'), (5, 'a--b'), (6, 'ab_c'), (7, 'phở'),
                      (8, repeat('a', 65))) v(i, x)));
    perform pg_temp.expect('errors: 64 characters is still fine', 'ok ' || repeat('a', 64) || ' /r/' || repeat('a', 64),
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, repeat('a', 64))]));
    perform pg_temp.expect('errors: every reserved word, in any letter case: 22023 slug_reserved',
      'ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved|ERR 22023 slug_reserved',
      (select string_agg(pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v.x)]), '|' order by v.i)
         from (values (1, 'r'), (2, 'API'), (3, 'auth'), (4, 'Admin'), (5, 'app'), (6, 'www'), (7, 'help'),
                      (8, 'privacy'), (9, 'terms'), (10, 'ccpa')) v(i, x)));
    perform pg_temp.expect('errors: the hints name the rule',
      'Use 2 to 64 lowercase letters, digits and single hyphens, for example pho-ha-noi.|That word is kept for the platform. Pick another web address.',
      pg_temp.hint_as(v_owner, format(c_set, v_second, 'a')) || '|' || pg_temp.hint_as(v_owner, format(c_set, v_second, 'api')));

    -- B's main takes w3.
    perform pg_temp.expect('fixture: B''s owner gives B''s main w3', 'ok ' || v_w3 || ' /r/' || v_w3,
      pg_temp.call_as(v_owner_b, format(c_set, v_bmain, v_w3)));
    perform pg_temp.expect('taken: another branch''s web address, in any letter case: 23505 slug_taken',
      'ERR 23505 slug_taken|ERR 23505 slug_taken',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_w3)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, upper(v_w3))]));
    perform pg_temp.expect('taken: a restaurant slug (another restaurant''s or its own)',
      'ERR 23505 slug_taken|ERR 23505 slug_taken',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_b)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_a)]));
    -- B gives up its slug: a restaurant-level alias.
    update public.restaurants set slug = v_b2 where id = v_rb;
    perform pg_temp.expect('taken: a slug a restaurant gave up (a restaurant-level alias)', 'ERR 23505 slug_taken',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_b)]));
    perform pg_temp.expect('taken: the hint', 'Another storefront already answers to that address. Pick another.',
      pg_temp.hint_as(v_owner, format(c_set, v_second, v_w3)));
    perform pg_temp.expect('errors: nothing was written to second', '<none>',
      coalesce((select public_slug from public.branches where id = v_second), '<none>'));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. The namespace from the restaurant side. Starts: A main = w1, B (zz-bps-b2) main = w3,
  --    alias zz-bps-b -> B. ----------------------------------------------------------------------
  begin
    perform pg_temp.expect('restaurants: a new restaurant may not take a web address, in any letter case: 23505 slug_taken',
      'ERR 23505 slug_taken|ERR 23505 slug_taken',
      pg_temp.try_sql(array[format(
        'insert into public.restaurants (owner_user_id, slug, name) values (%L, %L, %L) returning slug', v_stranger, v_w1, 'Squat')])
        || '|' || pg_temp.try_sql(array[format(
        'insert into public.restaurants (owner_user_id, slug, name) values (%L, lower(%L), %L) returning slug', v_stranger, upper(v_w3), 'Squat')]));
    perform pg_temp.expect('restaurants: nor be renamed to one (the owner, through the API)', 'ERR 23505 slug_taken',
      pg_temp.try_as('authenticated', v_owner, array[format(
        'update public.restaurants set slug = %L where id = %L returning slug', v_w3, v_ra)]));
    perform pg_temp.expect('restaurants: onboarding (create_restaurant_with_branch) is refused the same way, with no "branch" in the message, so the wizard blames the restaurant field',
      'ERR 23505 slug_taken',
      pg_temp.try_as('authenticated', v_stranger, array[format(
        'select public.create_restaurant_with_branch(p_restaurant_name => %L, p_restaurant_slug => %L, p_branch_name => %L, p_branch_slug => %L)::text',
        'Squat', upper(v_w1), 'Main', 'main')]));
    perform pg_temp.expect('restaurants: and no detail (the wizard reads message and detail for /branch/)',
      '<none>', coalesce(pg_temp.detail_as(v_stranger, format(
        'select public.create_restaurant_with_branch(p_restaurant_name => %L, p_restaurant_slug => %L, p_branch_name => %L, p_branch_slug => %L)::text',
        'Squat', v_w1, 'Main', 'main')), '<none>'));
    perform pg_temp.expect('restaurants: a free slug still works, and a restaurant may still take another restaurant''s old slug (live wins, as before)',
      'ok ' || v_w6 || '|ok ' || v_b,
      pg_temp.try_sql(array[format(
        'insert into public.restaurants (owner_user_id, slug, name) values (%L, %L, %L) returning slug', v_stranger, v_w6, 'Fine')])
        || '|' || pg_temp.try_as('authenticated', v_owner, array[format(
        'update public.restaurants set slug = %L where id = %L returning slug', v_b, v_ra)]));
    perform pg_temp.expect('restaurants: an update that leaves the slug alone is not checked', 'ok ZZ Renamed',
      pg_temp.try_as('authenticated', v_owner, array[format(
        'update public.restaurants set name = %L where id = %L returning name', 'ZZ Renamed', v_ra)]));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. An old web address becomes an alias, which only its branch may take back. Starts: A main =
  --    w1, B main = w3. -----------------------------------------------------------------------------
  begin
    perform pg_temp.expect('change: the owner moves A main from w1 to w2', 'ok ' || v_w2 || ' /r/' || v_w2,
      pg_temp.call_as(v_owner, format(c_set, v_main, v_w2)));
    perform pg_temp.expect('change: w1 is now a first-segment alias pointing at the branch',
      '1|-|true|true',
      (select count(*)::text || '|' || coalesce(max(a.branch_slug), '-') || '|' || bool_and(a.branch_id = v_main)::text || '|'
                || bool_and(a.restaurant_id = v_ra)::text
         from public.storefront_path_aliases a where a.restaurant_slug = v_w1));
    perform pg_temp.expect('change: /r/w1/… goes to /r/w2/… (one segment); /r/w2/… is served short',
      'redirect ' || v_a || ' main ' || v_w2 || ' /r/' || v_w2 || ' 1|redirect ' || v_a || ' main ' || v_w2 || ' /r/' || v_w2 || ' 1|short '
        || v_a || ' main ' || v_w2 || ' /r/' || v_w2 || ' 1',
      pg_temp.resolve(v_w1, 'cart') || '|' || pg_temp.resolve(v_w1, null) || '|' || pg_temp.resolve(v_w2, 'cart'));
    perform pg_temp.expect('change: an audit row from w1 to w2', '1',
      (select count(*)::text from public.audit_logs
        where branch_id = v_main and action = 'branch_public_slug_changed'
          and metadata ->> 'from' = v_w1 and metadata ->> 'to' = v_w2));

    perform pg_temp.expect('clear: null clears it and answers the long form', 'ok - /r/' || v_a || '/main',
      pg_temp.call_as(v_owner, format(c_set, v_main, null)));
    perform pg_temp.expect('clear: blank clears too (already clear: nothing to do)', 'ok - /r/' || v_a || '/main',
      pg_temp.call_as(v_owner, format(c_set, v_main, '   ')));
    perform pg_temp.expect('clear: both old addresses go straight to the long form (no chain); the long form is live again',
      'redirect ' || v_a || ' main - /r/' || v_a || '/main 1|redirect ' || v_a || ' main - /r/' || v_a || '/main 1|live '
        || v_a || ' main - /r/' || v_a || '/main 2',
      pg_temp.resolve(v_w1, 'x') || '|' || pg_temp.resolve(v_w2, null) || '|' || pg_temp.resolve(v_a, 'main'));

    perform pg_temp.expect('take back: the branch may take its own old address again; it is live there, and the other old one follows',
      'ok ' || v_w1 || ' /r/' || v_w1 || '|short ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1|redirect ' || v_a || ' main '
        || v_w1 || ' /r/' || v_w1 || ' 1',
      pg_temp.call_as(v_owner, format(c_set, v_main, v_w1)) || '|' || pg_temp.resolve(v_w1, null) || '|'
        || pg_temp.resolve(v_w2, 'orders'));
    perform pg_temp.expect('restaurants: may not take an old web address either', 'ERR 23505 slug_taken',
      pg_temp.try_sql(array[format('update public.restaurants set slug = %L where id = %L returning slug', v_w2, v_ra)]));
    perform pg_temp.expect('claim: another branch may not take an old web address, of the same owner or of another: 23505 slug_taken (its printed codes still point at it)',
      'ERR 23505 slug_taken|ERR 23505 slug_taken',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_w2)]) || '|'
        || pg_temp.try_as('authenticated', v_owner_b, array[format(c_set, v_bmain, v_w2)]));
    perform pg_temp.expect('claim: check_public_slug answers the same, so the Branding card does not write the App name''s suggestion',
      'ok ' || v_w2 || ' false slug_taken false|ok ' || v_w2 || ' false slug_taken false',
      pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, v_w2)]) || '|'
        || pg_temp.try_as('authenticated', v_owner_b, array[format(c_check, v_bmain, v_w2)]));
    perform pg_temp.expect('claim: nor with no JWT role (a migration) or the service role: the rules trigger refuses it too',
      'ERR 23505 slug_taken|ERR 23505 slug_taken',
      pg_temp.try_sql(array[
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w2, v_second)]) || '|'
        || pg_temp.try_sql(array[
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w2, v_bmain)], 'service_role'));
    perform pg_temp.expect('claim: after the refused attempts w2 is still one row pointing at main, and goes to main''s address',
      '1|' || v_main || '|redirect ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1',
      (select count(*)::text || '|' || max(a.branch_id::text) from public.storefront_path_aliases a where a.restaurant_slug = v_w2)
        || '|' || pg_temp.resolve(v_w2, null));
    perform pg_temp.expect('claim: main itself may take w2 back and give it up again; w2 then goes to main''s address again',
      'ok redirect ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_main, v_w2), format(c_set, v_main, v_w1),
        format(c_resolve, v_w2, null)]));
    perform pg_temp.expect('claim: (still one row for w2, pointing at main: one row per address)', 'ok 1|' || v_main,
      pg_temp.try_sql(array[
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w2, v_main),
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w1, v_main),
        format('select count(*)::text || ''|'' || max(branch_id::text) from public.storefront_path_aliases where restaurant_slug = %L', v_w2)]));

    -- Cascade, on the switched-off branch (written with no JWT, which the guard lets by).
    perform pg_temp.expect('cascade: deleting a branch deletes its old web addresses', 'ok 0',
      pg_temp.try_sql(array[
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w4, v_closed),
        format('update public.branches set public_slug = null where id = %L returning id', v_closed),
        format('delete from public.branches where id = %L returning id', v_closed),
        format('select count(*)::text from public.storefront_path_aliases where restaurant_slug = %L', v_w4)]));
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. The branch guard. Starts: A main = w1, B main = w3. -------------------------------------------
  begin
    perform pg_temp.expect('guard: the owner may not write the column directly, set or clear',
      'ERR P0001 branch_privileged_column_forbidden|ERR P0001 branch_privileged_column_forbidden',
      pg_temp.try_as('authenticated', v_owner, array[format(
        'update public.branches set public_slug = %L where id = %L returning public_slug', v_w5, v_second)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(
        'update public.branches set public_slug = null where id = %L returning id', v_main)]));
    perform pg_temp.expect('guard: nor may a platform admin', 'ERR P0001 branch_privileged_column_forbidden',
      pg_temp.try_as('authenticated', v_platform, array[format(
        'update public.branches set public_slug = %L where id = %L returning public_slug', v_w5, v_second)], true));
    perform pg_temp.expect('guard: the hint names the RPC', 'A branch''s web address is changed through set_branch_public_slug().',
      pg_temp.hint_as(v_owner, format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w5, v_second)));
    perform pg_temp.expect('guard: nor insert a branch that carries one', 'ERR P0001 branch_privileged_column_forbidden',
      pg_temp.try_as('authenticated', v_owner, array[format(
        'insert into public.branches (restaurant_id, slug, name, public_slug) values (%L, %L, %L, %L) returning id',
        v_ra, 'third', 'Third', v_w5)]));
    perform pg_temp.expect('guard: other columns are written as before', 'ok Main!',
      pg_temp.try_as('authenticated', v_owner, array[format(
        'update public.branches set name = %L where id = %L returning name', 'Main!', v_main)]));
    perform pg_temp.expect('guard: the flag is down again once the RPC returns', 'ok off',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_w5),
        'select coalesce(current_setting(''favornoms.public_slug_write'', true), ''<unset>'')']));
    perform pg_temp.expect('guard: and a direct write right after the RPC is still refused', 'ERR P0001 branch_privileged_column_forbidden',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_w5),
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w6, v_second)]));
    perform pg_temp.expect('no JWT role (a migration) or the service role: passes the guard but meets the rules',
      'ERR 22023 slug_reserved|ERR 23505 slug_taken|ERR 22023 slug_invalid',
      pg_temp.try_sql(array[format(
        'update public.branches set public_slug = %L where id = %L returning public_slug', 'api', v_second)]) || '|'
        || pg_temp.try_sql(array[format(
        'update public.branches set public_slug = %L where id = %L returning public_slug', v_b2, v_second)], 'service_role') || '|'
        || pg_temp.try_sql(array[format(
        'update public.branches set public_slug = %L where id = %L returning public_slug', upper(v_w5), v_second)]));
    perform pg_temp.expect('no JWT role, or the service role: and leaves an alias behind like the RPC does', 'ok 1|ok 1',
      pg_temp.try_sql(array[
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w5, v_second),
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w6, v_second),
        format('select count(*)::text from public.storefront_path_aliases where restaurant_slug = %L and branch_id = %L', v_w5, v_second)])
        || '|' || pg_temp.try_sql(array[
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w5, v_second),
        format('update public.branches set public_slug = %L where id = %L returning public_slug', v_w6, v_second),
        format('select count(*)::text from public.storefront_path_aliases where restaurant_slug = %L and branch_id = %L', v_w5, v_second)],
        'service_role'));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. resolve_storefront_path. Starts: A {main = w1, second, closed (off)}, B zz-bps-b2 {main = w3},
  --    aliases w1 -> main (shadowed), w2 -> main, zz-bps-b -> B. -----------------------------------
  begin
    perform pg_temp.expect('live: the long form of a branch with no web address',
      'live ' || v_a || ' second - /r/' || v_a || '/second 2', pg_temp.resolve(v_a, 'second'));
    perform pg_temp.expect('redirect: the long form of a branch with a web address goes to the short form (two segments)',
      'redirect ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 2', pg_temp.resolve(v_a, 'main'));
    perform pg_temp.expect('short: a web address alone, or with any page after it',
      'short ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1|short ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1|short '
        || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1',
      pg_temp.resolve(v_w1, null) || '|' || pg_temp.resolve(v_w1, 'cart') || '|' || pg_temp.resolve(v_w1, 'orders'));
    perform pg_temp.expect('redirect: a web address in other letter case goes to its spelling (one segment)',
      'redirect ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1', pg_temp.resolve(upper(v_w1), 'cart'));
    perform pg_temp.expect('redirect: an old restaurant slug lands on the short form when the branch has one',
      'redirect ' || v_b2 || ' main ' || v_w3 || ' /r/' || v_w3 || ' 2', pg_temp.resolve(v_b, 'main'));
    update public.branches set slug = 'main-x' where id = v_bmain;
    perform pg_temp.expect('redirect: an old branch slug too, under the new or the old restaurant slug',
      'redirect ' || v_b2 || ' main-x ' || v_w3 || ' /r/' || v_w3 || ' 2|redirect ' || v_b2 || ' main-x ' || v_w3 || ' /r/' || v_w3 || ' 2',
      pg_temp.resolve(v_b2, 'main') || '|' || pg_temp.resolve(v_b, 'main'));
    perform pg_temp.expect('none: a restaurant alone, an unknown first segment, an unknown branch, blank or null',
      'none - - - - -|none - - - - -|none - - - - -|none - - - - -|none - - - - -|none - - - - -',
      pg_temp.resolve(v_a, null) || '|' || pg_temp.resolve(v_a, ' ') || '|' || pg_temp.resolve('zz-nobody-' || v_sfx, 'x') || '|'
        || pg_temp.resolve(v_a, 'nowhere') || '|' || pg_temp.resolve('', 'x') || '|' || pg_temp.resolve(null, null));

    -- The switched-off branch gets a web address (as the script, no JWT) and changes it once.
    update public.branches set public_slug = v_w5 where id = v_closed;
    update public.branches set public_slug = v_w6 where id = v_closed;
    perform pg_temp.expect('none: a switched-off branch''s web address, its old one and its long form',
      'none - - - - -|none - - - - -|none - - - - -',
      pg_temp.resolve(v_w6, null) || '|' || pg_temp.resolve(v_w5, 'cart') || '|' || pg_temp.resolve(v_a, 'closed'));
    perform pg_temp.expect('none: and it still owns the address and its old one (nobody else may take either)',
      'ERR 23505 slug_taken|ERR 23505 slug_taken',
      pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_w6)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_set, v_second, v_w5)]));

    perform pg_temp.expect('one row every time', '1|1|1',
      (select count(*)::text from public.resolve_storefront_path(v_w1, null)) || '|'
        || (select count(*)::text from public.resolve_storefront_path(v_a, 'main')) || '|'
        || (select count(*)::text from public.resolve_storefront_path('zz-nobody-' || v_sfx, 'x')));
    perform pg_temp.expect('anon: may call it, with or without the second segment',
      'ok short ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 1|ok redirect ' || v_a || ' main ' || v_w1 || ' /r/' || v_w1 || ' 2',
      pg_temp.try_as('anon', null, array[format(
        'select status || '' '' || restaurant_slug || '' '' || branch_slug || '' '' || public_slug || '' '' || public_base || '' '' || segments from public.resolve_storefront_path(%L)',
        v_w1)]) || '|' || pg_temp.try_as('anon', null, array[format(c_resolve, v_a, 'main')]));
  exception when others then
    perform pg_temp.expect('section 6 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 7. check_public_slug. Starts: A {main = w1, second, closed = w6 (off)}, B {main-x = w3},
  --    aliases w1 and w2 -> main, w5 -> closed, zz-bps-b -> B. ---------------------------------------
  begin
    perform pg_temp.expect('check: a free address, typed in capitals with spaces', 'ok zz-free-' || v_sfx || ' true - false',
      pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, ' ZZ-FREE-' || upper(v_sfx) || ' ')]));
    perform pg_temp.expect('check: another branch''s address, a restaurant slug, an old restaurant slug, a reserved word, a bad one',
      'ok ' || v_w3 || ' false slug_taken false|ok ' || v_b2 || ' false slug_taken false|ok ' || v_b || ' false slug_taken false|ok api false slug_reserved false|ok a false slug_invalid false',
      pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, v_w3)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, v_b2)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, v_b)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, 'api')]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, 'a')]));
    perform pg_temp.expect('check: another branch''s old address is taken, whether that branch is switched on or off',
      'ok ' || v_w2 || ' false slug_taken false|ok ' || v_w5 || ' false slug_taken false',
      pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, v_w2)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, v_w5)]));
    perform pg_temp.expect('check: the branch''s own address is available and current; its own old one is available',
      'ok ' || v_w1 || ' true - true|ok ' || v_w2 || ' true - false',
      pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_main, v_w1)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_main, v_w2)]));
    perform pg_temp.expect('check: no web address is always available (current when the branch has none)',
      'ok - true - true|ok - true - false',
      pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_second, '')]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_check, v_main, null)]));
    perform pg_temp.expect('check: an admin may; a manager and another restaurant''s owner may not; anon may not call it; no user: sign in',
      'ok ' || v_w4 || ' true - false|ERR 42501 not_authorized|ERR 42501 not_authorized|ERR 42501 permission denied for function check_public_slug|ERR 42501 sign_in_required',
      pg_temp.try_as('authenticated', v_admin, array[format(c_check, v_second, v_w4)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_check, v_second, v_w4)]) || '|'
        || pg_temp.try_as('authenticated', v_owner_b, array[format(c_check, v_second, v_w4)]) || '|'
        || pg_temp.try_as('anon', null, array[format(c_check, v_second, v_w4)]) || '|'
        || pg_temp.try_as('authenticated', null, array[format(c_check, v_second, v_w4)]));
    perform pg_temp.expect('check: an unknown branch', 'ERR P0002 branch_not_found',
      pg_temp.try_as('authenticated', v_platform, array[format(c_check, gen_random_uuid(), v_w4)], true));
  exception when others then
    perform pg_temp.expect('section 7 ran', 'ok', 'ERR ' || sqlerrm);
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
