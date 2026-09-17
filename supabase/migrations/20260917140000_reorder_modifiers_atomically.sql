-- Reordering option groups and options in one transaction.
--
-- The back office's Move up / Move down renumbered a list with one UPDATE per row. A move made
-- while a delete was in flight then hit a row that no longer existed and was rolled back as a
-- failure, and a network error halfway left two rows at the same position (the storefront and the
-- back office then broke that tie differently). These functions take the list in its new order and
-- renumber it 0..n-1 in a single statement:
--   * ids that no longer belong to the list (deleted meanwhile) are ignored;
--   * rows the caller did not list (added meanwhile in another tab) keep their relative order and
--     go after the listed ones, so nothing is dropped and no position is shared.
-- Same permission as editing the menu: private.staff_has_capability(branch, 'menu.manage').

create or replace function public.reorder_modifier_options(p_group_id uuid, p_option_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_branch uuid;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select g.branch_id into v_branch
    from public.modifier_groups g
   where g.id = p_group_id
     for update;
  if not found then
    raise exception 'group_not_found' using errcode = 'P0002';
  end if;
  if not private.staff_has_capability(v_branch, 'menu.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  with wanted as (
    select u.id, u.ord from unnest(coalesce(p_option_ids, '{}')) with ordinality as u(id, ord)
  ),
  ranked as (
    select o.id,
           row_number() over (
             order by (w.ord is null), w.ord, o.display_order, o.created_at, o.id
           ) - 1 as pos
      from public.modifier_options o
      left join wanted w on w.id = o.id
     where o.group_id = p_group_id
  )
  update public.modifier_options o
     set display_order = r.pos
    from ranked r
   where o.id = r.id
     and o.display_order is distinct from r.pos;
end;
$$;

create or replace function public.reorder_item_modifier_groups(p_menu_item_id uuid, p_group_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_branch uuid;
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

  with wanted as (
    select u.id, u.ord from unnest(coalesce(p_group_ids, '{}')) with ordinality as u(id, ord)
  ),
  ranked as (
    select l.modifier_group_id,
           row_number() over (
             order by (w.ord is null), w.ord, l.display_order, g.display_order, g.created_at, g.id
           ) - 1 as pos
      from public.menu_item_modifiers l
      join public.modifier_groups g on g.id = l.modifier_group_id
      left join wanted w on w.id = l.modifier_group_id
     where l.menu_item_id = p_menu_item_id
  )
  update public.menu_item_modifiers l
     set display_order = r.pos
    from ranked r
   where l.menu_item_id = p_menu_item_id
     and l.modifier_group_id = r.modifier_group_id
     and l.display_order is distinct from r.pos;
end;
$$;

comment on function public.reorder_modifier_options(uuid, uuid[]) is
  'Renumbers a modifier group''s options 0..n-1 in the given order in one statement. Unknown ids are ignored; unlisted options follow in their current order. Requires menu.manage.';
comment on function public.reorder_item_modifier_groups(uuid, uuid[]) is
  'Renumbers the option groups attached to a menu item 0..n-1 in the given order in one statement. Unknown ids are ignored; unlisted groups follow in their current order. Requires menu.manage.';

revoke execute on function public.reorder_modifier_options(uuid, uuid[]) from public, anon;
grant  execute on function public.reorder_modifier_options(uuid, uuid[]) to authenticated;
revoke execute on function public.reorder_item_modifier_groups(uuid, uuid[]) from public, anon;
grant  execute on function public.reorder_item_modifier_groups(uuid, uuid[]) to authenticated;
