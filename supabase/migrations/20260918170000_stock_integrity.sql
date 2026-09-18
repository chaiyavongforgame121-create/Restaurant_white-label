-- Stock integrity: restock lifts a kitchen 86, one meaning for "sold out" and "low", combos use up
-- the dishes inside them, and only the people who run inventory can change the counts.
--
-- The owner of Coastal Grill opened the new branch (Food Thai Thai), pressed Restock on Mango Sticky
-- Rice twice (+10 at 00:52 and +10 at 00:53 UTC on 2026-09-18) and "nothing happened": the count went
-- 9 -> 29, but the dish had been 86'd from the kitchen board (sold_out_until 05:00 UTC), restock never
-- touched that column and no back-office screen showed it, so the dish stayed "Out of stock" on the
-- storefront and the till with 29 on the shelf.
--
-- 1. tg_apply_restock also clears sold_out_until.
--    Every restock_log row has delta > 0 (restock_log_delta_check), so a restock always means "there
--    is some again". set_stock already cleared the 86 on a positive count; the two paths now agree.
--
-- 2. Who may change stock, by capability instead of "any staff of the branch".
--    restock_log / waste_log inserts, set_item_86 and set_stock only asked private.user_branch_ids(),
--    which holds every role, riders included. Now:
--      restock / waste / set_stock : inventory.manage (admin, manager, owner)
--      set_item_86                 : kitchen.access or menu.availability or inventory.manage, so the
--                                    kitchen can still 86 a dish mid-service and un-86 it.
--    private.staff_has_capability covers owner rows (whichever branch they were created at),
--    restaurant-wide rows, restaurants.owner_user_id and platform admins, so the owner can act at the
--    new branch that has no staff rows of its own. The log rows must also carry the caller as
--    created_by (the column default), so nobody can file a restock under someone else's name.
--    anon never reads or writes these logs; its table grants go.
--
-- 3. v_low_stock_items: active items only, and says WHY a row is listed.
--    It listed archived dishes and could not tell "low" from "86'd", so the inventory page printed an
--    86'd untracked dish as "{blank} left" under Low stock and counted 86'd dishes with plenty on the
--    shelf as low. Recreated (security_invoker, as before) with is_low_stock, is_86 and is_sold_out:
--      is_86        sold_out_until is in the future (a manual "sold out until ...")
--      is_low_stock tracked and stock_quantity <= low_stock_threshold (0 included)
--      is_sold_out  is_86, or tracked with nothing left - the same test the storefront, the counter
--                   (packages/database/src/queries/menu.ts) and place-order apply
--    A row is listed when the item is active and is low or 86'd. anon loses its grants on the view
--    (it exposed every restaurant's stock levels to anyone); signed-in users keep SELECT, and the
--    view runs with the caller's RLS as before. RLS alone still let any signed-in account (a diner,
--    a Hamburger-only admin) list other branches' rows, because menu_items_public shows every active
--    dish, so the view also keeps to private.user_branch_ids(): it is a staff "needs attention"
--    list (the inventory page and the dashboard, both reading one branch), and a branch's list is
--    that branch's staff's business only. Service-role callers see nothing (no auth.uid()); none
--    read it.
--
-- 4. Selling a combo uses up its dishes.
--    place-order writes a combo as one order_items line with menu_item_id null and combo_id set, and
--    order_items_decrement_stock returned early on a null menu item, so Food Thai Thai sold a Family
--    Meal (Thai Vegetable Soup + Green Curry) and neither count moved. The trigger now expands every
--    line into the dishes it takes off the shelf (private.order_line_stock_components):
--      a dish line   -> that dish x line quantity
--      a combo line  -> each dish in order_items.combo_contents (the snapshot place-order stores at
--                       sale time: [{menu_item_id, quantity, ...}], quantity per ONE combo) when the
--                       line has one, else the combo's current combo_items; component quantity x
--                       line quantity, summed per dish
--    and decrements each tracked dish with the same row lock and the same low_stock / oversold
--    outbox rows as before (private.take_stock_for_sale). Only dishes of the order's own branch are
--    touched. combo_contents is read as to_jsonb(new) -> 'combo_contents', so this works whether or
--    not that column exists yet, and a malformed entry is skipped rather than failing the sale.
--
-- 5. A cancellation gives back exactly what the sale took: order_items.stock_taken.
--    The cancel-side restore (private.tg_orders_restore_stock_on_cancel, first written in
--    20260918100000_branch_staff_parity) re-expanded each line when the order was cancelled, so it
--    gave back what the line ASKED for, not what it took:
--      - an oversold line (3 sold, 1 on the shelf, clamped at 0) gave back 3: two phantom portions;
--      - a dish that was untracked at the sale and counted before the cancel got the line added on
--        top of a count that never included it;
--      - a combo sold without a snapshot (every combo line live today: the deployed place-order does
--        not write combo_contents yet) gave back the combo's dishes as they are NOW, so swapping a
--        dish in the combo between sale and cancel returned the new dish and never the old one;
--      - pre-combo-decrement combo lines were told apart by a fixed timestamp.
--    Now each line records what it took, [{menu_item_id, qty}], in order_items.stock_taken:
--      * the sale-side trigger runs BEFORE INSERT and writes the record onto the row it is inserting
--        (the orders row exists by then); private.take_stock_for_sale returns what it removed,
--        least(on the shelf, asked), 0 for an untracked or other-branch dish;
--      * a give-back returns exactly the record, summed per dish (locked in id order), then empties
--        it ('[]'), so a second give-back returns nothing;
--      * an un-cancel takes again, like a sale, for every line whose record is empty, and records it;
--      * NULL means "never accounted": a line written before this column. It gives nothing back and
--        takes nothing on an un-cancel. The backfill below leaves NULL only on the combo lines sold
--        before combos took stock (2026-09-18 05:45:50 UTC), which is what the timestamp stood for.
--    What a line took is the database's record, not the client's: the insert trigger overwrites
--    whatever the INSERT carried, and a signed-in caller cannot UPDATE it (order_items_staff lets any
--    staff role update order lines; a padded record plus a cancel would have been a restock without
--    inventory.manage).
--
-- 6. A tracked item always has a count: check (not track_stock or stock_quantity is not null).
--    track_stock with a null count meant three different things: the storefront and the till said
--    sold out (null read as 0), place-order sold it without limit, and the decrement skipped it. No
--    live row is in that state (checked 2026-09-18); any that appears before this runs is backfilled
--    to 0. The writers comply: the inventory page and the menu editor set a count (through set_stock)
--    when tracking goes on and clear it when tracking goes off; restock and set_stock always write a
--    count. duplicate_menu_item used to copy the source's live count (a copy of a sold-out dish was
--    published "Sold out", a copy of a dish with 7 left claimed 7 nobody counted): the copy now
--    starts untracked with no count, keeps the low-stock threshold, and the merchant ticks Track
--    stock, which asks for a starting count (set_stock). copy_branch_setup copies track_stock without
--    the source kitchen's count, so a BEFORE INSERT normaliser turns "tracked, no count" on a NEW row
--    into "not tracked yet" - the new branch has counted nothing, and the merchant switches tracking
--    on with a starting count. Updates are not normalised: an update that switches tracking on
--    without a count is refused by the check, so the writer learns about it.

-- 1. Restock lifts the 86 --------------------------------------------------------------------------

create or replace function public.tg_apply_restock()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update public.menu_items
     set stock_quantity = greatest(0, coalesce(stock_quantity, 0) + NEW.delta),
         track_stock = true,
         -- A restock is always a positive delta: there is some again, so a kitchen 86 no longer
         -- holds. Leaving it made a dish with 29 on the shelf read "Out of stock" everywhere.
         sold_out_until = null,
         updated_at = now()
   where id = NEW.menu_item_id
     and branch_id = NEW.branch_id;

  if not found then
    raise exception 'item_not_in_branch'
      using hint = 'That menu item does not belong to this branch.';
  end if;
  return NEW;
end;
$function$;

-- 2. Who may change stock --------------------------------------------------------------------------

create or replace function public.set_item_86(p_menu_item_id uuid, p_sold_out boolean, p_until timestamp with time zone default null::timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch_id uuid;
  v_tz text;
  v_until timestamptz;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;

  select mi.branch_id into v_branch_id from public.menu_items mi where mi.id = p_menu_item_id;
  if not found then raise exception 'item_not_found'; end if;

  -- The kitchen 86es a dish mid-service; the back office (menu or inventory) puts it back on sale.
  -- Membership alone let any role do it, riders included.
  if not (
    private.staff_has_capability(v_branch_id, 'kitchen.access')
    or private.staff_has_capability(v_branch_id, 'menu.availability')
    or private.staff_has_capability(v_branch_id, 'inventory.manage')
  ) then
    raise exception 'not_authorized'
      using hint = 'Your role cannot change what is sold out at this branch.';
  end if;

  if p_sold_out then
    select coalesce(b.timezone, 'America/New_York') into v_tz
      from public.branches b where b.id = v_branch_id;

    -- Default is "until we open tomorrow", computed in the BRANCH's timezone —
    -- a UTC midnight would un-86 the item mid-service in America/Chicago.
    v_until := coalesce(
      p_until,
      (date_trunc('day', (now() at time zone v_tz)) + interval '1 day') at time zone v_tz
    );

    if v_until <= now() then
      raise exception 'invalid_until' using hint = 'Pick a time in the future.';
    end if;
  else
    v_until := null;
  end if;

  update public.menu_items
     set sold_out_until = v_until,
         updated_at = now()
   where id = p_menu_item_id;

  return jsonb_build_object(
    'menu_item_id', p_menu_item_id,
    'sold_out_until', v_until
  );
end
$function$;

create or replace function public.set_stock(p_menu_item_id uuid, p_counted_qty integer, p_notes text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch_id uuid;
  v_prev int;
  v_was_86 boolean;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if p_counted_qty is null or p_counted_qty < 0 then
    raise exception 'invalid_count' using hint = 'A stock count cannot be negative.';
  end if;

  select mi.branch_id, mi.stock_quantity, (mi.sold_out_until is not null and mi.sold_out_until > now())
    into v_branch_id, v_prev, v_was_86
    from public.menu_items mi
   where mi.id = p_menu_item_id;

  if not found then raise exception 'item_not_found'; end if;

  -- A count replaces what is on the shelf outright, so it takes the same right as a restock.
  if not private.staff_has_capability(v_branch_id, 'inventory.manage') then
    raise exception 'not_authorized'
      using hint = 'Your role cannot change stock counts at this branch.';
  end if;

  insert into public.stock_count_log (branch_id, menu_item_id, counted_qty, previous_qty, notes)
  values (v_branch_id, p_menu_item_id, p_counted_qty, v_prev, nullif(btrim(coalesce(p_notes,'')), ''));

  update public.menu_items
     set stock_quantity = p_counted_qty,
         track_stock    = true,
         -- Counting stock back in is the clearest possible statement that the
         -- item is available again; leaving a stale manual 86 in place would
         -- make the shelf and the storefront disagree.
         sold_out_until = case when p_counted_qty > 0 then null else sold_out_until end,
         updated_at     = now()
   where id = p_menu_item_id;

  return jsonb_build_object(
    'menu_item_id', p_menu_item_id,
    'previous_qty', v_prev,
    'stock_quantity', p_counted_qty,
    'cleared_86', v_was_86 and p_counted_qty > 0
  );
end
$function$;

revoke execute on function public.set_item_86(uuid, boolean, timestamptz) from public, anon;
grant execute on function public.set_item_86(uuid, boolean, timestamptz) to authenticated, service_role;
revoke execute on function public.set_stock(uuid, integer, text) from public, anon;
grant execute on function public.set_stock(uuid, integer, text) to authenticated, service_role;

drop policy if exists restock_staff_insert on public.restock_log;
create policy restock_staff_insert on public.restock_log
  for insert to authenticated
  with check (
    private.staff_has_capability(branch_id, 'inventory.manage')
    and created_by is not distinct from auth.uid()
  );

drop policy if exists waste_staff_insert on public.waste_log;
create policy waste_staff_insert on public.waste_log
  for insert to authenticated
  with check (
    private.staff_has_capability(branch_id, 'inventory.manage')
    and created_by is not distinct from auth.uid()
  );

revoke all on public.restock_log from anon;
revoke all on public.waste_log from anon;
revoke all on public.stock_count_log from anon;

-- 3. v_low_stock_items -----------------------------------------------------------------------------

drop view if exists public.v_low_stock_items;
create view public.v_low_stock_items
with (security_invoker = true) as
select mi.id,
       mi.branch_id,
       mi.name,
       mi.image_url,
       mi.stock_quantity,
       mi.low_stock_threshold,
       mi.price,
       mi.track_stock,
       mi.sold_out_until,
       mi.is_active,
       (mi.sold_out_until is not null and mi.sold_out_until > now())
         or (mi.track_stock and coalesce(mi.stock_quantity, 0) <= 0) as is_sold_out,
       (mi.track_stock and mi.stock_quantity is not null
         and mi.stock_quantity <= mi.low_stock_threshold) as is_low_stock,
       (mi.sold_out_until is not null and mi.sold_out_until > now()) as is_86
  from public.menu_items mi
 where mi.is_active
   -- The caller's own branches only: menu_items_public shows every active dish to any signed-in
   -- account, and this is a staff list.
   and mi.branch_id in (select private.user_branch_ids())
   and (
     (mi.track_stock and mi.stock_quantity is not null and mi.stock_quantity <= mi.low_stock_threshold)
     or (mi.sold_out_until is not null and mi.sold_out_until > now())
   );

comment on view public.v_low_stock_items is
  'Active menu items of the caller''s own branches that need attention: low on stock (is_low_stock), '
  '86''d by hand (is_86), or sold out either way (is_sold_out). Runs with the caller''s RLS. See '
  '20260918170000_stock_integrity.';

revoke all on public.v_low_stock_items from public, anon, authenticated;
grant select on public.v_low_stock_items to authenticated, service_role;

-- 4. Selling a combo uses up its dishes ------------------------------------------------------------

-- What one order line takes off the shelf, one row per dish. Shared by the sale-side decrement below
-- and the cancel-side restore, so the two always agree.
create or replace function private.order_line_stock_components(
  p_menu_item_id uuid,
  p_combo_id uuid,
  p_combo_contents jsonb,
  p_line_qty integer
)
returns table (menu_item_id uuid, quantity integer)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with snapshot as (
    -- place-order's record of what the combo held when it was sold. Entries without a usable id
    -- are skipped: a malformed snapshot must never fail the sale it belongs to.
    select e
      from jsonb_array_elements(
             case when jsonb_typeof(p_combo_contents) = 'array' then p_combo_contents else '[]'::jsonb end
           ) e
     where jsonb_typeof(e) = 'object'
       and (e ->> 'menu_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  parts as (
    select p_menu_item_id as menu_item_id, coalesce(p_line_qty, 0) as qty
     where p_menu_item_id is not null
    union all
    select (s.e ->> 'menu_item_id')::uuid,
           (case when (s.e ->> 'quantity') ~ '^[0-9]{1,6}$' then (s.e ->> 'quantity')::int else 1 end)
             * coalesce(p_line_qty, 0)
      from snapshot s
     where p_menu_item_id is null and p_combo_id is not null
    union all
    -- No snapshot on the line (orders placed before place-order stored one): the combo as it is now.
    select ci.menu_item_id, ci.quantity * coalesce(p_line_qty, 0)
      from public.combo_items ci
     where p_menu_item_id is null and p_combo_id is not null
       and ci.combo_id = p_combo_id
       and not exists (select 1 from snapshot)
  )
  select parts.menu_item_id, sum(parts.qty)::int
    from parts
   where parts.qty > 0
   group by parts.menu_item_id
   order by parts.menu_item_id;
$function$;

revoke execute on function private.order_line_stock_components(uuid, uuid, jsonb, integer) from public, anon, authenticated;

-- Take p_qty of one dish off the shelf for a sale at p_branch_id and return how many actually came
-- off: least(on the shelf, p_qty) for a tracked dish of that branch, 0 otherwise. The body is the old
-- order_items_decrement_stock, unchanged apart from the branch guard and the return value (section 5
-- records it on the order line, so a cancellation gives back exactly that).
-- The return type changed (void -> integer), which create or replace cannot do.
drop function if exists private.take_stock_for_sale(uuid, integer, uuid);
create function private.take_stock_for_sale(p_menu_item_id uuid, p_qty integer, p_branch_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_menu public.menu_items%rowtype;
  v_prev_qty int;
  v_new_qty int;
  v_threshold int;
begin
  if p_menu_item_id is null or coalesce(p_qty, 0) <= 0 then
    return 0;
  end if;

  select * into v_menu from public.menu_items where id = p_menu_item_id;
  if not found or not v_menu.track_stock or v_menu.stock_quantity is null then
    return 0;
  end if;
  -- Branches are separate kitchens: a sale here never draws down another branch's shelf.
  if p_branch_id is not null and v_menu.branch_id is distinct from p_branch_id then
    return 0;
  end if;

  -- Serialise concurrent orders for this item on the row lock. Without it two
  -- orders both read 5, both write 4, and one sale silently disappears.
  select mi.stock_quantity, mi.low_stock_threshold
    into v_prev_qty, v_threshold
    from public.menu_items mi
   where mi.id = v_menu.id
     and mi.track_stock
   for update;

  if not found or v_prev_qty is null then
    return 0;  -- tracking switched off while we waited for the lock
  end if;

  v_new_qty := greatest(0, v_prev_qty - p_qty);

  update public.menu_items
     set stock_quantity = v_new_qty,
         updated_at = now()
   where id = v_menu.id;

  if v_prev_qty < p_qty then
    -- Sold more than we had. The clamp keeps checkout working (refusing an
    -- order that is already paid for is worse), but it used to swallow the fact.
    insert into public.notifications_outbox(
      recipient_type, recipient_id, branch_id, channel, template, variables
    ) values (
      'staff', coalesce(p_branch_id, v_menu.branch_id), v_menu.branch_id,
      'in_app', 'low_stock',
      jsonb_build_object(
        'menu_item_id', v_menu.id, 'name', v_menu.name,
        'remaining', 0, 'threshold', v_threshold, 'sold_out', true,
        'oversold_by', p_qty - v_prev_qty
      )
    );
  elsif v_prev_qty > v_threshold and v_new_qty <= v_threshold then
    insert into public.notifications_outbox(
      recipient_type, recipient_id, branch_id, channel, template, variables
    ) values (
      'staff', coalesce(p_branch_id, v_menu.branch_id), v_menu.branch_id,
      'in_app', 'low_stock',
      jsonb_build_object(
        'menu_item_id', v_menu.id, 'name', v_menu.name,
        'remaining', v_new_qty, 'threshold', v_threshold,
        'sold_out', v_new_qty <= 0
      )
    );
  end if;

  -- What came off the shelf: all of it, or what was left when the sale was clamped at 0.
  return greatest(0, v_prev_qty - v_new_qty);
end;
$function$;

revoke execute on function private.take_stock_for_sale(uuid, integer, uuid) from public, anon, authenticated;

-- What the line took off the shelf (section 5). NULL: a line written before this column existed.
alter table public.order_items add column if not exists stock_taken jsonb;

comment on column public.order_items.stock_taken is
  'What this line took off the shelf, [{menu_item_id, qty}], written by order_items_decrement_stock '
  'at insert and by an un-cancel; emptied when a cancellation gives it back. NULL: written before '
  'stock was recorded per line (gives back nothing). Read-only to signed-in callers. See '
  '20260918170000_stock_integrity.';

create or replace function public.order_items_decrement_stock()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_branch_id uuid;
  v_part record;
  v_taken int;
  v_record jsonb := '[]'::jsonb;
begin
  -- BEFORE INSERT: the line carries its own record of what it took, which is exactly what a
  -- cancellation gives back. Whatever the INSERT itself put in stock_taken is replaced.
  if new.menu_item_id is not null or new.combo_id is not null then
    select o.branch_id into v_branch_id from public.orders o where o.id = new.order_id;

    -- A dish line is one part; a combo line is every dish inside it. Parts come back ordered by id,
    -- so a line always takes its row locks in the same order.
    for v_part in
      select c.menu_item_id, c.quantity
        from private.order_line_stock_components(
               new.menu_item_id, new.combo_id, to_jsonb(new) -> 'combo_contents', new.quantity
             ) c
    loop
      v_taken := private.take_stock_for_sale(v_part.menu_item_id, v_part.quantity, v_branch_id);
      if v_taken > 0 then
        v_record := v_record || jsonb_build_array(
          jsonb_build_object('menu_item_id', v_part.menu_item_id, 'qty', v_taken));
      end if;
    end loop;
  end if;

  new.stock_taken := v_record;
  return new;
end;
$function$;

-- Was AFTER INSERT; it now writes stock_taken onto the row being inserted. Only place-order inserts
-- order lines (a plain insert, no ON CONFLICT), so a BEFORE trigger never takes stock for a row
-- that is not written; if the insert fails, the whole statement and its stock moves roll back.
drop trigger if exists order_items_decrement_stock_trg on public.order_items;
create trigger order_items_decrement_stock_trg
  before insert on public.order_items
  for each row execute function public.order_items_decrement_stock();

-- A signed-in caller cannot rewrite what a line took. SECURITY DEFINER code (the restore trigger
-- below) runs as its owner and passes; service_role (place-order) is trusted like everywhere else.
create or replace function private.tg_order_items_stock_taken_read_only()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.stock_taken is distinct from old.stock_taken and current_user in ('anon', 'authenticated') then
    raise exception 'stock_taken_read_only'
      using hint = 'What an order line took off the shelf is recorded by the database.';
  end if;
  return new;
end;
$function$;

revoke execute on function private.tg_order_items_stock_taken_read_only() from public, anon, authenticated;

drop trigger if exists order_items_stock_taken_read_only on public.order_items;
create trigger order_items_stock_taken_read_only
  before update of stock_taken on public.order_items
  for each row execute function private.tg_order_items_stock_taken_read_only();

-- 5. A cancellation gives back exactly what the sale took ------------------------------------------

-- Replaces the version in 20260918100000_branch_staff_parity (same trigger, same transitions):
--   give back : into 'cancelled' from any live status (not from 'refunded'), and into 'refunded'
--               from 'pending' / 'confirmed' (a full refund before the kitchen started: nothing was
--               made). Exactly each line's stock_taken, summed per dish, onto tracked dishes of the
--               order's branch; then the records are emptied, so nothing comes back twice.
--   take again: out of 'cancelled' into a live status (a manual un-cancel) sells the lines again
--               through private.take_stock_for_sale and records what that took. Only lines whose
--               record is empty: a NULL record (a line from before per-line records, see the
--               backfill) takes nothing, and a line that still holds stock keeps what it holds.
--   'cancelled' -> 'refunded' and 'refunded' -> 'cancelled' move nothing; 'refunded' is terminal.
-- A dish whose tracking was switched off since the sale gets nothing back (there is no count to
-- add to). Nothing else on the dish (sold_out_until, is_active) is touched.
create or replace function private.tg_orders_restore_stock_on_cancel()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  l record;
  v_give_back boolean;
  v_take_again boolean;
  v_taken int;
  v_record jsonb;
begin
  if new.status is not distinct from old.status then return new; end if;
  v_give_back := (new.status = 'cancelled' and old.status <> 'refunded')
              or (new.status = 'refunded' and old.status in ('pending', 'confirmed'));
  v_take_again := old.status = 'cancelled' and new.status not in ('cancelled', 'refunded');
  if not (v_give_back or v_take_again) then
    return new;
  end if;

  if v_give_back then
    for r in
      select (e ->> 'menu_item_id')::uuid as menu_item_id, sum((e ->> 'qty')::int)::int as qty
        from public.order_items oi
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(oi.stock_taken) = 'array' then oi.stock_taken else '[]'::jsonb end) e
       where oi.order_id = new.id
         and jsonb_typeof(e) = 'object'
         and (e ->> 'menu_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and (e ->> 'qty') ~ '^[0-9]{1,6}$'
       group by 1
       order by 1   -- one lock order for every writer, so two cancels cannot deadlock
    loop
      update public.menu_items
         set stock_quantity = stock_quantity + r.qty,
             updated_at = now()
       where id = r.menu_item_id
         and track_stock
         and stock_quantity is not null
         and (new.branch_id is null or branch_id = new.branch_id);
    end loop;

    update public.order_items
       set stock_taken = '[]'::jsonb
     where order_id = new.id
       and stock_taken is not null
       and stock_taken <> '[]'::jsonb;
    return new;
  end if;

  -- Un-cancelled: the order is live again and takes its stock like a sale. Lock every dish it will
  -- draw from in id order first, then take line by line so each line records its own share.
  perform 1
     from public.menu_items mi
    where mi.id in (
            select c.menu_item_id
              from public.order_items oi
              cross join lateral private.order_line_stock_components(
                oi.menu_item_id, oi.combo_id, oi.combo_contents, oi.quantity) c
             where oi.order_id = new.id
               and oi.stock_taken = '[]'::jsonb)
    order by mi.id
      for update;

  for l in
    select oi.id, oi.menu_item_id, oi.combo_id, oi.combo_contents, oi.quantity
      from public.order_items oi
     where oi.order_id = new.id
       and oi.stock_taken = '[]'::jsonb
     order by oi.created_at, oi.id
  loop
    v_record := '[]'::jsonb;
    for r in
      select c.menu_item_id, c.quantity
        from private.order_line_stock_components(l.menu_item_id, l.combo_id, l.combo_contents, l.quantity) c
    loop
      v_taken := private.take_stock_for_sale(r.menu_item_id, r.quantity, new.branch_id);
      if v_taken > 0 then
        v_record := v_record || jsonb_build_array(
          jsonb_build_object('menu_item_id', r.menu_item_id, 'qty', v_taken));
      end if;
    end loop;
    if v_record <> '[]'::jsonb then
      update public.order_items set stock_taken = v_record where id = l.id;
    end if;
  end loop;

  return new;
end $function$;

revoke all on function private.tg_orders_restore_stock_on_cancel() from public, anon, authenticated;

-- Backfill the lines written before this column (116 lines on 2026-09-18), so the orders open today
-- keep the give-back they had under the old restore:
--   * orders already 'cancelled' or 'refunded': their stock was given back (or is gone for good), so
--     they hold nothing ('[]'), and an un-cancel sells them again as before;
--   * every other order: what the old restore would have given back - each line expanded as it is
--     sold, onto dishes of the order's branch that are tracked with a count. It cannot know about an
--     oversell that happened before today; from now on the sale records it;
--   * combo lines sold before combos took stock (2026-09-18 05:45:50 UTC, when this migration was
--     first applied; all 23 live combo lines) took nothing: they stay NULL, which gives nothing back
--     and takes nothing on an un-cancel - exactly what the timestamp cutoff meant.
update public.order_items oi
   set stock_taken = case
         when o.status in ('cancelled', 'refunded') then '[]'::jsonb
         else coalesce((
           select jsonb_agg(jsonb_build_object('menu_item_id', c.menu_item_id, 'qty', c.quantity)
                            order by c.menu_item_id)
             from private.order_line_stock_components(
                    oi.menu_item_id, oi.combo_id, oi.combo_contents, oi.quantity) c
             join public.menu_items mi on mi.id = c.menu_item_id
            where mi.track_stock
              and mi.stock_quantity is not null
              and (o.branch_id is null or mi.branch_id = o.branch_id)
         ), '[]'::jsonb)
       end
  from public.orders o
 where o.id = oi.order_id
   and oi.stock_taken is null
   and (oi.menu_item_id is not null or oi.combo_id is not null)
   and not (oi.menu_item_id is null and oi.created_at < timestamptz '2026-09-18 05:45:50+00');

-- Lines with neither a dish nor a combo never took anything.
update public.order_items
   set stock_taken = '[]'::jsonb
 where stock_taken is null
   and menu_item_id is null
   and combo_id is null;

-- 6. A tracked item always has a count -------------------------------------------------------------

-- A new row that asks to be tracked without saying how many there are is not tracked yet.
create or replace function private.tg_menu_item_untracked_until_counted()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.track_stock and new.stock_quantity is null then
    new.track_stock := false;
  end if;
  return new;
end;
$function$;

revoke execute on function private.tg_menu_item_untracked_until_counted() from public, anon, authenticated;

drop trigger if exists menu_items_untracked_until_counted on public.menu_items;
create trigger menu_items_untracked_until_counted
  before insert on public.menu_items
  for each row execute function private.tg_menu_item_untracked_until_counted();

-- Backfill: none live on 2026-09-18. Zero is what every reader but place-order already assumed.
update public.menu_items
   set stock_quantity = 0
 where track_stock and stock_quantity is null;

alter table public.menu_items drop constraint if exists menu_items_tracked_stock_has_count;
alter table public.menu_items
  add constraint menu_items_tracked_stock_has_count
  check (not track_stock or stock_quantity is not null);

-- A copy is a new dish that nobody has counted: it starts untracked with no count (the source's
-- live count made a copy of a sold-out dish read "Sold out" once published). Everything else as
-- before; the low-stock threshold is kept for when the merchant switches tracking on.
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
  return v_new_id;
end $function$;
