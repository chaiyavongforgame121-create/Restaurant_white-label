-- A dish's own option groups: a library group changed in a dish's editor becomes that dish's copy
-- (the owner's request of 2026-10-30). The per-dish editor in the menu item form wrote straight
-- through to the shared rows: deleting "Hot" from Spicy Level inside one dish deleted it from the
-- Modifier groups page and from every dish that shows the group, and removing the group from its
-- last dish deleted it from the library. The owner wants a library group attached to a dish to be
-- only shown there; a change or a deletion made in the dish's editor is saved for that dish alone
-- and never written over the library group.
--
-- 1. TWO KINDS OF GROUP. modifier_groups.owner_menu_item_id null: a LIBRARY group (the Modifier
--    groups page lists it; any dish of its branch may show it; editing it there changes every dish
--    that shows it). Set: that dish's OWN group, which no other dish may show and the library page
--    does not list: the dish's copy of a library group, or a group made in the dish's editor.
--    Deleting the dish deletes its own groups. modifier_groups.source_group_id: the library group a
--    copy was made from (null for a group made in the editor); deleting that library group leaves
--    the copy on its dish with source null. A source needs an owner
--    (modifier_groups_source_needs_owner). Every existing group stays a library group: nothing is
--    converted.
--
-- 2. INTEGRITY, 23514 with the code as the message (a missing dish or group is still the foreign
--    key's to report):
--      modifier_group_branch_mismatch  (the existing code) the owner dish is not on the group's
--                                      branch;
--      modifier_source_invalid         the source is not a library group of the group's branch, or
--                                      is the group itself;
--      modifier_group_owned_elsewhere  a dish's own group linked to another dish, a group made a
--                                      dish's own while another dish shows it, or a library group
--                                      linked to a dish that shows its own copy of it.
--    private.tg_modifier_groups_ownership (new: BEFORE INSERT OR UPDATE OF owner_menu_item_id,
--    source_group_id, branch_id on modifier_groups, for a row with an owner or a source) and
--    private.tg_menu_item_modifiers_same_branch (re-created from its live body with the two
--    owned-elsewhere checks added; it now reads the dish FOR KEY SHARE, so a link made while
--    customize_item_modifier_group or reset_item_modifier_group holds the dish waits for it and
--    then sees the copy, and the group FOR SHARE, so a link and a change of the group's owner made
--    at the same moment cannot both pass). Both SECURITY DEFINER, so a dish or group the caller
--    cannot see is still recognised.
--
-- 3. COPY ON FIRST CHANGE: public.customize_item_modifier_group(p_menu_item_id, p_group_id), which
--    the dish's editor awaits before its first write to a group that is not the dish's own. The
--    dish must show p_group_id. A library group is copied (name, translations, rules and position;
--    owner = the dish, source = the library group) with its options (name, translations, price,
--    default, active) numbered 0..n-1 in the storefront's order, and the dish shows the copy where
--    it showed the library group (the link row keeps its display_order). Answers {group_id: the
--    copy, copied: true, source_group_id: the library group, options: {<library option id>: <copy
--    option id>}}, which the editor uses to send the writes it queued meanwhile to the copy. A group
--    that is already the dish's own answers {group_id: p_group_id, copied: false, source_group_id:
--    its source or null, options: {<id>: <same id>}}, so a second call changes nothing.
--
-- 4. "USE THE LIBRARY VERSION": public.reset_item_modifier_group(p_menu_item_id, p_group_id). The
--    dish shows the library group p_group_id was copied from where it showed the copy, and the copy
--    is deleted with its options. Answers {group_id: the library group}. Only for a copy this dish
--    owns with a source (P0002 modifier_group_not_customized); the source must still be a library
--    group of the dish's branch (P0002 modifier_source_missing).
--
--    Both RPCs: SECURITY DEFINER; 42501 auth_required without a user; the dish is locked FOR UPDATE
--    (as reorder_item_modifier_groups does, so the three take turns on one dish) and must exist
--    (P0002 item_not_found); menu.manage at the dish's branch (42501 not_authorized); a link the
--    dish does not have is P0002 modifier_link_not_found. Authenticated only.
--
-- 5. copy_branch_setup, re-created from its live definition (pg_get_functiondef on 2026-10-30,
--    which matched 20261026100000_asap_delivery_switch) with the same arguments, owner, grants,
--    SECURITY DEFINER and search_path. Only the modifier groups' copy changed: library groups
--    first, then the dishes' own groups in a second statement (the ownership trigger checks that
--    the owner dish and the source exist), each pointing at the target's copy of its dish and of
--    its library group (a copy whose library group has since been made a dish's own goes over with
--    no source); modifier_groups_copied counts both. The options and the links were already copied
--    for every group of the branch, these included. duplicate_menu_item copies no option groups
--    and is unchanged.
--
-- Deploy order: place-order v11.10 first (it reads only menu_item_modifiers, which exists today; a
-- Management API / MCP deploy passes item-options.ts too). Then this migration: the admin and
-- storefront already live keep working on it, since every existing group has owner_menu_item_id
-- null and the new checks pass it by. Then admin and storefront together, in one push. Pushed
-- before this migration, the admin's reads of owner_menu_item_id and source_group_id fail
-- (42703): every dish's option list fails to load, and the Modifier groups page shows an empty
-- library. The admin is the only thing that makes copies, so place-order must be live before it.
--
-- Rolled-back checks: supabase/tests/item_modifier_copies.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. modifier_groups.owner_menu_item_id and source_group_id
-- ---------------------------------------------------------------------------------------------

alter table public.modifier_groups
  add column if not exists owner_menu_item_id uuid
    constraint modifier_groups_owner_menu_item_id_fkey references public.menu_items(id) on delete cascade,
  add column if not exists source_group_id uuid
    constraint modifier_groups_source_group_id_fkey references public.modifier_groups(id) on delete set null;

alter table public.modifier_groups drop constraint if exists modifier_groups_source_needs_owner;
alter table public.modifier_groups add constraint modifier_groups_source_needs_owner
  check (source_group_id is null or owner_menu_item_id is not null);

-- A dish's delete finds its own groups by the first; the library page counts a group's copies by
-- the second, and a library group's delete clears their source by it.
create index if not exists idx_modifier_groups_owner_menu_item
  on public.modifier_groups (owner_menu_item_id) where owner_menu_item_id is not null;
create index if not exists idx_modifier_groups_source_group
  on public.modifier_groups (source_group_id) where source_group_id is not null;

comment on column public.modifier_groups.owner_menu_item_id is
  'Null: a library group (the Modifier groups page; any dish of the branch may show it). Set: that dish''s own group, shown on that dish only and not in the library: its copy of a library group (customize_item_modifier_group) or one made in its editor. Deleted with the dish.';
comment on column public.modifier_groups.source_group_id is
  'The library group this dish''s own group was copied from (reset_item_modifier_group goes back to it). Null for a group made in the dish''s editor, and once that library group is deleted. Needs owner_menu_item_id.';

-- ---------------------------------------------------------------------------------------------
-- 2. Integrity: who owns a group, what a copy was made from, who may show it
-- ---------------------------------------------------------------------------------------------

-- BEFORE INSERT OR UPDATE OF owner_menu_item_id, source_group_id, branch_id on modifier_groups, for
-- a row with an owner or a source. Runs as its owner, like tg_menu_item_modifiers_same_branch, so a
-- dish or group the caller cannot see is still recognised.
create or replace function private.tg_modifier_groups_ownership()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_owner_branch  uuid;
  v_source_branch uuid;
  v_source_owner  uuid;
begin
  if tg_op = 'UPDATE'
     and new.owner_menu_item_id is not distinct from old.owner_menu_item_id
     and new.source_group_id is not distinct from old.source_group_id
     and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;

  -- A dish's own group belongs to the dish's menu. A dish that does not exist is the foreign key's
  -- to report.
  if new.owner_menu_item_id is not null then
    select mi.branch_id into v_owner_branch from public.menu_items mi where mi.id = new.owner_menu_item_id;
    if v_owner_branch is not null and v_owner_branch <> new.branch_id then
      raise exception 'modifier_group_branch_mismatch'
        using errcode = '23514',
              detail  = format('dish %s is not on the menu of modifier group %s''s branch', new.owner_menu_item_id, new.id);
    end if;
  end if;

  -- A copy is made from a library group of its own branch. A group that does not exist is the
  -- foreign key's to report; the group itself would pass it, so that is checked here.
  if new.source_group_id is not null then
    if new.source_group_id = new.id then
      raise exception 'modifier_source_invalid'
        using errcode = '23514',
              detail  = format('modifier group %s cannot be a copy of itself', new.id);
    end if;
    select s.branch_id, s.owner_menu_item_id into v_source_branch, v_source_owner
      from public.modifier_groups s
     where s.id = new.source_group_id;
    if found and (v_source_owner is not null or v_source_branch <> new.branch_id) then
      raise exception 'modifier_source_invalid'
        using errcode = '23514',
              detail  = format('modifier group %s is not in the Modifier groups library of modifier group %s''s branch',
                               new.source_group_id, new.id);
    end if;
  end if;

  -- No other dish may show a dish's own group (only an update can find a link: a new group has
  -- none). tg_menu_item_modifiers_same_branch reads the group FOR SHARE, so a link being made now
  -- waits for this row and is then checked against its new owner, and this update waits for a link
  -- made first and finds it here.
  if new.owner_menu_item_id is not null
     and exists (select 1 from public.menu_item_modifiers l
                  where l.modifier_group_id = new.id
                    and l.menu_item_id <> new.owner_menu_item_id) then
    raise exception 'modifier_group_owned_elsewhere'
      using errcode = '23514',
            detail  = format('modifier group %s is shown on another dish', new.id);
  end if;
  return new;
end;
$function$;

revoke all on function private.tg_modifier_groups_ownership() from public, anon, authenticated;

drop trigger if exists trg_modifier_groups_ownership on public.modifier_groups;
create trigger trg_modifier_groups_ownership
  before insert or update of owner_menu_item_id, source_group_id, branch_id on public.modifier_groups
  for each row
  when (new.owner_menu_item_id is not null or new.source_group_id is not null)
  execute function private.tg_modifier_groups_ownership();

-- The link trigger: the live body; the dish is read FOR KEY SHARE and the group FOR SHARE, and the
-- two owned-elsewhere checks are new. A dish's modifier groups come from the dish's own branch.
-- Runs as its owner so a group the caller cannot see is still recognised as foreign (the foreign
-- key ignores RLS).
create or replace function private.tg_menu_item_modifiers_same_branch()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_item_branch  uuid;
  v_group_branch uuid;
  v_group_owner  uuid;
begin
  -- FOR KEY SHARE, the lock the foreign key takes on the dish anyway, taken here before the checks
  -- below: a link made while customize_item_modifier_group or reset_item_modifier_group holds the
  -- dish (FOR UPDATE) waits for it to commit, and then finds the copy.
  select mi.branch_id into v_item_branch
    from public.menu_items mi
   where mi.id = new.menu_item_id
     for key share;
  -- FOR SHARE: the group cannot be made another dish's own while this link is being made
  -- (tg_modifier_groups_ownership).
  select mg.branch_id, mg.owner_menu_item_id into v_group_branch, v_group_owner
    from public.modifier_groups mg
   where mg.id = new.modifier_group_id
     for share;
  -- A row that does not exist is the foreign key's to report.
  if v_item_branch is null or v_group_branch is null then
    return new;
  end if;
  if v_item_branch <> v_group_branch then
    raise exception 'modifier_group_branch_mismatch'
      using errcode = '23514',
            detail  = format('modifier group %s is not on the menu of this dish''s branch', new.modifier_group_id);
  end if;
  -- A dish shows a library group or its own copy of it, never both: customize_item_modifier_group
  -- moved the dish's link to the copy, and a screen loaded before that adding the library group
  -- again would list it twice. The row being updated is left out, so reset_item_modifier_group's
  -- move from the copy back to its library group goes through.
  if v_group_owner is null
     and exists (select 1
                   from public.menu_item_modifiers l
                   join public.modifier_groups c on c.id = l.modifier_group_id
                  where l.menu_item_id = new.menu_item_id
                    and c.owner_menu_item_id = new.menu_item_id
                    and c.source_group_id = new.modifier_group_id
                    and (tg_op = 'INSERT' or l.modifier_group_id <> old.modifier_group_id)) then
    raise exception 'modifier_group_owned_elsewhere'
      using errcode = '23514',
            detail  = format('this dish already shows its own copy of modifier group %s', new.modifier_group_id);
  end if;
  -- A dish's own group (its copy of a library group, or one made in its editor) shows on that dish
  -- only.
  if v_group_owner is not null and v_group_owner <> new.menu_item_id then
    raise exception 'modifier_group_owned_elsewhere'
      using errcode = '23514',
            detail  = format('modifier group %s belongs to another dish', new.modifier_group_id);
  end if;
  return new;
end;
$function$;

revoke all on function private.tg_menu_item_modifiers_same_branch() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. public.customize_item_modifier_group: the dish's own copy, made on its first change
-- ---------------------------------------------------------------------------------------------

create or replace function public.customize_item_modifier_group(p_menu_item_id uuid, p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch  uuid;
  v_group   public.modifier_groups%rowtype;
  v_copy_id uuid;
  v_options jsonb;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  -- One change at a time on a dish: this, reset_item_modifier_group and
  -- reorder_item_modifier_groups all lock the dish first. It also holds back a link being added to
  -- the dish meanwhile: tg_menu_item_modifiers_same_branch locks the dish before it checks, so it
  -- waits for this to commit and then finds the copy.
  select mi.branch_id into v_branch
    from public.menu_items mi
   where mi.id = p_menu_item_id
     for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if not private.staff_has_capability(v_branch, 'menu.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- The group, held against a delete until this commits (deleting a library group takes the group
  -- first and then its links, in the same order as here, so the two cannot deadlock). Only one this
  -- dish shows.
  select g.* into v_group
    from public.modifier_groups g
   where g.id = p_group_id
     for key share;
  if not found
     or not exists (select 1 from public.menu_item_modifiers l
                     where l.menu_item_id = p_menu_item_id and l.modifier_group_id = p_group_id) then
    raise exception 'modifier_link_not_found' using errcode = 'P0002';
  end if;

  -- Already this dish's own (its copy, or made in its editor): the change goes straight to it.
  if v_group.owner_menu_item_id = p_menu_item_id then
    return jsonb_build_object(
      'group_id', p_group_id,
      'copied', false,
      'source_group_id', v_group.source_group_id,
      'options', coalesce((select jsonb_object_agg(o.id::text, o.id::text)
                             from public.modifier_options o
                            where o.group_id = p_group_id), '{}'::jsonb));
  end if;
  -- Another dish's own group, which tg_menu_item_modifiers_same_branch never lets a dish show.
  if v_group.owner_menu_item_id is not null then
    raise exception 'modifier_group_owned_elsewhere'
      using errcode = '23514',
            detail  = format('modifier group %s belongs to another dish', p_group_id);
  end if;

  -- The copy: the library group's name, rules and place, owned by this dish. Written into the
  -- dish's branch, the one menu.manage was checked at (the library group's, as the link says).
  insert into public.modifier_groups (
    branch_id, name, name_translations, selection_type, is_required, min_select, max_select, display_order,
    owner_menu_item_id, source_group_id
  )
  values (
    v_branch, v_group.name, v_group.name_translations, v_group.selection_type, v_group.is_required,
    v_group.min_select, v_group.max_select, v_group.display_order,
    p_menu_item_id, p_group_id
  )
  returning id into v_copy_id;

  -- Its options, in the order the storefront lists them (display_order, then created_at and id
  -- for two at the same position), numbered 0..n-1. The copies' ids are minted in the same
  -- statement that inserts them, so the map handed back is exactly what was inserted, even while
  -- the library group is being edited.
  with src as materialized (
    select o.id, gen_random_uuid() as copy_id, o.name, o.name_translations, o.price_delta, o.is_default,
           o.is_active, (row_number() over (order by o.display_order, o.created_at, o.id) - 1)::integer as pos
      from public.modifier_options o
     where o.group_id = p_group_id
  ),
  copied as (
    insert into public.modifier_options (id, group_id, name, name_translations, price_delta, is_default, is_active, display_order)
    select s.copy_id, v_copy_id, s.name, s.name_translations, s.price_delta, s.is_default, s.is_active, s.pos
      from src s
    returning id
  )
  select coalesce(jsonb_object_agg(s.id::text, s.copy_id::text), '{}'::jsonb) into v_options
    from src s;

  -- The dish shows the copy where it showed the library group: the same link row, so its
  -- display_order stays. Taken off the dish meanwhile (a link's delete does not wait for the dish):
  -- nothing is kept.
  update public.menu_item_modifiers l
     set modifier_group_id = v_copy_id
   where l.menu_item_id = p_menu_item_id
     and l.modifier_group_id = p_group_id;
  if not found then
    raise exception 'modifier_link_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'group_id', v_copy_id,
    'copied', true,
    'source_group_id', p_group_id,
    'options', v_options
  );
end;
$function$;

comment on function public.customize_item_modifier_group(uuid, uuid) is
  'Makes p_group_id this dish''s own before the dish''s editor changes it. A library group the dish shows is copied (name, translations, rules, position; options renumbered 0..n-1 in the storefront''s order) with owner_menu_item_id = the dish and source_group_id = the library group, and the dish shows the copy at the same position. Returns {group_id, copied, source_group_id, options: {<library option id>: <copy option id>}}; a group that is already the dish''s own answers copied = false with its own ids. P0002 item_not_found / modifier_link_not_found, 23514 modifier_group_owned_elsewhere. Requires menu.manage at the dish''s branch.';

revoke all on function public.customize_item_modifier_group(uuid, uuid) from public, anon, service_role;
grant execute on function public.customize_item_modifier_group(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. public.reset_item_modifier_group: "Use the library version"
-- ---------------------------------------------------------------------------------------------

create or replace function public.reset_item_modifier_group(p_menu_item_id uuid, p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch uuid;
  v_source uuid;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select mi.branch_id into v_branch
    from public.menu_items mi
   where mi.id = p_menu_item_id
     for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if not private.staff_has_capability(v_branch, 'menu.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- A copy this dish owns, still naming its library group. A group made in the editor has no
  -- source, nor has a copy whose library group was deleted.
  select g.source_group_id into v_source
    from public.modifier_groups g
   where g.id = p_group_id
     and g.owner_menu_item_id = p_menu_item_id;
  if v_source is null then
    raise exception 'modifier_group_not_customized' using errcode = 'P0002';
  end if;

  -- The library group, held against a delete until this commits; one deleted, made a dish's own or
  -- moved to another branch meanwhile is gone from the library.
  perform 1
     from public.modifier_groups s
    where s.id = v_source
      and s.owner_menu_item_id is null
      and s.branch_id = v_branch
      for key share;
  if not found then
    raise exception 'modifier_source_missing' using errcode = 'P0002';
  end if;

  -- The dish shows the library group where it showed the copy: the same link row, so its
  -- display_order stays. A dish that somehow shows both keeps the library group where it is (the
  -- copy's link goes with the copy below); a copy taken off the dish by hand gives way to the
  -- library group at the end of the list.
  if not exists (select 1 from public.menu_item_modifiers l
                  where l.menu_item_id = p_menu_item_id and l.modifier_group_id = v_source) then
    update public.menu_item_modifiers l
       set modifier_group_id = v_source
     where l.menu_item_id = p_menu_item_id
       and l.modifier_group_id = p_group_id;
    if not found then
      insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order)
      select p_menu_item_id, v_source, coalesce(max(l.display_order) + 1, 0)
        from public.menu_item_modifiers l
       where l.menu_item_id = p_menu_item_id;
    end if;
  end if;

  -- The copy goes, and its options and any link to it with it.
  delete from public.modifier_groups g
   where g.id = p_group_id
     and g.owner_menu_item_id = p_menu_item_id;

  return jsonb_build_object('group_id', v_source);
end;
$function$;

comment on function public.reset_item_modifier_group(uuid, uuid) is
  '"Use the library version": the dish shows the library group its copy p_group_id was made from, at the copy''s position, and the copy is deleted with its options. Returns {group_id: <the library group>}. P0002 item_not_found / modifier_group_not_customized (not a copy this dish owns, or its library group was deleted) / modifier_source_missing (its library group is no longer in the branch''s library). Requires menu.manage at the dish''s branch.';

revoke all on function public.reset_item_modifier_group(uuid, uuid) from public, anon, service_role;
grant execute on function public.reset_item_modifier_group(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. public.copy_branch_setup (live body; library groups first, then the dishes' own groups)
-- ---------------------------------------------------------------------------------------------

create or replace function public.copy_branch_setup(p_source_branch_id uuid, p_target_branch_id uuid, p_copy_menu boolean, p_copy_hours boolean, p_copy_settings boolean, p_copy_look boolean default false, p_copy_loyalty boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  -- The payment, delivery, tip, service-fee, kitchen-timing, dine-in and scheduling settings the
  -- Branch settings cards edit, plus the currency the copied prices are written in.
  -- Deliberately absent:
  --   qr_transfer            the source branch's bank account. Each branch uploads its own.
  --   storefront_override    the look, copied only with p_copy_look.
  --   orders_paused, busy_extra_prep_min   the source kitchen's live state.
  --   driver_* tuning        set by the platform.
  --   delivery_min_fee, delivery_max_fee, batch_max_dropoff_mi   read by nothing.
  v_setting_keys constant text[] := array[
    'currency', 'payment_methods', 'tip_config', 'service_fee_percent', 'prep_time_min', 'dine_in',
    'delivery_mode', 'delivery_hours_enabled', 'delivery_base_fee', 'delivery_per_km_fee',
    'delivery_radius_km', 'delivery_surge_from_mi', 'delivery_surge_multiplier',
    'batch_enabled', 'batch_max_detour_mi',
    'scheduling_enabled', 'schedule_hours_enabled', 'schedule_min_lead_min', 'schedule_max_days',
    'schedule_slot_minutes', 'schedule_lead_time_min', 'asap_delivery_enabled'
  ];
  -- Theme keys that describe the logo or icons rather than colours; each branch owns those.
  v_icon_theme_keys constant text[] := array['logoUrl', 'logo_url', 'faviconUrl', 'appIcon', 'brandName'];
  v_source public.branches%rowtype;
  v_target public.branches%rowtype;
  v_cat_map jsonb;
  v_item_map jsonb;
  v_group_map jsonb;
  v_combo_map jsonb;
  v_settings jsonb;
  v_pm jsonb;
  v_target_has_qr boolean;
  v_source_transfer boolean := false;
  v_transfer_needs_qr boolean := false;
  v_categories int := 0;
  v_stations int := 0;
  v_items int := 0;
  v_groups int := 0;
  v_own_groups int := 0;
  v_combos int := 0;
  v_stock_off int := 0;
  v_hours int := 0;
  v_schedule_windows int := 0;
  v_settings_copied boolean := false;
  v_tax_copied boolean := false;
  v_look_copied boolean := false;
  v_loyalty jsonb;
  v_ladder jsonb;
  v_loyalty_copied boolean := false;
  v_rewards int := 0;
  v_rewards_skipped int := 0;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if p_source_branch_id is null or p_target_branch_id is null then raise exception 'branch_required'; end if;
  -- Nothing ticked means nothing to authorise, so answer before the lookups below could tell a
  -- caller whether two branch ids share a restaurant.
  if not (coalesce(p_copy_menu, false) or coalesce(p_copy_hours, false) or coalesce(p_copy_settings, false)
          or coalesce(p_copy_look, false) or coalesce(p_copy_loyalty, false)) then
    return jsonb_build_object('categories_copied', 0, 'stations_copied', 0, 'items_copied', 0, 'modifier_groups_copied', 0,
                              'combos_copied', 0, 'stock_tracking_off', 0, 'hours_copied', 0,
                              'schedule_windows_copied', 0, 'settings_copied', false, 'tax_copied', false,
                              'transfer_needs_qr', false, 'look_copied', false,
                              'loyalty_copied', false, 'rewards_copied', 0, 'rewards_skipped', 0);
  end if;
  if p_source_branch_id = p_target_branch_id then raise exception 'same_branch'; end if;

  select * into v_source from public.branches where id = p_source_branch_id;
  if not found then raise exception 'source_not_found'; end if;
  -- Locked so two retries of the same copy cannot both find the target menu empty.
  select * into v_target from public.branches where id = p_target_branch_id for update;
  if not found then raise exception 'target_not_found'; end if;
  if v_source.restaurant_id <> v_target.restaurant_id then raise exception 'different_restaurant'; end if;

  if coalesce(p_copy_menu, false) then
    if not (private.staff_has_capability(p_source_branch_id, 'menu.manage')
            and private.staff_has_capability(p_target_branch_id, 'menu.manage')) then
      raise exception 'not_authorized';
    end if;
    -- Copying into a branch that already has a menu would duplicate every dish and group.
    if exists (select 1 from public.menu_items where branch_id = p_target_branch_id)
       or exists (select 1 from public.menu_categories where branch_id = p_target_branch_id)
       or exists (select 1 from public.modifier_groups where branch_id = p_target_branch_id)
       or exists (select 1 from public.combo_sets where branch_id = p_target_branch_id) then
      raise exception 'target_menu_not_empty';
    end if;
  end if;

  if (coalesce(p_copy_hours, false) or coalesce(p_copy_settings, false) or coalesce(p_copy_look, false))
     and not (private.staff_has_capability(p_source_branch_id, 'branch.settings')
              and private.staff_has_capability(p_target_branch_id, 'branch.settings')) then
    raise exception 'not_authorized';
  end if;

  if coalesce(p_copy_loyalty, false) then
    if not (private.staff_has_capability(p_source_branch_id, 'loyalty.manage')
            and private.staff_has_capability(p_target_branch_id, 'loyalty.manage')) then
      raise exception 'not_authorized';
    end if;
    -- Like the menu: copying next to an existing catalogue would list every reward twice.
    if exists (select 1 from public.loyalty_rewards where branch_id = p_target_branch_id) then
      raise exception 'target_rewards_not_empty';
    end if;
  end if;

  if coalesce(p_copy_menu, false) then
    -- Fresh ids are minted up front so every child row can point at its copied parent.
    select coalesce(jsonb_object_agg(c.id::text, gen_random_uuid()), '{}'::jsonb) into v_cat_map
      from public.menu_categories c where c.branch_id = p_source_branch_id;
    select coalesce(jsonb_object_agg(i.id::text, gen_random_uuid()), '{}'::jsonb) into v_item_map
      from public.menu_items i where i.branch_id = p_source_branch_id;
    select coalesce(jsonb_object_agg(g.id::text, gen_random_uuid()), '{}'::jsonb) into v_group_map
      from public.modifier_groups g where g.branch_id = p_source_branch_id;
    -- Archived combos are history, not menu. Read as JSON so this holds with or without the column.
    select coalesce(jsonb_object_agg(cs.id::text, gen_random_uuid()), '{}'::jsonb) into v_combo_map
      from public.combo_sets cs
     where cs.branch_id = p_source_branch_id
       and (to_jsonb(cs) ->> 'archived_at') is null;

    insert into public.menu_categories (
      id, branch_id, name, name_translations, description, icon_emoji, display_order, is_active, available_hours
    )
    select (v_cat_map ->> c.id::text)::uuid, p_target_branch_id, c.name, c.name_translations, c.description,
           c.icon_emoji, c.display_order, c.is_active, c.available_hours
      from public.menu_categories c
     where c.branch_id = p_source_branch_id;
    get diagnostics v_categories = row_count;

    -- Kitchen stations before the dishes, which may only name a station their branch has
    -- (menu_items_branch_id_station_fkey). The target's menu is empty (checked above, with the
    -- target row locked so no dish can be added meanwhile), so none of its stations is in use, and
    -- its list is replaced by the source's, keys, names and order included, as hours are: the
    -- copied dishes keep their keys, and a station of the same name under another key would
    -- collide with the source's.
    delete from public.kitchen_stations where branch_id = p_target_branch_id;
    insert into public.kitchen_stations (branch_id, key, name, display_order)
    select p_target_branch_id, s.key, s.name, s.display_order
      from public.kitchen_stations s
     where s.branch_id = p_source_branch_id;
    get diagnostics v_stations = row_count;

    -- Stock counts, sold-out-until and ratings are the source kitchen's live state, not menu. The
    -- new kitchen has counted nothing, so tracking starts off (a tracked dish with no count shows
    -- as sold out); the merchant switches it on after the first stock count.
    select count(*) into v_stock_off
      from public.menu_items i
     where i.branch_id = p_source_branch_id and i.track_stock;

    insert into public.menu_items (
      id, branch_id, category_id, name, name_translations, description, description_translations,
      price, cost, image_url, image_urls, is_active, is_recommended, is_new, available_channels,
      track_stock, low_stock_threshold, allergens, dietary_tags, prep_time_minutes, calories,
      display_order, layout_config, slug, station, availability_schedule, requires_age_verification
    )
    select (v_item_map ->> i.id::text)::uuid, p_target_branch_id, (v_cat_map ->> i.category_id::text)::uuid,
           i.name, i.name_translations, i.description, i.description_translations,
           i.price, i.cost, i.image_url, i.image_urls, i.is_active, i.is_recommended, i.is_new, i.available_channels,
           false, i.low_stock_threshold, i.allergens, i.dietary_tags, i.prep_time_minutes, i.calories,
           i.display_order, i.layout_config, i.slug, i.station, i.availability_schedule, i.requires_age_verification
      from public.menu_items i
     where i.branch_id = p_source_branch_id;
    get diagnostics v_items = row_count;

    -- Library groups first, then the dishes' own groups (their copies of library groups and the
    -- groups made in their editors), whose dish and library group tg_modifier_groups_ownership
    -- checks exist: each points at the target's copy of its dish and of its library group. That
    -- trigger checks a copy's source only when the copy itself is written, so a copy whose library
    -- group has since been made a dish's own keeps no source in the target (the join to s below
    -- finds nothing), as reset_item_modifier_group already treats it (modifier_source_missing).
    -- Mapped as it stands, it would fail the whole copy or name an owned group, depending on which
    -- of the two rows was copied first.
    insert into public.modifier_groups (
      id, branch_id, name, name_translations, selection_type, is_required, min_select, max_select, display_order
    )
    select (v_group_map ->> g.id::text)::uuid, p_target_branch_id, g.name, g.name_translations, g.selection_type,
           g.is_required, g.min_select, g.max_select, g.display_order
      from public.modifier_groups g
     where g.branch_id = p_source_branch_id
       and g.owner_menu_item_id is null;
    get diagnostics v_groups = row_count;

    insert into public.modifier_groups (
      id, branch_id, name, name_translations, selection_type, is_required, min_select, max_select, display_order,
      owner_menu_item_id, source_group_id
    )
    select (v_group_map ->> g.id::text)::uuid, p_target_branch_id, g.name, g.name_translations, g.selection_type,
           g.is_required, g.min_select, g.max_select, g.display_order,
           (v_item_map ->> g.owner_menu_item_id::text)::uuid, (v_group_map ->> s.id::text)::uuid
      from public.modifier_groups g
      left join public.modifier_groups s
        on s.id = g.source_group_id and s.owner_menu_item_id is null and s.branch_id = p_source_branch_id
     where g.branch_id = p_source_branch_id
       and g.owner_menu_item_id is not null;
    get diagnostics v_own_groups = row_count;
    v_groups := v_groups + v_own_groups;

    insert into public.modifier_options (group_id, name, name_translations, price_delta, is_default, is_active, display_order)
    select (v_group_map ->> o.group_id::text)::uuid, o.name, o.name_translations, o.price_delta,
           o.is_default, o.is_active, o.display_order
      from public.modifier_options o
      join public.modifier_groups g on g.id = o.group_id
     where g.branch_id = p_source_branch_id;

    -- A link to another branch's group has no copy to point at, so it is left behind.
    insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order)
    select (v_item_map ->> m.menu_item_id::text)::uuid, (v_group_map ->> m.modifier_group_id::text)::uuid, m.display_order
      from public.menu_item_modifiers m
      join public.menu_items i on i.id = m.menu_item_id
     where i.branch_id = p_source_branch_id
       and v_group_map ? m.modifier_group_id::text;

    insert into public.combo_sets (id, branch_id, name, description, total_price, image_url, is_active, display_order)
    select (v_combo_map ->> cs.id::text)::uuid, p_target_branch_id, cs.name, cs.description, cs.total_price,
           cs.image_url, cs.is_active, cs.display_order
      from public.combo_sets cs
     where cs.branch_id = p_source_branch_id
       and v_combo_map ? cs.id::text;
    get diagnostics v_combos = row_count;

    -- Each dish of a combo points at its copy; one that is not on the source menu has none.
    insert into public.combo_items (combo_id, menu_item_id, quantity, is_swappable, swap_group, position)
    select (v_combo_map ->> ci.combo_id::text)::uuid, (v_item_map ->> ci.menu_item_id::text)::uuid,
           ci.quantity, ci.is_swappable, ci.swap_group, ci.position
      from public.combo_items ci
     where v_combo_map ? ci.combo_id::text
       and v_item_map ? ci.menu_item_id::text;
  end if;

  if coalesce(p_copy_hours, false) then
    -- Replaced, not merged, like set_branch_hours: copying hours means "open when that branch is".
    delete from public.branch_hours where branch_id = p_target_branch_id;
    insert into public.branch_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_hours h
     where h.branch_id = p_source_branch_id;
    get diagnostics v_hours = row_count;
  end if;

  if coalesce(p_copy_settings, false) then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_settings
      from jsonb_each(case when jsonb_typeof(v_source.settings) = 'object' then v_source.settings else '{}'::jsonb end) e
     where e.key = any (v_setting_keys);

    -- "Accept ASAP delivery orders" is off unless it is exactly true, so a source that never
    -- ticked it is copied as an explicit false: merged as it stands, the target kept its own true.
    v_settings := v_settings || jsonb_build_object('asap_delivery_enabled',
      coalesce((v_source.settings -> 'asap_delivery_enabled') = 'true'::jsonb, false));

    -- Transfer needs this branch's own QR (place-order refuses transfer without one). Until it has
    -- one, the copied matrix takes transfer off in both modes and the caller is told why.
    v_target_has_qr := coalesce(btrim(v_target.settings #>> '{qr_transfer,image_url}'), '') <> '';
    if jsonb_typeof(v_settings -> 'payment_methods') = 'object' and not v_target_has_qr then
      v_pm := v_settings -> 'payment_methods';
      v_source_transfer := (v_pm #> '{asap,transfer}') = 'true'::jsonb
                        or (v_pm #> '{scheduled,transfer}') = 'true'::jsonb;
      v_pm := v_pm || jsonb_build_object(
        'asap', (case when jsonb_typeof(v_pm -> 'asap') = 'object' then v_pm -> 'asap' else '{}'::jsonb end)
                || '{"transfer": false}'::jsonb,
        'scheduled', (case when jsonb_typeof(v_pm -> 'scheduled') = 'object' then v_pm -> 'scheduled' else '{}'::jsonb end)
                || '{"transfer": false}'::jsonb);
      v_settings := v_settings || jsonb_build_object('payment_methods', v_pm);
      v_transfer_needs_qr := v_source_transfer;
    end if;

    update public.branches b
       set settings = (case when jsonb_typeof(b.settings) = 'object' then b.settings else '{}'::jsonb end)
                      || v_settings,
           sales_tax_rate = v_source.sales_tax_rate
     where b.id = p_target_branch_id;
    v_settings_copied := v_settings <> '{}'::jsonb;
    v_tax_copied := true;

    -- delivery_hours_enabled copied without its windows would close delivery all week.
    delete from public.branch_delivery_hours where branch_id = p_target_branch_id;
    insert into public.branch_delivery_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_delivery_hours h
     where h.branch_id = p_source_branch_id;

    -- Likewise schedule_hours_enabled without its booking windows would refuse every booking.
    delete from public.branch_schedule_hours where branch_id = p_target_branch_id;
    insert into public.branch_schedule_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_schedule_hours h
     where h.branch_id = p_source_branch_id;
    get diagnostics v_schedule_windows = row_count;
  end if;

  if coalesce(p_copy_look, false) then
    -- Colours, layout and hero. Never the logo or icons: every branch uploads its own.
    update public.branches b
       set theme_override = (case when jsonb_typeof(v_source.theme_override) = 'object'
                                  then v_source.theme_override else '{}'::jsonb end) - v_icon_theme_keys,
           settings = case
                        when jsonb_typeof(v_source.settings -> 'storefront_override') = 'object'
                          then (case when jsonb_typeof(b.settings) = 'object' then b.settings else '{}'::jsonb end)
                               || jsonb_build_object('storefront_override', v_source.settings -> 'storefront_override')
                        else b.settings
                      end
     where b.id = p_target_branch_id;
    v_look_copied := true;
  end if;

  if coalesce(p_copy_loyalty, false) then
    -- The programme. A source that never saved one runs on the platform defaults ('{}'), and so
    -- will the copy.
    select bls.settings into v_loyalty
      from public.branch_loyalty_settings bls
     where bls.branch_id = p_source_branch_id;
    insert into public.branch_loyalty_settings (branch_id, restaurant_id, settings, updated_at, updated_by)
    values (p_target_branch_id, v_target.restaurant_id, coalesce(v_loyalty, '{}'::jsonb), now(), auth.uid())
    on conflict (branch_id) do update
       set settings = excluded.settings,
           restaurant_id = excluded.restaurant_id,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by;
    v_loyalty_copied := true;

    -- Members this branch already has are re-graded on the ladder they now follow, as
    -- set_loyalty_settings does. A brand-new branch has none.
    v_ladder := public.loyalty_settings_for(p_target_branch_id);
    update public.loyalty_points lp
       set tier = (case
                     when lp.lifetime_earned >= (v_ladder ->> 'platinum')::int then 'platinum'
                     when lp.lifetime_earned >= (v_ladder ->> 'gold')::int     then 'gold'
                     when lp.lifetime_earned >= (v_ladder ->> 'silver')::int   then 'silver'
                     else 'bronze'
                   end)::loyalty_tier
     where lp.branch_id = p_target_branch_id
       and lp.tier is distinct from (case
                     when lp.lifetime_earned >= (v_ladder ->> 'platinum')::int then 'platinum'
                     when lp.lifetime_earned >= (v_ladder ->> 'gold')::int     then 'gold'
                     when lp.lifetime_earned >= (v_ladder ->> 'silver')::int   then 'silver'
                     else 'bronze'
                   end)::loyalty_tier;

    -- The catalogue. A free-item reward must name a dish on this branch's own menu, which only
    -- exists when the menu was copied in this same call.
    insert into public.loyalty_rewards (
      branch_id, restaurant_id, name, description, kind, points_cost, value, max_discount,
      menu_item_id, min_subtotal, is_active, sort_order
    )
    select p_target_branch_id, v_target.restaurant_id, r.name, r.description, r.kind, r.points_cost,
           r.value, r.max_discount,
           case when r.menu_item_id is not null then (v_item_map ->> r.menu_item_id::text)::uuid end,
           r.min_subtotal, r.is_active, r.sort_order
      from public.loyalty_rewards r
     where r.branch_id = p_source_branch_id
       and (r.menu_item_id is null or coalesce(v_item_map, '{}'::jsonb) ? r.menu_item_id::text);
    get diagnostics v_rewards = row_count;

    select count(*) into v_rewards_skipped
      from public.loyalty_rewards r
     where r.branch_id = p_source_branch_id
       and r.menu_item_id is not null
       and not (coalesce(v_item_map, '{}'::jsonb) ? r.menu_item_id::text);
  end if;

  return jsonb_build_object(
    'categories_copied', v_categories,
    'stations_copied', v_stations,
    'items_copied', v_items,
    'modifier_groups_copied', v_groups,
    'combos_copied', v_combos,
    'stock_tracking_off', v_stock_off,
    'hours_copied', v_hours,
    'schedule_windows_copied', v_schedule_windows,
    'settings_copied', v_settings_copied,
    'tax_copied', v_tax_copied,
    'sales_tax_rate', case when v_tax_copied then v_source.sales_tax_rate end,
    'transfer_needs_qr', v_transfer_needs_qr,
    'look_copied', v_look_copied,
    'loyalty_copied', v_loyalty_copied,
    'rewards_copied', v_rewards,
    'rewards_skipped', v_rewards_skipped
  );
end $function$;

revoke all on function public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean, boolean, boolean)
  to authenticated, service_role;

commit;
