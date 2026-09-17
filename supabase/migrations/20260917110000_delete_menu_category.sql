-- Deleting a menu category from the back office.
--
-- There was no way to remove a category: the menu screen could create one from the item editor
-- and nothing else, so test and misspelt categories piled up in every dropdown.
--
-- A plain DELETE is not safe, which is why this is a function rather than a policy change:
--   * menu_items.category_id is ON DELETE SET NULL. Every dish in the category would lose it and
--     drop off the storefront and the back-office grid, both of which list dishes by category.
--     So a category that still holds dishes (hidden ones included) is only deleted together with
--     moving those dishes into another category of the same branch, in one transaction.
--   * happy_hours.applies_to_category_ids scopes a discount to categories, and an empty category
--     list together with an empty item list means "every dish". Dropping the id would widen a
--     "Drinks only" happy hour to the whole menu. The category is swapped for the dishes it held,
--     so each happy hour keeps discounting exactly the same dishes. A happy hour whose only target
--     is this category while it holds no dishes cannot be rewritten that way; the delete is refused
--     and names it, so the merchant edits that happy hour first.
--
-- Concurrency: the category row is locked FOR UPDATE. Inserting or re-pointing a dish at it takes
-- a key-share lock on the same row for the foreign key check, so it waits and then fails against
-- the deleted row instead of slipping in between the move and the delete and losing its category.
-- The dishes themselves are locked as they are read, so a dish another manager is moving out at
-- that moment is either already gone from the list or waits; its move is never overwritten.
--
-- Tenancy: nothing ties a dish's or a happy hour's category ids to its own branch, and category ids
-- are public. Every read and write here is limited to the category's branch, so another
-- restaurant's rows can neither block the delete nor be changed by it.
--
-- Direct DELETE on menu_categories is revoked from the API roles: the RLS policy lets any staff
-- member (cashiers included) write categories, and a direct delete would skip every check above.
-- No application code deletes categories directly; this function runs as its owner.

create or replace function public.delete_menu_category(
  p_category_id uuid,
  p_move_items_to uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_cat         public.menu_categories%rowtype;
  v_item_ids    uuid[];
  v_target_max  integer;
  v_blocking    text;
  v_moved       integer := 0;
  v_happy_hours integer := 0;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select * into v_cat
    from public.menu_categories
   where id = p_category_id
     for update;
  if not found then
    raise exception 'category_not_found' using errcode = 'P0002';
  end if;

  if not private.staff_has_capability(v_cat.branch_id, 'menu.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select coalesce(array_agg(locked.id order by locked.display_order, locked.created_at), '{}')
    into v_item_ids
    from (
      select mi.id, mi.display_order, mi.created_at
        from public.menu_items mi
       where mi.category_id = p_category_id
         and mi.branch_id = v_cat.branch_id
         for update
    ) as locked;

  if cardinality(v_item_ids) > 0 then
    if p_move_items_to is null then
      raise exception 'category_not_empty' using errcode = 'P0001';
    end if;
    if p_move_items_to = p_category_id then
      raise exception 'invalid_move_target' using errcode = 'P0001';
    end if;
    perform 1
       from public.menu_categories t
      where t.id = p_move_items_to
        and t.branch_id = v_cat.branch_id
        for share;
    if not found then
      raise exception 'invalid_move_target' using errcode = 'P0001';
    end if;

    -- After the target's own dishes, in the order they had here.
    select coalesce(max(mi.display_order), -1)
      into v_target_max
      from public.menu_items mi
     where mi.category_id = p_move_items_to
       and mi.branch_id = v_cat.branch_id;

    update public.menu_items mi
       set category_id = p_move_items_to,
           display_order = v_target_max + moved.ord
      from unnest(v_item_ids) with ordinality as moved(id, ord)
     where mi.id = moved.id
       and mi.category_id = p_category_id
       and mi.branch_id = v_cat.branch_id;
    get diagnostics v_moved = row_count;
  end if;

  select string_agg(hh.name, ', ' order by hh.name)
    into v_blocking
    from public.happy_hours hh
   where hh.branch_id = v_cat.branch_id
     and p_category_id = any(hh.applies_to_category_ids)
     and cardinality(array_remove(hh.applies_to_category_ids, p_category_id)) = 0
     and cardinality(coalesce(hh.applies_to_item_ids, '{}')) = 0
     and cardinality(v_item_ids) = 0;
  if v_blocking is not null then
    raise exception 'category_used_by_happy_hour'
      using errcode = 'P0001', detail = v_blocking;
  end if;

  update public.happy_hours hh
     set applies_to_category_ids = array_remove(hh.applies_to_category_ids, p_category_id),
         applies_to_item_ids = (
           select coalesce(array_agg(distinct x), '{}')
             from unnest(coalesce(hh.applies_to_item_ids, '{}') || v_item_ids) as x
         )
   where hh.branch_id = v_cat.branch_id
     and p_category_id = any(hh.applies_to_category_ids);
  get diagnostics v_happy_hours = row_count;

  delete from public.menu_categories where id = p_category_id;

  return jsonb_build_object(
    'moved_items', v_moved,
    'happy_hours_updated', v_happy_hours
  );
end;
$$;

comment on function public.delete_menu_category(uuid, uuid) is
  'Deletes a menu category. Dishes still in it must be moved to another category of the same branch (p_move_items_to), in the same transaction; happy hours scoped to the category are rewritten to the dishes it held so their discount covers the same dishes. Requires menu.manage.';

revoke execute on function public.delete_menu_category(uuid, uuid) from public, anon;
grant  execute on function public.delete_menu_category(uuid, uuid) to authenticated;

revoke delete on table public.menu_categories from anon, authenticated;
