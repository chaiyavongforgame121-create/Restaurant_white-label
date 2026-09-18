-- Combos: one branch per deal, availability, archive instead of delete, and a whole-card save.
--
-- Found when the owner opened a second branch (Food Thai Thai) and asked where a combo's picture
-- is changed. Everything below was reproduced against the live data first.
--
--   * Nothing kept a combo's dishes in the combo's own branch. The combo_items policy checks the
--     combo's branch only, and the foreign key on menu_item_id ignores RLS, so Food Thai Thai's
--     Family Meal could be given Hamburger's Cheese Burger, or another restaurant's Pad Thai, and
--     v_active_combos listed and priced it. A BEFORE trigger now refuses such a pair
--     (combo_item_branch_mismatch, 23514); it runs as its owner so a dish the caller cannot see is
--     still recognised as foreign. The view also joins only dishes of the combo's branch. A combo
--     cannot be moved to another branch either (combo_branch_locked): it would take its dishes along.
--   * "Delete" did nothing for a combo that had ever been ordered. order_items.combo_id has no
--     ON DELETE action, it cannot be SET NULL (order_items_item_or_combo needs one of the two ids),
--     and the back office ignored the error. Combos are archived instead (archived_at). An archived
--     combo is never on sale (CHECK), is not in the view, and is hidden by the public policies.
--     Staff keep reading archived combos through their existing policy, which is how the back
--     office lists them for Restore.
--   * The view had no idea whether a deal could be sold. Hamburger's Burger Combo Deal stayed on
--     sale with its Cola at zero stock, and a dish that was switched off showed as a blank line.
--     is_available is now false when any dish is switched off, 86'd (sold_out_until in the future)
--     or tracked with less stock than one combo uses; `items` lists only the dishes the viewer can
--     see, each with its own is_available and photo. A combo with no dishes is no longer listed,
--     and new combos start off sale (column default).
--   * Nothing ordered the list or the dishes in a combo (jsonb_agg had no ORDER BY, the storefront
--     no ORDER BY at all). combo_sets.display_order and combo_items.position, backfilled to the
--     order the view was already returning, and the view exposes display_order and created_at.
--   * The back office wrote every keystroke and deleted a dish when its quantity was cleared.
--     save_combo writes one combo card (details and dishes, in order) in one transaction;
--     set_combo_archived archives or restores; reorder_combo_sets renumbers the list. All three
--     require menu.manage for the combo's branch, like the other menu functions.
--   * Deleting a dish silently shrank every combo holding it (combo_items cascades): Family Meal
--     stayed on sale at 25.99 with only its 13.95 soup left, and showed as available. Combo sales
--     write order_items.menu_item_id null, so past orders never stopped the delete. A dish in a
--     combo that is not archived can no longer be deleted (menu_item_in_combo, 23503 like the
--     other "still in use" refusals, the combos named in DETAIL); archived combos let it go.
--   * combo_sets accepted a price of 0 from direct writes (only save_combo refused it), and
--     place-order prices a combo from total_price. The CHECK is now total_price > 0.

-- 1. Columns -------------------------------------------------------------------------------------

alter table public.combo_sets  add column if not exists archived_at   timestamptz;
alter table public.combo_sets  add column if not exists display_order integer not null default 0;
alter table public.combo_items add column if not exists position      integer not null default 0;

-- A combo goes on sale once it has dishes; the back office switches it on.
alter table public.combo_sets alter column is_active set default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'combo_sets_archived_off_sale'
       and conrelid = 'public.combo_sets'::regclass
  ) then
    alter table public.combo_sets
      add constraint combo_sets_archived_off_sale check (archived_at is null or is_active = false);
  end if;
end;
$$;

-- A deal is never free. Every live row was 17.00 or more when this was written; VALIDATE fails
-- loudly rather than rewrite a price if that is no longer so.
alter table public.combo_sets drop constraint if exists combo_sets_total_price_check;
alter table public.combo_sets
  add constraint combo_sets_total_price_check check (total_price > 0) not valid;
alter table public.combo_sets validate constraint combo_sets_total_price_check;

-- Backfill. Combos in the order they were created; dishes in the order the view has been listing
-- them (its aggregate had no ORDER BY, so that was physical order). Only lists nobody has arranged
-- yet (every position 0) are touched, so running this again keeps the merchant's order.
with ranked as (
  select cs.id,
         row_number() over (partition by cs.branch_id order by cs.created_at, cs.id) - 1 as pos
    from public.combo_sets cs
   where not exists (
           select 1 from public.combo_sets o
            where o.branch_id = cs.branch_id and o.display_order <> 0
         )
)
update public.combo_sets cs
   set display_order = r.pos
  from ranked r
 where cs.id = r.id
   and cs.display_order is distinct from r.pos;

with ranked as (
  select ci.combo_id, ci.menu_item_id,
         row_number() over (partition by ci.combo_id order by ci.ctid) - 1 as pos
    from public.combo_items ci
   where not exists (
           select 1 from public.combo_items o
            where o.combo_id = ci.combo_id and o.position <> 0
         )
)
update public.combo_items ci
   set position = r.pos
  from ranked r
 where ci.combo_id = r.combo_id
   and ci.menu_item_id = r.menu_item_id
   and ci.position is distinct from r.pos;

-- 2. A combo's dishes are its own branch's ------------------------------------------------------

create or replace function private.tg_combo_items_same_branch()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_combo_branch uuid;
  v_item_branch  uuid;
begin
  select cs.branch_id into v_combo_branch from public.combo_sets cs where cs.id = new.combo_id;
  select mi.branch_id into v_item_branch  from public.menu_items mi where mi.id = new.menu_item_id;
  -- A row that does not exist is the foreign key's to report.
  if v_combo_branch is null or v_item_branch is null then
    return new;
  end if;
  if v_item_branch <> v_combo_branch then
    raise exception 'combo_item_branch_mismatch'
      using errcode = '23514',
            detail  = format('menu item %s is not on the menu of this combo''s branch', new.menu_item_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_combo_items_same_branch on public.combo_items;
create trigger trg_combo_items_same_branch
  before insert or update of combo_id, menu_item_id on public.combo_items
  for each row execute function private.tg_combo_items_same_branch();

create or replace function private.tg_combo_sets_branch_locked()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.branch_id is distinct from old.branch_id then
    raise exception 'combo_branch_locked' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_combo_sets_branch_locked on public.combo_sets;
create trigger trg_combo_sets_branch_locked
  before update of branch_id on public.combo_sets
  for each row execute function private.tg_combo_sets_branch_locked();

revoke execute on function private.tg_combo_items_same_branch() from public, anon, authenticated;
revoke execute on function private.tg_combo_sets_branch_locked() from public, anon, authenticated;

-- A dish is not deleted out from under a combo. The cascade on combo_items stays for the cases
-- where losing the row is right: an archived combo (off sale for good; restoring one brings it
-- back off sale, for the merchant to look over), and a branch or restaurant being deleted, whose
-- branch row is already gone by the time its cascade reaches the dish. Runs as its owner so the
-- combos count whatever the deleter's policies let it read.
create or replace function private.tg_menu_items_keep_combos()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_combos text;
begin
  select string_agg(cs.name, ', ' order by cs.display_order, cs.name)
    into v_combos
    from public.combo_items ci
    join public.combo_sets cs on cs.id = ci.combo_id
    join public.branches b on b.id = cs.branch_id
   where ci.menu_item_id = old.id
     and cs.archived_at is null;
  if v_combos is not null then
    raise exception 'menu_item_in_combo'
      using errcode = '23503',
            detail  = v_combos,
            hint    = 'Remove the dish from these combos, or archive them, before deleting it.';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_menu_items_keep_combos on public.menu_items;
create trigger trg_menu_items_keep_combos
  before delete on public.menu_items
  for each row execute function private.tg_menu_items_keep_combos();

revoke execute on function private.tg_menu_items_keep_combos() from public, anon, authenticated;

-- The live data was clean when this was written. Anything that is not is left in place (the view
-- ignores it and the back office shows it for removal) and reported here rather than deleted.
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
    from public.combo_items ci
    join public.combo_sets cs on cs.id = ci.combo_id
    join public.menu_items mi on mi.id = ci.menu_item_id
   where mi.branch_id <> cs.branch_id;
  if v_bad > 0 then
    raise notice '% combo_items row(s) pair a combo with another branch''s dish', v_bad;
  end if;
end;
$$;

-- 3. Public reads skip archived combos -----------------------------------------------------------

drop policy if exists combo_sets_public on public.combo_sets;
create policy combo_sets_public on public.combo_sets
  for select to anon, authenticated
  using (
    is_active = true
    and archived_at is null
    and branch_id in (select b.id from public.branches b where b.is_active = true)
  );

drop policy if exists combo_items_public on public.combo_items;
create policy combo_items_public on public.combo_items
  for select to anon, authenticated
  using (
    combo_id in (
      select cs.id
        from public.combo_sets cs
        join public.branches b on b.id = cs.branch_id
       where cs.is_active = true
         and cs.archived_at is null
         and b.is_active = true
    )
  );

-- 4. The view the storefront, the till and the cart read -----------------------------------------
-- Same columns in the same order (create or replace keeps the grants), three appended.
-- security_invoker stays: a dish the viewer may not see (switched off, for a diner) joins as null,
-- which drops it from `items` and makes the combo unavailable instead of printing a blank line.

create or replace view public.v_active_combos
with (security_invoker = true)
as
select cs.id,
       cs.branch_id,
       cs.name,
       cs.description,
       cs.image_url,
       cs.total_price,
       cs.is_active,
       coalesce(
         jsonb_agg(
           jsonb_build_object(
             'menu_item_id',   ci.menu_item_id,
             'item_name',      mi.name,
             'item_image_url', mi.image_url,
             'quantity',       ci.quantity,
             'is_swappable',   ci.is_swappable,
             'swap_group',     ci.swap_group,
             'list_price',     mi.price,
             'position',       ci.position,
             'is_available',   mi.is_active
                               and (mi.sold_out_until is null or mi.sold_out_until <= now())
                               and (not mi.track_stock or coalesce(mi.stock_quantity, 0) >= ci.quantity)
           )
           order by ci.position, mi.name, ci.menu_item_id
         ) filter (where mi.id is not null),
         '[]'::jsonb
       ) as items,
       coalesce(
         bool_and(
           mi.id is not null
           and mi.is_active
           and (mi.sold_out_until is null or mi.sold_out_until <= now())
           and (not mi.track_stock or coalesce(mi.stock_quantity, 0) >= ci.quantity)
         ),
         false
       ) as is_available,
       cs.display_order,
       cs.created_at
  from public.combo_sets cs
  join public.combo_items ci on ci.combo_id = cs.id
  left join public.menu_items mi
         on mi.id = ci.menu_item_id
        and mi.branch_id = cs.branch_id
 where cs.is_active = true
   and cs.archived_at is null
 group by cs.id
having count(mi.id) > 0;

comment on view public.v_active_combos is
  'Combos on sale: active, not archived, with at least one dish of their own branch the viewer can see. is_available is false when any dish is switched off, 86''d or short of stock. items are ordered by position. Order the list by display_order, created_at.';

-- 5. Back-office writes ---------------------------------------------------------------------------

create or replace function public.save_combo(
  p_branch_id   uuid,
  p_combo_id    uuid,
  p_name        text,
  p_description text,
  p_total_price numeric,
  p_image_url   text,
  p_is_active   boolean,
  p_items       jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_combo  public.combo_sets%rowtype;
  v_branch uuid;
  v_id     uuid;
  v_name   text    := nullif(btrim(coalesce(p_name, '')), '');
  v_desc   text    := nullif(btrim(coalesce(p_description, '')), '');
  v_image  text    := nullif(btrim(coalesce(p_image_url, '')), '');
  v_active boolean := coalesce(p_is_active, false);
  v_items  jsonb   := coalesce(p_items, '[]'::jsonb);
  v_ids    uuid[];
  v_qtys   integer[];
  v_n      integer;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  if p_combo_id is null then
    v_branch := p_branch_id;
    if v_branch is null or not exists (select 1 from public.branches b where b.id = v_branch) then
      raise exception 'branch_not_found' using errcode = 'P0002';
    end if;
  else
    select * into v_combo from public.combo_sets where id = p_combo_id for update;
    -- The page names the branch it edits; another branch's combo is not found from there.
    if not found or (p_branch_id is not null and v_combo.branch_id <> p_branch_id) then
      raise exception 'combo_not_found' using errcode = 'P0002';
    end if;
    v_branch := v_combo.branch_id;
  end if;

  if not private.staff_has_capability(v_branch, 'menu.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_combo.archived_at is not null then
    raise exception 'combo_archived' using errcode = '55000';
  end if;

  if v_name is null then
    raise exception 'combo_name_required' using errcode = '23514';
  end if;
  if p_total_price is null or p_total_price <= 0 then
    raise exception 'combo_price_invalid' using errcode = '23514';
  end if;
  if v_image is not null and v_image !~* '^https?://' then
    raise exception 'combo_image_invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'combo_items_invalid' using errcode = '22023';
  end if;

  select coalesce(array_agg((x.e ->> 'menu_item_id')::uuid order by x.ord), '{}'),
         coalesce(array_agg(coalesce((x.e ->> 'quantity')::integer, 1) order by x.ord), '{}')
    into v_ids, v_qtys
    from jsonb_array_elements(v_items) with ordinality as x(e, ord);
  v_n := cardinality(v_ids);

  if exists (select 1 from unnest(v_ids) as u(id) where u.id is null) then
    raise exception 'combo_items_invalid' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_qtys) as u(q) where u.q < 1) then
    raise exception 'combo_quantity_invalid' using errcode = '23514';
  end if;
  if (select count(distinct u.id) from unnest(v_ids) as u(id)) <> v_n then
    raise exception 'combo_item_duplicate' using errcode = '23505';
  end if;
  -- The trigger refuses the same thing row by row; this refuses it before anything is written.
  if (select count(*) from public.menu_items mi where mi.id = any(v_ids) and mi.branch_id = v_branch) <> v_n then
    raise exception 'combo_item_branch_mismatch' using errcode = '23514';
  end if;
  if v_active and v_n = 0 then
    raise exception 'combo_empty' using errcode = '23514';
  end if;

  if p_combo_id is null then
    insert into public.combo_sets (branch_id, name, description, total_price, image_url, is_active, display_order)
    values (
      v_branch, v_name, v_desc, p_total_price, v_image, v_active,
      coalesce(
        (select max(cs.display_order) + 1 from public.combo_sets cs
          where cs.branch_id = v_branch and cs.archived_at is null),
        0)
    )
    returning id into v_id;
  else
    v_id := p_combo_id;
    -- Only when something changed: every write republishes the storefront.
    update public.combo_sets
       set name = v_name,
           description = v_desc,
           total_price = p_total_price,
           image_url = v_image,
           is_active = v_active
     where id = v_id
       and (name, description, total_price, image_url, is_active)
           is distinct from (v_name, v_desc, p_total_price, v_image, v_active);
  end if;

  delete from public.combo_items ci
   where ci.combo_id = v_id
     and ci.menu_item_id <> all (v_ids);

  insert into public.combo_items (combo_id, menu_item_id, quantity, position)
  select v_id, u.id, u.qty, (u.ord - 1)::integer
    from unnest(v_ids, v_qtys) with ordinality as u(id, qty, ord)
  on conflict (combo_id, menu_item_id) do update
     set quantity = excluded.quantity,
         position = excluded.position
   where (combo_items.quantity, combo_items.position)
         is distinct from (excluded.quantity, excluded.position);

  return v_id;
end;
$$;

comment on function public.save_combo(uuid, uuid, text, text, numeric, text, boolean, jsonb) is
  'Creates (p_combo_id null) or updates one combo with its dishes in one transaction. p_items is [{menu_item_id, quantity}] in display order; dishes not listed are removed. Name required, price > 0, quantity >= 1, dishes of the combo''s branch only, no active combo without dishes, archived combos refused. Requires menu.manage.';

create or replace function public.set_combo_archived(p_combo_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_combo public.combo_sets%rowtype;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select * into v_combo from public.combo_sets where id = p_combo_id for update;
  if not found then
    raise exception 'combo_not_found' using errcode = 'P0002';
  end if;
  if not private.staff_has_capability(v_combo.branch_id, 'menu.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if coalesce(p_archived, true) then
    update public.combo_sets
       set is_active = false,
           archived_at = now()
     where id = p_combo_id
       and archived_at is null;
  else
    -- Back off sale and at the end of the list: the merchant looks it over before selling it again.
    update public.combo_sets
       set archived_at = null,
           is_active = false,
           display_order = coalesce(
             (select max(cs.display_order) + 1 from public.combo_sets cs
               where cs.branch_id = v_combo.branch_id and cs.archived_at is null),
             0)
     where id = p_combo_id
       and archived_at is not null;
  end if;
end;
$$;

comment on function public.set_combo_archived(uuid, boolean) is
  'Archives a combo (off sale, hidden from diners and the till, kept for past orders) or restores it off sale at the end of the list. Requires menu.manage.';

create or replace function public.reorder_combo_sets(p_branch_id uuid, p_combo_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id) then
    raise exception 'branch_not_found' using errcode = 'P0002';
  end if;
  if not private.staff_has_capability(p_branch_id, 'menu.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  perform 1 from public.combo_sets cs where cs.branch_id = p_branch_id for update;

  -- Ids of other branches' combos are ignored; this branch's combos that were not listed keep
  -- their relative order after the listed ones, so nothing shares a position.
  with wanted as (
    select u.id, u.ord from unnest(coalesce(p_combo_ids, '{}')) with ordinality as u(id, ord)
  ),
  ranked as (
    select cs.id,
           row_number() over (
             order by (w.ord is null), w.ord, cs.display_order, cs.created_at, cs.id
           ) - 1 as pos
      from public.combo_sets cs
      left join wanted w on w.id = cs.id
     where cs.branch_id = p_branch_id
       and cs.archived_at is null
  )
  update public.combo_sets cs
     set display_order = r.pos
    from ranked r
   where cs.id = r.id
     and cs.display_order is distinct from r.pos;
end;
$$;

comment on function public.reorder_combo_sets(uuid, uuid[]) is
  'Renumbers a branch''s combos 0..n-1 in the given order in one statement. Other branches'' ids are ignored; unlisted combos follow in their current order. Requires menu.manage.';

revoke execute on function public.save_combo(uuid, uuid, text, text, numeric, text, boolean, jsonb) from public, anon;
grant  execute on function public.save_combo(uuid, uuid, text, text, numeric, text, boolean, jsonb) to authenticated;
revoke execute on function public.set_combo_archived(uuid, boolean) from public, anon;
grant  execute on function public.set_combo_archived(uuid, boolean) to authenticated;
revoke execute on function public.reorder_combo_sets(uuid, uuid[]) from public, anon;
grant  execute on function public.reorder_combo_sets(uuid, uuid[]) to authenticated;
