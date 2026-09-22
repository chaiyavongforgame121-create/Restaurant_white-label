-- Kitchen stations: the lines on the board follow the menu.
--
-- Found when the owner of Food Thai Thai gave Fountain Drink a station (Cold) and left Tom Yum and
-- Tom Kha without one while order #0005 was on the board. order_items.station is a snapshot taken
-- once, at insert, by order_items_default_station (public.order_items_set_station()), so the three
-- lines of #0005 kept station null. The board used to put a line with no station on EVERY station,
-- so the Dessert screen showed two soups and a drink; now that it shows such a line only under
-- All and "No station" (kitchen-model.ts), the snapshot has to keep up with the menu instead.
--
-- 1. private.combo_contents_with_station(contents, menu_item_id, station, only_missing): the combo
--    snapshot (order_items.combo_contents, [{menu_item_id, name, quantity, station}] written by
--    place-order) with one dish's station replaced. Anything that is not an array, and any entry
--    that is not an object, comes back as it was. The kitchen reads a dish's id from menu_item_id
--    or, failing that, id (parseComboContents); so does this.
--
-- 2. private.tg_menu_items_station_follows(), AFTER UPDATE OF station on menu_items. When a dish's
--    station really changes (null and '' are the same "no station"), the lines that dish still
--    has in the kitchen take the new station:
--      * only orders the kitchen board shows: pending, confirmed, preparing, ready (the board's
--        ACTIVE_STATUSES, held scheduled orders included). out_for_delivery has left the kitchen;
--        completed, cancelled and refunded orders are history and keep the station they were made
--        at;
--      * a line not made yet (prep_status pending or in_progress) follows the dish. A line the cook
--        has already ticked off (ready, served) keeps the station that made it, unless it never
--        had one;
--      * a combo line holding the dish gets the dish's entry in combo_contents updated, by the same
--        rule (the combo line's own prep_status decides).
--    Every changed line is an order_items UPDATE, which the board already receives over realtime
--    and merges in place, so an open board regroups without a reload. Rows already right are not
--    written: no realtime event for nothing.
--    Runs as its owner: whoever may change a dish's station (menu.manage) changes where the open
--    tickets for that dish are shown, whatever their own order_items policy allows.
--
-- 3. One-time backfill: on those same active orders, a line with no station takes its dish's
--    current station, and so does a combo dish with none. Lines of closed orders are left alone.
--    Live when written: 14 active dish lines had a null station. 6 take one: 5 at Food Thai Thai
--    (#0005's Fountain Drink, two Pad Thai, a Green Curry and a Thai Vegetable Soup) and a Classic
--    Cheeseburger at Hamburger. The other 8 are dishes that still have no station (Tom Yum and Tom
--    Kha on #0005, Hamburger's test dishes) and stay under "No station" until the owner gives them
--    one; the trigger then moves them. No active combo line had a combo_contents snapshot yet.

-- 1. The combo snapshot with one dish's station replaced -----------------------------------------

create or replace function private.combo_contents_with_station(
  p_contents     jsonb,
  p_menu_item_id uuid,
  p_station      text,
  p_only_missing boolean
)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case
           when jsonb_typeof(p_contents) is distinct from 'array' then p_contents
           else (
             -- An empty array aggregates to null; it comes back as it was.
             select coalesce(
                      jsonb_agg(
                        case
                          when jsonb_typeof(a.e) = 'object'
                           and coalesce(a.e ->> 'menu_item_id', a.e ->> 'id') = p_menu_item_id::text
                           and (not p_only_missing or nullif(a.e ->> 'station', '') is null)
                          then a.e || jsonb_build_object('station', p_station)
                          else a.e
                        end
                        order by a.i),
                      p_contents)
               from jsonb_array_elements(p_contents) with ordinality as a(e, i)
           )
         end;
$function$;

comment on function private.combo_contents_with_station(jsonb, uuid, text, boolean) is
  'order_items.combo_contents with the station of one dish replaced (only where it has none, when p_only_missing).';

revoke all on function private.combo_contents_with_station(jsonb, uuid, text, boolean) from public, anon, authenticated;

-- 2. Open lines follow a dish's station ---------------------------------------------------------

create or replace function private.tg_menu_items_station_follows()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_station text := nullif(new.station, '');
begin
  -- The dish's own lines. menu_item_id is indexed; no branch filter is needed to reach them.
  update public.order_items oi
     set station = v_station
    from public.orders o
   where o.id = oi.order_id
     and oi.menu_item_id = new.id
     and o.status in ('pending', 'confirmed', 'preparing', 'ready')
     and oi.station is distinct from v_station
     and (nullif(oi.station, '') is null or oi.prep_status not in ('ready', 'served'));

  -- Combo lines holding the dish. A combo's dishes are always its own branch's
  -- (trg_combo_items_same_branch), so the branch's active orders are all there is to look at.
  update public.order_items oi
     set combo_contents = private.combo_contents_with_station(
           oi.combo_contents, new.id, v_station, oi.prep_status in ('ready', 'served'))
    from public.orders o
   where o.id = oi.order_id
     and o.branch_id = new.branch_id
     and o.status in ('pending', 'confirmed', 'preparing', 'ready')
     and oi.combo_id is not null
     and oi.combo_contents is distinct from private.combo_contents_with_station(
           oi.combo_contents, new.id, v_station, oi.prep_status in ('ready', 'served'));

  return null;
end;
$function$;

comment on function private.tg_menu_items_station_follows() is
  'AFTER UPDATE OF station on menu_items: the dish''s lines on active orders (not yet made, or with no station) take the new station.';

revoke all on function private.tg_menu_items_station_follows() from public, anon, authenticated;

drop trigger if exists menu_items_station_follows on public.menu_items;
create trigger menu_items_station_follows
  after update of station on public.menu_items
  for each row
  when (nullif(old.station, '') is distinct from nullif(new.station, ''))
  execute function private.tg_menu_items_station_follows();

-- 3. Backfill: active lines with no station take their dish's current one -------------------------

update public.order_items oi
   set station = mi.station
  from public.orders o, public.menu_items mi
 where o.id = oi.order_id
   and mi.id = oi.menu_item_id
   and o.status in ('pending', 'confirmed', 'preparing', 'ready')
   and nullif(oi.station, '') is null
   and nullif(mi.station, '') is not null;

-- Combo lines sold before place-order wrote combo_contents (2026-09-19) have no snapshot for the
-- statement below or the trigger to update, so the board could only file them under "No station"
-- and giving a dish a station never moved them. They get the snapshot now, built from the combo as
-- it is today in the shape place-order writes. The stock record is not touched: a cancel gives back
-- order_items.stock_taken, and a line with no snapshot was already expanded from these same
-- combo_items (private.order_line_stock_components).
update public.order_items oi
   set combo_contents = (
         select jsonb_agg(
                  jsonb_build_object(
                    'menu_item_id', ci.menu_item_id,
                    'name',         mi.name,
                    'quantity',     ci.quantity,
                    'station',      nullif(mi.station, ''))
                  order by ci.position, ci.menu_item_id)
           from public.combo_items ci
           join public.menu_items mi on mi.id = ci.menu_item_id
          where ci.combo_id = oi.combo_id)
  from public.orders o
 where o.id = oi.order_id
   and o.status in ('pending', 'confirmed', 'preparing', 'ready')
   and oi.combo_id is not null
   and oi.menu_item_id is null
   and oi.combo_contents is null
   and exists (select 1 from public.combo_items ci where ci.combo_id = oi.combo_id);


with filled as (
  select oi.id,
         (select coalesce(
                   jsonb_agg(
                     case
                       when jsonb_typeof(a.e) = 'object'
                        and nullif(a.e ->> 'station', '') is null
                        and nullif(mi.station, '') is not null
                       then a.e || jsonb_build_object('station', mi.station)
                       else a.e
                     end
                     order by a.i),
                   oi.combo_contents)
            from jsonb_array_elements(oi.combo_contents) with ordinality as a(e, i)
            left join public.menu_items mi
              on mi.id::text = coalesce(a.e ->> 'menu_item_id', a.e ->> 'id')) as contents
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.status in ('pending', 'confirmed', 'preparing', 'ready')
     and oi.combo_id is not null
     and jsonb_typeof(oi.combo_contents) = 'array'
)
update public.order_items oi
   set combo_contents = f.contents
  from filled f
 where oi.id = f.id
   and oi.combo_contents is distinct from f.contents;
