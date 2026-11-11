-- Duplicate keeps a dish's option groups (20261111100000_duplicate_menu_item_option_groups, the
-- owner's report of 2026-11-11). A rolled-back script, not a migration. Pins: duplicate_menu_item
-- giving the new dish the source's option groups at the same places (the very same library groups;
-- new copies of the groups the source owns, owned by the new dish, with the same source library
-- group, name, translations, rules and position, and the same options renumbered 0..n-1 in the
-- storefront's order); the source dish untouched, ids included; a dish with no groups; what is left
-- behind (a group of another branch, another dish's own group, a library group the source also
-- shows its own copy of, an own group the source no longer shows, a library origin that is no
-- longer in the library); a library group's later edit reaching both dishes while an edit to one
-- dish's own group never reaches the other; customize_item_modifier_group and
-- reset_item_modifier_group treating the new dish's groups as its own; who may duplicate and the
-- errors, as before; deleting either dish leaving the other's groups whole. Section 0 checks what
-- the migration left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/duplicate_menu_item_option_groups.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script
-- creates for itself (section 0 only reads).
--   pg_temp.try_as(role, uid, sqls[])  as `anon` (uid null), `authenticated` or `service_role`, in a
--                                      subtransaction that is always rolled back; reports
--                                      'ok <last value>' or 'ERR <sqlstate> <message>'.
--   pg_temp.try_sql(sqls[])            the same as the script itself with no JWT (a migration, the
--                                      SQL editor): only triggers and constraints apply. A statement
--                                      may set request.jwt.claim.sub to call an RPC as someone.
--   pg_temp.call_as(uid, sql)          with uid's JWT claims (the role stays the script's), KEPT when
--                                      it succeeds. Reports the same way; the claims are cleared
--                                      afterwards either way.
--   pg_temp.act_as(uid)                sets only the JWT claims, so auth.uid() is that person while
--                                      the statements that follow keep their effect. act_as(null)
--                                      clears them.
--
-- People (auth.users rows made here):
--   owner     restaurants.owner_user_id of A (manages every branch of A)
--   manager   manager at A's branch one only
--   cashier   cashier at branch one (manages nothing)
--   stranger  no membership anywhere
--
-- Restaurant A (zz-dmi-a-<s>): branch one (the menu under test) and two (a dish and a group).
-- Branch one's library groups: Spicy Level, Add-ons, Sauce. Dishes: Pad Thai {Add-ons at 0; Spicy
-- (Pad Thai), its copy of Spicy Level, at 1 (six options, two pairs tied on position); Sauce at 3;
-- Pad Extras, made in its editor, at 5}, Fried Rice {Spicy Level, Add-ons}, Plain Rice {none}.
-- Branch two: Two Noodles {Two Toppings}. modifier_options.price_delta is numeric(10,2), so a price
-- reads 0.50.
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

-- Run statements as the script's own database role with no JWT claims. Reports like try_as.
-- Always rolled back.
create or replace function pg_temp.try_sql(p_sqls text[])
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
    perform set_config('request.jwt.claims', '', true);
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

-- Run one statement with p_uid's JWT claims (the database role stays the script's) and KEEP what
-- it did when it succeeds. 'ok <value>' or 'ERR <sqlstate> <message>' (then nothing it did is
-- kept). The claims are cleared afterwards.
create or replace function pg_temp.call_as(p_uid uuid, p_sql text)
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
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
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

-- Who auth.uid() is for the statements that follow (null: nobody, no JWT). The database role
-- stays the script's.
create or replace function pg_temp.act_as(p_uid uuid)
returns void
language plpgsql
as $$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
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

create or replace function pg_temp.new_user(p_label text)
returns uuid
language plpgsql
as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v, 'duplicate-menu-item-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', false), '{}'::jsonb, now(), now());
  return v;
end $$;

-- Links p_group to p_item at p_order with the link trigger switched off, as only a migration or
-- the SQL editor could. Called inside try_sql, which rolls it back.
create or replace function pg_temp.link_unchecked(p_item uuid, p_group uuid, p_order integer)
returns text
language plpgsql
as $$
begin
  alter table public.menu_item_modifiers disable trigger trg_menu_item_modifiers_same_branch;
  insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (p_item, p_group, p_order);
  alter table public.menu_item_modifiers enable trigger trg_menu_item_modifiers_same_branch;
  return 'linked';
end $$;

-- A group's options as name:display_order:price_delta, in the storefront's order.
create or replace function pg_temp.options(p_group uuid)
returns text
language sql
as $$
  select coalesce(string_agg(o.name || ':' || o.display_order || ':' || o.price_delta, ','
                             order by o.display_order, o.created_at, o.id), '')
    from public.modifier_options o
   where o.group_id = p_group;
$$;

-- What a dish shows, as group:display_order:kind in its order. kind: library (no owner), copy
-- (the dish's own, with a source) or own (the dish's own, no source).
create or replace function pg_temp.links(p_item uuid)
returns text
language sql
as $$
  select coalesce(string_agg(g.name || ':' || l.display_order || ':'
                             || case when g.owner_menu_item_id is null then 'library'
                                     when g.source_group_id is not null then 'copy'
                                     else 'own' end,
                             ',' order by l.display_order, g.name), '')
    from public.menu_item_modifiers l
    join public.modifier_groups g on g.id = l.modifier_group_id
   where l.menu_item_id = p_item;
$$;

-- What the storefront lists on a dish: each group in the dish's order, with its active options in
-- theirs.
create or replace function pg_temp.storefront(p_item uuid)
returns text
language sql
as $$
  select coalesce(string_agg(g.name || '('
                             || coalesce((select string_agg(o.name, ',' order by o.display_order, o.created_at, o.id)
                                            from public.modifier_options o
                                           where o.group_id = g.id and o.is_active), '')
                             || ')', ' ' order by l.display_order, g.name), '')
    from public.menu_item_modifiers l
    join public.modifier_groups g on g.id = l.modifier_group_id
   where l.menu_item_id = p_item;
$$;

-- A branch's Modifier groups page: its library groups.
create or replace function pg_temp.library(p_branch uuid)
returns text
language sql
as $$
  select coalesce(string_agg(g.name, ',' order by g.display_order, g.name), '')
    from public.modifier_groups g
   where g.branch_id = p_branch and g.owner_menu_item_id is null;
$$;

-- Everything a dish shows, without ids: each group in the dish's order as
-- position:kind:name:translations:selection:required:min:max:the group's own position:the name of
-- its source, then its options in the storefront's order as name|translations|price|default|active
-- (not their positions: a copy numbers them 0..n-1).
create or replace function pg_temp.dish_shape(p_item uuid)
returns text
language sql
as $$
  select coalesce(string_agg(l.display_order || ':'
                             || case when g.owner_menu_item_id is null then 'library'
                                     when g.source_group_id is not null then 'copy'
                                     else 'own' end || ':'
                             || g.name || ':' || g.name_translations::text || ':' || g.selection_type || ':'
                             || g.is_required::text || ':' || g.min_select || ':' || coalesce(g.max_select::text, '-') || ':'
                             || g.display_order || ':' || coalesce(s.name, '-') || '('
                             || coalesce((select string_agg(o.name || '|' || o.name_translations::text || '|' || o.price_delta
                                                            || '|' || o.is_default::text || '|' || o.is_active::text,
                                                            ',' order by o.display_order, o.created_at, o.id)
                                            from public.modifier_options o
                                           where o.group_id = g.id), '')
                             || ')',
                             ' ; ' order by l.display_order, g.name), '')
    from public.menu_item_modifiers l
    join public.modifier_groups g on g.id = l.modifier_group_id
    left join public.modifier_groups s on s.id = g.source_group_id
   where l.menu_item_id = p_item;
$$;

-- A dish and everything of its option groups as stored, ids included: the dish's row, its links,
-- the groups it shows or owns, and their options.
create or replace function pg_temp.raw(p_item uuid)
returns text
language sql
as $$
  with groups as (
    select g.* from public.modifier_groups g
     where g.owner_menu_item_id = p_item
        or g.id in (select l.modifier_group_id from public.menu_item_modifiers l where l.menu_item_id = p_item)
  )
  select coalesce((select to_jsonb(mi)::text from public.menu_items mi where mi.id = p_item), '-') || ' # '
      || coalesce((select string_agg(to_jsonb(l)::text, ',' order by l.modifier_group_id)
                     from public.menu_item_modifiers l where l.menu_item_id = p_item), '') || ' # '
      || coalesce((select string_agg(to_jsonb(g)::text, ',' order by g.id) from groups g), '') || ' # '
      || coalesce((select string_agg(to_jsonb(o)::text, ',' order by o.id)
                     from public.modifier_options o where o.group_id in (select g.id from groups g)), '');
$$;

do $test$
declare
  v_owner    uuid := pg_temp.new_user('owner');
  v_manager  uuid := pg_temp.new_user('manager');
  v_cashier  uuid := pg_temp.new_user('cashier');
  v_stranger uuid := pg_temp.new_user('stranger');
  v_sfx text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_t timestamptz := now() - interval '1 hour';
  v_ra uuid; v_a1 uuid; v_a2 uuid;
  v_cat uuid; v_cat2 uuid;
  v_pad uuid; v_rice uuid; v_plain uuid; v_two uuid;
  v_spicy uuid; v_addons uuid; v_sauce uuid; v_two_group uuid; v_pad_spicy uuid; v_extras uuid;
  -- Medium and Mild share a position and a created_at, so their ids decide: v_lo first.
  v_lo uuid; v_hi uuid;
  v_copy uuid; v_copy_spicy uuid; v_copy_extras uuid; v_plain_copy uuid; v_two_copy uuid;
  v_raw text;
  v_groups int; v_options int; v_dishes int;
  v_answer text;
  c_dup       constant text := 'select public.duplicate_menu_item(%L)::text';
  -- Duplicates p_item as the owner inside try_sql and keeps the new dish's id in dup.new for the
  -- statements after it.
  c_dup_owner constant text := 'select set_config(''dup.new'', public.duplicate_menu_item(%L)::text, true)';
  c_sub       constant text := 'select set_config(''request.jwt.claim.sub'', %L, true)';
  c_new       constant text := 'current_setting(''dup.new'')::uuid';
  c_no_auth   constant text := 'ERR P0001 not_authorized';
  c_elsewhere constant text := 'ERR 23514 modifier_group_owned_elsewhere';
  -- Pad Thai's links as the fixture writes them.
  c_pad_links constant text := 'Add-ons:0:library,Spicy (Pad Thai):1:copy,Sauce:3:library,Pad Extras:5:own';
  -- Pad Thai's copy of Spicy Level, its options as the fixture writes them, in the storefront's
  -- order.
  c_pad_spicy constant text := 'Not Spicy:0:0.00,Medium:2:0.25,Mild:2:0.00,Extra Hot:7:0.75,Hot:7:0.50,Thai Hot:9:1.00';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('duplicate_menu_item: postgres, SECURITY DEFINER, search_path pinned, returns uuid; authenticated and service_role may call it, anon and PUBLIC may not (as before)',
    'duplicate_menu_item(uuid) postgres true search_path=public, pg_temp uuid true true false false',
    (select p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
            || array_to_string(p.proconfig, ',') || ' ' || format_type(p.prorettype, null) || ' '
            || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
            || has_function_privilege('service_role', p.oid, 'execute')::text || ' '
            || has_function_privilege('anon', p.oid, 'execute')::text || ' '
            || (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text
       from pg_proc p
      where p.oid = 'public.duplicate_menu_item(uuid)'::regprocedure));
  perform pg_temp.expect('duplicate_menu_item: one signature, (p_item_id uuid)', 'p_item_id uuid',
    (select string_agg(pg_get_function_arguments(p.oid), '|')
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'duplicate_menu_item'));
  perform pg_temp.expect('duplicate_menu_item: the live checks and the dish''s copy are kept; the groups, their options and the links are written after the dish',
    'true|true',
    (select (p.prosrc like '%if v_uid is null then raise exception ''auth_required''; end if;%'
                           || 'if not found then raise exception ''item_not_found''; end if;%'
                           || 'if not private.user_manages_branch(v_src.branch_id) then raise exception ''not_authorized''; end if;%'
                           || 'v_src.name || '' (Copy)''%false, null, v_src.low_stock_threshold%v_src.display_order + 1%')::text
            || '|' || (p.prosrc like '%returning id into v_new_id;%insert into public.modifier_groups%'
                                     || 'insert into public.modifier_options%insert into public.menu_item_modifiers%')::text
       from pg_proc p
      where p.oid = 'public.duplicate_menu_item(uuid)'::regprocedure));

  -- Fixture: restaurant A on its trial with two branches; a manager and a cashier at branch one.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-dmi-a-' || v_sfx, 'ZZ Duplicate Menu Item A') returning id into v_ra;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'one', 'A One') returning id into v_a1;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'two', 'A Two') returning id into v_a2;
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_manager, v_ra, v_a1, 'manager', 'active'), (v_cashier, v_ra, v_a1, 'cashier', 'active');

  insert into public.menu_categories (branch_id, name, display_order) values (v_a1, 'Mains', 1) returning id into v_cat;
  insert into public.menu_items (branch_id, category_id, name, price, display_order)
  values (v_a1, v_cat, 'Pad Thai', 12, 4) returning id into v_pad;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a1, v_cat, 'Fried Rice', 10) returning id into v_rice;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a1, v_cat, 'Plain Rice', 3) returning id into v_plain;
  insert into public.menu_categories (branch_id, name, display_order) values (v_a2, 'Mains', 1) returning id into v_cat2;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a2, v_cat2, 'Two Noodles', 11) returning id into v_two;

  insert into public.modifier_groups (branch_id, name, name_translations, selection_type, is_required, min_select, max_select, display_order)
  values (v_a1, 'Spicy Level', '{"th": "ระดับความเผ็ด"}', 'single', true, 1, 1, 0) returning id into v_spicy;
  insert into public.modifier_groups (branch_id, name, selection_type, is_required, min_select, max_select, display_order)
  values (v_a1, 'Add-ons', 'multiple', false, 0, null, 1) returning id into v_addons;
  insert into public.modifier_groups (branch_id, name, selection_type, is_required, min_select, max_select, display_order)
  values (v_a1, 'Sauce', 'single', false, 0, 1, 2) returning id into v_sauce;
  insert into public.modifier_groups (branch_id, name, selection_type, is_required, min_select, max_select, display_order)
  values (v_a2, 'Two Toppings', 'multiple', false, 0, null, 0) returning id into v_two_group;
  insert into public.modifier_options (group_id, name, price_delta, display_order)
  values (v_spicy, 'Not Spicy', 0, 0), (v_spicy, 'Mild', 0, 1), (v_spicy, 'Hot', 0.50, 2),
         (v_addons, 'Egg', 1.00, 0), (v_addons, 'Shrimp', 2.50, 1),
         (v_sauce, 'Fish Sauce', 0, 0), (v_sauce, 'Soy Sauce', 0, 1),
         (v_two_group, 'Cheese', 1.50, 0);

  -- Pad Thai's own groups: its copy of Spicy Level (the dish's editor changed it: options added,
  -- repriced, two pairs left on one position) and Pad Extras, made in its editor.
  insert into public.modifier_groups (branch_id, name, name_translations, selection_type, is_required, min_select, max_select,
                                      display_order, owner_menu_item_id, source_group_id)
  values (v_a1, 'Spicy (Pad Thai)', '{"th": "ระดับความเผ็ด"}', 'single', true, 1, 1, 0, v_pad, v_spicy)
  returning id into v_pad_spicy;
  v_lo := (left(gen_random_uuid()::text, 35) || '0')::uuid;
  v_hi := (left(v_lo::text, 35) || 'f')::uuid;
  insert into public.modifier_options (id, group_id, name, name_translations, price_delta, is_default, is_active, display_order, created_at)
  values (gen_random_uuid(), v_pad_spicy, 'Not Spicy', '{"th": "ไม่เผ็ด"}', 0, true, true, 0, v_t),
         (v_hi, v_pad_spicy, 'Mild', '{}', 0, false, true, 2, v_t),
         (v_lo, v_pad_spicy, 'Medium', '{}', 0.25, false, true, 2, v_t),
         (gen_random_uuid(), v_pad_spicy, 'Hot', '{}', 0.50, false, true, 7, v_t + interval '1 second'),
         (gen_random_uuid(), v_pad_spicy, 'Extra Hot', '{}', 0.75, false, true, 7, v_t),
         (gen_random_uuid(), v_pad_spicy, 'Thai Hot', '{}', 1.00, false, false, 9, v_t);
  insert into public.modifier_groups (branch_id, name, selection_type, is_required, min_select, max_select, display_order,
                                      owner_menu_item_id)
  values (v_a1, 'Pad Extras', 'multiple', false, 0, 2, 3, v_pad) returning id into v_extras;
  insert into public.modifier_options (group_id, name, price_delta, display_order)
  values (v_extras, 'Peanuts', 0.50, 0), (v_extras, 'Lime', 0, 1);

  insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order)
  values (v_pad, v_addons, 0), (v_pad, v_pad_spicy, 1), (v_pad, v_sauce, 3), (v_pad, v_extras, 5),
         (v_rice, v_spicy, 0), (v_rice, v_addons, 1),
         (v_two, v_two_group, 0);

  perform pg_temp.expect('fixture: the library page lists Spicy Level, Add-ons and Sauce; Pad Thai shows two of them and two of its own',
    'Spicy Level,Add-ons,Sauce|' || c_pad_links || '|' || c_pad_spicy,
    pg_temp.library(v_a1) || '|' || pg_temp.links(v_pad) || '|' || pg_temp.options(v_pad_spicy));

  -- 1. Duplicate Pad Thai. Starts: the fixture. ---------------------------------------------------
  begin
    v_raw := pg_temp.raw(v_pad);
    select count(*) into v_groups from public.modifier_groups where branch_id = v_a1;
    select count(*) into v_options from public.modifier_options o join public.modifier_groups g on g.id = o.group_id
     where g.branch_id = v_a1;
    perform pg_temp.act_as(v_manager);
    v_copy := public.duplicate_menu_item(v_pad);
    perform pg_temp.act_as(null);
    select g.id into v_copy_spicy from public.modifier_groups g where g.owner_menu_item_id = v_copy and g.name = 'Spicy (Pad Thai)';
    select g.id into v_copy_extras from public.modifier_groups g where g.owner_menu_item_id = v_copy and g.name = 'Pad Extras';

    perform pg_temp.expect('duplicate: the dish is copied as before: a new dish "Pad Thai (Copy)" on branch one, hidden, untracked, one place further down',
      'true|true|Pad Thai (Copy)|false|false|5|true',
      (select (mi.id <> v_pad)::text || '|' || (mi.branch_id = v_a1)::text || '|' || mi.name || '|' || mi.is_active::text
                || '|' || mi.track_stock::text || '|' || mi.display_order || '|' || (mi.category_id = v_cat)::text
         from public.menu_items mi where mi.id = v_copy));
    perform pg_temp.expect('duplicate: the new dish shows the same groups at the same places, the library ones as library groups and Pad Thai''s own as its own',
      c_pad_links || '|' || c_pad_links, pg_temp.links(v_copy) || '|' || pg_temp.links(v_pad));
    perform pg_temp.expect('duplicate: the library groups it shows are the very rows Pad Thai shows (Add-ons, Sauce), not copies',
      v_addons || ',' || v_sauce,
      (select string_agg(g.id::text, ',' order by l.display_order)
         from public.menu_item_modifiers l join public.modifier_groups g on g.id = l.modifier_group_id
        where l.menu_item_id = v_copy and g.owner_menu_item_id is null));
    perform pg_temp.expect('duplicate: Pad Thai''s two own groups are copied as two new groups owned by the new dish on branch one; the copy of Spicy Level keeps Spicy Level as its source, Pad Extras none',
      '2|2|true|true|Pad Extras<--,Spicy (Pad Thai)<-Spicy Level|true',
      (select count(*)::text || '|'
                || (select count(*) from public.modifier_groups x where x.owner_menu_item_id = v_copy)::text || '|'
                || bool_and(g.id not in (v_pad_spicy, v_extras))::text || '|' || bool_and(g.branch_id = v_a1)::text || '|'
                || string_agg(g.name || '<-' || coalesce(s.name, '-'), ',' order by g.name) || '|'
                || (select (x.source_group_id = v_spicy)::text from public.modifier_groups x where x.id = v_copy_spicy)
         from public.menu_item_modifiers l
         join public.modifier_groups g on g.id = l.modifier_group_id
         left join public.modifier_groups s on s.id = g.source_group_id
        where l.menu_item_id = v_copy and g.owner_menu_item_id is not null));
    perform pg_temp.expect('duplicate: every group the new dish shows has the source''s name, translations, rules, position and source, with the same options (name, translations, price, default, active) in the same order',
      pg_temp.dish_shape(v_pad), pg_temp.dish_shape(v_copy));
    perform pg_temp.expect('duplicate: the copy of Spicy (Pad Thai) lists its six options in the storefront''s order (position, then created_at, then id), numbered 0..5',
      'Not Spicy:0:0.00:true:true:{"th": "ไม่เผ็ด"},Medium:1:0.25:false:true:{},Mild:2:0.00:false:true:{},Extra Hot:3:0.75:false:true:{},Hot:4:0.50:false:true:{},Thai Hot:5:1.00:false:false:{}'
      || '|Peanuts:0:0.50,Lime:1:0.00',
      (select string_agg(o.name || ':' || o.display_order || ':' || o.price_delta || ':' || o.is_default || ':' || o.is_active || ':'
                         || o.name_translations::text, ',' order by o.display_order)
         from public.modifier_options o where o.group_id = v_copy_spicy)
      || '|' || pg_temp.options(v_copy_extras));
    perform pg_temp.expect('duplicate: the storefront lists the same groups and options on both dishes',
      'Add-ons(Egg,Shrimp) Spicy (Pad Thai)(Not Spicy,Medium,Mild,Extra Hot,Hot) Sauce(Fish Sauce,Soy Sauce) Pad Extras(Peanuts,Lime)|same',
      pg_temp.storefront(v_pad) || '|'
        || case when pg_temp.storefront(v_copy) = pg_temp.storefront(v_pad) then 'same' else pg_temp.storefront(v_copy) end);
    perform pg_temp.expect('duplicate: Pad Thai is untouched: its row, links, groups and options, ids included, are exactly as before',
      'same', case when pg_temp.raw(v_pad) = v_raw then 'same' else pg_temp.raw(v_pad) end);
    perform pg_temp.expect('duplicate: branch one gained exactly the two groups and their eight options; the library page still lists only Spicy Level, Add-ons and Sauce',
      (v_groups + 2) || '|' || (v_options + 8) || '|Spicy Level,Add-ons,Sauce',
      (select count(*)::text from public.modifier_groups where branch_id = v_a1) || '|'
        || (select count(*)::text from public.modifier_options o join public.modifier_groups g on g.id = o.group_id
             where g.branch_id = v_a1) || '|' || pg_temp.library(v_a1));
    perform pg_temp.expect('duplicate: the Modifier groups page now counts two dishes with their own copy of Spicy Level', '2',
      (select count(*)::text from public.modifier_groups where source_group_id = v_spicy));
    perform pg_temp.expect('duplicate: each dish''s own groups are its own: Pad Thai may not show the new dish''s, nor the new dish Pad Thai''s',
      c_elsewhere || '|' || c_elsewhere || '|' || c_elsewhere,
      pg_temp.try_sql(array[format(
        'insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (%L, %L, 9) returning display_order',
        v_pad, v_copy_spicy)]) || '|'
        || pg_temp.try_sql(array[format(
        'insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (%L, %L, 9) returning display_order',
        v_copy, v_extras)]) || '|'
        || pg_temp.try_sql(array[format(
        'insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (%L, %L, 9) returning display_order',
        v_copy, v_spicy)]));
  exception when others then
    perform pg_temp.act_as(null);
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. A dish with no groups. Starts: Plain Rice shows nothing. ----------------------------------
  begin
    select count(*) into v_groups from public.modifier_groups where branch_id = v_a1;
    v_answer := pg_temp.call_as(v_manager, format(c_dup, v_plain));
    v_plain_copy := case when v_answer like 'ok %' then substr(v_answer, 4)::uuid end;
    perform pg_temp.expect('no groups: the copy is made as before and shows nothing; no group is made',
      'Plain Rice (Copy)||0|' || v_groups,
      (select mi.name from public.menu_items mi where mi.id = v_plain_copy) || '|' || pg_temp.links(v_plain_copy) || '|'
        || (select count(*)::text from public.modifier_groups where owner_menu_item_id = v_plain_copy) || '|'
        || (select count(*)::text from public.modifier_groups where branch_id = v_a1));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. What is left behind, each rolled back. Starts: Pad Thai as the fixture wrote it; Fried Rice
  --    {Spicy Level, Add-ons}. -----------------------------------------------------------------------
  begin
    perform pg_temp.expect('left behind: a copy whose library group was since made a dish''s own goes over with no source (as copy_branch_setup)',
      'ok Add-ons:0:library,Spicy (Pad Thai):1:own,Sauce:3:library,Pad Extras:5:own|-|' || v_spicy,
      pg_temp.try_sql(array[
        format('update public.modifier_groups set owner_menu_item_id = %L where id = %L returning name', v_rice, v_spicy),
        format(c_sub, v_owner),
        format(c_dup_owner, v_pad),
        format('select pg_temp.links(%s) || ''|'' || (select coalesce(g.source_group_id::text, ''-'') from public.modifier_groups g where g.owner_menu_item_id = %s and g.name = ''Spicy (Pad Thai)'') || ''|'' || (select source_group_id::text from public.modifier_groups where id = %L)',
               c_new, c_new, v_pad_spicy)]));
    perform pg_temp.expect('left behind: a library group Pad Thai also shows its own copy of (link trigger off): the new dish shows only the copy',
      'ok ' || c_pad_links || ',Spicy Level:7:library => ' || c_pad_links,
      pg_temp.try_sql(array[
        format('select pg_temp.link_unchecked(%L, %L, 7)', v_pad, v_spicy),
        format(c_sub, v_owner),
        format(c_dup_owner, v_pad),
        format('select pg_temp.links(%L) || '' => '' || pg_temp.links(%s)', v_pad, c_new)]));
    perform pg_temp.expect('left behind: another branch''s group and another dish''s own group on Pad Thai (link trigger off) are not copied, nor shown on the new dish',
      'ok ' || c_pad_links || ',Two Toppings:8:library,Rice Only:9:own => ' || c_pad_links || '|2',
      pg_temp.try_sql(array[
        format('insert into public.modifier_groups (branch_id, name, selection_type, owner_menu_item_id) values (%L, ''Rice Only'', ''single'', %L) returning name',
               v_a1, v_rice),
        format('select pg_temp.link_unchecked(%L, %L, 8)', v_pad, v_two_group),
        format('select pg_temp.link_unchecked(%L, (select g.id from public.modifier_groups g where g.branch_id = %L and g.name = ''Rice Only''), 9)',
               v_pad, v_a1),
        format(c_sub, v_owner),
        format(c_dup_owner, v_pad),
        format('select pg_temp.links(%L) || '' => '' || pg_temp.links(%s) || ''|'' || (select count(*) from public.modifier_groups where owner_menu_item_id = %s)',
               v_pad, c_new, c_new)]));
    perform pg_temp.expect('left behind: a group Pad Thai owns but no longer shows is not copied',
      'ok Add-ons:0:library,Spicy (Pad Thai):1:copy,Sauce:3:library|1',
      pg_temp.try_sql(array[
        format('delete from public.menu_item_modifiers where menu_item_id = %L and modifier_group_id = %L returning display_order', v_pad, v_extras),
        format(c_sub, v_owner),
        format(c_dup_owner, v_pad),
        format('select pg_temp.links(%s) || ''|'' || (select count(*) from public.modifier_groups where owner_menu_item_id = %s)',
               c_new, c_new)]));
    perform pg_temp.expect('left behind: (nothing of that was kept: Pad Thai, Fried Rice and Spicy Level as they were)',
      c_pad_links || '|Spicy Level:0:library,Add-ons:1:library|-',
      pg_temp.links(v_pad) || '|' || pg_temp.links(v_rice) || '|'
        || (select coalesce(owner_menu_item_id::text, '-') from public.modifier_groups where id = v_spicy));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. Edits after the copy. Starts: Pad Thai and Pad Thai (Copy) as section 1 left them. ----------
  begin
    -- Kept: the library group Add-ons renamed and given a third option.
    update public.modifier_groups set name = 'Extras' where id = v_addons;
    insert into public.modifier_options (group_id, name, price_delta, display_order) values (v_addons, 'Tofu', 1.25, 2);
    -- Kept: the new dish's copy of Spicy renamed, Hot deleted from it, Mild repriced there.
    update public.modifier_groups set name = 'Spicy (Copy)' where id = v_copy_spicy;
    delete from public.modifier_options where group_id = v_copy_spicy and name = 'Hot';
    update public.modifier_options set price_delta = 0.10 where group_id = v_copy_spicy and name = 'Mild';
    -- Kept: Pad Thai's own Pad Extras given a third option.
    insert into public.modifier_options (group_id, name, price_delta, display_order) values (v_extras, 'Cashews', 1.00, 2);

    perform pg_temp.expect('edit the library group: both dishes list it as edited',
      'Extras(Egg,Shrimp,Tofu) Spicy (Pad Thai)(Not Spicy,Medium,Mild,Extra Hot,Hot) Sauce(Fish Sauce,Soy Sauce) Pad Extras(Peanuts,Lime,Cashews)'
      || ' / Extras(Egg,Shrimp,Tofu) Spicy (Copy)(Not Spicy,Medium,Mild,Extra Hot) Sauce(Fish Sauce,Soy Sauce) Pad Extras(Peanuts,Lime)',
      pg_temp.storefront(v_pad) || ' / ' || pg_temp.storefront(v_copy));
    perform pg_temp.expect('edit the new dish''s own group: Pad Thai''s keeps its name and its six options',
      'Spicy (Pad Thai)|' || c_pad_spicy,
      (select name from public.modifier_groups where id = v_pad_spicy) || '|' || pg_temp.options(v_pad_spicy));
    perform pg_temp.expect('edit Pad Thai''s own group: the new dish''s keeps its two options',
      'Peanuts:0:0.50,Lime:1:0.00|Peanuts:0:0.50,Lime:1:0.00,Cashews:2:1.00',
      pg_temp.options(v_copy_extras) || '|' || pg_temp.options(v_extras));
    perform pg_temp.expect('the dish''s editor: customize on the new dish''s own copy answers copied = false with Spicy Level as its source (the change goes straight to it)',
      'ok false|' || v_spicy || '|true',
      pg_temp.try_as('authenticated', v_manager, array[format(
        'select (x ->> ''copied'') || ''|'' || (x ->> ''source_group_id'') || ''|'' || ((x ->> ''group_id'') = %L)::text from public.customize_item_modifier_group(%L, %L) x',
        v_copy_spicy, v_copy, v_copy_spicy)]));

    v_answer := pg_temp.call_as(v_manager, format('select public.reset_item_modifier_group(%L, %L)::text', v_copy, v_copy_spicy));
    perform pg_temp.expect('"Use the library version" on the new dish: it shows Spicy Level where its copy was, the copy is gone; Pad Thai keeps its own copy',
      'ok {"group_id": "' || v_spicy || '"}|Extras:0:library,Spicy Level:1:library,Sauce:3:library,Pad Extras:5:own|0|'
      || 'Extras:0:library,Spicy (Pad Thai):1:copy,Sauce:3:library,Pad Extras:5:own',
      v_answer || '|' || pg_temp.links(v_copy) || '|'
        || (select count(*)::text from public.modifier_groups where id = v_copy_spicy) || '|' || pg_temp.links(v_pad));
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. Who may duplicate, and the errors, as before. Starts: Pad Thai {Extras, Spicy (Pad Thai),
  --    Sauce, Pad Extras}; Two Noodles (branch two) {Two Toppings}. ------------------------------------
  begin
    select count(*) into v_dishes from public.menu_items where branch_id in (v_a1, v_a2);
    select count(*) into v_groups from public.modifier_groups where branch_id in (v_a1, v_a2);
    perform pg_temp.expect('who: anon may not call it; a token without a user, or the service role, must sign in',
      'ERR 42501 permission denied for function duplicate_menu_item|ERR P0001 auth_required|ERR P0001 auth_required',
      pg_temp.try_as('anon', null, array[format(c_dup, v_pad)]) || '|'
        || pg_temp.try_as('authenticated', null, array[format(c_dup, v_pad)]) || '|'
        || pg_temp.try_as('service_role', null, array[format(c_dup, v_pad)]));
    perform pg_temp.expect('who: the cashier, a stranger, and branch one''s manager on branch two may not',
      c_no_auth || '|' || c_no_auth || '|' || c_no_auth,
      pg_temp.call_as(v_cashier, format(c_dup, v_pad)) || '|'
        || pg_temp.call_as(v_stranger, format(c_dup, v_pad)) || '|'
        || pg_temp.call_as(v_manager, format(c_dup, v_two)));
    perform pg_temp.expect('who: an unknown dish is item_not_found', 'ERR P0001 item_not_found',
      pg_temp.call_as(v_manager, format(c_dup, gen_random_uuid())));
    perform pg_temp.expect('who: the refused calls made no dish and no group', v_dishes || '|' || v_groups,
      (select count(*)::text from public.menu_items where branch_id in (v_a1, v_a2)) || '|'
        || (select count(*)::text from public.modifier_groups where branch_id in (v_a1, v_a2)));
    v_answer := pg_temp.call_as(v_owner, format(c_dup, v_two));
    v_two_copy := case when v_answer like 'ok %' then substr(v_answer, 4)::uuid end;
    perform pg_temp.expect('who: the restaurant owner may, on any of its branches; Two Noodles (Copy) shows Two Toppings too',
      'true|Two Noodles (Copy)|Two Toppings:0:library',
      (v_two_copy is not null)::text || '|' || (select name from public.menu_items where id = v_two_copy) || '|'
        || pg_temp.links(v_two_copy));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. Deleting either dish. Starts: Pad Thai {Extras, Spicy (Pad Thai), Sauce, Pad Extras (+
  --    Cashews)}; Pad Thai (Copy) {Extras, Spicy Level, Sauce, Pad Extras (its own)}. -----------------
  begin
    perform pg_temp.expect('delete Pad Thai (rolled back): its own groups go, the new dish keeps all of its groups and options',
      'ok 0|Extras:0:library,Spicy Level:1:library,Sauce:3:library,Pad Extras:5:own|Peanuts:0:0.50,Lime:1:0.00',
      pg_temp.try_sql(array[
        format('delete from public.menu_items where id = %L returning name', v_pad),
        format('select (select count(*) from public.modifier_groups where id in (%L, %L)) || ''|'' || pg_temp.links(%L) || ''|'' || pg_temp.options(%L)',
               v_pad_spicy, v_extras, v_copy, v_copy_extras)]));

    delete from public.menu_items where id = v_copy;
    perform pg_temp.expect('delete the new dish: its own group and options go with it; Pad Thai and the library are untouched',
      '0|0|Extras:0:library,Spicy (Pad Thai):1:copy,Sauce:3:library,Pad Extras:5:own|Peanuts:0:0.50,Lime:1:0.00,Cashews:2:1.00|Spicy Level,Extras,Sauce',
      (select count(*)::text from public.modifier_groups where owner_menu_item_id = v_copy or id = v_copy_extras) || '|'
        || (select count(*)::text from public.modifier_options where group_id = v_copy_extras) || '|'
        || pg_temp.links(v_pad) || '|' || pg_temp.options(v_extras) || '|' || pg_temp.library(v_a1));
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
