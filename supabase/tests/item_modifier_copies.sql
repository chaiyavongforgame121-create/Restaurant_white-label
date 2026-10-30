-- A dish's own option groups (20261030100000_item_modifier_copies, the owner's request of
-- 2026-10-30). A rolled-back script, not a migration. Pins: customize_item_modifier_group copying a
-- library group the first time a dish's editor changes it (the group, its options renumbered in the
-- storefront's order, the dish's link moved to the copy at the same position, the option map it
-- answers) and a second call on the copy changing nothing; edits to the copy never reaching the
-- library group or another dish, and library edits never reaching the copy;
-- reset_item_modifier_group putting the library group back where the copy was and deleting the
-- copy, and refusing anything that is not a copy the dish owns or whose library group is gone; a
-- deleted library group leaving its copies on their dishes with no source; a deleted dish taking
-- its own groups with it; every integrity error (a dish's own group on another dish, by link or by
-- owner; a library group on a dish that shows its own copy of it; an owner from another branch; a
-- source that is not a library group of the branch, or the group itself; a source without an
-- owner); both RPCs' errors and grants; copy_branch_setup pointing the copied groups at the
-- target's dishes and groups, and a copy whose library group was since made a dish's own at none;
-- a branch delete taking all of it. Section 0 checks what the migration left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/item_modifier_copies.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script
-- creates for itself (section 0 only reads).
--   pg_temp.try_as(role, uid, sqls[])  as `anon` (uid null) or `authenticated`, in a subtransaction
--                                      that is always rolled back; reports 'ok <last value>' or
--                                      'ERR <sqlstate> <message>'.
--   pg_temp.try_sql(sqls[])            the same as the script itself with no JWT (a migration, the
--                                      SQL editor): only triggers and constraints apply.
--   pg_temp.call_as(uid, sql)          with uid's JWT claims (the role stays the script's), KEPT when
--                                      it succeeds. Reports the same way; the claims are cleared
--                                      afterwards either way.
--   pg_temp.act_as(uid)                sets only the JWT claims, so auth.uid() is that person while
--                                      the statements that follow keep their effect. act_as(null)
--                                      clears them.
--
-- People (auth.users rows made here):
--   owner     restaurants.owner_user_id of A (menu.manage at every branch of A)
--   manager   manager at A's branch one only (menu.manage there, nowhere else)
--   cashier   cashier at branch one (no menu.manage)
--   stranger  no membership anywhere
--
-- Restaurant A (zz-imc-a-<s>): branch one (the menu under test), two (another branch: a dish and a
-- group), three (copy_branch_setup's empty target, deleted at the end).
-- Branch one's library groups: Spicy Level (six options, two pairs tied on position), Add-ons,
-- Sauce. Dishes: Pad Thai (Spicy Level, Add-ons, and Pad Extras made in its editor), Fried Rice
-- (Spicy Level), Green Curry (Add-ons, Sauce), Tom Yum (Sauce, Add-ons).
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
  values (v, 'item-modifier-copies-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', false), '{}'::jsonb, now(), now());
  return v;
end $$;

-- Links p_group to p_item with the link trigger switched off, as only a migration or the SQL
-- editor could. Called inside try_sql, which rolls it back.
create or replace function pg_temp.link_unchecked(p_item uuid, p_group uuid)
returns text
language plpgsql
as $$
begin
  alter table public.menu_item_modifiers disable trigger trg_menu_item_modifiers_same_branch;
  insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (p_item, p_group, 9);
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

-- Every group of a branch as owner dish/name/source/options, '-' for none. An owner or a source
-- outside the branch, or a source that is not a library group, reads '-' too. Options by position
-- and name: copy_branch_setup gives the copied options a new created_at, so two at one position
-- may change places.
create or replace function pg_temp.shape(p_branch uuid)
returns text
language sql
as $$
  select coalesce(string_agg(coalesce(d.name, '-') || '/' || g.name || '/' || coalesce(s.name, '-') || '/'
                             || coalesce((select string_agg(o.name || ':' || o.display_order || ':' || o.price_delta, ','
                                                            order by o.display_order, o.name)
                                            from public.modifier_options o
                                           where o.group_id = g.id), ''),
                             '; ' order by coalesce(d.name, ''), g.name, coalesce(s.name, '')), '')
    from public.modifier_groups g
    left join public.menu_items d on d.id = g.owner_menu_item_id and d.branch_id = g.branch_id
    left join public.modifier_groups s
           on s.id = g.source_group_id and s.branch_id = g.branch_id and s.owner_menu_item_id is null
   where g.branch_id = p_branch;
$$;

-- Every dish of a branch with what it shows, dish:links.
create or replace function pg_temp.dish_links(p_branch uuid)
returns text
language sql
as $$
  select coalesce(string_agg(mi.name || ':' || pg_temp.links(mi.id), ' | ' order by mi.name), '')
    from public.menu_items mi
   where mi.branch_id = p_branch;
$$;

do $test$
declare
  v_owner    uuid := pg_temp.new_user('owner');
  v_manager  uuid := pg_temp.new_user('manager');
  v_cashier  uuid := pg_temp.new_user('cashier');
  v_stranger uuid := pg_temp.new_user('stranger');
  v_sfx text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_t timestamptz := now() - interval '1 hour';
  v_ra uuid; v_a1 uuid; v_a2 uuid; v_a3 uuid;
  v_cat uuid; v_cat2 uuid;
  v_pad uuid; v_rice uuid; v_curry uuid; v_soup uuid; v_two uuid;
  v_spicy uuid; v_addons uuid; v_sauce uuid; v_two_group uuid; v_extras uuid; v_curry_only uuid;
  -- Medium and Mild share a position and a created_at, so their ids decide: v_lo first.
  v_lo uuid; v_hi uuid;
  v_copy uuid; v_copy_c uuid; v_copy_r uuid; v_copy_s uuid; v_copy_cs uuid; v_copy_r2 uuid;
  v_self uuid := gen_random_uuid();
  v_ids uuid[];
  v_before text;
  v_answer text;
  v_shape text;
  r jsonb;
  r2 jsonb;
  c_customize constant text := 'select public.customize_item_modifier_group(%L, %L)::text';
  c_reset     constant text := 'select public.reset_item_modifier_group(%L, %L)::text';
  -- A branch-one-or-two group with this name, owner and source.
  c_group     constant text :=
    'insert into public.modifier_groups (branch_id, name, selection_type, owner_menu_item_id, source_group_id) values (%L, %L, ''single'', %L, %L) returning name';
  c_link      constant text :=
    'insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (%L, %L, %s) returning display_order';
  c_elsewhere constant text := 'ERR 23514 modifier_group_owned_elsewhere';
  c_mismatch  constant text := 'ERR 23514 modifier_group_branch_mismatch';
  c_invalid   constant text := 'ERR 23514 modifier_source_invalid';
  c_needs     constant text := 'ERR 23514 new row for relation "modifier_groups" violates check constraint "modifier_groups_source_needs_owner"';
  c_not_copy  constant text := 'ERR P0002 modifier_group_not_customized';
  c_no_link   constant text := 'ERR P0002 modifier_link_not_found';
  c_no_auth   constant text := 'ERR 42501 not_authorized';
  -- Spicy Level's options as the fixture writes them, in the storefront's order.
  c_spicy_lib constant text := 'Not Spicy:0:0.00,Medium:2:0.25,Mild:2:0.00,Extra Hot:7:0.75,Hot:7:0.50,Thai Hot:9:1.00';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  perform pg_temp.expect('columns: owner_menu_item_id and source_group_id, uuid, nullable, no default',
    'owner_menu_item_id uuid YES <none>|source_group_id uuid YES <none>',
    (select string_agg(c.column_name || ' ' || c.data_type || ' ' || c.is_nullable || ' ' || coalesce(c.column_default, '<none>'),
                       '|' order by c.column_name)
       from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'modifier_groups'
        and c.column_name in ('owner_menu_item_id', 'source_group_id')));
  perform pg_temp.expect('columns: the owner dish''s delete takes its groups; a deleted source leaves the copy with none',
    'FOREIGN KEY (owner_menu_item_id) REFERENCES %menu_items(id) ON DELETE CASCADE || FOREIGN KEY (source_group_id) REFERENCES %modifier_groups(id) ON DELETE SET NULL%',
    (select string_agg(pg_get_constraintdef(oid), ' || ' order by conname) from pg_constraint
      where conrelid = 'public.modifier_groups'::regclass
        and conname in ('modifier_groups_owner_menu_item_id_fkey', 'modifier_groups_source_group_id_fkey')));
  perform pg_temp.expect('columns: a source needs an owner',
    'CHECK (((source_group_id IS NULL) OR (owner_menu_item_id IS NOT NULL)))',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.modifier_groups'::regclass and conname = 'modifier_groups_source_needs_owner'));
  perform pg_temp.expect('indexes: one on each, where set',
    'CREATE INDEX idx_modifier_groups_owner_menu_item ON public.modifier_groups USING btree (owner_menu_item_id) WHERE (owner_menu_item_id IS NOT NULL)'
    || ' || CREATE INDEX idx_modifier_groups_source_group ON public.modifier_groups USING btree (source_group_id) WHERE (source_group_id IS NOT NULL)',
    (select string_agg(indexdef, ' || ' order by indexname) from pg_indexes
      where schemaname = 'public' and indexname in ('idx_modifier_groups_owner_menu_item', 'idx_modifier_groups_source_group')));
  perform pg_temp.expect('triggers: the ownership rules on modifier_groups, for a row with an owner or a source; the link trigger as it was',
    'trg_modifier_groups_ownership:CREATE TRIGGER trg_modifier_groups_ownership BEFORE INSERT OR UPDATE OF owner_menu_item_id, source_group_id, branch_id ON public.modifier_groups FOR EACH ROW WHEN (((new.owner_menu_item_id IS NOT NULL) OR (new.source_group_id IS NOT NULL))) EXECUTE FUNCTION private.tg_modifier_groups_ownership()'
    || ' || trg_menu_item_modifiers_same_branch:CREATE TRIGGER trg_menu_item_modifiers_same_branch BEFORE INSERT OR UPDATE OF menu_item_id, modifier_group_id ON public.menu_item_modifiers FOR EACH ROW EXECUTE FUNCTION private.tg_menu_item_modifiers_same_branch()',
    (select string_agg(t.tgname || ':' || pg_get_triggerdef(t.oid), ' || ' order by t.tgname desc)
       from pg_trigger t
      where not t.tgisinternal
        and t.tgname in ('trg_modifier_groups_ownership', 'trg_menu_item_modifiers_same_branch')));
  perform pg_temp.expect('trigger functions: postgres, SECURITY DEFINER, search_path pinned; no API role may call them; both know both codes',
    'private.tg_menu_item_modifiers_same_branch() postgres true search_path=public, pg_temp false false true true|private.tg_modifier_groups_ownership() postgres true search_path=public, pg_temp false false true true',
    (select string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
                       || array_to_string(p.proconfig, ',') || ' '
                       || has_function_privilege('anon', p.oid, 'execute')::text || ' '
                       || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
                       || (p.prosrc like '%modifier_group_owned_elsewhere%')::text || ' '
                       || (p.prosrc like '%modifier_group_branch_mismatch%')::text,
                       '|' order by p.oid::regprocedure::text)
       from pg_proc p
      where p.oid in ('private.tg_menu_item_modifiers_same_branch()'::regprocedure,
                      'private.tg_modifier_groups_ownership()'::regprocedure)));
  perform pg_temp.expect('trigger functions: the link trigger locks the dish (FOR KEY SHARE) and the group (FOR SHARE) it reads', 'true|true',
    (select (prosrc ~* 'where\s+mi\.id\s*=\s*new\.menu_item_id\s+for\s+key\s+share\s*;')::text || '|'
            || (prosrc ~* 'where\s+mg\.id\s*=\s*new\.modifier_group_id\s+for\s+share\s*;')::text from pg_proc
      where oid = 'private.tg_menu_item_modifiers_same_branch()'::regprocedure));
  perform pg_temp.expect('RPCs: postgres, SECURITY DEFINER, search_path pinned, jsonb; authenticated only (not anon, not the service role)',
    'customize_item_modifier_group(uuid,uuid) postgres true search_path=public, pg_temp true false false jsonb|reset_item_modifier_group(uuid,uuid) postgres true search_path=public, pg_temp true false false jsonb',
    (select string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
                       || array_to_string(p.proconfig, ',') || ' '
                       || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
                       || has_function_privilege('anon', p.oid, 'execute')::text || ' '
                       || has_function_privilege('service_role', p.oid, 'execute')::text || ' '
                       || format_type(p.prorettype, null),
                       '|' order by p.oid::regprocedure::text)
       from pg_proc p
      where p.oid in ('public.customize_item_modifier_group(uuid,uuid)'::regprocedure,
                      'public.reset_item_modifier_group(uuid,uuid)'::regprocedure)));
  perform pg_temp.expect('RPCs: one signature each, (p_menu_item_id, p_group_id)',
    'p_menu_item_id uuid, p_group_id uuid|p_menu_item_id uuid, p_group_id uuid',
    (select string_agg(pg_get_function_arguments(p.oid), '|' order by p.proname)
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('customize_item_modifier_group', 'reset_item_modifier_group')));
  perform pg_temp.expect('copy_branch_setup: still postgres, SECURITY DEFINER, search_path pinned, authenticated and service_role but not anon; the dishes'' own groups go in after the library ones, pointing at the copies (a source only while it is still a library group of the source branch)',
    'postgres true search_path=public, pg_temp true true false true true',
    (select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || (p.prosrc like '%g.owner_menu_item_id is null;%g.owner_menu_item_id is not null;%')::text || ' '
              || (p.prosrc like '%(v_item_map ->> g.owner_menu_item_id::text)::uuid, (v_group_map ->> s.id::text)::uuid%left join public.modifier_groups s%on s.id = g.source_group_id and s.owner_menu_item_id is null and s.branch_id = p_source_branch_id%')::text
       from pg_proc p
      where p.oid = 'public.copy_branch_setup(uuid,uuid,boolean,boolean,boolean,boolean,boolean)'::regprocedure));
  -- The state right after the migration; dishes' own groups appear once a dish's editor changes a
  -- group.
  perform pg_temp.expect('data: every existing group stayed a library group (nothing converted)', '0',
    (select count(*)::text from public.modifier_groups
      where owner_menu_item_id is not null or source_group_id is not null));

  -- Fixture: restaurant A on its trial with three branches; a manager and a cashier at branch one.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-imc-a-' || v_sfx, 'ZZ Modifier Copies A') returning id into v_ra;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'one', 'A One') returning id into v_a1;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'two', 'A Two') returning id into v_a2;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'three', 'A Three') returning id into v_a3;
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_manager, v_ra, v_a1, 'manager', 'active'), (v_cashier, v_ra, v_a1, 'cashier', 'active');

  insert into public.menu_categories (branch_id, name, display_order) values (v_a1, 'Mains', 1) returning id into v_cat;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a1, v_cat, 'Pad Thai', 12) returning id into v_pad;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a1, v_cat, 'Fried Rice', 10) returning id into v_rice;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a1, v_cat, 'Green Curry', 13) returning id into v_curry;
  insert into public.menu_items (branch_id, category_id, name, price) values (v_a1, v_cat, 'Tom Yum', 9) returning id into v_soup;
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

  v_lo := (left(gen_random_uuid()::text, 35) || '0')::uuid;
  v_hi := (left(v_lo::text, 35) || 'f')::uuid;
  insert into public.modifier_options (id, group_id, name, name_translations, price_delta, is_default, is_active, display_order, created_at)
  values (gen_random_uuid(), v_spicy, 'Not Spicy', '{"th": "ไม่เผ็ด"}', 0, true, true, 0, v_t),
         (v_hi, v_spicy, 'Mild', '{}', 0, false, true, 2, v_t),
         (v_lo, v_spicy, 'Medium', '{}', 0.25, false, true, 2, v_t),
         (gen_random_uuid(), v_spicy, 'Hot', '{}', 0.50, false, true, 7, v_t + interval '1 second'),
         (gen_random_uuid(), v_spicy, 'Extra Hot', '{}', 0.75, false, true, 7, v_t),
         (gen_random_uuid(), v_spicy, 'Thai Hot', '{}', 1.00, false, false, 9, v_t);
  insert into public.modifier_options (group_id, name, price_delta, display_order)
  values (v_addons, 'Egg', 1.00, 0), (v_addons, 'Shrimp', 2.50, 1),
         (v_sauce, 'Fish Sauce', 0, 0), (v_sauce, 'Soy Sauce', 0, 1),
         (v_two_group, 'Cheese', 1.50, 0);
  insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order)
  values (v_pad, v_spicy, 0), (v_pad, v_addons, 1), (v_rice, v_spicy, 0),
         (v_curry, v_addons, 0), (v_curry, v_sauce, 1), (v_soup, v_sauce, 0), (v_soup, v_addons, 1),
         (v_two, v_two_group, 0);

  -- Pad Thai's own group, made in its editor: an owner, no source.
  insert into public.modifier_groups (branch_id, name, selection_type, min_select, max_select, display_order, owner_menu_item_id)
  values (v_a1, 'Pad Extras', 'multiple', 0, null, 3, v_pad) returning id into v_extras;
  insert into public.modifier_options (group_id, name, price_delta, display_order) values (v_extras, 'Peanuts', 0.50, 0);
  insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (v_pad, v_extras, 2);

  perform pg_temp.expect('fixture: the library page lists Spicy Level, Add-ons and Sauce; Pad Extras is Pad Thai''s own',
    'Spicy Level,Add-ons,Sauce|Spicy Level:0:library,Add-ons:1:library,Pad Extras:2:own|' || c_spicy_lib,
    pg_temp.library(v_a1) || '|' || pg_temp.links(v_pad) || '|' || pg_temp.options(v_spicy));

  -- 1. The first change makes a copy. Starts: the fixture. ---------------------------------------
  begin
    perform pg_temp.act_as(v_manager);
    r := public.customize_item_modifier_group(v_pad, v_spicy);
    perform pg_temp.act_as(null);
    v_copy := (r ->> 'group_id')::uuid;

    perform pg_temp.expect('customize: answers a new group, copied = true and Spicy Level as its source',
      'true|true|' || v_spicy,
      (r ->> 'copied') || '|' || (v_copy is not null and v_copy <> v_spicy)::text || '|' || (r ->> 'source_group_id'));
    perform pg_temp.expect('customize: the copy is Pad Thai''s own, made from Spicy Level, on branch one, with its name, translations, rules and position',
      'true|true|true|Spicy Level|{"th": "ระดับความเผ็ด"}|single|true|1|1|0',
      (select (g.branch_id = v_a1)::text || '|' || (g.owner_menu_item_id = v_pad)::text || '|' || (g.source_group_id = v_spicy)::text
                || '|' || g.name || '|' || g.name_translations::text || '|' || g.selection_type || '|' || g.is_required::text
                || '|' || g.min_select || '|' || coalesce(g.max_select::text, '-') || '|' || g.display_order
         from public.modifier_groups g where g.id = v_copy));
    perform pg_temp.expect('customize: its options in the storefront''s order (position, then created_at, then id), numbered 0..5, with name, translations, price, default and active',
      'Not Spicy:0:0.00:true:true:{"th": "ไม่เผ็ด"},Medium:1:0.25:false:true:{},Mild:2:0.00:false:true:{},Extra Hot:3:0.75:false:true:{},Hot:4:0.50:false:true:{},Thai Hot:5:1.00:false:false:{}',
      (select string_agg(o.name || ':' || o.display_order || ':' || o.price_delta || ':' || o.is_default || ':' || o.is_active || ':'
                         || o.name_translations::text, ',' order by o.display_order)
         from public.modifier_options o where o.group_id = v_copy));
    perform pg_temp.expect('customize: the map pairs each of the six library options with its copy, and nothing else',
      '6|6|true',
      (select count(*)::text || '|' || count(distinct m.value)::text || '|'
                || coalesce(bool_and(coalesce(lo.group_id = v_spicy and co.group_id = v_copy and lo.name = co.name
                                              and lo.price_delta = co.price_delta, false)), false)::text
         from jsonb_each_text(r -> 'options') m
         left join public.modifier_options lo on lo.id = m.key::uuid
         left join public.modifier_options co on co.id = m.value::uuid));
    perform pg_temp.expect('customize: Pad Thai shows the copy where it showed Spicy Level; Add-ons and Pad Extras keep their places',
      'Spicy Level:0:copy,Add-ons:1:library,Pad Extras:2:own', pg_temp.links(v_pad));
    perform pg_temp.expect('customize: the library group keeps all six options, and Fried Rice still shows it',
      c_spicy_lib || '|Spicy Level:0:library', pg_temp.options(v_spicy) || '|' || pg_temp.links(v_rice));
    perform pg_temp.expect('customize: the library page still lists only Spicy Level, Add-ons and Sauce',
      'Spicy Level,Add-ons,Sauce', pg_temp.library(v_a1));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. A second call changes nothing. Starts: Pad Thai shows its copy of Spicy Level. -------------
  begin
    perform pg_temp.act_as(v_manager);
    r2 := public.customize_item_modifier_group(v_pad, v_copy);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('customize again: on the copy itself, copied = false, the same group, its source, every option mapped to itself',
      v_copy || '|false|' || v_spicy || '|6|true',
      (r2 ->> 'group_id') || '|' || (r2 ->> 'copied') || '|' || (r2 ->> 'source_group_id') || '|'
        || (select count(*)::text || '|'
                   || coalesce(bool_and(m.key = m.value
                                        and exists (select 1 from public.modifier_options o
                                                     where o.id = m.key::uuid and o.group_id = v_copy)), false)::text
              from jsonb_each_text(r2 -> 'options') m));
    perform pg_temp.expect('customize again: nothing new was made', '2|6',
      (select count(*)::text from public.modifier_groups where owner_menu_item_id = v_pad) || '|'
        || (select count(*)::text from public.modifier_options where group_id = v_copy));
    perform pg_temp.expect('customize again: Pad Thai no longer shows the library group itself', c_no_link,
      pg_temp.try_as('authenticated', v_manager, array[format(c_customize, v_pad, v_spicy)]));
    perform pg_temp.expect('customize: a group made in the dish''s editor is already its own: copied = false, no source, its own id',
      'ok false|null|true',
      pg_temp.try_as('authenticated', v_manager, array[format(
        'select (x ->> ''copied'') || ''|'' || jsonb_typeof(x -> ''source_group_id'') || ''|'' || ((x ->> ''group_id'') = %L)::text from public.customize_item_modifier_group(%L, %L) x',
        v_extras, v_pad, v_extras)]));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. Edits stay where they are made. Starts: Pad Thai shows its copy of Spicy Level. ------------
  begin
    perform pg_temp.expect('edit the copy: the manager renames it, deletes, reprices, adds and reorders its options through the API',
      'ok Volcano:2.00,Thai Hot:1.00,Extra Hot:0.75,Mild:0.10,Medium:0.25,Not Spicy:0.00',
      pg_temp.try_as('authenticated', v_manager, array[
        format('update public.modifier_groups set name = %L where id = %L returning name', 'Spicy (Pad Thai)', v_copy),
        format('delete from public.modifier_options where group_id = %L and name = %L returning name', v_copy, 'Hot'),
        format('update public.modifier_options set price_delta = 0.10 where group_id = %L and name = %L returning name', v_copy, 'Mild'),
        format('insert into public.modifier_options (group_id, name, price_delta, display_order) values (%L, %L, 2, 9) returning name',
               v_copy, 'Volcano'),
        format('select public.reorder_modifier_options(%L, array(select o.id from public.modifier_options o where o.group_id = %L order by o.display_order desc, o.created_at desc, o.id desc))::text',
               v_copy, v_copy),
        format('select string_agg(o.name || '':'' || o.price_delta, '','' order by o.display_order) from public.modifier_options o where o.group_id = %L',
               v_copy)]));

    -- Kept: the copy renamed, Hot and Thai Hot gone from it, Mild repriced there.
    update public.modifier_groups set name = 'Spicy (Pad Thai)' where id = v_copy;
    delete from public.modifier_options where group_id = v_copy and name in ('Hot', 'Thai Hot');
    update public.modifier_options set price_delta = 0.10 where group_id = v_copy and name = 'Mild';
    perform pg_temp.expect('edit the copy: the library group keeps its name and its six options; Fried Rice still lists them',
      'Spicy Level|' || c_spicy_lib || '|Spicy Level(Not Spicy,Medium,Mild,Extra Hot,Hot)',
      (select name from public.modifier_groups where id = v_spicy) || '|' || pg_temp.options(v_spicy) || '|'
        || pg_temp.storefront(v_rice));

    -- Kept: the library group renamed, Not Spicy deleted, Medium repriced, Volcano added.
    update public.modifier_groups set name = 'Spice Level' where id = v_spicy;
    delete from public.modifier_options where group_id = v_spicy and name = 'Not Spicy';
    update public.modifier_options set price_delta = 0.30 where group_id = v_spicy and name = 'Medium';
    insert into public.modifier_options (group_id, name, price_delta, display_order) values (v_spicy, 'Volcano', 1.50, 10);
    perform pg_temp.expect('edit the library group: the copy keeps its own name and options',
      'Spicy (Pad Thai)|Not Spicy:0:0.00,Medium:1:0.25,Mild:2:0.10,Extra Hot:3:0.75',
      (select name from public.modifier_groups where id = v_copy) || '|' || pg_temp.options(v_copy));
    perform pg_temp.expect('edit the library group: Fried Rice follows it; Pad Thai lists its own version',
      'Spice Level(Medium,Mild,Extra Hot,Hot,Volcano) / Spicy (Pad Thai)(Not Spicy,Medium,Mild,Extra Hot) Add-ons(Egg,Shrimp) Pad Extras(Peanuts)',
      pg_temp.storefront(v_rice) || ' / ' || pg_temp.storefront(v_pad));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. "Use the library version". Starts: Pad Thai {Spicy (Pad Thai), the copy; Add-ons; Pad
  --    Extras}; the library group is Spice Level (Medium, Mild, Extra Hot, Hot, Thai Hot (off),
  --    Volcano), on Fried Rice too. ----------------------------------------------------------------
  begin
    perform pg_temp.act_as(v_manager);
    r := public.reset_item_modifier_group(v_pad, v_copy);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('reset: answers the library group', '{"group_id": "' || v_spicy || '"}', r::text);
    perform pg_temp.expect('reset: Pad Thai shows Spice Level where the copy was; the others keep their places',
      'Spice Level:0:library,Add-ons:1:library,Pad Extras:2:own', pg_temp.links(v_pad));
    perform pg_temp.expect('reset: the copy and its options are gone', '0|0',
      (select count(*)::text from public.modifier_groups where id = v_copy) || '|'
        || (select count(*)::text from public.modifier_options where group_id = v_copy));
    perform pg_temp.expect('reset: Pad Thai lists the library version again',
      'Spice Level(Medium,Mild,Extra Hot,Hot,Volcano) Add-ons(Egg,Shrimp) Pad Extras(Peanuts)', pg_temp.storefront(v_pad));

    -- Green Curry's copy of Add-ons.
    perform pg_temp.act_as(v_manager);
    v_copy_c := (public.customize_item_modifier_group(v_curry, v_addons) ->> 'group_id')::uuid;
    perform pg_temp.act_as(null);
    perform pg_temp.expect('reset: a library group, a group made in the editor, another dish''s copy, an unknown group: not customized',
      c_not_copy || '|' || c_not_copy || '|' || c_not_copy || '|' || c_not_copy,
      pg_temp.try_as('authenticated', v_manager, array[format(c_reset, v_pad, v_spicy)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_reset, v_pad, v_extras)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_reset, v_pad, v_copy_c)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_reset, v_pad, gen_random_uuid())]));

    -- Fried Rice's copy. The library group is then refused on Fried Rice (a screen loaded before
    -- the copy adding it again), another library group is not.
    perform pg_temp.act_as(v_manager);
    v_copy_r := (public.customize_item_modifier_group(v_rice, v_spicy) ->> 'group_id')::uuid;
    perform pg_temp.act_as(null);
    perform pg_temp.expect('links: a dish that shows its own copy of a library group may not show the library group too, added through the API or moved over from another dish; another library group it may',
      c_elsewhere || '|' || c_elsewhere || '|ok 1',
      pg_temp.try_as('authenticated', v_manager, array[format(c_link, v_rice, v_spicy, 1)]) || '|'
        || pg_temp.try_sql(array[format(
        'update public.menu_item_modifiers set menu_item_id = %L where menu_item_id = %L and modifier_group_id = %L returning display_order',
        v_rice, v_pad, v_spicy)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_link, v_rice, v_sauce, 1)]));

    -- The library group on Fried Rice as well, with the link trigger off, as only a migration or
    -- the SQL editor could.
    alter table public.menu_item_modifiers disable trigger trg_menu_item_modifiers_same_branch;
    insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (v_rice, v_spicy, 1);
    alter table public.menu_item_modifiers enable trigger trg_menu_item_modifiers_same_branch;
    v_before := pg_temp.links(v_rice);
    v_answer := pg_temp.call_as(v_manager, format(c_reset, v_rice, v_copy_r));
    perform pg_temp.expect('reset: a dish showing the copy and the library group keeps the library group where it is; the copy goes',
      'Spice Level:0:copy,Spice Level:1:library|ok {"group_id": "' || v_spicy || '"}|Spice Level:1:library|0',
      v_before || '|' || v_answer || '|' || pg_temp.links(v_rice) || '|'
        || (select count(*)::text from public.modifier_groups where id = v_copy_r));

    -- Tom Yum's copy of Sauce, taken off Tom Yum by hand.
    perform pg_temp.act_as(v_manager);
    v_copy_s := (public.customize_item_modifier_group(v_soup, v_sauce) ->> 'group_id')::uuid;
    perform pg_temp.act_as(null);
    delete from public.menu_item_modifiers where menu_item_id = v_soup and modifier_group_id = v_copy_s;
    v_before := pg_temp.links(v_soup);
    v_answer := pg_temp.call_as(v_manager, format(c_reset, v_soup, v_copy_s));
    perform pg_temp.expect('reset: a copy taken off its dish by hand gives way to the library group at the end of the list',
      'Add-ons:1:library|ok {"group_id": "' || v_sauce || '"}|Add-ons:1:library,Sauce:2:library|0',
      v_before || '|' || v_answer || '|' || pg_temp.links(v_soup) || '|'
        || (select count(*)::text from public.modifier_groups where id = v_copy_s));

    -- Green Curry's copy of Sauce. Its library group is then made Tom Yum's own (Tom Yum is the
    -- only dish showing it), or moved to branch two.
    perform pg_temp.act_as(v_manager);
    v_copy_cs := (public.customize_item_modifier_group(v_curry, v_sauce) ->> 'group_id')::uuid;
    perform pg_temp.act_as(null);
    perform pg_temp.expect('reset: a library group made a dish''s own, or moved to another branch, is no longer the copy''s library version',
      'ERR P0002 modifier_source_missing|ERR P0002 modifier_source_missing',
      pg_temp.try_as('authenticated', v_owner, array[
        format('update public.modifier_groups set owner_menu_item_id = %L where id = %L returning name', v_soup, v_sauce),
        format(c_reset, v_curry, v_copy_cs)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[
        format('update public.modifier_groups set branch_id = %L where id = %L returning name', v_a2, v_sauce),
        format(c_reset, v_curry, v_copy_cs)]));
    perform pg_temp.expect('reset: (nothing of that was kept: Sauce is still branch one''s library group, Green Curry keeps both copies)',
      'true|-|Add-ons:0:copy,Sauce:1:copy',
      (select (branch_id = v_a1)::text || '|' || coalesce(owner_menu_item_id::text, '-') from public.modifier_groups where id = v_sauce)
        || '|' || pg_temp.links(v_curry));
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. A deleted library group leaves its copies. Starts: Green Curry {Add-ons copy, Sauce copy};
  --    Pad Thai and Tom Yum show the library Add-ons. ----------------------------------------------
  begin
    delete from public.modifier_groups where id = v_addons;
    perform pg_temp.expect('delete a library group: its copy stays on Green Curry with its options, now with no source',
      'Add-ons:0:own,Sauce:1:copy|-|' || v_curry || '|Egg:0:1.00,Shrimp:1:2.50',
      pg_temp.links(v_curry) || '|'
        || (select coalesce(source_group_id::text, '-') || '|' || owner_menu_item_id from public.modifier_groups where id = v_copy_c)
        || '|' || pg_temp.options(v_copy_c));
    perform pg_temp.expect('delete a library group: the dishes that showed it directly no longer do',
      'Spice Level:0:library,Pad Extras:2:own / Sauce:2:library', pg_temp.links(v_pad) || ' / ' || pg_temp.links(v_soup));
    perform pg_temp.expect('delete a library group: the copy is simply the dish''s own now: reset says not customized, customize answers copied = false with no source',
      c_not_copy || '|ok false|null',
      pg_temp.try_as('authenticated', v_manager, array[format(c_reset, v_curry, v_copy_c)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(
             'select (x ->> ''copied'') || ''|'' || jsonb_typeof(x -> ''source_group_id'') from public.customize_item_modifier_group(%L, %L) x',
             v_curry, v_copy_c)]));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. A deleted dish takes its own groups. Starts: Green Curry {Add-ons (its own, a copy once),
  --    Sauce copy}, then Curry Only made in its editor. ---------------------------------------------
  begin
    insert into public.modifier_groups (branch_id, name, selection_type, owner_menu_item_id)
    values (v_a1, 'Curry Only', 'single', v_curry) returning id into v_curry_only;
    insert into public.modifier_options (group_id, name, display_order) values (v_curry_only, 'Basil', 0);
    insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) values (v_curry, v_curry_only, 2);
    delete from public.menu_items where id = v_curry;
    perform pg_temp.expect('delete a dish: its copies and the group made in its editor go with it, options included', '0|0',
      (select count(*)::text from public.modifier_groups where id in (v_copy_c, v_copy_cs, v_curry_only)) || '|'
        || (select count(*)::text from public.modifier_options where group_id in (v_copy_c, v_copy_cs, v_curry_only)));
    perform pg_temp.expect('delete a dish: the library group it was copied from and the other dishes are untouched',
      'Fish Sauce:0:0.00,Soy Sauce:1:0.00|Sauce:2:library|Spice Level:0:library,Pad Extras:2:own',
      pg_temp.options(v_sauce) || '|' || pg_temp.links(v_soup) || '|' || pg_temp.links(v_pad));
  exception when others then
    perform pg_temp.expect('section 6 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 7. Integrity. Starts: Pad Thai {Spice Level, Pad Extras (own)}, Fried Rice {Spice Level at
  --    1}, Tom Yum {Sauce at 2}; Fried Rice then copies Spice Level. --------------------------------
  begin
    perform pg_temp.act_as(v_manager);
    v_copy_r2 := (public.customize_item_modifier_group(v_rice, v_spicy) ->> 'group_id')::uuid;
    perform pg_temp.act_as(null);

    perform pg_temp.expect('links: a dish''s own group on another dish is refused, by insert or by either update, through the API too',
      c_elsewhere || '|' || c_elsewhere || '|' || c_elsewhere || '|' || c_elsewhere,
      pg_temp.try_sql(array[format(c_link, v_pad, v_copy_r2, 5)]) || '|'
        || pg_temp.try_sql(array[format(
        'update public.menu_item_modifiers set menu_item_id = %L where menu_item_id = %L and modifier_group_id = %L returning display_order',
        v_pad, v_rice, v_copy_r2)]) || '|'
        || pg_temp.try_sql(array[format(
        'update public.menu_item_modifiers set modifier_group_id = %L where menu_item_id = %L and modifier_group_id = %L returning display_order',
        v_copy_r2, v_pad, v_spicy)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_link, v_soup, v_copy_r2, 5)]));
    perform pg_temp.expect('groups: a group another dish shows cannot be made a dish''s own (a library group, or a copy given another owner)',
      c_elsewhere || '|' || c_elsewhere,
      pg_temp.try_sql(array[format('update public.modifier_groups set owner_menu_item_id = %L where id = %L returning name', v_rice, v_spicy)])
        || '|' || pg_temp.try_sql(array[format(
        'update public.modifier_groups set owner_menu_item_id = %L where id = %L returning name', v_pad, v_copy_r2)]));
    perform pg_temp.expect('groups: an owner dish of another branch, given at insert, by a new owner or by moving the group',
      c_mismatch || '|' || c_mismatch || '|' || c_mismatch,
      pg_temp.try_sql(array[format(c_group, v_a1, 'Wrong Owner', v_two, null)]) || '|'
        || pg_temp.try_sql(array[format('update public.modifier_groups set owner_menu_item_id = %L where id = %L returning name', v_two, v_extras)])
        || '|' || pg_temp.try_sql(array[format('update public.modifier_groups set branch_id = %L where id = %L returning name', v_a2, v_copy_r2)]));
    perform pg_temp.expect('groups: a source that is a dish''s own group, a group of another branch or the group itself, at insert or update',
      c_invalid || '|' || c_invalid || '|' || c_invalid || '|' || c_invalid || '|' || c_invalid,
      pg_temp.try_sql(array[format(c_group, v_a1, 'Copy Of A Copy', v_pad, v_copy_r2)]) || '|'
        || pg_temp.try_sql(array[format(c_group, v_a1, 'Copy From Two', v_pad, v_two_group)]) || '|'
        || pg_temp.try_sql(array[format(
        'insert into public.modifier_groups (id, branch_id, name, selection_type, owner_menu_item_id, source_group_id) values (%L, %L, %L, ''single'', %L, %L) returning name',
        v_self, v_a1, 'Itself', v_pad, v_self)]) || '|'
        || pg_temp.try_sql(array[format('update public.modifier_groups set source_group_id = id where id = %L returning name', v_copy_r2)])
        || '|' || pg_temp.try_sql(array[format(
        'update public.modifier_groups set source_group_id = %L where id = %L returning name', v_two_group, v_extras)]));
    perform pg_temp.expect('groups: a source needs an owner, at insert or when the owner is cleared',
      c_needs || '|' || c_needs,
      pg_temp.try_sql(array[format(c_group, v_a1, 'Unowned Copy', null, v_spicy)]) || '|'
        || pg_temp.try_sql(array[format('update public.modifier_groups set owner_menu_item_id = null where id = %L returning name', v_copy_r2)]));
    perform pg_temp.expect('groups: a dish or a group that does not exist is still the foreign key''s to report',
      'ERR 23503 insert or update on table "modifier_groups" violates foreign key constraint "modifier_groups_owner_menu_item_id_fkey"|'
      || 'ERR 23503 insert or update on table "modifier_groups" violates foreign key constraint "modifier_groups_source_group_id_fkey"',
      pg_temp.try_sql(array[format(c_group, v_a1, 'Ghost Owner', gen_random_uuid(), null)]) || '|'
        || pg_temp.try_sql(array[format(c_group, v_a1, 'Ghost Source', v_pad, gen_random_uuid())]));
    perform pg_temp.expect('allowed: a library group on any dish of its branch; an unlinked library group made a dish''s own; a copy made a library group again',
      'ok 3|ok Loose|ok Spice Level',
      pg_temp.try_sql(array[format(c_link, v_soup, v_spicy, 3)]) || '|'
        || pg_temp.try_sql(array[format(c_group, v_a1, 'Loose', null, null),
             format('update public.modifier_groups set owner_menu_item_id = %L where branch_id = %L and name = %L returning name',
                    v_soup, v_a1, 'Loose')]) || '|'
        || pg_temp.try_sql(array[format(
             'update public.modifier_groups set owner_menu_item_id = null, source_group_id = null where id = %L returning name', v_copy_r2)]));
    perform pg_temp.expect('allowed: the API may make a dish''s own group with a source and show it on that dish (the editor''s draft does)',
      'ok 7',
      pg_temp.try_as('authenticated', v_manager, array[format(c_group, v_a1, 'Draft Copy', v_soup, v_sauce),
        format('insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order) select %L, g.id, 7 from public.modifier_groups g where g.branch_id = %L and g.name = %L returning display_order',
               v_soup, v_a1, 'Draft Copy')]));
    perform pg_temp.expect('links: another branch''s group on a dish is still modifier_group_branch_mismatch', c_mismatch,
      pg_temp.try_sql(array[format(c_link, v_pad, v_two_group, 6)]));
    perform pg_temp.expect('customize: another dish''s own group on this dish (linked with the link trigger off) is refused, not copied',
      c_elsewhere,
      pg_temp.try_sql(array[format('select pg_temp.link_unchecked(%L, %L)', v_soup, v_copy_r2),
        format('select set_config(''request.jwt.claim.sub'', %L, true)', v_owner),
        format(c_customize, v_soup, v_copy_r2)]));
    perform pg_temp.expect('integrity: none of the refused writes was kept', 'Spice Level:1:copy|Sauce:2:library|' || v_rice || '|' || v_spicy,
      pg_temp.links(v_rice) || '|' || pg_temp.links(v_soup) || '|'
        || (select owner_menu_item_id || '|' || source_group_id from public.modifier_groups where id = v_copy_r2));
  exception when others then
    perform pg_temp.expect('section 7 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 8. Who may call the RPCs, and their errors. Starts: Fried Rice {its copy of Spice Level};
  --    Two Noodles (branch two) {Two Toppings}. ------------------------------------------------------
  begin
    perform pg_temp.expect('customize: anon may not call it; a token without a user must sign in',
      'ERR 42501 permission denied for function customize_item_modifier_group|ERR 42501 auth_required',
      pg_temp.try_as('anon', null, array[format(c_customize, v_pad, v_spicy)]) || '|'
        || pg_temp.try_as('authenticated', null, array[format(c_customize, v_pad, v_spicy)]));
    perform pg_temp.expect('customize: the cashier (no menu.manage), a stranger, and branch one''s manager on branch two may not',
      c_no_auth || '|' || c_no_auth || '|' || c_no_auth,
      pg_temp.try_as('authenticated', v_cashier, array[format(c_customize, v_pad, v_spicy)]) || '|'
        || pg_temp.try_as('authenticated', v_stranger, array[format(c_customize, v_pad, v_spicy)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_customize, v_two, v_two_group)]));
    perform pg_temp.expect('customize: the restaurant owner may, on any of its branches', 'ok true',
      pg_temp.try_as('authenticated', v_owner, array[format(
        'select x ->> ''copied'' from public.customize_item_modifier_group(%L, %L) x', v_two, v_two_group)]));
    perform pg_temp.expect('customize: an unknown dish is item_not_found; a group the dish does not show (of its branch, of another, none at all) is modifier_link_not_found',
      'ERR P0002 item_not_found|' || c_no_link || '|' || c_no_link || '|' || c_no_link,
      pg_temp.try_as('authenticated', v_manager, array[format(c_customize, gen_random_uuid(), v_spicy)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_customize, v_pad, v_sauce)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_customize, v_pad, v_two_group)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_customize, v_pad, gen_random_uuid())]));
    perform pg_temp.expect('reset: anon may not call it; a token without a user must sign in',
      'ERR 42501 permission denied for function reset_item_modifier_group|ERR 42501 auth_required',
      pg_temp.try_as('anon', null, array[format(c_reset, v_rice, v_copy_r2)]) || '|'
        || pg_temp.try_as('authenticated', null, array[format(c_reset, v_rice, v_copy_r2)]));
    perform pg_temp.expect('reset: the cashier, a stranger, and branch one''s manager on branch two may not',
      c_no_auth || '|' || c_no_auth || '|' || c_no_auth,
      pg_temp.try_as('authenticated', v_cashier, array[format(c_reset, v_rice, v_copy_r2)]) || '|'
        || pg_temp.try_as('authenticated', v_stranger, array[format(c_reset, v_rice, v_copy_r2)]) || '|'
        || pg_temp.try_as('authenticated', v_manager, array[format(c_reset, v_two, v_two_group)]));
    perform pg_temp.expect('reset: an unknown dish is item_not_found', 'ERR P0002 item_not_found',
      pg_temp.try_as('authenticated', v_manager, array[format(c_reset, gen_random_uuid(), v_copy_r2)]));
    perform pg_temp.expect('refused calls keep nothing: Fried Rice still shows its copy, Two Noodles its library group',
      'Spice Level:1:copy|Two Toppings:0:library', pg_temp.links(v_rice) || '|' || pg_temp.links(v_two));
  exception when others then
    perform pg_temp.expect('section 8 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 9. copy_branch_setup into the empty branch three. Starts: branch one {Spice Level, Sauce;
  --    Fried Rice's copy of Spice Level, renamed below; Pad Extras, Pad Thai's own}. ----------------
  begin
    update public.modifier_groups set name = 'Spicy (Fried Rice)' where id = v_copy_r2;
    delete from public.modifier_options where group_id = v_copy_r2 and name = 'Volcano';

    -- Spice Level made Pad Thai's own through the API (Pad Thai is the only dish that shows it;
    -- reset would answer modifier_source_missing): Fried Rice's copy of it goes over with no
    -- source, whichever of the two is copied first. Rolled back, so branch three is still empty.
    perform pg_temp.expect('copy branch: a copy whose library group was since made a dish''s own goes over with no source',
      'ok Pad Extras/-,Spice Level/-,Spicy (Fried Rice)/-',
      pg_temp.try_as('authenticated', v_owner, array[
        format('update public.modifier_groups set owner_menu_item_id = %L where id = %L returning name', v_pad, v_spicy),
        format('select public.copy_branch_setup(%L, %L, true, false, false)::text', v_a1, v_a3),
        format('select string_agg(g.name || ''/'' || coalesce(s.name, ''-''), '','' order by g.name) from public.modifier_groups g left join public.modifier_groups s on s.id = g.source_group_id where g.branch_id = %L and g.owner_menu_item_id is not null',
               v_a3)]));

    v_shape := pg_temp.shape(v_a1);
    perform pg_temp.act_as(v_owner);
    r := public.copy_branch_setup(v_a1, v_a3, true, false, false);
    perform pg_temp.act_as(null);
    perform pg_temp.expect('copy branch: three dishes; modifier_groups_copied counts the library groups and the dishes'' own',
      '3|4', (r ->> 'items_copied') || '|' || (r ->> 'modifier_groups_copied'));
    perform pg_temp.expect('copy branch: the target''s library page lists the same library groups', 'Spice Level,Sauce|Spice Level,Sauce',
      pg_temp.library(v_a1) || '|' || pg_temp.library(v_a3));
    perform pg_temp.expect('copy branch: the source''s groups, for the comparison below',
      '-/Sauce/-/Fish Sauce:0:0.00,Soy Sauce:1:0.00; -/Spice Level/-/Medium:2:0.30,Mild:2:0.00,Extra Hot:7:0.75,Hot:7:0.50,Thai Hot:9:1.00,Volcano:10:1.50; '
      || 'Fried Rice/Spicy (Fried Rice)/Spice Level/Medium:0:0.30,Mild:1:0.00,Extra Hot:2:0.75,Hot:3:0.50,Thai Hot:4:1.00; Pad Thai/Pad Extras/-/Peanuts:0:0.50',
      v_shape);
    perform pg_temp.expect('copy branch: each dish''s own group belongs to the target''s copy of the dish, and the copy names the target''s copy of its library group',
      v_shape, pg_temp.shape(v_a3));
    perform pg_temp.expect('copy branch: no group of the target points at the source branch''s dishes or groups (two own groups, one a copy)',
      '0|2|1',
      (select count(*) filter (where (g.owner_menu_item_id is not null
                                      and not exists (select 1 from public.menu_items mi
                                                       where mi.id = g.owner_menu_item_id and mi.branch_id = v_a3))
                                  or (g.source_group_id is not null
                                      and not exists (select 1 from public.modifier_groups s
                                                       where s.id = g.source_group_id and s.branch_id = v_a3)))::text
              || '|' || (count(*) filter (where g.owner_menu_item_id is not null))::text
              || '|' || (count(*) filter (where g.source_group_id is not null))::text
         from public.modifier_groups g where g.branch_id = v_a3));
    perform pg_temp.expect('copy branch: every dish shows the same groups at the same places',
      'Fried Rice:Spicy (Fried Rice):1:copy | Pad Thai:Spice Level:0:library,Pad Extras:2:own | Tom Yum:Sauce:2:library|same',
      pg_temp.dish_links(v_a1) || '|' || case when pg_temp.dish_links(v_a3) = pg_temp.dish_links(v_a1) then 'same' else pg_temp.dish_links(v_a3) end);
  exception when others then
    perform pg_temp.expect('section 9 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 10. A branch delete takes its groups with it. Starts: branch three as copied above. ----------
  begin
    v_ids := array(select id from public.modifier_groups where branch_id = v_a3);
    delete from public.branches where id = v_a3;
    perform pg_temp.expect('delete a branch: its groups, the dishes'' own included, their options and links go with it',
      '4|0|0|0',
      coalesce(array_length(v_ids, 1), 0)::text || '|'
        || (select count(*)::text from public.modifier_groups where id = any (v_ids)) || '|'
        || (select count(*)::text from public.modifier_options where group_id = any (v_ids)) || '|'
        || (select count(*)::text from public.menu_item_modifiers where modifier_group_id = any (v_ids)));
  exception when others then
    perform pg_temp.expect('section 10 ran', 'ok', 'ERR ' || sqlerrm);
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
