-- A storefront keeps answering at its old address after a rename
-- (20261026110000_storefront_path_aliases). A rolled-back script, not a migration. Pins: the alias
-- table locked away from the API roles, the rename triggers writing the old pair (and nothing when
-- the slug did not really change), public.resolve_storefront_path answering live / redirect /
-- none with the current slugs, a live slug always winning over an alias (restaurant and branch),
-- no chains after two renames, an old address moving to whoever gave it up last, a branch moved
-- to another restaurant, other letter case, switched-off branches, the cascade on delete, anon
-- being able to call the RPC, and the coastal-grill seed. Section 0 checks what the migration left
-- behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/storefront_path_aliases.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on two restaurants this script
-- creates for itself (section 0 only reads).
--   pg_temp.try_as(role, uid, sqls)  as `anon` (uid null) or `authenticated`, in a subtransaction
--                                    that is always rolled back; reports 'ok <last value>' or
--                                    'ERR <sqlstate> <message>'.
--   pg_temp.resolve(first, second)   resolve_storefront_path's one row as 'status r b'.
--
-- Restaurants and branches (slugs carry a random suffix <s>):
--   A  zz-spa-a-<s>   main, second, closed (switched off)
--   B  zz-spa-b-<s>   main
--
-- Each section after the fixtures runs in its own block: one that breaks reports a FAIL row and
-- the others still run. Later sections build on the renames of earlier ones; the state each one
-- starts from is written above it. The result is one row per check with PASS/FAIL, then a summary
-- row.

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
create or replace function pg_temp.try_as(p_role text, p_uid uuid, p_sqls text[])
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
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
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
  values (v, 'storefront-path-aliases-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', false), '{}'::jsonb, now(), now());
  return v;
end $$;

-- resolve_storefront_path's row as 'status restaurant_slug branch_slug' ('-' for a null slug).
create or replace function pg_temp.resolve(p_first text, p_second text)
returns text
language sql
as $$
  select string_agg(x.status || ' ' || coalesce(x.restaurant_slug, '-') || ' ' || coalesce(x.branch_slug, '-'), ' | ')
    from public.resolve_storefront_path(p_first, p_second) x;
$$;

do $test$
declare
  v_owner uuid := pg_temp.new_user('owner');
  v_sfx   text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_a     text := 'zz-spa-a-' || v_sfx;
  v_a2    text := 'zz-spa-a2-' || v_sfx;
  v_b     text := 'zz-spa-b-' || v_sfx;
  v_ra uuid; v_rb uuid;
  v_main uuid; v_second uuid; v_closed uuid; v_bmain uuid;
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('table: RLS on; anon and authenticated may not select, insert, update or delete',
    'true false false false false false false false false',
    (select c.relrowsecurity::text || ' '
              || has_table_privilege('anon', c.oid, 'select')::text || ' '
              || has_table_privilege('anon', c.oid, 'insert')::text || ' '
              || has_table_privilege('anon', c.oid, 'update')::text || ' '
              || has_table_privilege('anon', c.oid, 'delete')::text || ' '
              || has_table_privilege('authenticated', c.oid, 'select')::text || ' '
              || has_table_privilege('authenticated', c.oid, 'insert')::text || ' '
              || has_table_privilege('authenticated', c.oid, 'update')::text || ' '
              || has_table_privilege('authenticated', c.oid, 'delete')::text
       from pg_class c where c.oid = 'public.storefront_path_aliases'::regclass));
  perform pg_temp.expect('table: no policy at all', '0',
    (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'storefront_path_aliases'));
  perform pg_temp.expect('rpc: postgres, SECURITY DEFINER, stable, search_path pinned; anon, authenticated and service_role may call it',
    'postgres true s search_path=public, pg_temp true true true',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' '
              || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'public.resolve_storefront_path(text,text)'::regprocedure));
  perform pg_temp.expect('rpc: one signature', '1',
    (select count(*)::text from pg_proc p
      where p.proname = 'resolve_storefront_path' and p.pronamespace = 'public'::regnamespace));
  perform pg_temp.expect('trigger function: postgres, SECURITY DEFINER, search_path pinned; no API role may call it',
    'postgres true search_path=public, pg_temp false false',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'private.record_storefront_path_alias()'::regprocedure));
  perform pg_temp.expect('triggers: after update of slug on restaurants; of slug, restaurant_id on branches',
    'branches:CREATE TRIGGER trg_storefront_path_alias AFTER UPDATE OF slug, restaurant_id ON public.branches%',
    (select string_agg(c.relname || ':' || pg_get_triggerdef(t.oid), ' || ' order by c.relname)
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where t.tgname = 'trg_storefront_path_alias' and not t.tgisinternal));
  perform pg_temp.expect('triggers: the restaurants one too, only when the slug really changes',
    '%restaurants:CREATE TRIGGER trg_storefront_path_alias AFTER UPDATE OF slug ON public.restaurants FOR EACH ROW WHEN ((old.slug IS DISTINCT FROM new.slug))%',
    (select string_agg(c.relname || ':' || pg_get_triggerdef(t.oid), ' || ' order by c.relname)
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where t.tgname = 'trg_storefront_path_alias' and not t.tgisinternal));
  perform pg_temp.expect('seed: coastal-grill points at the Demo-FavorNoms restaurant wherever that restaurant exists',
    'true',
    ((select count(*) from public.storefront_path_aliases
       where restaurant_slug = 'coastal-grill' and branch_slug is null
         and restaurant_id = '33333333-3333-3333-3333-333333333333')
     = (select count(*) from public.restaurants where id = '33333333-3333-3333-3333-333333333333'))::text);
  -- The owner's showcase links (live only; a local stack without the showcase store skips this).
  if exists (select 1 from public.branches b join public.restaurants r on r.id = b.restaurant_id
              where r.id = '33333333-3333-3333-3333-333333333333' and b.slug = 'brooklyn' and b.is_active) then
    perform pg_temp.expect('seed: /r/coastal-grill/brooklyn now goes to the current showcase address',
      'redirect ' || (select slug from public.restaurants where id = '33333333-3333-3333-3333-333333333333') || ' brooklyn',
      pg_temp.resolve('coastal-grill', 'brooklyn'));
  end if;

  -- Fixture: two restaurants on their trial; A has main, second and a switched-off branch.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, v_a, 'ZZ Path Aliases A') returning id into v_ra;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, v_b, 'ZZ Path Aliases B') returning id into v_rb;
  perform private.billing_apply_selection(v_rb, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'main', 'Main') returning id into v_main;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'second', 'Second') returning id into v_second;
  insert into public.branches (restaurant_id, slug, name, is_active) values (v_ra, 'closed', 'Closed', false)
  returning id into v_closed;
  insert into public.branches (restaurant_id, slug, name) values (v_rb, 'main', 'B Main') returning id into v_bmain;

  perform pg_temp.expect('fixture: no alias rows for the new restaurants yet', '0',
    (select count(*)::text from public.storefront_path_aliases where restaurant_id in (v_ra, v_rb)));

  -- 1. Before any rename -------------------------------------------------------------------------
  begin
    perform pg_temp.expect('resolve: a storefront today is live, with its slugs', 'live ' || v_a || ' main',
      pg_temp.resolve(v_a, 'main'));
    perform pg_temp.expect('resolve: other letter case is the same storefront, sent to its real spelling',
      'redirect ' || v_a || ' main', pg_temp.resolve(upper(v_a), 'Main'));
    perform pg_temp.expect('resolve: an unknown restaurant, an unknown branch, blank or null slugs are none',
      'none - -|none - -|none - -|none - -|none - -',
      pg_temp.resolve('zz-nobody-' || v_sfx, 'main') || '|' || pg_temp.resolve(v_a, 'nowhere') || '|'
        || pg_temp.resolve('', 'main') || '|' || pg_temp.resolve(v_a, ' ') || '|' || pg_temp.resolve(null, null));
    perform pg_temp.expect('resolve: a switched-off branch is none', 'none - -', pg_temp.resolve(v_a, 'closed'));
    perform pg_temp.expect('resolve: one row every time', '1|1',
      (select count(*)::text from public.resolve_storefront_path(v_a, 'main')) || '|'
        || (select count(*)::text from public.resolve_storefront_path('zz-nobody-' || v_sfx, 'x')));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. Branch renames. Starts: A {main, second, closed}, B {main}. -------------------------------
  begin
    update public.branches set slug = 'main-2' where id = v_main;
    perform pg_temp.expect('trigger: a branch rename records the old pair, pointing at the branch',
      v_a || '|main|true|true',
      (select a.restaurant_slug || '|' || a.branch_slug || '|' || (a.restaurant_id = v_ra)::text || '|'
                || (a.branch_id = v_main)::text
         from public.storefront_path_aliases a where a.restaurant_id = v_ra and a.branch_slug = 'main'));
    perform pg_temp.expect('resolve: the old address goes to the new one; the new one is live',
      'redirect ' || v_a || ' main-2|live ' || v_a || ' main-2',
      pg_temp.resolve(v_a, 'main') || '|' || pg_temp.resolve(v_a, 'main-2'));

    update public.branches set slug = slug, name = 'Second!' where id = v_second;
    perform pg_temp.expect('trigger: an UPDATE that sets the slug to itself records nothing', '0',
      (select count(*)::text from public.storefront_path_aliases where branch_id = v_second));

    update public.branches set slug = 'main-3' where id = v_main;
    perform pg_temp.expect('resolve: renamed twice, both old addresses go straight to the newest (no chain)',
      'redirect ' || v_a || ' main-3|redirect ' || v_a || ' main-3',
      pg_temp.resolve(v_a, 'main') || '|' || pg_temp.resolve(v_a, 'main-2'));

    -- A live slug wins: "second" takes the address "main" gave up.
    update public.branches set slug = 'main' where id = v_second;
    perform pg_temp.expect('resolve: a branch that takes an old slug is live there; the alias is ignored',
      'live ' || v_a || ' main', pg_temp.resolve(v_a, 'main'));
    perform pg_temp.expect('resolve: and its own old slug goes to it',
      'redirect ' || v_a || ' main', pg_temp.resolve(v_a, 'second'));

    -- ... and gives it up again: the old address now belongs to the branch that left it last.
    update public.branches set slug = 'other' where id = v_second;
    perform pg_temp.expect('trigger: one row per old address, moved to whoever gave it up last', '1|true',
      (select count(*)::text || '|' || bool_and(a.branch_id = v_second)::text
         from public.storefront_path_aliases a where a.restaurant_id = v_ra and a.branch_slug = 'main'));
    perform pg_temp.expect('resolve: so "main" now goes to "other", and "main-2" still to "main-3"',
      'redirect ' || v_a || ' other|redirect ' || v_a || ' main-3',
      pg_temp.resolve(v_a, 'main') || '|' || pg_temp.resolve(v_a, 'main-2'));
    perform pg_temp.expect('resolve: branch aliases are per restaurant (B''s main is untouched)',
      'live ' || v_b || ' main', pg_temp.resolve(v_b, 'main'));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. Restaurant renames. Starts: A {main-3, other, closed} with aliases main->other,
  --    main-2->main-3, second->other; B {main}. ------------------------------------------------------
  begin
    update public.restaurants set slug = v_a2 where id = v_ra;
    perform pg_temp.expect('trigger: a restaurant rename records the old slug, pointing at the restaurant',
      '1|true|true',
      (select count(*)::text || '|' || bool_and(a.restaurant_id = v_ra)::text || '|' || bool_and(a.branch_id is null)::text
         from public.storefront_path_aliases a where a.restaurant_slug = v_a and a.branch_slug is null));
    perform pg_temp.expect('resolve: the old restaurant slug keeps the branch',
      'redirect ' || v_a2 || ' main-3', pg_temp.resolve(v_a, 'main-3'));
    perform pg_temp.expect('resolve: old restaurant slug + old branch slug both followed, in one step',
      'redirect ' || v_a2 || ' other|redirect ' || v_a2 || ' main-3',
      pg_temp.resolve(v_a, 'main') || '|' || pg_temp.resolve(v_a, 'main-2'));
    perform pg_temp.expect('resolve: a branch alias still works under the new restaurant slug',
      'redirect ' || v_a2 || ' other', pg_temp.resolve(v_a2, 'second'));
    perform pg_temp.expect('resolve: the new address is live', 'live ' || v_a2 || ' main-3', pg_temp.resolve(v_a2, 'main-3'));

    -- A live slug wins: B takes A's old restaurant slug.
    update public.restaurants set slug = v_a where id = v_rb;
    perform pg_temp.expect('resolve: a restaurant that takes an old slug is live there',
      'live ' || v_a || ' main', pg_temp.resolve(v_a, 'main'));
    perform pg_temp.expect('resolve: and A''s branches are no longer found through it (B has no main-3)',
      'none - -', pg_temp.resolve(v_a, 'main-3'));
    perform pg_temp.expect('resolve: B''s own old slug goes to B',
      'redirect ' || v_a || ' main', pg_temp.resolve(v_b, 'main'));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. A branch moved to another restaurant. Starts: A is v_a2 {main-3, other, closed}, B is v_a
  --    {main}. --------------------------------------------------------------------------------------
  begin
    update public.branches set restaurant_id = v_rb where id = v_main;
    perform pg_temp.expect('trigger: a move records the pair it left, under the restaurant it left', '1|true',
      (select count(*)::text || '|' || bool_and(a.branch_id = v_main)::text
         from public.storefront_path_aliases a where a.restaurant_id = v_ra and a.branch_slug = 'main-3'));
    perform pg_temp.expect('resolve: its old address goes to where it is now',
      'redirect ' || v_a || ' main-3', pg_temp.resolve(v_a2, 'main-3'));
    perform pg_temp.expect('resolve: and it is live there', 'live ' || v_a || ' main-3', pg_temp.resolve(v_a, 'main-3'));
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. Switched off, deleted. Starts: A is v_a2 {other, closed}, aliases main->other,
  --    second->other. -----------------------------------------------------------------------------
  begin
    update public.branches set is_active = false where id = v_second;
    perform pg_temp.expect('resolve: an alias to a switched-off branch is none, and so is its live address',
      'none - -|none - -', pg_temp.resolve(v_a2, 'main') || '|' || pg_temp.resolve(v_a2, 'other'));
    update public.branches set slug = 'closed-2' where id = v_closed;
    perform pg_temp.expect('resolve: a switched-off branch still owns its old address (none, never another branch)',
      'none - -', pg_temp.resolve(v_a2, 'closed'));

    delete from public.branches where id = v_closed;
    perform pg_temp.expect('cascade: deleting a branch deletes its alias rows', '0',
      (select count(*)::text from public.storefront_path_aliases where branch_id = v_closed));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. Who may call what. ----------------------------------------------------------------------------
  begin
    perform pg_temp.expect('anon: may call the RPC', 'ok live ' || v_a || ' main',
      pg_temp.try_as('anon', null, array[format(
        'select status || '' '' || restaurant_slug || '' '' || branch_slug from public.resolve_storefront_path(%L, %L)',
        v_a, 'main')]));
    perform pg_temp.expect('anon and authenticated: may not read or write the table',
      'ERR 42501 permission denied for table storefront_path_aliases|ERR 42501 permission denied for table storefront_path_aliases|ERR 42501 permission denied for table storefront_path_aliases',
      pg_temp.try_as('anon', null, array['select count(*) from public.storefront_path_aliases'])
        || '|' || pg_temp.try_as('authenticated', v_owner, array['select count(*) from public.storefront_path_aliases'])
        || '|' || pg_temp.try_as('authenticated', v_owner, array[format(
             'insert into public.storefront_path_aliases (restaurant_slug, restaurant_id) values (%L, %L) returning id',
             'zz-squat-' || v_sfx, v_ra)]));
    -- The owner renames through the API: the trigger writes as its owner all the same.
    perform pg_temp.expect('owner: a rename through the API records the old pair (seen through the RPC)',
      'ok redirect ' || v_a || ' main-4',
      pg_temp.try_as('authenticated', v_owner, array[
        format('update public.branches set slug = %L where id = %L returning slug', 'main-4', v_main),
        format('select status || '' '' || restaurant_slug || '' '' || branch_slug from public.resolve_storefront_path(%L, %L)',
               v_a, 'main-3')]));
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
