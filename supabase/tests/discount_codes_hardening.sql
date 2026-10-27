-- Discount codes, hardened (20261027100000_discount_codes_hardening, the discount-code audit of
-- 2026-10-27). A rolled-back script, not a migration. Pins: what the migration left behind (the
-- nullable restaurant_id and its ON DELETE SET NULL, both redemption triggers, the codes table's
-- select-only grant and policy, owners, SECURITY DEFINER, search_path and grants of every function
-- it made or replaced, one request_package_change signature, the cron job); the console's write
-- rules on create and on update (D7), each with its precise error, and an old code kept editable;
-- direct writes to the codes table refused while the RPCs keep working (D6); request_package_change
-- refusing quote_changed with the server's figures when what the merchant confirmed differs, filing
-- nothing, replacing nothing and counting nothing, while an old caller and a matching figure go
-- through (D1); billing_cancel_expired_checkout letting go of an abandoned card checkout and its
-- code's use only while that session is still the one paying it, and the stale-checkout sweep (D2);
-- a deleted restaurant keeping the uses it was given and giving back the ones it only reserved,
-- with every counter matching its rows (D5); and billing_checkout_context naming each charge's list
-- price and code (D12).
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/discount_codes_hardening.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on restaurants, users and codes
-- this script creates for itself (section 0 only reads).
--   pg_temp.try_as(role, uid, sqls[, admin])  as `anon` (uid null) or `authenticated`, in a
--                                    subtransaction that is always rolled back; reports
--                                    'ok <last value>' or 'ERR <sqlstate> <message>'.
--   pg_temp.try_sql(sqls)           as the script itself with no JWT (the service role's path),
--                                    the same way.
--   pg_temp.rpc_as(uid, sql[, admin]) with uid's JWT claims (the role stays the script's), KEPT
--                                    when it succeeds: the answer as jsonb, or {"error": "<sqlstate>
--                                    <message>"} (then nothing it did is kept). The claims are
--                                    cleared afterwards either way.
--   pg_temp.req_text(answer)         a request_package_change answer as 'filed once= monthly= off=
--                                    code=' or 'refused <reason> once= monthly= off= code='.
--   pg_temp.code_state(code_id)      'counter=<n> rows=[status:amount:restaurant?,...]'.
--
-- People (auth.users rows made here):
--   owner     restaurants.owner_user_id of A, C and D (billing.manage there)
--   owner_b   restaurants.owner_user_id of B
--   stranger  no membership anywhere
--   platform  a platform admin (app_metadata.is_platform_admin)
--
-- Restaurants (all on the trial, nothing paid; slugs carry a random suffix):
--   A  manual requests (section 3), then deleted (section 5)
--   B  card checkouts (section 4)
--   C  a checkout left 97 hours (section 4, the sweep)
--   D  a fresh checkout (section 4, the sweep leaves it) and its context (section 6)
--
-- Codes (made through the RPC by the platform admin; <S> is a random suffix):
--   ZZ-DCH-HALF-<S>  50 % off every one-time charge, one use per restaurant (edited to 10 % in 3)
--   ZZ-DCH-ONE-<S>   10 % off, one use in all
--   ZZ-DCH-ALL-<S>   25 % off, five uses per restaurant
--   ZZ-DCH-OLD-<S>   planted directly, naming the withdrawn `delivery` (an old code, section 1)
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

-- Run one statement returning jsonb with p_uid's JWT claims (role 'authenticated' in the claims;
-- the database role stays the script's) and KEEP what it did when it succeeds. The answer, or
-- {"error": "<sqlstate> <message>"} (then nothing it did is kept). The claims are cleared afterwards.
create or replace function pg_temp.rpc_as(p_uid uuid, p_sql text, p_admin boolean default false)
returns jsonb
language plpgsql
as $$
declare
  v jsonb;
  v_msg text;
  v_state text;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    execute p_sql into v;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return v;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return jsonb_build_object('error', v_state || ' ' || v_msg);
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
  values (v, 'discount-codes-hardening-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', p_admin), '{}'::jsonb, now(), now());
  return v;
end $$;

-- A request_package_change answer, without its id.
create or replace function pg_temp.req_text(p jsonb)
returns text
language sql
as $$
  select case
           when p ? 'error' and not (p ? 'ok') then 'ERR ' || (p ->> 'error')
           when (p ->> 'ok') = 'false' then
             'refused ' || coalesce(p ->> 'reason', '?') || ' once=' || coalesce(p ->> 'one_time_total', '-')
               || ' monthly=' || coalesce(p ->> 'monthly_total', '-') || ' off=' || coalesce(p ->> 'discount_amount', '-')
               || ' code=' || coalesce(p ->> 'discount_code', '-')
           else
             'filed once=' || (p ->> 'one_time_total') || ' monthly=' || (p ->> 'monthly_total')
               || ' off=' || (p ->> 'discount_amount') || ' code=' || coalesce(p ->> 'discount_code', '-')
         end;
$$;

-- The code's counter and its ledger rows ('+' a restaurant, '-' none), in a fixed order.
create or replace function pg_temp.code_state(p_code_id uuid)
returns text
language sql
as $$
  select 'counter=' || c.redemption_count || ' rows=[' || coalesce((
           select string_agg(r.status || ':' || r.amount_off || ':' || case when r.restaurant_id is null then '-' else '+' end,
                             ',' order by r.status, r.amount_off desc, r.restaurant_id is null)
             from public.billing_discount_redemptions r
            where r.code_id = c.id), '') || ']'
    from public.billing_discount_codes c where c.id = p_code_id;
$$;

do $test$
declare
  v_owner    uuid := pg_temp.new_user('owner');
  v_owner_b  uuid := pg_temp.new_user('owner-b');
  v_stranger uuid := pg_temp.new_user('stranger');
  v_platform uuid := pg_temp.new_user('platform', true);
  v_sfx  text := upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
  v_half text := 'ZZ-DCH-HALF-' || v_sfx;
  v_one  text := 'ZZ-DCH-ONE-' || v_sfx;
  v_all  text := 'ZZ-DCH-ALL-' || v_sfx;
  v_old  text := 'ZZ-DCH-OLD-' || v_sfx;
  v_ra uuid; v_rb uuid; v_rc uuid; v_rd uuid;
  v_i_half uuid; v_i_one uuid; v_i_all uuid; v_i_old uuid; v_i_tmp uuid;
  v_q1 uuid; v_q2 uuid; v_qb1 uuid; v_qb2 uuid; v_qc uuid; v_qd uuid; v_qa2 uuid;
  v jsonb;
  v_text text;
  -- request_package_change by position: restaurant, seats, code, expected once, expected monthly.
  c_req constant text :=
    'select public.request_package_change(%L, ''base'', %s, ''{}''::uuid[], %L, null, %s, %s)';
  c_create constant text := 'select to_jsonb(c) from public.platform_create_discount_code(%L::jsonb) c';
  c_update constant text := 'select to_jsonb(c) from public.platform_update_discount_code(%L, %L::jsonb) c';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('column: billing_discount_redemptions.restaurant_id, uuid, nullable',
    'uuid YES',
    (select c.data_type || ' ' || c.is_nullable from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'billing_discount_redemptions' and c.column_name = 'restaurant_id'));
  perform pg_temp.expect('column: its restaurant may be deleted (ON DELETE SET NULL); the other two keys unchanged',
    'billing_discount_redemptions_code_id_fkey:FOREIGN KEY (code_id) REFERENCES billing_discount_codes(id) ON DELETE CASCADE'
    || ' || billing_discount_redemptions_request_id_fkey:FOREIGN KEY (request_id) REFERENCES billing_requests(id) ON DELETE SET NULL'
    || ' || billing_discount_redemptions_restaurant_id_fkey:FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE SET NULL',
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), ' || ' order by conname) from pg_constraint
      where conrelid = 'public.billing_discount_redemptions'::regclass and contype = 'f'));
  perform pg_temp.expect('triggers: a deleted reservation gives its use back; a reservation that loses its restaurant or request is deleted',
    'billing_discount_redemptions_orphan_release:CREATE TRIGGER billing_discount_redemptions_orphan_release AFTER UPDATE OF restaurant_id, request_id ON public.billing_discount_redemptions FOR EACH ROW WHEN (((new.status = ''reserved''::text) AND ((new.restaurant_id IS NULL) OR (new.request_id IS NULL)))) EXECUTE FUNCTION private.tg_billing_discount_orphan_release()'
    || ' || billing_discount_redemptions_release:CREATE TRIGGER billing_discount_redemptions_release AFTER DELETE ON public.billing_discount_redemptions FOR EACH ROW WHEN ((old.status = ''reserved''::text)) EXECUTE FUNCTION private.tg_billing_discount_release()',
    (select string_agg(t.tgname || ':' || pg_get_triggerdef(t.oid), ' || ' order by t.tgname) from pg_trigger t
      where t.tgrelid = 'public.billing_discount_redemptions'::regclass and not t.tgisinternal));
  perform pg_temp.expect('codes table: authenticated may select, not insert, update or delete; RLS on',
    'true false false false true',
    has_table_privilege('authenticated', 'public.billing_discount_codes', 'select')::text || ' '
      || has_table_privilege('authenticated', 'public.billing_discount_codes', 'insert')::text || ' '
      || has_table_privilege('authenticated', 'public.billing_discount_codes', 'update')::text || ' '
      || has_table_privilege('authenticated', 'public.billing_discount_codes', 'delete')::text || ' '
      || (select relrowsecurity::text from pg_class where oid = 'public.billing_discount_codes'::regclass));
  perform pg_temp.expect('codes table: one policy, select-only, platform admins, for authenticated',
    'billing_discount_codes_platform_admin r {authenticated} private.user_is_platform_admin() -',
    (select string_agg(p.polname || ' ' || p.polcmd::text || ' ' || (select array_agg(rolname order by rolname) from pg_roles where oid = any (p.polroles))::text
                       || ' ' || pg_get_expr(p.polqual, p.polrelid) || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'), ' | ')
       from pg_policy p where p.polrelid = 'public.billing_discount_codes'::regclass));
  perform pg_temp.expect('request_package_change: one signature, the two expected figures last with null defaults',
    '1|p_restaurant_id uuid, p_plan_code text, p_branch_seats integer DEFAULT 1, p_delivery_branch_ids uuid[] DEFAULT ''{}''::uuid[], p_discount_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_expected_one_time numeric DEFAULT NULL::numeric, p_expected_monthly numeric DEFAULT NULL::numeric',
    (select count(*)::text || '|' || max(pg_get_function_arguments(p.oid)) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'request_package_change'));
  perform pg_temp.expect('public RPCs: postgres, SECURITY DEFINER, search_path pinned; who may call (authenticated anon service_role)',
    'billing_cancel_expired_checkout(uuid,text) postgres true search_path=public, pg_temp false false true'
    || '|billing_checkout_context(uuid) postgres true search_path=public, pg_temp true false true'
    || '|platform_create_discount_code(jsonb) postgres true search_path=public, pg_temp true false true'
    || '|platform_update_discount_code(uuid,jsonb) postgres true search_path=public, pg_temp true false true'
    || '|request_package_change(uuid,text,integer,uuid[],text,text,numeric,numeric) postgres true search_path=public, pg_temp true false true',
    (select string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
                       || array_to_string(p.proconfig, ',') || ' '
                       || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
                       || has_function_privilege('anon', p.oid, 'execute')::text || ' '
                       || has_function_privilege('service_role', p.oid, 'execute')::text, '|' order by p.oid::regprocedure::text)
       from pg_proc p
      where p.oid in ('public.billing_cancel_expired_checkout(uuid,text)'::regprocedure,
                      'public.billing_checkout_context(uuid)'::regprocedure,
                      'public.platform_create_discount_code(jsonb)'::regprocedure,
                      'public.platform_update_discount_code(uuid,jsonb)'::regprocedure,
                      'public.request_package_change(uuid,text,integer,uuid[],text,text,numeric,numeric)'::regprocedure)));
  perform pg_temp.expect('private helpers: postgres, search_path pinned; no API role may call them',
    'private.billing_discount_unsold_product(text[],text[]) postgres false search_path=public, pg_temp false false'
    || '|private.billing_release_stale_checkouts() postgres true search_path=public, pg_temp false false'
    || '|private.tg_billing_discount_orphan_release() postgres true search_path=public, pg_temp false false',
    (select string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
                       || array_to_string(p.proconfig, ',') || ' '
                       || has_function_privilege('anon', p.oid, 'execute')::text || ' '
                       || has_function_privilege('authenticated', p.oid, 'execute')::text, '|' order by p.oid::regprocedure::text)
       from pg_proc p
      where p.oid in ('private.billing_discount_unsold_product(text[],text[])'::regprocedure,
                      'private.billing_release_stale_checkouts()'::regprocedure,
                      'private.tg_billing_discount_orphan_release()'::regprocedure)));
  perform pg_temp.expect('cron: the stale-checkout sweep, hourly at :23, switched on',
    'billing-release-stale-checkouts|23 * * * *|select private.billing_release_stale_checkouts()|true',
    (select jobname || '|' || schedule || '|' || btrim(command) || '|' || active::text from cron.job
      where jobname = 'billing-release-stale-checkouts'));
  perform pg_temp.expect('data: every code''s counter matches its ledger rows', 'none',
    coalesce((select string_agg(c.code, ', ') from public.billing_discount_codes c
               where c.redemption_count <> (select count(*) from public.billing_discount_redemptions r where r.code_id = c.id)),
             'none'));
  perform pg_temp.expect('data: no code the new rules would refuse (characters, dates)', 'none',
    coalesce((select string_agg(c.code, ', ') from public.billing_discount_codes c
               where c.code !~ '^[A-Z0-9]([A-Z0-9-]*[A-Z0-9])?$'
                  or (c.ends_at is not null and c.ends_at <= c.starts_at)), 'none'));

  -- Fixture: four restaurants on the trial; three codes made through the RPC; an old code planted
  -- directly (as a migration or the SQL editor could), naming the withdrawn delivery product.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-dch-a-' || lower(v_sfx), 'ZZ Discount Hardening A') returning id into v_ra;
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner_b, 'zz-dch-b-' || lower(v_sfx), 'ZZ Discount Hardening B') returning id into v_rb;
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-dch-c-' || lower(v_sfx), 'ZZ Discount Hardening C') returning id into v_rc;
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-dch-d-' || lower(v_sfx), 'ZZ Discount Hardening D') returning id into v_rd;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);
  perform private.billing_apply_selection(v_rb, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);
  perform private.billing_apply_selection(v_rc, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);
  perform private.billing_apply_selection(v_rd, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);

  v := pg_temp.rpc_as(v_platform, format(c_create, jsonb_build_object('code', v_half, 'kind', 'percent', 'value', 50,
         'starts_at', now() - interval '1 hour')), true);
  v_i_half := (v ->> 'id')::uuid;
  v := pg_temp.rpc_as(v_platform, format(c_create, jsonb_build_object('code', v_one, 'kind', 'percent', 'value', 10,
         'max_redemptions', 1, 'starts_at', now() - interval '1 hour')), true);
  v_i_one := (v ->> 'id')::uuid;
  v := pg_temp.rpc_as(v_platform, format(c_create, jsonb_build_object('code', v_all, 'kind', 'percent', 'value', 25,
         'per_restaurant_limit', 5, 'starts_at', now() - interval '1 hour')), true);
  v_i_all := (v ->> 'id')::uuid;
  insert into public.billing_discount_codes (code, kind, value, product_codes, starts_at)
  values (v_old, 'fixed', 5, array['delivery'], now() - interval '1 day') returning id into v_i_old;

  perform pg_temp.expect('fixture: the three codes were made through the RPC', 'true true true',
    (v_i_half is not null)::text || ' ' || (v_i_one is not null)::text || ' ' || (v_i_all is not null)::text);

  -- 1. The console's write rules (D7). Starts: the four codes above, none used. ------------------
  begin
    perform pg_temp.expect('create: typed lower case with spaces, stored upper case; per restaurant defaults to 1',
      'ok ZZ-DCH-NEW-' || v_sfx || ' 1 {base,extra_branch}',
      pg_temp.try_as('authenticated', v_platform, array[format(
        'select c.code || '' '' || c.per_restaurant_limit || '' '' || c.product_codes::text from public.platform_create_discount_code(%L::jsonb) c',
        jsonb_build_object('code', '  zz-dch-new-' || lower(v_sfx) || ' ', 'kind', 'fixed', 'value', 5,
                           'product_codes', jsonb_build_array('base', 'extra_branch')))], true));
    perform pg_temp.expect('create: an inner space, symbols, a dash at either end, a letter outside A-Z: code_invalid_chars',
      'ERR 22023 code_invalid_chars|ERR 22023 code_invalid_chars|ERR 22023 code_invalid_chars|ERR 22023 code_invalid_chars|ERR 22023 code_invalid_chars',
      pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"zz dch $%","kind":"fixed","value":1}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ_DCH","kind":"fixed","value":1}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"-ZZDCH","kind":"fixed","value":1}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZDCH-","kind":"fixed","value":1}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ÉTÉ-50","kind":"fixed","value":1}')], true));
    perform pg_temp.expect('create: a one-character code is fine; blank is still code_required; a bad kind still kind_invalid',
      'ok Z|ERR P0001 code_required|ERR P0001 kind_invalid',
      pg_temp.try_as('authenticated', v_platform, array['select (public.platform_create_discount_code(''{"code":"z","kind":"fixed","value":1}''::jsonb)).code'], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"   ","kind":"fixed","value":1}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-K","kind":"bogus","value":1}')], true));
    perform pg_temp.expect('create: 40 characters is fine, 41 is code_too_long (the most a Stripe line names)',
      'ok ' || rpad('ZZ-DCH-L', 40, 'X') || '|ERR 22023 code_too_long',
      pg_temp.try_as('authenticated', v_platform, array[format(
        'select (public.platform_create_discount_code(%L::jsonb)).code',
        jsonb_build_object('code', rpad('ZZ-DCH-L', 40, 'X'), 'kind', 'fixed', 'value', 1))], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create,
             jsonb_build_object('code', rpad('ZZ-DCH-L', 41, 'X'), 'kind', 'fixed', 'value', 1))], true));
    perform pg_temp.expect('create: a withdrawn product, the trial (no one-time price), an unknown one, a null: product_not_one_time',
      'ERR 22023 product_not_one_time:delivery|ERR 22023 product_not_one_time:trial|ERR 22023 product_not_one_time:nope|ERR 22023 product_not_one_time:',
      pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-P1","kind":"fixed","value":1,"product_codes":["base","delivery"]}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-P2","kind":"fixed","value":1,"product_codes":["trial"]}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-P3","kind":"fixed","value":1,"product_codes":["nope"]}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-P4","kind":"fixed","value":1,"product_codes":[null]}')], true));
    perform pg_temp.expect('create: an end before the start, at the start, or in the past with no start (now): ends_before_start',
      'ERR 22023 ends_before_start|ERR 22023 ends_before_start|ERR 22023 ends_before_start',
      pg_temp.try_as('authenticated', v_platform, array[format(c_create, jsonb_build_object('code', 'ZZ-DCH-D1', 'kind', 'fixed', 'value', 1,
          'starts_at', now(), 'ends_at', now() - interval '1 day'))], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, jsonb_build_object('code', 'ZZ-DCH-D2', 'kind', 'fixed', 'value', 1,
          'starts_at', now() + interval '1 day', 'ends_at', now() + interval '1 day'))], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, jsonb_build_object('code', 'ZZ-DCH-D3', 'kind', 'fixed', 'value', 1,
          'ends_at', now() - interval '1 minute'))], true));
    perform pg_temp.expect('create: per-restaurant limit 0 and -1 refused (no longer stored as 1); blank means 1',
      'ERR 22023 per_restaurant_limit_invalid|ERR 22023 per_restaurant_limit_invalid|ok 1',
      pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-L0","kind":"fixed","value":1,"per_restaurant_limit":0}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-L1","kind":"fixed","value":1,"per_restaurant_limit":-1}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array['select (public.platform_create_discount_code(''{"code":"ZZ-DCH-L2","kind":"fixed","value":1,"per_restaurant_limit":""}''::jsonb)).per_restaurant_limit::text'], true));
    perform pg_temp.expect('create: the table''s own checks still answer (value 0)',
      'ERR 23514 %billing_discount_codes_value_check%',
      pg_temp.try_as('authenticated', v_platform, array[format(c_create, '{"code":"ZZ-DCH-V0","kind":"fixed","value":0}')], true));

    perform pg_temp.expect('update: adding a product nobody buys once is refused; the code is left as it was',
      'ERR 22023 product_not_one_time:delivery|{}',
      pg_temp.try_as('authenticated', v_platform, array[format(c_update, v_i_all, '{"product_codes":["base","delivery"]}')], true) || '|'
        || (select product_codes::text from public.billing_discount_codes where id = v_i_all));
    perform pg_temp.expect('update: an old code may keep the withdrawn product it names, but take no new one; switching it off needs no products',
      'ok {delivery,base}|ERR 22023 product_not_one_time:ai_suite|ok false',
      pg_temp.try_as('authenticated', v_platform, array[format(
          'select c.product_codes::text from public.platform_update_discount_code(%L, ''{"product_codes":["delivery","base"]}''::jsonb) c', v_i_old)], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_update, v_i_old, '{"product_codes":["delivery","ai_suite"]}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(
          'select c.is_active::text from public.platform_update_discount_code(%L, ''{"is_active":false}''::jsonb) c', v_i_old)], true));
    perform pg_temp.expect('update: per-restaurant limit 0 refused; blank means 1',
      'ERR 22023 per_restaurant_limit_invalid|ok 1',
      pg_temp.try_as('authenticated', v_platform, array[format(c_update, v_i_all, '{"per_restaurant_limit":0}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(
          'select c.per_restaurant_limit::text from public.platform_update_discount_code(%L, ''{"per_restaurant_limit":""}''::jsonb) c', v_i_all)], true));
    perform pg_temp.expect('update: an end before the code''s start, or a start after its end, is refused; clearing the end is fine',
      'ERR 22023 ends_before_start|ERR 22023 ends_before_start|ok null',
      pg_temp.try_as('authenticated', v_platform, array[format(c_update, v_i_all,
          jsonb_build_object('ends_at', now() - interval '2 hours'))], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[
             format(c_update, v_i_all, jsonb_build_object('ends_at', now() + interval '1 day')),
             format(c_update, v_i_all, jsonb_build_object('starts_at', now() + interval '2 days'))], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[
             format(c_update, v_i_all, jsonb_build_object('ends_at', now() + interval '1 day')),
             format('select coalesce(c.ends_at::text, ''null'') from public.platform_update_discount_code(%L, ''{"ends_at":null}''::jsonb) c', v_i_all)], true));
    perform pg_temp.expect('update: the full console shape still saves; the code key is still ignored; unknown id and bad kind as before',
      'ok ZZ-DCH-ALL-' || v_sfx || ' percent 25.00 {base,extra_branch} 3 5 true|ERR P0001 code_not_found|ERR P0001 kind_invalid',
      pg_temp.try_as('authenticated', v_platform, array[format(
          'select c.code || '' '' || c.kind || '' '' || c.value || '' '' || c.product_codes::text || '' '' || c.max_redemptions || '' '' || c.per_restaurant_limit || '' '' || c.is_active from public.platform_update_discount_code(%L, %L::jsonb) c',
          v_i_all, jsonb_build_object('code', 'RENAMED', 'description', 'edited', 'kind', 'percent', 'value', 25,
            'product_codes', jsonb_build_array('base', 'extra_branch'), 'max_redemptions', 3, 'per_restaurant_limit', 5,
            'starts_at', now() - interval '1 hour', 'ends_at', now() + interval '7 days', 'is_active', true))], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_update, gen_random_uuid(), '{"is_active":false}')], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(c_update, v_i_all, '{"kind":"bogus"}')], true));
    perform pg_temp.expect('update and create: still refused to a non-admin and to anon',
      'ERR P0001 forbidden|ERR P0001 forbidden|ERR 42501 permission denied for function platform_create_discount_code',
      pg_temp.try_as('authenticated', v_stranger, array[format(c_update, v_i_all, '{"is_active":false}')]) || '|'
        || pg_temp.try_as('authenticated', v_stranger, array[format(c_create, '{"code":"ZZ-DCH-S","kind":"fixed","value":1}')]) || '|'
        || pg_temp.try_as('anon', null, array[format(c_create, '{"code":"ZZ-DCH-ANON","kind":"fixed","value":1}')]));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. Direct writes to the codes table (D6). Starts: as after 1 (nothing kept from it). -----------
  begin
    perform pg_temp.expect('table: a platform admin can no longer update or insert codes directly',
      'ERR 42501 permission denied for table billing_discount_codes|ERR 42501 permission denied for table billing_discount_codes',
      pg_temp.try_as('authenticated', v_platform, array[format(
          'update public.billing_discount_codes set redemption_count = 42, code = ''RENAMED'' where id = %L returning code', v_i_half)], true) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[
          'insert into public.billing_discount_codes (code, kind, value) values (''  zz-dch-raw '', ''fixed'', 5) returning code'], true));
    perform pg_temp.expect('table: a platform admin still reads it, a stranger sees nothing, nobody deletes',
      'ok true|ok 0|ERR 42501 permission denied for table billing_discount_codes',
      pg_temp.try_as('authenticated', v_platform, array[format(
          'select (count(*) >= 4)::text from public.billing_discount_codes where code like ''ZZ-DCH-%%-%s''', v_sfx)], true) || '|'
        || pg_temp.try_as('authenticated', v_stranger, array['select count(*)::text from public.billing_discount_codes']) || '|'
        || pg_temp.try_as('authenticated', v_platform, array[format(
          'delete from public.billing_discount_codes where id = %L returning code', v_i_half)], true));
    perform pg_temp.expect('table: the console''s RPCs still write it as the authenticated role',
      'ok ZZ-DCH-RPC-' || v_sfx || ' false',
      pg_temp.try_as('authenticated', v_platform, array[
          format(c_create, jsonb_build_object('code', 'ZZ-DCH-RPC-' || v_sfx, 'kind', 'fixed', 'value', 3)),
          format('select c.code || '' '' || c.is_active from public.platform_update_discount_code((select id from public.billing_discount_codes where code = %L), ''{"is_active":false}''::jsonb) c',
                 'ZZ-DCH-RPC-' || v_sfx)], true));
    perform pg_temp.expect('table: the code is untouched by the refused writes', 'counter=0 rows=[]|' || v_half,
      pg_temp.code_state(v_i_half) || '|' || (select code from public.billing_discount_codes where id = v_i_half));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. The figures the merchant confirmed (D1), restaurant A (trial: $199 once, $49 a month). ------
  --    Starts: no request anywhere; HALF 50 % unused.
  begin
    v := pg_temp.rpc_as(v_owner, format(
      'select public.request_package_change(p_restaurant_id => %L, p_plan_code => ''base'', p_branch_seats => 1, p_delivery_branch_ids => ''{}''::uuid[], p_discount_code => null, p_note => null)',
      v_ra));
    v_q1 := (v ->> 'id')::uuid;
    perform pg_temp.expect('request: an old caller (the six named arguments) is filed as before',
      'filed once=199.00 monthly=49.00 off=0.00 code=-', pg_temp.req_text(v));
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, null, '199', '49'));
    v_q2 := (v ->> 'id')::uuid;
    perform pg_temp.expect('request: the confirmed figures match: filed, and it replaces the first',
      'filed once=199.00 monthly=49.00 off=0.00 code=-|cancelled',
      pg_temp.req_text(v) || '|' || (select status from public.billing_requests where id = v_q1));
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, null, '150', '49'));
    perform pg_temp.expect('request: a different one-time figure: quote_changed, with the server''s figures and what was expected',
      'refused quote_changed once=199.00 monthly=49.00 off=0 code=-|quote_changed|150|49',
      pg_temp.req_text(v) || '|' || (v ->> 'error') || '|' || (v ->> 'expected_one_time') || '|' || (v ->> 'expected_monthly'));
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, null, '199', '98'));
    perform pg_temp.expect('request: a different monthly figure: quote_changed', 'refused quote_changed once=199.00 monthly=49.00 off=0 code=-',
      pg_temp.req_text(v));
    perform pg_temp.expect('request: nothing was filed or replaced, and nothing counted against the guessing limit',
      'pending|2|0',
      (select status from public.billing_requests where id = v_q2) || '|'
        || (select count(*)::text from public.billing_requests where restaurant_id = v_ra) || '|'
        || (select coalesce(sum(count), 0)::text from public.rate_limits where bucket_key = 'billing_discount_fail:' || v_ra::text));

    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, lower(v_half), '99.5', '49.00'));
    v_q1 := (v ->> 'id')::uuid;
    perform pg_temp.expect('request: with HALF, confirmed at $99.50: filed, the use reserved',
      'filed once=99.50 monthly=49.00 off=99.50 code=' || v_half || '|counter=1 rows=[reserved:99.50:+]',
      pg_temp.req_text(v) || '|' || pg_temp.code_state(v_i_half));
    v := pg_temp.rpc_as(v_platform, format(c_update, v_i_half, '{"value":10}'), true);
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, v_half, '99.50', '49'));
    perform pg_temp.expect('request: the operator made HALF 10 % before the merchant sent it again: quote_changed at $179.10',
      'refused quote_changed once=179.10 monthly=49.00 off=19.90 code=' || v_half, pg_temp.req_text(v));
    perform pg_temp.expect('request: the request it would have replaced still waits, still holding its use; nothing counted',
      'pending 99.50|counter=1 rows=[reserved:99.50:+]|0',
      (select status || ' ' || one_time_total from public.billing_requests where id = v_q1) || '|' || pg_temp.code_state(v_i_half) || '|'
        || (select coalesce(sum(count), 0)::text from public.rate_limits where bucket_key = 'billing_discount_fail:' || v_ra::text));
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, 'ZZ-DCH-NOPE-' || v_sfx, '99.50', '49'));
    perform pg_temp.expect('request: a refused code answers discount_invalid first, and counts, whatever was expected',
      'refused invalid_code once=- monthly=- off=- code=-|discount_invalid:invalid_code|1',
      pg_temp.req_text(v) || '|' || (v ->> 'error') || '|'
        || (select coalesce(sum(count), 0)::text from public.rate_limits where bucket_key = 'billing_discount_fail:' || v_ra::text));
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, v_half, '179.1', '49'));
    v_qa2 := (v ->> 'id')::uuid;
    perform pg_temp.expect('request: confirmed at the new $179.10 (one decimal is the same figure): filed; the use moved to it',
      'filed once=179.10 monthly=49.00 off=19.90 code=' || v_half || '|cancelled|counter=1 rows=[reserved:19.90:+]',
      pg_temp.req_text(v) || '|' || (select status from public.billing_requests where id = v_q1) || '|' || pg_temp.code_state(v_i_half));
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 1, v_half, 'null', 'null'));
    v_qa2 := coalesce((v ->> 'id')::uuid, v_qa2);
    perform pg_temp.expect('request: no expected figures (null) is not checked', 'filed once=179.10 monthly=49.00 off=19.90 code=' || v_half,
      pg_temp.req_text(v));
    perform pg_temp.expect('request: a stranger and anon still cannot file',
      'ERR P0001 forbidden|ERR 42501 permission denied for function request_package_change',
      pg_temp.try_as('authenticated', v_stranger, array[format(c_req, v_ra, 1, null, '199', '49')]) || '|'
        || pg_temp.try_as('anon', null, array[format(c_req, v_ra, 1, null, '199', '49')]));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. An abandoned card checkout (D2). Starts: A has one pending manual request (HALF reserved);
  --    B, C and D have none; ONE unused.
  begin
    v := pg_temp.rpc_as(v_owner_b, format(c_req, v_rb, 1, v_one, 'null', 'null'));
    v_qb1 := (v ->> 'id')::uuid;
    perform public.billing_mark_request_stripe(v_qb1, 'cs_test_dch_a' || v_sfx, null);
    perform pg_temp.expect('checkout: B files with ONE (one use in all) and starts paying by card',
      'filed once=179.10 monthly=49.00 off=19.90 code=' || v_one || '|stripe|counter=1 rows=[reserved:19.90:+]',
      pg_temp.req_text(v) || '|' || (select rail from public.billing_requests where id = v_qb1) || '|' || pg_temp.code_state(v_i_one));
    perform pg_temp.expect('checkout: another session expiring leaves it alone (the merchant opened a newer one)',
      '{"reason": "other_session", "cancelled": false}|pending|counter=1 rows=[reserved:19.90:+]',
      public.billing_cancel_expired_checkout(v_qb1, 'cs_test_dch_other')::text || '|'
        || (select status from public.billing_requests where id = v_qb1) || '|' || pg_temp.code_state(v_i_one));
    perform pg_temp.expect('checkout: a malformed session id is refused; an unknown request is not_found; a manual request is not a card one',
      'ERR P0001 invalid_checkout_session_id|request_not_found|not_card_request',
      pg_temp.try_sql(array[format('select public.billing_cancel_expired_checkout(%L, ''not a session'')::text', v_qb1)]) || '|'
        || (public.billing_cancel_expired_checkout(gen_random_uuid(), 'cs_test_dch_x') ->> 'reason') || '|'
        || (public.billing_cancel_expired_checkout(v_qa2, 'cs_test_dch_x') ->> 'reason'));
    perform pg_temp.expect('checkout: only the service role may call it',
      'ERR 42501 permission denied for function billing_cancel_expired_checkout|ERR 42501 permission denied for function billing_cancel_expired_checkout|true',
      pg_temp.try_as('authenticated', v_owner_b, array[format('select public.billing_cancel_expired_checkout(%L, %L)::text', v_qb1, 'cs_test_dch_a' || v_sfx)]) || '|'
        || pg_temp.try_as('anon', null, array[format('select public.billing_cancel_expired_checkout(%L, %L)::text', v_qb1, 'cs_test_dch_a' || v_sfx)]) || '|'
        || has_function_privilege('service_role', 'public.billing_cancel_expired_checkout(uuid,text)', 'execute')::text);
    v := public.billing_cancel_expired_checkout(v_qb1, 'cs_test_dch_a' || v_sfx);
    perform pg_temp.expect('checkout: its own session expired unpaid: cancelled, and the answer names the code',
      'true|' || v_one || '|' || v_rb, (v ->> 'cancelled') || '|' || (v ->> 'discount_code') || '|' || (v ->> 'restaurant_id'));
    perform pg_temp.expect('checkout: the request is cancelled with a reason, its charges void, ONE''s use given back, logged',
      'cancelled|Card checkout expired unpaid|void|counter=0 rows=[]|1',
      (select status || '|' || decision_note from public.billing_requests where id = v_qb1) || '|'
        || (select string_agg(distinct status, ',') from public.billing_charges where request_id = v_qb1) || '|'
        || pg_temp.code_state(v_i_one) || '|'
        || (select count(*)::text from public.billing_events where type = 'stripe.request_cancelled' and payload ->> 'request_id' = v_qb1::text));
    perform pg_temp.expect('checkout: a second expiry of it is a no-op', 'request_not_pending',
      public.billing_cancel_expired_checkout(v_qb1, 'cs_test_dch_a' || v_sfx) ->> 'reason');
    perform pg_temp.expect('checkout: ONE is free again for another restaurant',
      'true',
      (pg_temp.rpc_as(v_owner, format('select public.validate_billing_discount(%L, %L, ''base'', 1, ''{}''::uuid[])', v_rd, v_one)) ->> 'valid'));

    -- B again, now paying a change through an invoice: the card lock's business, not this one's.
    v := pg_temp.rpc_as(v_owner_b, format(c_req, v_rb, 1, v_one, 'null', 'null'));
    v_qb2 := (v ->> 'id')::uuid;
    perform public.billing_mark_request_stripe(v_qb2, 'cs_test_dch_b' || v_sfx, null);
    perform public.billing_mark_request_stripe(v_qb2, null, 'in_test_dch_b' || v_sfx);
    perform pg_temp.expect('checkout: a request tied to an invoice is left alone',
      'invoice_in_progress|pending|counter=1 rows=[reserved:19.90:+]',
      (public.billing_cancel_expired_checkout(v_qb2, 'cs_test_dch_b' || v_sfx) ->> 'reason') || '|'
        || (select status from public.billing_requests where id = v_qb2) || '|' || pg_temp.code_state(v_i_one));

    -- C: a checkout whose session was stored 97 hours ago; D: one stored now.
    v := pg_temp.rpc_as(v_owner, format(c_req, v_rc, 1, v_all, 'null', 'null'));
    v_qc := (v ->> 'id')::uuid;
    perform public.billing_mark_request_stripe(v_qc, 'cs_test_dch_c' || v_sfx, null);
    v := pg_temp.rpc_as(v_owner, format(c_req, v_rd, 1, v_all, 'null', 'null'));
    v_qd := (v ->> 'id')::uuid;
    perform public.billing_mark_request_stripe(v_qd, 'cs_test_dch_d' || v_sfx, null);
    alter table public.billing_requests disable trigger billing_requests_set_updated_at;
    update public.billing_requests set updated_at = now() - interval '97 hours' where id in (v_qc, v_qb2);
    alter table public.billing_requests enable trigger billing_requests_set_updated_at;
    perform pg_temp.expect('sweep: ALL holds two uses (C and D)', 'counter=2 rows=[reserved:49.75:+,reserved:49.75:+]',
      pg_temp.code_state(v_i_all));
    v_text := private.billing_release_stale_checkouts()::text;
    perform pg_temp.expect('sweep: lets go of C''s checkout only (D is fresh; B''s invoice is the card lock''s)',
      '1|cancelled Card checkout expired unpaid|pending|pending',
      v_text || '|'
        || (select status || ' ' || coalesce(decision_note, '-') from public.billing_requests where id = v_qc) || '|'
        || (select status from public.billing_requests where id = v_qd) || '|'
        || (select status from public.billing_requests where id = v_qb2));
    perform pg_temp.expect('sweep: C''s charges void, its use of ALL given back, logged as a warning',
      'void|counter=1 rows=[reserved:49.75:+]|1',
      coalesce((select string_agg(distinct status, ',') from public.billing_charges where request_id = v_qc), '-') || '|'
        || pg_temp.code_state(v_i_all) || '|'
        || (select count(*)::text from public.billing_events
             where type = 'stripe.checkout_stale_released' and level = 'warn' and payload ->> 'request_id' = v_qc::text));
    perform pg_temp.expect('sweep: a second run finds nothing', '0', private.billing_release_stale_checkouts()::text);
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. A deleted restaurant (D5). Starts: A has one pending manual request with HALF reserved
  --    ($19.90); ALL has one use reserved (D).
  begin
    v := pg_temp.rpc_as(v_platform, format('select public.decide_billing_request(%L, true, ''test'')', v_qa2), true);
    v := pg_temp.rpc_as(v_owner, format(c_req, v_ra, 2, v_all, 'null', 'null'));
    perform pg_temp.expect('delete: before, HALF given to A (approved) and ALL reserved for A''s new request',
      'counter=1 rows=[redeemed:19.90:+]|counter=2 rows=[reserved:49.75:+,reserved:22.25:+]',
      pg_temp.code_state(v_i_half) || '|' || pg_temp.code_state(v_i_all));
    delete from public.restaurants where id = v_ra;
    perform pg_temp.expect('delete: the use given away stays on HALF with no restaurant; the reserved one on ALL is given back',
      'counter=1 rows=[redeemed:19.90:-]|counter=1 rows=[reserved:49.75:+]',
      pg_temp.code_state(v_i_half) || '|' || pg_temp.code_state(v_i_all));
    perform pg_temp.expect('delete: the console lists the kept use with no restaurant (it reads "Deleted restaurant")',
      'ok 1 null null redeemed 19.90',
      pg_temp.try_as('authenticated', v_platform, array[format(
        'select jsonb_array_length(x)::text || '' '' || coalesce(x -> 0 ->> ''restaurant_id'', ''null'') || '' '' || coalesce(x -> 0 ->> ''restaurant_name'', ''null'') || '' '' || (x -> 0 ->> ''status'') || '' '' || (x -> 0 ->> ''amount_off'') from public.platform_list_discount_redemptions(%L) x',
        v_i_half)], true));
    perform pg_temp.expect('delete: every fixture code''s counter matches its rows', 'none',
      coalesce((select string_agg(c.code, ', ') from public.billing_discount_codes c
                 where c.id in (v_i_half, v_i_one, v_i_all, v_i_old)
                   and c.redemption_count <> (select count(*) from public.billing_discount_redemptions r where r.code_id = c.id)),
               'none'));
    -- A reservation that loses only its request is given back too.
    insert into public.billing_discount_codes (code, kind, value) values ('ZZ-DCH-TMP-' || v_sfx, 'fixed', 1)
    returning id into v_i_tmp;
    perform private.billing_reserve_discount(v_rd, v_i_tmp, v_qd, 1);
    update public.billing_discount_redemptions set request_id = null where code_id = v_i_tmp;
    perform pg_temp.expect('delete: a reservation whose request is gone is given back', 'counter=0 rows=[]',
      pg_temp.code_state(v_i_tmp));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. The checkout context names each charge's list price and code (D12). Starts: D's pending
  --    checkout request, ALL 25 % on the $199 setup.
  begin
    perform pg_temp.expect('context: each charge says what it was listed at and which code took what off',
      'base 199.00 ' || v_all || ' 49.75 149.25',
      (select string_agg((c ->> 'code') || ' ' || (c ->> 'amount') || ' ' || coalesce(c ->> 'discount_code', '-') || ' '
                         || (c ->> 'discount_amount') || ' ' || (c ->> 'net_amount'), ', ')
         from jsonb_array_elements(pg_temp.rpc_as(v_owner, format('select public.billing_checkout_context(%L)', v_qd)) -> 'charges') c));
    perform pg_temp.expect('context: still refused to someone else', '{"ok": false, "error": "forbidden"}',
      pg_temp.rpc_as(v_owner_b, format('select public.billing_checkout_context(%L)', v_qd))::text);
  exception when others then
    perform pg_temp.expect('section 6 ran', 'ok', 'ERR ' || sqlerrm);
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
