-- Duplicate keeps a dish's option groups (the owner's report of 2026-11-11: copying a dish does not
-- copy its modifiers). The menu card's Duplicate button calls public.duplicate_menu_item, which
-- copied the dish alone. Since 2026-10-30 (20261030100000_item_modifier_copies) merchants build
-- option groups inside each dish's editor, and those groups belong to that dish (live on 2026-11-11:
-- 134 of them, on every one of one branch's 39 dishes), so a duplicated dish came out with no
-- options at all, and its groups were not even in the Modifier groups library to add back.
--
-- public.duplicate_menu_item(p_item_id) is re-created from its live definition (pg_get_functiondef
-- on 2026-11-11, which matched 20260918170000_stock_integrity) with the same argument, return type,
-- owner, grants, SECURITY DEFINER and search_path, the same checks and errors (auth_required,
-- item_not_found, not_authorized through private.user_manages_branch, raised as before) and the
-- same copy of the dish ("<name> (Copy)", hidden, not new, untracked, one place further down).
-- Only the lines after the dish's insert are new.
--
-- 1. THE COPY SHOWS THE SAME GROUPS AT THE SAME PLACES (each link's display_order, as it stands):
--      a library group the source shows (owner_menu_item_id null): the copy shows that same group,
--        so an edit on the Modifier groups page reaches both dishes;
--      a group the source owns (its copy of a library group, or one made in its editor): copied for
--        the new dish: name, translations, rules and position; owner = the new dish; source = the
--        same library group, so "Use the library version" works on the new dish too. Its options
--        are copied (name, translations, price, default, active) numbered 0..n-1 in the
--        storefront's order (display_order, then created_at and id, as
--        customize_item_modifier_group numbers them: the copies all get one created_at). From then
--        on an edit to one dish's own group never reaches the other.
--    The groups, their options and the positions are read in one statement, so the copy is the
--    source as it stood at one moment even while the source's editor is saving; a library group
--    deleted, made a dish's own or moved to another branch in the instant before the links are
--    written is left off instead of failing the copy.
--
-- 2. LEFT BEHIND (none live on 2026-11-11; each takes a link written with
--    tg_menu_item_modifiers_same_branch switched off, or removed by hand): a group of another
--    branch and a group another dish owns, which that trigger refuses on the new dish; a library
--    group the source also shows its own copy of (a dish shows one or the other, so the new dish
--    shows only its own copy); a group the source owns but no longer shows. A source group's
--    library origin that is no longer a library group of the branch leaves the new dish's copy
--    with no source, as copy_branch_setup does.
--
-- Deploy: the migration first, then the admin. The RPC's signature and answer are unchanged (the
-- new dish's id back), and the dish's editor, the Modifier groups page ("N customized" counts the
-- new dish's copies), the storefront and place-order read the copy's groups and links as they
-- read every dish's. Only the admin's wording changes with it: the Duplicate toast and the item
-- form's hint (menu.json notices.copied, editor.showOnMenuHint) no longer say a copy starts
-- without option groups. That text must not ship before this migration, or it promises groups the
-- live RPC does not copy yet.
--
-- Rolled-back checks: supabase/tests/duplicate_menu_item_option_groups.sql.

begin;

create or replace function public.duplicate_menu_item(p_item_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_src public.menu_items%rowtype;
  v_new_id uuid;
  v_links jsonb;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_src from public.menu_items where id = p_item_id;
  if not found then raise exception 'item_not_found'; end if;
  if not private.user_manages_branch(v_src.branch_id) then raise exception 'not_authorized'; end if;
  insert into public.menu_items (
    branch_id, category_id, name, name_translations, description, description_translations,
    price, cost, image_url, image_urls, is_active, is_recommended, is_new, available_channels,
    track_stock, stock_quantity, low_stock_threshold, allergens, dietary_tags, prep_time_minutes,
    calories, station, display_order
  ) values (
    v_src.branch_id, v_src.category_id, v_src.name || ' (Copy)', v_src.name_translations,
    v_src.description, v_src.description_translations, v_src.price, v_src.cost, v_src.image_url,
    v_src.image_urls, false, v_src.is_recommended, false, v_src.available_channels,
    false, null, v_src.low_stock_threshold, v_src.allergens,
    v_src.dietary_tags, v_src.prep_time_minutes, v_src.calories, v_src.station, v_src.display_order + 1
  ) returning id into v_new_id;

  -- The option groups the source shows, read in this one statement. A library group of the
  -- branch is shown on the copy as it is, unless the source also shows its own copy of it (only
  -- with the link trigger off); a group the source owns gets a new id, minted here, for the copy's
  -- own group and its options, written in the same statement. The source of a copy is kept only
  -- while it is still a library group of the branch, which tg_modifier_groups_ownership checks.
  with src as materialized (
    select l.modifier_group_id as group_id, l.display_order as link_order,
           g.owner_menu_item_id is not null as own,
           case when g.owner_menu_item_id is not null then gen_random_uuid() end as copy_id,
           g.name, g.name_translations, g.selection_type, g.is_required, g.min_select, g.max_select,
           g.display_order, s.id as source_group_id
      from public.menu_item_modifiers l
      join public.modifier_groups g on g.id = l.modifier_group_id
      left join public.modifier_groups s
        on s.id = g.source_group_id and s.owner_menu_item_id is null and s.branch_id = v_src.branch_id
     where l.menu_item_id = p_item_id
       and g.branch_id = v_src.branch_id
       and (g.owner_menu_item_id = p_item_id
            or (g.owner_menu_item_id is null
                and not exists (select 1
                                  from public.menu_item_modifiers l2
                                  join public.modifier_groups c on c.id = l2.modifier_group_id
                                 where l2.menu_item_id = p_item_id
                                   and c.owner_menu_item_id = p_item_id
                                   and c.source_group_id = g.id)))
  ),
  own_groups as (
    insert into public.modifier_groups (
      id, branch_id, name, name_translations, selection_type, is_required, min_select, max_select, display_order,
      owner_menu_item_id, source_group_id
    )
    select k.copy_id, v_src.branch_id, k.name, k.name_translations, k.selection_type, k.is_required,
           k.min_select, k.max_select, k.display_order, v_new_id, k.source_group_id
      from src k
     where k.own
    returning id
  ),
  -- In the order the storefront lists them (display_order, then created_at and id for two at the
  -- same position), numbered 0..n-1: the copies all get this transaction's created_at.
  own_options as (
    insert into public.modifier_options (group_id, name, name_translations, price_delta, is_default, is_active, display_order)
    select k.copy_id, o.name, o.name_translations, o.price_delta, o.is_default, o.is_active,
           (row_number() over (partition by o.group_id order by o.display_order, o.created_at, o.id) - 1)::integer
      from src k
      join public.modifier_options o on o.group_id = k.group_id
     where k.own
    returning id
  )
  select coalesce(jsonb_agg(jsonb_build_object('group_id', coalesce(k.copy_id, k.group_id),
                                               'display_order', k.link_order)), '[]'::jsonb)
    into v_links
    from src k;

  -- The copy shows them where the source does, in a statement of its own so the link trigger finds
  -- the copy's own groups. A library group deleted, made a dish's own or moved to another branch
  -- since the read above is left off rather than failing the copy.
  insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order)
  select v_new_id, g.id, (e ->> 'display_order')::integer
    from jsonb_array_elements(v_links) e
    join public.modifier_groups g on g.id = (e ->> 'group_id')::uuid
   where g.branch_id = v_src.branch_id
     and (g.owner_menu_item_id is null or g.owner_menu_item_id = v_new_id);

  return v_new_id;
end $function$;

revoke all on function public.duplicate_menu_item(uuid) from public, anon;
grant execute on function public.duplicate_menu_item(uuid) to authenticated, service_role;

commit;
