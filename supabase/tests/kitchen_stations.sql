-- Kitchen stations the merchant manages (20261024200000_kitchen_stations,
-- docs/KITCHEN-STATIONS-2026-10-24.md). A rolled-back script, not a migration. Pins: the five
-- built-ins every branch has (backfill and new branches), the key that never changes and the name
-- rules (§1), who reads and writes the list (§2), the dishes' foreign key and blank stations, a
-- rename that rewrites no dish and no order line, public.delete_kitchen_station (dishes, lines on
-- open boards made or not, combo entries; closed orders untouched; a station still on a dish
-- refused unless a target or p_clear is given), public.reorder_kitchen_stations, copy_branch_setup
-- and broadcast_franchise_menu carrying stations, a combo line's entries restamped with their
-- dishes' stations at insert, an order that comes back onto the board (the kitchen's Undo) taking
-- its dead keys off, and a branch delete taking its stations with it. Section 0 checks what the
-- migration's data step left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/kitchen_stations.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on restaurants this script
-- creates for itself (section 0 only reads). Two ways of acting as someone:
--   pg_temp.try_as(uid, sqls[, admin])  as the `authenticated` role (or anon when uid is null), in
--                                       a subtransaction that is always rolled back -- for
--                                       permission checks.
--   pg_temp.act_as(uid[, admin])        sets only the JWT claims, so auth.uid() is that person
--                                       while the statements that follow keep their effect.
--                                       act_as(null) is the service role again (no JWT).
-- Each section after the fixtures runs in its own block: one that breaks reports a FAIL row and
-- the others still run, on whatever state it left.
--
-- People (auth.users rows made here):
--   owner    restaurants.owner_user_id of restaurant A, and owner of its franchise group
--   manager  manager at branch a1 only (menu.manage there, nowhere else)
--   cashier  cashier at a1 (no menu.manage)
--   kitchen  kitchen at a1 (kitchen.access and menu.availability, no menu.manage)
--   other    owner of restaurant B
--
-- Restaurant A: a1 (the stations, dishes and orders under test), a2 (copy_branch_setup's target,
-- later deleted), a3 (broadcast_franchise_menu's target, with stations of its own).
--
-- The result is one row per check with PASS/FAIL, then a summary row.

begin;

create temp table t_out (
  seq serial,
  check_name text,
  expected text,
  actual text,
  verdict text
) on commit drop;

-- Run statements as p_uid and report 'ok <last value>' or 'ERR <message>'. Always rolled back.
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

-- Run statements as the service role (no JWT) and report 'ok <last value>' or 'ERR <message>'.
-- Always rolled back.
create or replace function pg_temp.try_service(p_sqls text[])
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

-- Who auth.uid() is for the statements that follow (null: the service role, no JWT).
create or replace function pg_temp.act_as(p_uid uuid, p_admin boolean default false)
returns void
language plpgsql
as $$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
    perform set_config('request.jwt.claim.role', '', true);
  end if;
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
  values (v, 'kitchen-stations-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', p_admin), '{}'::jsonb, now(), now());
  return v;
end $$;

-- A branch's stations as the checks below spell them: key:name:display_order in list order, '-'
-- for a built-in's missing name.
create or replace function pg_temp.stations(p_branch uuid)
returns text
language sql
as $$
  select coalesce(string_agg(ks.key || ':' || coalesce(ks.name, '-') || ':' || ks.display_order, ','
                             order by ks.display_order, ks.key), '')
    from public.kitchen_stations ks
   where ks.branch_id = p_branch;
$$;

-- The station of each entry in a combo line's snapshot, in order, '-' for none.
create or replace function pg_temp.combo_stations(p_line uuid)
returns text
language sql
as $$
  select string_agg(coalesce(a.e ->> 'station', '-'), ',' order by a.i)
    from public.order_items oi,
         jsonb_array_elements(oi.combo_contents) with ordinality as a(e, i)
   where oi.id = p_line;
$$;

-- A branch's dishes as name:station, '-' for none.
create or replace function pg_temp.dishes(p_branch uuid)
returns text
language sql
as $$
  select coalesce(string_agg(mi.name || ':' || coalesce(mi.station, '-'), ',' order by mi.name), '')
    from public.menu_items mi
   where mi.branch_id = p_branch;
$$;

do $test$
declare
  v_owner    uuid := pg_temp.new_user('owner');
  v_manager  uuid := pg_temp.new_user('manager');
  v_cashier  uuid := pg_temp.new_user('cashier');
  v_kitchen  uuid := pg_temp.new_user('kitchen');
  v_other    uuid := pg_temp.new_user('other');
  v_sfx      text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  c_builtins constant text := 'hot:-:10,cold:-:20,bar:-:30,dessert:-:40,expo:-:50';
  c_rls      constant text := 'ERR new row violates row-level security policy for table "kitchen_stations"';
  c_name     constant text := 'ERR new row for relation "kitchen_stations" violates check constraint "kitchen_stations_name_check"';
  c_key      constant text := 'ERR new row for relation "kitchen_stations" violates check constraint "kitchen_stations_key_check"';
  c_fk       constant text := 'ERR insert or update on table "menu_items" violates foreign key constraint "menu_items_branch_id_station_fkey"';
  v_ra uuid; v_a1 uuid; v_a2 uuid; v_a3 uuid;
  v_rb uuid; v_b1 uuid;
  v_group uuid;
  v_cat uuid; v_cat3 uuid;
  v_hot uuid; v_expo uuid;
  v_grill uuid;  v_grill_key text;
  v_wok uuid;    v_wok_key text;
  v_pastry uuid; v_pastry_key text;
  v_prep2_key text;
  v_wok3_key text; v_prep3 uuid;
  v_fish uuid; v_pork uuid; v_tomyum uuid; v_rice uuid; v_stirfry uuid; v_mango uuid;
  v_combo uuid; v_contents jsonb;
  v_active uuid; v_done uuid;
  v_l_pending uuid; v_l_ready uuid; v_l_moved uuid; v_l_wok uuid;
  v_l_combo_ready uuid; v_l_combo_pending uuid; v_l_done uuid; v_l_combo_done uuid;
  v_l_combo_new uuid; v_l_object uuid; v_l_race uuid;
  v_l_done_alive uuid; v_l_done_wok uuid; v_l_done_blank uuid; v_l_combo_done2 uuid;
  v_a3_fish uuid;
  c_no_dish  constant text := '00000000-0000-4000-8000-000000000000';
  v_expected jsonb;
  v_ids uuid[];
  v_before text;
  v_n integer;
  r jsonb;
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('data: every dish''s station is a station of its branch', '0',
    (select count(*)::text from public.menu_items mi
      where mi.station is not null
        and not exists (select 1 from public.kitchen_stations ks
                         where ks.branch_id = mi.branch_id and ks.key = mi.station)));
  perform pg_temp.expect('data: no dish holds a blank station', '0',
    (select count(*)::text from public.menu_items where btrim(station) = ''));
  -- These two describe the state right after the migration; a merchant may delete a built-in or
  -- rename a backfilled station later.
  perform pg_temp.expect('backfill: every branch has the five built-ins', '0',
    (select count(*)::text from public.branches b
      where (select count(*) from public.kitchen_stations ks
              where ks.branch_id = b.id and ks.key in ('hot', 'cold', 'bar', 'dessert', 'expo')) <> 5));
  perform pg_temp.expect('backfill: any other station a dish held is a station named as its key', '0',
    (select count(*)::text from public.kitchen_stations ks
      where ks.key !~ '^st_[0-9a-f]{10}$'
        and ks.key not in ('hot', 'cold', 'bar', 'dessert', 'expo')
        and ks.name is distinct from ks.key));
  perform pg_temp.expect('fk: menu_items (branch_id, station) -> kitchen_stations (branch_id, key), NO ACTION both ways, MATCH SIMPLE',
    'true a a s',
    (select (confrelid = 'public.kitchen_stations'::regclass)::text || ' ' || confupdtype::text || ' '
              || confdeltype::text || ' ' || confmatchtype::text
       from pg_constraint
      where conname = 'menu_items_branch_id_station_fkey' and conrelid = 'public.menu_items'::regclass));
  perform pg_temp.expect('realtime: kitchen_stations is in supabase_realtime', '1',
    (select count(*)::text from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kitchen_stations'));
  perform pg_temp.expect('grants: RLS on; anon nothing; authenticated reads, adds (no key), renames and moves (no key), never deletes',
    'true false false true true false false true false true',
    (select relrowsecurity::text from pg_class where oid = 'public.kitchen_stations'::regclass) || ' '
      || has_table_privilege('anon', 'public.kitchen_stations', 'select')::text || ' '
      || has_table_privilege('anon', 'public.kitchen_stations', 'insert')::text || ' '
      || has_table_privilege('authenticated', 'public.kitchen_stations', 'select')::text || ' '
      || has_column_privilege('authenticated', 'public.kitchen_stations', 'name', 'insert')::text || ' '
      || has_column_privilege('authenticated', 'public.kitchen_stations', 'key', 'insert')::text || ' '
      || has_column_privilege('authenticated', 'public.kitchen_stations', 'key', 'update')::text || ' '
      || has_column_privilege('authenticated', 'public.kitchen_stations', 'name', 'update')::text || ' '
      || has_table_privilege('authenticated', 'public.kitchen_stations', 'delete')::text || ' '
      || has_table_privilege('service_role', 'public.kitchen_stations', 'delete')::text);
  perform pg_temp.expect('triggers: the key guard, updated_at and the platform-admin audit; no storefront bump',
    'kitchen_stations_rules,set_updated_at_kitchen_stations,trg_platform_admin_audit',
    (select string_agg(tgname, ',' order by tgname) from pg_trigger
      where tgrelid = 'public.kitchen_stations'::regclass and not tgisinternal));

  -- Fixture: restaurant A on its trial with three branches, in a franchise group of its owner's;
  -- restaurant B with one.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-ks-a-' || v_sfx, 'ZZ Stations A') returning id into v_ra;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'one', 'A One') returning id into v_a1;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'two', 'A Two') returning id into v_a2;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'three', 'A Three') returning id into v_a3;
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_manager, v_ra, v_a1, 'manager', 'active'), (v_cashier, v_ra, v_a1, 'cashier', 'active'),
         (v_kitchen, v_ra, v_a1, 'kitchen', 'active');
  insert into public.franchise_groups (owner_user_id, name, slug)
  values (v_owner, 'ZZ Stations Group', 'zz-ks-' || v_sfx) returning id into v_group;
  update public.restaurants set franchise_group_id = v_group where id = v_ra;

  insert into public.restaurants (owner_user_id, slug, name)
  values (v_other, 'zz-ks-b-' || v_sfx, 'ZZ Stations B') returning id into v_rb;
  perform private.billing_apply_selection(v_rb, 'trial', '{}'::uuid[], 1, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_rb, 'one', 'B One') returning id into v_b1;

  -- 1. A new branch starts with the five built-ins (§2) -----------------------------------------
  perform pg_temp.expect('seed: a new branch has the five built-ins, unnamed, 10 to 50', c_builtins,
    pg_temp.stations(v_a1));
  perform pg_temp.expect('seed: every new branch gets its own', c_builtins || '|' || c_builtins || '|10',
    pg_temp.stations(v_a3) || '|' || pg_temp.stations(v_b1) || '|'
      || (select count(distinct id) from public.kitchen_stations where branch_id in (v_a1, v_b1)));
  perform pg_temp.expect('seed: a branch opened through create_branch too', 'ok 5',
    pg_temp.try_as(v_owner, array[
      format('select public.create_branch(p_restaurant_id => %L, p_name => %L, p_slug => %L)::text',
             v_ra, 'A Four', 'four'),
      format('select count(*)::text from public.kitchen_stations ks join public.branches b on b.id = ks.branch_id
               where b.restaurant_id = %L and b.slug = ''four''', v_ra)]));
  perform pg_temp.expect('seed: its trigger function runs as postgres and no API role may call it', 'postgres true false false',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text
       from pg_proc p where p.oid = 'private.tg_branches_seed_kitchen_stations()'::regprocedure));

  -- Fixture: a1's own stations (written as the service role: the checks below try the API roles),
  -- dishes, a combo, an open order and a closed one.
  select id into v_hot from public.kitchen_stations where branch_id = v_a1 and key = 'hot';
  select id into v_expo from public.kitchen_stations where branch_id = v_a1 and key = 'expo';
  insert into public.kitchen_stations (branch_id, name, display_order) values (v_a1, '  Grill  ', 60)
  returning id, key into v_grill, v_grill_key;
  insert into public.kitchen_stations (branch_id, name, display_order) values (v_a1, 'Wok', 70)
  returning id, key into v_wok, v_wok_key;
  insert into public.kitchen_stations (branch_id, name, display_order) values (v_a1, 'Pastry', 80)
  returning id, key into v_pastry, v_pastry_key;

  insert into public.menu_categories (branch_id, name, display_order) values (v_a1, 'Mains', 1) returning id into v_cat;
  insert into public.menu_items (branch_id, category_id, name, price, station)
  values (v_a1, v_cat, 'Grilled Fish', 10, v_grill_key) returning id into v_fish;
  insert into public.menu_items (branch_id, category_id, name, price, station)
  values (v_a1, v_cat, 'Grilled Pork', 10, v_grill_key) returning id into v_pork;
  insert into public.menu_items (branch_id, category_id, name, price, station)
  values (v_a1, v_cat, 'Tom Yum', 8, 'hot') returning id into v_tomyum;
  insert into public.menu_items (branch_id, category_id, name, price, station)
  values (v_a1, v_cat, 'Plain Rice', 2, null) returning id into v_rice;
  insert into public.menu_items (branch_id, category_id, name, price, station)
  values (v_a1, v_cat, 'Stir Fry', 9, v_wok_key) returning id into v_stirfry;
  insert into public.menu_items (branch_id, category_id, name, price, station)
  values (v_a1, v_cat, 'Mango Sticky Rice', 6, v_pastry_key) returning id into v_mango;

  insert into public.combo_sets (branch_id, name, total_price, is_active)
  values (v_a1, 'Grill combo', 18, true) returning id into v_combo;
  insert into public.combo_items (combo_id, menu_item_id, quantity) values (v_combo, v_pork, 1), (v_combo, v_tomyum, 1);
  v_contents := jsonb_build_array(
    jsonb_build_object('menu_item_id', v_pork, 'name', 'Grilled Pork', 'quantity', 1, 'station', v_grill_key),
    jsonb_build_object('menu_item_id', v_tomyum, 'name', 'Tom Yum', 'quantity', 1, 'station', 'hot'));

  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-KS-OPEN-' || v_sfx, v_a1, 'pickup', 'preparing', 10, 10, '[]') returning id into v_active;
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-KS-DONE-' || v_sfx, v_a1, 'pickup', 'completed', 10, 10, '[]') returning id into v_done;
  -- Dish lines take their dish's station at insert (order_items_default_station).
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status)
  values (v_active, v_fish, 'Grilled Fish', 10, 1, 10, 'pending') returning id into v_l_pending;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status)
  values (v_active, v_fish, 'Grilled Fish', 10, 1, 10, 'ready') returning id into v_l_ready;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status)
  values (v_active, v_stirfry, 'Stir Fry', 9, 1, 9, 'ready') returning id into v_l_wok;
  -- Made at the grill before Tom Yum moved to hot.
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status, station)
  values (v_active, v_tomyum, 'Tom Yum', 8, 1, 8, 'served', v_grill_key) returning id into v_l_moved;
  insert into public.order_items (order_id, combo_id, item_name, unit_price, quantity, subtotal, prep_status, combo_contents)
  values (v_active, v_combo, 'Grill combo', 18, 1, 18, 'ready', v_contents) returning id into v_l_combo_ready;
  insert into public.order_items (order_id, combo_id, item_name, unit_price, quantity, subtotal, prep_status, combo_contents)
  values (v_active, v_combo, 'Grill combo', 18, 1, 18, 'pending', v_contents) returning id into v_l_combo_pending;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status)
  values (v_done, v_fish, 'Grilled Fish', 10, 1, 10, 'served') returning id into v_l_done;
  insert into public.order_items (order_id, combo_id, item_name, unit_price, quantity, subtotal, prep_status, combo_contents)
  values (v_done, v_combo, 'Grill combo', 18, 1, 18, 'served', v_contents) returning id into v_l_combo_done;

  -- a2 has a station of its own; a3 renamed hot, has a "wok" of its own under another key, a Prep,
  -- and already sells Mango Sticky Rice.
  insert into public.kitchen_stations (branch_id, name, display_order) values (v_a2, 'Prep', 60)
  returning key into v_prep2_key;
  update public.kitchen_stations set name = 'Fire' where branch_id = v_a3 and key = 'hot';
  insert into public.kitchen_stations (branch_id, name, display_order) values (v_a3, 'wok', 60)
  returning key into v_wok3_key;
  insert into public.kitchen_stations (branch_id, name, display_order) values (v_a3, 'Prep', 70)
  returning id into v_prep3;
  insert into public.menu_categories (branch_id, name, display_order) values (v_a3, 'Desserts', 1) returning id into v_cat3;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a3, v_cat3, 'Mango Sticky Rice', 6);

  perform pg_temp.expect('fixture: dish lines took their dish''s station', v_grill_key || ' ' || v_grill_key || ' ' || v_wok_key,
    (select station from public.order_items where id = v_l_pending) || ' '
      || (select station from public.order_items where id = v_l_ready) || ' '
      || (select station from public.order_items where id = v_l_wok));

  -- 2. A key that never changes, a name that can (§1) -------------------------------------------
  begin
    perform pg_temp.expect('key: minted by the database, st_ and 10 hex characters; the name trimmed', 'true Grill',
      (v_grill_key ~ '^st_[0-9a-f]{10}$')::text || ' ' || (select name from public.kitchen_stations where id = v_grill));
    perform pg_temp.expect('key: a manager''s new station gets one too', 'ok true 90',
      pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id, name, display_order) values (%L, ''Fryer'', 90)
         returning (key ~ ''^st_[0-9a-f]{10}$'')::text || '' '' || display_order', v_a1)]));
    perform pg_temp.expect('key: the client never chooses it', 'ERR permission denied for table kitchen_stations',
      pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id, key, name) values (%L, ''fryer'', ''Fryer'') returning 1', v_a1)]));
    perform pg_temp.expect('key: nor changes it', 'ERR permission denied for table kitchen_stations',
      pg_temp.try_as(v_manager, array[format(
        'update public.kitchen_stations set key = ''grill'' where id = %L returning 1', v_grill)]));
    perform pg_temp.expect('key: nor does the service role (the guard)', 'ERR station_key_immutable',
      pg_temp.try_service(array[format(
        'update public.kitchen_stations set key = ''grill'' where id = %L returning 1', v_grill)]));
    perform pg_temp.expect('key: a built-in''s neither', 'ERR station_key_immutable',
      pg_temp.try_service(array[format(
        'update public.kitchen_stations set key = ''grill'' where id = %L returning 1', v_hot)]));
    perform pg_temp.expect('branch: a station never moves to another branch', 'ERR station_branch_immutable',
      pg_temp.try_service(array[format(
        'update public.kitchen_stations set branch_id = %L where id = %L returning 1', v_a2, v_grill)]));
    perform pg_temp.expect('key: _none is the board''s "No station"', c_key,
      pg_temp.try_service(array[format(
        'insert into public.kitchen_stations (branch_id, key, name) values (%L, ''_none'', ''None'') returning 1', v_a1)]));
    perform pg_temp.expect('key: lower-case letters, digits, _ and - only', c_key,
      pg_temp.try_service(array[format(
        'insert into public.kitchen_stations (branch_id, key, name) values (%L, ''Pizza Oven'', ''Pizza'') returning 1', v_a1)]));

    perform pg_temp.expect('name: a station of the merchant''s own must have one', c_name,
      pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id) values (%L) returning 1', v_a1)]));
    perform pg_temp.expect('name: a blank one is none', c_name,
      pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, %L) returning 1', v_a1, E' \t ')]));
    perform pg_temp.expect('name: 40 characters fit, 41 do not', 'ok 40|' || c_name,
      pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, %L) returning char_length(name)::text',
        v_a1, repeat('x', 40))])
      || '|' || pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, %L) returning 1', v_a1, repeat('y', 41))]));
    perform pg_temp.expect('name: unique per branch, ignoring case',
      'ERR duplicate key value violates unique constraint "kitchen_stations_branch_name_key"',
      pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, ''GRILL'') returning 1', v_a1)]));
    perform pg_temp.expect('name: another branch may use it', 'ok 1',
      pg_temp.try_service(array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, ''Grill'') returning 1', v_a2)]));
    perform pg_temp.expect('name: a built-in renamed (trimmed), then back to its translated label', 'ok Charcoal|ok <none> hot',
      pg_temp.try_as(v_manager, array[format(
        'update public.kitchen_stations set name = '' Charcoal '' where id = %L returning name', v_hot)])
      || '|' || pg_temp.try_as(v_manager, array[
        format('update public.kitchen_stations set name = ''Charcoal'' where id = %L returning name', v_hot),
        format('update public.kitchen_stations set name = null where id = %L
                returning coalesce(name, ''<none>'') || '' '' || key', v_hot)]));
    perform pg_temp.expect('name: a blank rename of a built-in is its label again', 'ok <none>',
      pg_temp.try_as(v_manager, array[
        format('update public.kitchen_stations set name = ''Charcoal'' where id = %L returning name', v_hot),
        format('update public.kitchen_stations set name = ''   '' where id = %L returning coalesce(name, ''<none>'')', v_hot)]));
    perform pg_temp.expect('name: a station of the merchant''s own cannot lose its name', c_name,
      pg_temp.try_as(v_manager, array[format(
        'update public.kitchen_stations set name = null where id = %L returning 1', v_grill)]));
    perform pg_temp.expect('name: a built-in may not take another station''s name either',
      'ERR duplicate key value violates unique constraint "kitchen_stations_branch_name_key"',
      pg_temp.try_as(v_manager, array[format(
        'update public.kitchen_stations set name = ''wok'' where id = %L returning 1', v_hot)]));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. Who reads and writes the list (§2) --------------------------------------------------------
  begin
    v_n := (select count(*) from public.kitchen_stations where branch_id = v_a1);
    perform pg_temp.expect('read: the cashier and the kitchen read the branch''s list', format('ok %s|ok %s', v_n, v_n),
      pg_temp.try_as(v_cashier, array[format(
        'select count(*)::text from public.kitchen_stations where branch_id = %L', v_a1)])
      || '|' || pg_temp.try_as(v_kitchen, array[format(
        'select count(*)::text from public.kitchen_stations where branch_id = %L', v_a1)]));
    perform pg_temp.expect('read: another restaurant''s owner sees none of it', 'ok 0',
      pg_temp.try_as(v_other, array[format(
        'select count(*)::text from public.kitchen_stations where branch_id = %L', v_a1)]));
    perform pg_temp.expect('read: anon cannot read stations at all', 'ERR permission denied for table kitchen_stations',
      pg_temp.try_as(null, array[format(
        'select count(*)::text from public.kitchen_stations where branch_id = %L', v_a1)]));
    perform pg_temp.expect('write: the cashier and the kitchen cannot add', c_rls || '|' || c_rls,
      pg_temp.try_as(v_cashier, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, ''Counter'') returning 1', v_a1)])
      || '|' || pg_temp.try_as(v_kitchen, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, ''Counter'') returning 1', v_a1)]));
    perform pg_temp.expect('write: nor rename (no row is theirs to change)', 'ok 0|ok 0',
      pg_temp.try_as(v_cashier, array[format(
        'with u as (update public.kitchen_stations set name = ''Mine'' where id = %L returning 1)
         select count(*)::text from u', v_grill)])
      || '|' || pg_temp.try_as(v_kitchen, array[format(
        'with u as (update public.kitchen_stations set name = ''Mine'' where id = %L returning 1)
         select count(*)::text from u', v_grill)]));
    perform pg_temp.expect('write: the manager adds and renames', 'ok 1',
      pg_temp.try_as(v_manager, array[
        format('insert into public.kitchen_stations (branch_id, name) values (%L, ''Fryer'') returning 1', v_a1),
        format('with u as (update public.kitchen_stations set name = ''Big Grill'' where id = %L returning 1)
                select count(*)::text from u', v_grill)]));
    perform pg_temp.expect('write: so does the restaurant''s owner', 'ok 1',
      pg_temp.try_as(v_owner, array[format(
        'with u as (update public.kitchen_stations set name = ''Big Grill'' where id = %L returning 1)
         select count(*)::text from u', v_grill)]));
    perform pg_temp.expect('write: a1''s manager cannot add at a2', c_rls,
      pg_temp.try_as(v_manager, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, ''Fryer'') returning 1', v_a2)]));
    perform pg_temp.expect('write: another restaurant''s owner cannot add here', c_rls,
      pg_temp.try_as(v_other, array[format(
        'insert into public.kitchen_stations (branch_id, name) values (%L, ''Fryer'') returning 1', v_a1)]));
    perform pg_temp.expect('write: nobody deletes a station directly, not even one no dish uses',
      'ERR permission denied for table kitchen_stations',
      pg_temp.try_as(v_manager, array[format(
        'delete from public.kitchen_stations where id = %L returning 1', v_expo)]));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. A dish names a station its branch has, or none (§1) ---------------------------------------
  begin
    perform pg_temp.expect('fk: a dish cannot name a station its branch lacks', c_fk,
      pg_temp.try_service(array[format(
        'update public.menu_items set station = ''nope'' where id = %L returning 1', v_rice)]));
    perform pg_temp.expect('fk: nor another branch''s station', c_fk,
      pg_temp.try_service(array[format(
        'update public.menu_items set station = %L where id = %L returning 1', v_prep2_key, v_rice)]));
    perform pg_temp.expect('fk: the menu editor''s insert is refused the same way', c_fk,
      pg_temp.try_as(v_manager, array[format(
        'insert into public.menu_items (branch_id, name, price, station) values (%L, ''Mystery'', 1, ''nope'') returning 1', v_a1)]));
    perform pg_temp.expect('fk: a station the branch has is taken', 'ok cold',
      pg_temp.try_as(v_manager, array[format(
        'update public.menu_items set station = ''cold'' where id = %L returning station', v_rice)]));
    perform pg_temp.expect('blank: an empty station is stored as none', 'ok <none>',
      pg_temp.try_service(array[format(
        'insert into public.menu_items (branch_id, name, price, station) values (%L, ''Blank'', 1, '''')
         returning coalesce(station, ''<none>'')', v_a1)]));
    perform pg_temp.expect('blank: so is an update to spaces', 'ok <none>',
      pg_temp.try_service(array[format(
        'update public.menu_items set station = ''   '' where id = %L returning coalesce(station, ''<none>'')', v_tomyum)]));
    perform pg_temp.expect('fk: a station still on a dish cannot simply be deleted',
      'ERR update or delete on table "kitchen_stations" violates foreign key constraint "menu_items_branch_id_station_fkey" on table "menu_items"',
      pg_temp.try_service(array[format(
        'delete from public.kitchen_stations where id = %L returning 1', v_grill)]));
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. A rename rewrites nothing (§1) ------------------------------------------------------------
  begin
    v_before := (select string_agg(oi.id::text || '@' || oi.ctid::text || '@' || coalesce(oi.station, '-')
                                     || '@' || coalesce(oi.combo_contents::text, '-'), ',' order by oi.id)
                   from public.order_items oi where oi.order_id in (v_active, v_done))
                || '/' || (select string_agg(mi.id::text || '@' || mi.ctid::text, ',' order by mi.id)
                             from public.menu_items mi where mi.branch_id = v_a1);
    update public.kitchen_stations set name = 'Charcoal Grill' where id = v_grill;
    perform pg_temp.expect('rename: the key stays', v_grill_key || ' Charcoal Grill',
      (select key || ' ' || name from public.kitchen_stations where id = v_grill));
    perform pg_temp.expect('rename: no order line and no dish was written', v_before,
      (select string_agg(oi.id::text || '@' || oi.ctid::text || '@' || coalesce(oi.station, '-')
                           || '@' || coalesce(oi.combo_contents::text, '-'), ',' order by oi.id)
         from public.order_items oi where oi.order_id in (v_active, v_done))
      || '/' || (select string_agg(mi.id::text || '@' || mi.ctid::text, ',' order by mi.id)
                   from public.menu_items mi where mi.branch_id = v_a1));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. Reorder (§2) ------------------------------------------------------------------------------
  begin
    select array_agg(id order by display_order desc, key desc) into v_ids
      from public.kitchen_stations where branch_id = v_a1;
    perform pg_temp.act_as(v_manager);
    perform public.reorder_kitchen_stations(v_a1, v_ids);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('reorder: the list follows the ids, in steps of ten', 'true true',
      ((select array_agg(id order by display_order) from public.kitchen_stations where branch_id = v_a1) = v_ids)::text || ' '
      || ((select array_agg(display_order order by display_order) from public.kitchen_stations where branch_id = v_a1)
            = (select array_agg(10 * g order by g) from generate_series(1, cardinality(v_ids)) as g))::text);
    perform pg_temp.expect('reorder: the same list again is fine', 'ok done',
      pg_temp.try_as(v_manager, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, %L::uuid[])', v_a1, v_ids)]));
    perform pg_temp.expect('reorder: a list missing a station is refused', 'ERR ids_mismatch',
      pg_temp.try_as(v_manager, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, %L::uuid[])', v_a1, v_ids[1:cardinality(v_ids) - 1])]));
    perform pg_temp.expect('reorder: one naming a station twice', 'ERR ids_mismatch',
      pg_temp.try_as(v_manager, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, %L::uuid[])', v_a1,
        v_ids[1:cardinality(v_ids) - 1] || v_ids[1])]));
    perform pg_temp.expect('reorder: one naming another branch''s station', 'ERR ids_mismatch',
      pg_temp.try_as(v_manager, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, %L::uuid[])', v_a1,
        v_ids[1:cardinality(v_ids) - 1] || (select id from public.kitchen_stations where branch_id = v_a2 limit 1))]));
    perform pg_temp.expect('reorder: no list at all', 'ERR ids_mismatch',
      pg_temp.try_as(v_manager, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, null)', v_a1)]));
    perform pg_temp.expect('reorder: the cashier and the kitchen are refused', 'ERR forbidden|ERR forbidden',
      pg_temp.try_as(v_cashier, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, %L::uuid[])', v_a1, v_ids)])
      || '|' || pg_temp.try_as(v_kitchen, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, %L::uuid[])', v_a1, v_ids)]));
    perform pg_temp.expect('reorder: anon cannot call it', 'ERR permission denied for function reorder_kitchen_stations',
      pg_temp.try_as(null, array[format(
        'select ''done'' from public.reorder_kitchen_stations(%L, %L::uuid[])', v_a1, v_ids)]));
  exception when others then
    perform pg_temp.expect('section 6 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 7. copy_branch_setup carries the stations, before the dishes (§2) ----------------------------
  begin
    perform pg_temp.act_as(v_owner);
    r := public.copy_branch_setup(v_a1, v_a2, true, false, false);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('copy: the target''s stations alone are not a menu; stations_copied counts the source''s',
      (select count(*)::text from public.kitchen_stations where branch_id = v_a1),
      r ->> 'stations_copied');
    perform pg_temp.expect('copy: the target''s list is the source''s, keys, names and order included',
      pg_temp.stations(v_a1), pg_temp.stations(v_a2));
    perform pg_temp.expect('copy: the target''s own station (unused: its menu was empty) is replaced', '0',
      (select count(*)::text from public.kitchen_stations where branch_id = v_a2 and key = v_prep2_key));
    perform pg_temp.expect('copy: every copied dish keeps its station', pg_temp.dishes(v_a1), pg_temp.dishes(v_a2));
    perform pg_temp.expect('copy: a target with dishes is still refused', 'ERR target_menu_not_empty',
      pg_temp.try_as(v_owner, array[format(
        'select public.copy_branch_setup(%L, %L, true, false, false)::text', v_a1, v_a2)]));
    perform pg_temp.act_as(v_owner);
    r := public.copy_branch_setup(v_a1, v_a2, false, false, false);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('copy: nothing ticked answers stations_copied 0', '0', r ->> 'stations_copied');
  exception when others then
    perform pg_temp.expect('section 7 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 8. broadcast_franchise_menu adds the stations its dishes use (§2) ----------------------------
  begin
    perform pg_temp.act_as(v_owner);
    r := public.broadcast_franchise_menu(v_a1, array[v_a3]);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('broadcast: its answer is as before (Mains added, five dishes, Mango already there)', '1 5 0',
      (r ->> 'inserted_categories') || ' ' || (r ->> 'inserted_items') || ' ' || (r ->> 'updated_items'));
    perform pg_temp.expect('broadcast: a station the target lacks is added by key and name, after the target''s own',
      v_grill_key || ':Charcoal Grill:80',
      (select key || ':' || name || ':' || display_order from public.kitchen_stations
        where branch_id = v_a3 and key = v_grill_key));
    perform pg_temp.expect('broadcast: one the target has by key keeps the target''s name and place', 'Fire:10',
      (select name || ':' || display_order from public.kitchen_stations where branch_id = v_a3 and key = 'hot'));
    perform pg_temp.expect('broadcast: one whose name the target uses under another key is not added; its dishes take the target''s',
      '0 ' || v_wok3_key,
      (select count(*)::text from public.kitchen_stations where branch_id = v_a3 and key = v_wok_key) || ' '
        || (select station from public.menu_items where branch_id = v_a3 and name = 'Stir Fry'));
    perform pg_temp.expect('broadcast: one only a dish the target already sells uses is not added', '0',
      (select count(*)::text from public.kitchen_stations where branch_id = v_a3 and key = v_pastry_key));
    perform pg_temp.expect('broadcast: the other dishes keep their keys',
      format('Grilled Fish:%1$s,Grilled Pork:%1$s,Plain Rice:-,Tom Yum:hot', v_grill_key),
      (select string_agg(name || ':' || coalesce(station, '-'), ',' order by name) from public.menu_items
        where branch_id = v_a3 and name in ('Grilled Fish', 'Grilled Pork', 'Plain Rice', 'Tom Yum')));
    perform pg_temp.expect('broadcast: the target''s own stations are left alone', 'Prep:70',
      (select name || ':' || display_order from public.kitchen_stations where id = v_prep3));
    v_before := pg_temp.stations(v_a3);
    perform pg_temp.act_as(v_owner);
    r := public.broadcast_franchise_menu(v_a1, array[v_a3]);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('broadcast: a second time adds nothing', '0 true',
      (r ->> 'inserted_items') || ' ' || (pg_temp.stations(v_a3) = v_before)::text);
  exception when others then
    perform pg_temp.expect('section 8 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 9. Delete, moving the dishes and what is on the open board (§2) ------------------------------
  begin
    perform pg_temp.expect('delete: the cashier and the kitchen are refused', 'ERR forbidden|ERR forbidden',
      pg_temp.try_as(v_cashier, array[format('select public.delete_kitchen_station(%L, ''hot'')::text', v_grill)])
      || '|' || pg_temp.try_as(v_kitchen, array[format('select public.delete_kitchen_station(%L, ''hot'')::text', v_grill)]));
    perform pg_temp.expect('delete: so is another restaurant''s owner', 'ERR forbidden',
      pg_temp.try_as(v_other, array[format('select public.delete_kitchen_station(%L, ''hot'')::text', v_grill)]));
    perform pg_temp.expect('delete: anon cannot call it', 'ERR permission denied for function delete_kitchen_station',
      pg_temp.try_as(null, array[format('select public.delete_kitchen_station(%L, ''hot'')::text', v_grill)]));
    perform pg_temp.expect('delete: an unknown station is named', 'ERR station_not_found',
      pg_temp.try_as(v_manager, array['select public.delete_kitchen_station(gen_random_uuid())::text']));
    perform pg_temp.expect('delete: the dishes cannot move to the station itself', 'ERR move_target_invalid',
      pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L, %L)::text', v_grill, v_grill_key)]));
    perform pg_temp.expect('delete: nor to a key the branch lacks', 'ERR move_target_invalid',
      pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L, ''nope'')::text', v_grill)]));
    perform pg_temp.expect('delete: nor to another branch''s station', 'ERR move_target_invalid',
      pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L, %L)::text', v_grill, v_wok3_key)]));
    -- A page that last saw the station unused sends neither a target nor p_clear.
    perform pg_temp.expect('delete: a station still on a dish is refused with neither a target nor p_clear',
      'ERR station_in_use|ERR station_in_use|ERR station_in_use',
      pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L)::text', v_wok)])
      || '|' || pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L, null, false)::text', v_wok)])
      || '|' || pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L, ''  '')::text', v_wok)]));
    perform pg_temp.expect('delete: the refusal comes after the permission check', 'ERR forbidden',
      pg_temp.try_as(v_cashier, array[format('select public.delete_kitchen_station(%L)::text', v_wok)]));
    perform pg_temp.expect('delete: p_clear changes nothing when there is a target: the dishes go there', 'ok 0 cold',
      pg_temp.try_as(v_manager, array[
        format('select public.delete_kitchen_station(%L, ''cold'', true)::text', v_wok),
        -- a1 only: section 7 copied a1's menu, keys included, into a2.
        format('select (select count(*) from public.menu_items where branch_id = %L and station = %L)::text || '' ''
                       || (select station from public.menu_items where id = %L)', v_a1, v_wok_key, v_stirfry)]));

    perform pg_temp.act_as(v_manager);
    v_n := public.delete_kitchen_station(v_grill, 'hot');
    perform pg_temp.act_as(null);
    perform pg_temp.expect('delete with move: answers how many dishes moved; the row is gone', '2 0',
      v_n || ' ' || (select count(*) from public.kitchen_stations where id = v_grill));
    perform pg_temp.expect('delete with move: the dishes are at the new station', 'hot hot',
      (select station from public.menu_items where id = v_fish) || ' ' || (select station from public.menu_items where id = v_pork));
    perform pg_temp.expect('delete with move: a line not made yet followed its dish', 'hot',
      (select station from public.order_items where id = v_l_pending));
    perform pg_temp.expect('delete with move: a line already made moved too', 'hot',
      (select station from public.order_items where id = v_l_ready));
    perform pg_temp.expect('delete with move: so did one made here before its dish moved on', 'hot',
      (select station from public.order_items where id = v_l_moved));
    perform pg_temp.expect('delete with move: a combo line already made: its entry moved', 'hot,hot',
      pg_temp.combo_stations(v_l_combo_ready));
    perform pg_temp.expect('delete with move: a combo line not made yet: its entry moved', 'hot,hot',
      pg_temp.combo_stations(v_l_combo_pending));
    perform pg_temp.expect('delete with move: a closed order keeps the old key, lines and combo entries',
      v_grill_key || ' ' || v_grill_key || ',hot',
      (select station from public.order_items where id = v_l_done) || ' ' || pg_temp.combo_stations(v_l_combo_done));
    perform pg_temp.expect('delete with move: lines at other stations stay', v_wok_key,
      (select station from public.order_items where id = v_l_wok));

    perform pg_temp.act_as(v_manager);
    v_n := public.delete_kitchen_station(v_wok, null, true);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('delete to no station (p_clear): the dish and its made line on the open board have none', '1 - -',
      v_n || ' ' || coalesce((select station from public.menu_items where id = v_stirfry), '-') || ' '
        || coalesce((select station from public.order_items where id = v_l_wok), '-'));
    perform pg_temp.act_as(v_manager);
    v_n := public.delete_kitchen_station(v_pastry, '  ', true);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('delete: a blank target with p_clear is no station', '1 -',
      v_n || ' ' || coalesce((select station from public.menu_items where id = v_mango), '-'));
    perform pg_temp.expect('delete: a station no dish uses goes without p_clear, answering 0', 'ok 0',
      pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L)::text', v_expo)]));
    perform pg_temp.expect('delete: p_clear on a station no dish uses is fine too', 'ok 0',
      pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L, null, true)::text', v_expo)]));
    perform pg_temp.expect('delete: a built-in may go too, its dishes moved', 'ok 3',
      pg_temp.try_as(v_manager, array[format('select public.delete_kitchen_station(%L, ''cold'')::text', v_hot)]));
  exception when others then
    perform pg_temp.expect('section 9 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 10. A combo line's entries take their dishes' stations at insert (migration header, 8) -------
  -- After section 9: Grilled Fish, Grilled Pork and Tom Yum are at hot; Stir Fry, Mango Sticky Rice
  -- and Plain Rice have none; grill, wok and pastry are gone.
  begin
    select id into v_a3_fish from public.menu_items where branch_id = v_a3 and name = 'Grilled Fish';
    -- As place-order builds it: stations read several round trips before the insert.
    insert into public.order_items (order_id, combo_id, item_name, unit_price, quantity, subtotal, prep_status, combo_contents)
    values (v_active, v_combo, 'Grill combo', 18, 1, 18, 'pending', jsonb_build_array(
              jsonb_build_object('menu_item_id', v_pork, 'name', 'Grilled Pork', 'quantity', 1, 'station', v_grill_key),
              jsonb_build_object('id', v_tomyum, 'station', 'cold'),
              jsonb_build_object('menu_item_id', v_stirfry, 'station', v_wok_key),
              jsonb_build_object('menu_item_id', v_rice),
              jsonb_build_object('menu_item_id', v_a3_fish, 'station', 'cold'),
              jsonb_build_object('menu_item_id', c_no_dish, 'station', 'st_00000000aa'),
              jsonb_build_object('menu_item_id', 'not-a-uuid', 'station', 'bar'),
              to_jsonb('extra rice'::text)))
    returning id into v_l_combo_new;
    v_expected := jsonb_build_array(
      jsonb_build_object('menu_item_id', v_pork, 'name', 'Grilled Pork', 'quantity', 1, 'station', 'hot'),
      jsonb_build_object('id', v_tomyum, 'station', 'hot'),
      jsonb_build_object('menu_item_id', v_stirfry, 'station', null),
      jsonb_build_object('menu_item_id', v_rice, 'station', null),
      jsonb_build_object('menu_item_id', v_a3_fish, 'station', 'cold'),
      jsonb_build_object('menu_item_id', c_no_dish, 'station', 'st_00000000aa'),
      jsonb_build_object('menu_item_id', 'not-a-uuid', 'station', 'bar'),
      to_jsonb('extra rice'::text));
    perform pg_temp.expect('insert: every combo entry takes its dish''s station now (menu_item_id or id), or none; another branch''s dish, an unknown one, a malformed id and a non-object keep theirs, in order',
      v_expected::text, (select combo_contents::text from public.order_items where id = v_l_combo_new));
    perform pg_temp.expect('insert: an empty snapshot stays empty', 'ok []',
      pg_temp.try_service(array[format(
        'insert into public.order_items (order_id, combo_id, item_name, unit_price, quantity, subtotal, combo_contents)
         values (%L, %L, ''Grill combo'', 18, 1, 18, ''[]'') returning combo_contents::text', v_active, v_combo)]));
    insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, combo_contents)
    values (v_active, v_pork, 'Grilled Pork', 10, 1, 10, jsonb_build_object('station', v_grill_key))
    returning id into v_l_object;
    perform pg_temp.expect('insert: contents that are not an array are left alone; the dish line still takes its dish''s station',
      jsonb_build_object('station', v_grill_key)::text || ' hot',
      (select combo_contents::text || ' ' || station from public.order_items where id = v_l_object));
  exception when others then
    perform pg_temp.expect('section 10 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 11. An order back on the board takes its dead keys off (migration header, 8) -----------------
  begin
    -- Staged on the closed order, as section 9 left it (a line and a combo entry still under the
    -- grill): a line under a station the branch still has though its dish moved on, a line under
    -- wok (gone) whose dish has no station now, a blank station, and a combo line whose entries
    -- name gone stations (written after its insert, which would restamp them).
    insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status, station)
    values (v_done, v_tomyum, 'Tom Yum', 8, 1, 8, 'served', 'cold') returning id into v_l_done_alive;
    insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status, station)
    values (v_done, v_stirfry, 'Stir Fry', 9, 1, 9, 'served', v_wok_key) returning id into v_l_done_wok;
    insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status, station)
    values (v_done, v_pork, 'Grilled Pork', 10, 1, 10, 'served', '') returning id into v_l_done_blank;
    insert into public.order_items (order_id, combo_id, item_name, unit_price, quantity, subtotal, prep_status, combo_contents)
    values (v_done, v_combo, 'Grill combo', 18, 1, 18, 'served', v_contents) returning id into v_l_combo_done2;
    update public.order_items
       set combo_contents = jsonb_build_array(
             jsonb_build_object('menu_item_id', v_pork, 'name', 'Grilled Pork', 'station', v_wok_key),
             jsonb_build_object('id', v_mango, 'station', v_pastry_key),
             jsonb_build_object('menu_item_id', c_no_dish, 'station', v_pastry_key),
             jsonb_build_object('menu_item_id', v_tomyum, 'station', 'cold'),
             jsonb_build_object('menu_item_id', v_rice, 'station', ''),
             to_jsonb('extra rice'::text))
     where id = v_l_combo_done2;

    -- What kitchen-view's Undo writes, as the kitchen: the definer trigger moves lines the kitchen
    -- itself may not write.
    perform pg_temp.expect('reopen: the kitchen''s Undo of a bump puts a line under a gone station on its dish''s', 'ok hot hot,hot',
      pg_temp.try_as(v_kitchen, array[
        format('update public.orders set status = ''ready'' where id = %L and status = ''completed'' returning id::text', v_done),
        format('select (select station from public.order_items where id = %1$L) || '' ''
                       || (select string_agg(coalesce(a.e ->> ''station'', ''-''), '','' order by a.i)
                             from public.order_items oi, jsonb_array_elements(oi.combo_contents) with ordinality as a(e, i)
                            where oi.id = %2$L)', v_l_done, v_l_combo_done)]));

    update public.orders set status = 'ready' where id = v_done;
    perform pg_temp.expect('reopen: a line under a gone station takes its dish''s', 'hot',
      (select station from public.order_items where id = v_l_done));
    perform pg_temp.expect('reopen: or none, when its dish has none now', '-',
      (select coalesce(station, '-') from public.order_items where id = v_l_done_wok));
    perform pg_temp.expect('reopen: a line under a station the branch still has keeps it, though its dish moved on', 'cold',
      (select station from public.order_items where id = v_l_done_alive));
    perform pg_temp.expect('reopen: a blank station is left as it is', '[]',
      (select '[' || station || ']' from public.order_items where id = v_l_done_blank));
    perform pg_temp.expect('reopen: a combo entry under a gone station takes its dish''s', 'hot,hot',
      pg_temp.combo_stations(v_l_combo_done));
    v_expected := jsonb_build_array(
      jsonb_build_object('menu_item_id', v_pork, 'name', 'Grilled Pork', 'station', 'hot'),
      jsonb_build_object('id', v_mango, 'station', null),
      jsonb_build_object('menu_item_id', c_no_dish, 'station', null),
      jsonb_build_object('menu_item_id', v_tomyum, 'station', 'cold'),
      jsonb_build_object('menu_item_id', v_rice, 'station', ''),
      to_jsonb('extra rice'::text));
    perform pg_temp.expect('reopen: combo entries under gone stations take their dish''s, or none; live and blank ones stay, in order',
      v_expected::text, (select combo_contents::text from public.order_items where id = v_l_combo_done2));

    -- The accepted race (migration header, 8): a line that reached an open order under a key
    -- deleted meanwhile. Moving between open statuses is not a reopen and rewrites nothing.
    insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal, prep_status, station)
    values (v_active, v_stirfry, 'Stir Fry', 9, 1, 9, 'pending', v_wok_key) returning id into v_l_race;
    update public.orders set status = 'ready' where id = v_active;
    perform pg_temp.expect('reopen: an order moving between open statuses is not rewritten', v_wok_key,
      (select station from public.order_items where id = v_l_race));
  exception when others then
    perform pg_temp.expect('section 11 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 12. A deleted branch takes its stations with it ---------------------------------------------
  begin
    -- a2 has the copied dishes naming its stations: NO ACTION waits for the cascade to remove both.
    perform pg_temp.expect('branch delete: its stations and dishes go with it', 'ok 0 0',
      pg_temp.try_service(array[
        format('delete from public.branches where id = %L returning 1', v_a2),
        format('select (select count(*) from public.kitchen_stations where branch_id = %1$L) || '' ''
                       || (select count(*) from public.menu_items where branch_id = %1$L)', v_a2)]));
  exception when others then
    perform pg_temp.expect('section 12 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 13. The functions ---------------------------------------------------------------------------
  perform pg_temp.expect('functions: delete and reorder run as postgres, search_path pinned, for authenticated and the service role only',
    'postgres true search_path=public, pg_temp true false true|postgres true search_path=public, pg_temp true false true',
    (select string_agg(pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
                         || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
                         || has_function_privilege('anon', p.oid, 'execute')::text || ' '
                         || has_function_privilege('service_role', p.oid, 'execute')::text,
                       '|' order by p.proname)
       from pg_proc p
      where p.oid in ('public.delete_kitchen_station(uuid,text,boolean)'::regprocedure,
                      'public.reorder_kitchen_stations(uuid,uuid[])'::regprocedure)));
  perform pg_temp.expect('functions: delete_kitchen_station has one signature, no 2-argument overload', '1',
    (select count(*)::text from pg_proc p
      where p.proname = 'delete_kitchen_station' and p.pronamespace = 'public'::regnamespace));
  perform pg_temp.expect('functions: the insert and reopen trigger functions run as postgres and no API role may call them',
    'postgres true search_path=public false false|postgres true search_path=public, pg_temp false false',
    (select string_agg(pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
                         || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
                         || has_function_privilege('anon', p.oid, 'execute')::text,
                       '|' order by p.proname)
       from pg_proc p
      where p.oid in ('public.order_items_set_station()'::regprocedure,
                      'private.tg_orders_reopened_station_keys()'::regprocedure)));
  perform pg_temp.expect('triggers: order lines still take their station at insert; a reopened order fires after its status changes',
    'order_items_default_station public.order_items_set_station()|CREATE TRIGGER orders_reopened_station_keys AFTER UPDATE OF status ON public.orders FOR EACH ROW WHEN %',
    (select t.tgname::text || ' ' || n.nspname::text || '.' || p.proname::text || '()'
       from pg_trigger t
       join pg_proc p on p.oid = t.tgfoid
       join pg_namespace n on n.oid = p.pronamespace
      where t.tgrelid = 'public.order_items'::regclass and t.tgname = 'order_items_default_station')
      || '|' || (select pg_get_triggerdef(oid) from pg_trigger
                  where tgrelid = 'public.orders'::regclass and tgname = 'orders_reopened_station_keys'));
  perform pg_temp.expect('functions: copy_branch_setup and broadcast_franchise_menu keep their owner, search_path and grants',
    'postgres true search_path=public, pg_temp true false true|postgres true search_path=public, pg_temp true false true',
    (select string_agg(pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
                         || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
                         || has_function_privilege('anon', p.oid, 'execute')::text || ' '
                         || has_function_privilege('service_role', p.oid, 'execute')::text,
                       '|' order by p.proname)
       from pg_proc p
      where p.oid in ('public.copy_branch_setup(uuid,uuid,boolean,boolean,boolean,boolean,boolean)'::regprocedure,
                      'public.broadcast_franchise_menu(uuid,uuid[])'::regprocedure)));
end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
