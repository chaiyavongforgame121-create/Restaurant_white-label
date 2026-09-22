-- Order lines in menu order: bills, receipts and kitchen tickets list an order's lines category by
-- category, in the order the owner arranges the menu.
--
-- Reported by the owner of Food Thai Thai: a bill listed its lines in the order the diner tapped
-- them, so a dessert, a set or a drink landed in the middle of the mains (order A-2609-0005 read
-- SET A, Fountain Drink, Tom Yum, Tom Kha, SET A). They asked for the lines to run category by
-- category, in an order they set in the back office. That order already exists: the Arrange tab
-- (menu-reorder.tsx) writes menu_categories.display_order and menu_items.display_order, and the
-- Combos page writes combo_sets.display_order. Nothing new to set; this makes the lines follow it.
--
-- 1. order_items.category_position and order_items.item_position, where the line's dish sat on the
--    menu when it was ordered:
--      * a dish: its category's place among the branch's ACTIVE categories, counted from 1 in the
--        menu's order (display_order, then age, then id, so two categories saved with the same
--        position still get one each and never interleave), and the dish's own display_order;
--      * a combo: category_position 0 and the combo's display_order. Combos have no category; the
--        storefront (menu-view.tsx) and the counter show them in their own section above every
--        category, so that is where their lines go;
--      * a dish with no category, or in a hidden (inactive) one: null category_position, listed
--        after everything else. A hidden category's dishes stay on sale (the storefront's All
--        view lists every active dish, and place-order does not look at the category), but no
--        client can see the category itself: the menu_cat_public policy and listCategories read
--        active categories only. The cart (menuLinePositions) and the counter's printed receipt
--        therefore put such a dish last, and counting hidden categories here put it mid-bill.
--    private.order_line_menu_position() works this out; everything below uses it.
--
-- 2. order_items_menu_position, BEFORE INSERT on order_items, stamps both columns. place-order
--    does not write them, so no edge function changes; a writer that sets them keeps its values.
--
-- 3. The lines of open orders follow when the owner reorders. After a real change to
--    menu_categories.display_order or is_active (or an active category added or removed, which
--    moves the count of every category after it), menu_items.display_order or category_id, or
--    combo_sets.display_order, private.refresh_order_line_positions(branch) re-stamps the lines of
--    that branch's orders that are still open: pending, confirmed, preparing, ready and
--    out_for_delivery, and a completed round still on an open table's bill. Completed, cancelled
--    and refunded orders are history and keep the order they were listed in. Only lines whose
--    position really changes are written, which the kitchen board and every other realtime reader
--    receive as an order_items UPDATE. Runs as its owner: whoever may reorder the menu
--    (menu.manage) reorders the open bills.
--    The triggers are per statement, not per row, and the refresh reaches the open orders through
--    indexes only. A first draft refreshed once per moved row and found the open orders with one
--    OR over the branch's whole history: in a rolled-back dry run with 100,000 orders on Food Thai
--    Thai, moving Drink to the top (11 categories renumbered) took 4.6 s, and 20 categories ran
--    into the authenticated role's 8 s statement_timeout, rolling the owner's save back.
--
-- 4. private.order_line_options_key(modifiers): the chosen options as one sortable key, so the same
--    dish with different options sits side by side in a stable order. The SQL twin of
--    orderLineOptionsKey in packages/shared/src/utils/order-lines.ts, whose compareOrderLines every
--    screen sorts with; edit the two together. private.order_line_options(modifiers) is the same
--    options as [{name, price_delta}], for a bill that shows them; both read
--    private.order_line_option_rows.
--
-- 5. The SQL that lists lines orders them by the same keys: get_table_session_bill (the table's
--    bill, staff and diners), get_driver_order (the rider's order card) and issue_tax_invoice (the
--    invoice's line_items snapshot). Each is its live definition with the ORDER BY changed. Besides
--    that, get_table_session_bill's lines also carry their options: two SET A lines that differ
--    only by the egg read as the same dish twice on the diners' table bill otherwise. (What else
--    changed in issue_tax_invoice is explained beside it.)
--
-- 6. Backfill: every existing line, history included, from the current menu. Live when written:
--    130 lines, all of them left with both positions (every dish had a category); #0005 then reads
--    Tom Yum, Tom Kha (Soups, 2), SET A with No Egg, SET A with the fried egg (Special SET, 10),
--    Fountain Drink (Drink, 11).

-- 1. Columns ---------------------------------------------------------------------------------------

alter table public.order_items
  add column if not exists category_position integer,
  add column if not exists item_position integer;

comment on column public.order_items.category_position is
  'Where the line''s dish sat on the menu: 0 for a combo, else its category''s place among the branch''s active categories counted from 1. Null for a dish with no category or in a hidden one. Stamped by order_items_menu_position; followed on open orders when the menu is reordered.';
comment on column public.order_items.item_position is
  'The dish''s display_order in its category, or the combo''s display_order among combos. Bills, receipts and kitchen tickets list lines by category_position, then this.';

-- Where a dish or a combo sits on the menu right now. One row, or none for an id that does not
-- exist (order_items keeps its dish and combo by foreign key, so that is only a caller's typo).
-- Hidden categories are not counted, and a dish in one has no category position: the clients
-- cannot read a hidden category, so they list its dishes last, and so must the bill (see 1 above).
create or replace function private.order_line_menu_position(p_menu_item_id uuid, p_combo_id uuid)
returns table (category_position integer, item_position integer)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select 0, cs.display_order
    from public.combo_sets cs
   where cs.id = p_combo_id
  union all
  select case
           when c.id is null or not c.is_active then null
           else (select count(*)::integer
                   from public.menu_categories c2
                  where c2.branch_id = c.branch_id
                    and c2.is_active
                    and (c2.display_order, c2.created_at, c2.id) <= (c.display_order, c.created_at, c.id))
         end,
         mi.display_order
    from public.menu_items mi
    left join public.menu_categories c on c.id = mi.category_id
   where p_combo_id is null
     and mi.id = p_menu_item_id;
$function$;

comment on function private.order_line_menu_position(uuid, uuid) is
  'The menu position of a dish or a combo, as order_items.category_position / item_position hold it.';

revoke all on function private.order_line_menu_position(uuid, uuid) from public, anon, authenticated;

-- 2. New lines are stamped ------------------------------------------------------------------------

create or replace function private.tg_order_items_menu_position()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_category integer;
  v_item     integer;
begin
  if new.category_position is null or new.item_position is null then
    select p.category_position, p.item_position
      into v_category, v_item
      from private.order_line_menu_position(new.menu_item_id, new.combo_id) p;
    new.category_position := coalesce(new.category_position, v_category);
    new.item_position := coalesce(new.item_position, v_item);
  end if;
  return new;
end;
$function$;

comment on function private.tg_order_items_menu_position() is
  'BEFORE INSERT on order_items: stamps category_position and item_position from the menu.';

revoke all on function private.tg_order_items_menu_position() from public, anon, authenticated;

drop trigger if exists order_items_menu_position on public.order_items;
create trigger order_items_menu_position
  before insert on public.order_items
  for each row
  execute function private.tg_order_items_menu_position();

-- 3. Open orders follow a reorder -----------------------------------------------------------------

create or replace function private.refresh_order_line_positions(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order_ids uuid[];
begin
  -- Mid-cascade (a branch being deleted takes its menu with it) there is nothing left to follow.
  if p_branch_id is null or not exists (select 1 from public.branches b where b.id = p_branch_id) then
    return;
  end if;

  -- The open orders are reached through indexes only, never by reading the branch's history: the
  -- open statuses through idx_orders_branch_status_created, and a served round still on a table's
  -- bill through the branch's open sittings and orders_session_idx. Written as one filter with an
  -- OR between the two, the planner read every order the branch ever had.
  select coalesce(array_agg(x.id), '{}')
    into v_order_ids
    from (
      select o.id
        from public.orders o
       where o.branch_id = p_branch_id
         and o.status in ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery')
      union
      -- A served round stays on the table's bill until the table pays.
      select o.id
        from public.table_sessions ts
        join public.orders o on o.session_id = ts.id
       where ts.branch_id = p_branch_id
         and ts.status <> 'closed'
         and o.branch_id = p_branch_id
         and o.status = 'completed'
    ) x;

  if cardinality(v_order_ids) = 0 then
    return;
  end if;

  -- Their lines by idx_order_items_order, from the list of ids rather than a join. Joined to the
  -- open orders, the planner hash-joined a Seq Scan of order_items, which holds every tenant's
  -- lines: in the dry run it read all 60,130 to find the 612 of 205 open orders, where the list
  -- of ids takes an index scan of those 612 whatever the history (no-op refresh 63 ms -> 5 ms).
  with wanted as (
    select oi.id, p.category_position, p.item_position
      from public.order_items oi
     cross join lateral private.order_line_menu_position(oi.menu_item_id, oi.combo_id) p
     where oi.order_id = any (v_order_ids)
  )
  update public.order_items oi
     set category_position = w.category_position,
         item_position     = w.item_position
    from wanted w
   where oi.id = w.id
     and (oi.category_position, oi.item_position) is distinct from (w.category_position, w.item_position);
end;
$function$;

comment on function private.refresh_order_line_positions(uuid) is
  'Re-stamps category_position / item_position on the branch''s open orders from the current menu.';

revoke all on function private.refresh_order_line_positions(uuid) from public, anon, authenticated;

-- The follow triggers run once per statement, not once per row. The Arrange tab saves a whole
-- layout in one statement (reorder_menu_categories renumbers every category of the branch in one
-- UPDATE, reorder_menu_items every dish of a category, delete_menu_category moves all its dishes
-- in one), and with a trigger per row each moved row re-stamped the branch's open orders again:
-- eleven categories renumbered meant eleven refreshes. Now it is one refresh per branch the
-- statement really moved something in.
--
-- Postgres allows transition tables only on a trigger with one event and no column list, so each
-- table has a plain AFTER UPDATE trigger, and the category table one for INSERT and one for
-- DELETE as well. The functions compare the old and new rows themselves, which is what the WHEN
-- clauses of per-row triggers did: an update that changes nothing a position is read from (a
-- price, a photo, the stock count, or a reorder that leaves a row where it was) finds no branch
-- and returns without reading any order.

create or replace function private.tg_order_lines_follow_categories()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch_id uuid;
begin
  if tg_op = 'INSERT' then
    -- An active category moves the count of every category after it; a hidden one moves nothing.
    for v_branch_id in
      select distinct n.branch_id from new_rows n where n.is_active
    loop
      perform private.refresh_order_line_positions(v_branch_id);
    end loop;
  elsif tg_op = 'DELETE' then
    for v_branch_id in
      select distinct o.branch_id from old_rows o where o.is_active
    loop
      perform private.refresh_order_line_positions(v_branch_id);
    end loop;
  else
    -- Moved, hidden or shown again. Hiding a category takes its dishes' lines to the end of the
    -- bill and moves every active category after it up one; showing it again undoes both.
    for v_branch_id in
      select distinct n.branch_id
        from new_rows n
        join old_rows o on o.id = n.id
       where (o.display_order, o.is_active) is distinct from (n.display_order, n.is_active)
    loop
      perform private.refresh_order_line_positions(v_branch_id);
    end loop;
  end if;
  return null;
end;
$function$;

comment on function private.tg_order_lines_follow_categories() is
  'AFTER each statement that adds, removes, moves, hides or shows categories: the branch''s open order lines follow.';

revoke all on function private.tg_order_lines_follow_categories() from public, anon, authenticated;

create or replace function private.tg_order_lines_follow_dishes()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch_id uuid;
begin
  for v_branch_id in
    select distinct n.branch_id
      from new_rows n
      join old_rows o on o.id = n.id
     where (o.display_order, o.category_id) is distinct from (n.display_order, n.category_id)
  loop
    perform private.refresh_order_line_positions(v_branch_id);
  end loop;
  return null;
end;
$function$;

comment on function private.tg_order_lines_follow_dishes() is
  'AFTER each statement that moves dishes (display_order, category_id): the branch''s open order lines follow.';

revoke all on function private.tg_order_lines_follow_dishes() from public, anon, authenticated;

create or replace function private.tg_order_lines_follow_combos()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch_id uuid;
begin
  for v_branch_id in
    select distinct n.branch_id
      from new_rows n
      join old_rows o on o.id = n.id
     where o.display_order is distinct from n.display_order
  loop
    perform private.refresh_order_line_positions(v_branch_id);
  end loop;
  return null;
end;
$function$;

comment on function private.tg_order_lines_follow_combos() is
  'AFTER each statement that reorders combos: the branch''s open order lines follow.';

revoke all on function private.tg_order_lines_follow_combos() from public, anon, authenticated;

drop trigger if exists menu_categories_order_lines_follow on public.menu_categories;
create trigger menu_categories_order_lines_follow
  after update on public.menu_categories
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.tg_order_lines_follow_categories();

drop trigger if exists menu_categories_order_lines_follow_insert on public.menu_categories;
create trigger menu_categories_order_lines_follow_insert
  after insert on public.menu_categories
  referencing new table as new_rows
  for each statement
  execute function private.tg_order_lines_follow_categories();

drop trigger if exists menu_categories_order_lines_follow_delete on public.menu_categories;
create trigger menu_categories_order_lines_follow_delete
  after delete on public.menu_categories
  referencing old table as old_rows
  for each statement
  execute function private.tg_order_lines_follow_categories();

drop trigger if exists menu_items_order_lines_follow on public.menu_items;
create trigger menu_items_order_lines_follow
  after update on public.menu_items
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.tg_order_lines_follow_dishes();

drop trigger if exists combo_sets_order_lines_follow on public.combo_sets;
create trigger combo_sets_order_lines_follow
  after update on public.combo_sets
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.tg_order_lines_follow_combos();

-- 4. The options, as a sort key and as a list ------------------------------------------------------

-- A line's chosen options, one row each in the order they were chosen. The name is the first
-- non-empty text of name, label, option_name, title, value, or a bare string, exactly as
-- orderLineOptionsKey (packages/shared) and parseLineModifiers (the back office) read it; an entry
-- with no name is skipped. The price delta is the first of price_delta, price and extra_price that
-- is there, as a number or a numeric string, else 0, again as parseLineModifiers reads it: a jsonb
-- column has no schema, and one odd row must not make the bill that shows it fail on a cast.
-- place-order always writes an array of {group_id, option_id, name, price_delta}; anything that
-- is not an array has no options.
create or replace function private.order_line_option_rows(p_modifiers jsonb)
returns table (ord bigint, name text, price_delta numeric)
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select a.i,
         n.name,
         coalesce(case jsonb_typeof(d.v)
                    when 'number' then (d.v #>> '{}')::numeric
                    when 'string' then
                      case when btrim(d.v #>> '{}') ~ '^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
                           then btrim(d.v #>> '{}')::numeric
                      end
                  end, 0)
    from jsonb_array_elements(
           case when jsonb_typeof(p_modifiers) = 'array' then p_modifiers else '[]'::jsonb end
         ) with ordinality as a(e, i)
   cross join lateral (
     select case jsonb_typeof(a.e)
              when 'string' then nullif(btrim(a.e #>> '{}'), '')
              when 'object' then coalesce(
                case when jsonb_typeof(a.e -> 'name') = 'string' then nullif(btrim(a.e ->> 'name'), '') end,
                case when jsonb_typeof(a.e -> 'label') = 'string' then nullif(btrim(a.e ->> 'label'), '') end,
                case when jsonb_typeof(a.e -> 'option_name') = 'string' then nullif(btrim(a.e ->> 'option_name'), '') end,
                case when jsonb_typeof(a.e -> 'title') = 'string' then nullif(btrim(a.e ->> 'title'), '') end,
                case when jsonb_typeof(a.e -> 'value') = 'string' then nullif(btrim(a.e ->> 'value'), '') end)
            end as name
   ) n
   cross join lateral (
     -- -> on a bare string is null, and a JSON null counts as absent, as ?? does in the clients.
     select coalesce(nullif(a.e -> 'price_delta', 'null'::jsonb),
                     nullif(a.e -> 'price', 'null'::jsonb),
                     nullif(a.e -> 'extra_price', 'null'::jsonb)) as v
   ) d
   where n.name is not null;
$function$;

comment on function private.order_line_option_rows(jsonb) is
  'order_items.modifiers read leniently: one (ord, name, price_delta) row per named option, in the order chosen.';

revoke all on function private.order_line_option_rows(jsonb) from public, anon, authenticated;

-- Option names in the order they were chosen, joined by chr(1), which sorts below every printable
-- character, so under collate "C" two keys compare name by name. The SQL twin of
-- orderLineOptionsKey.
create or replace function private.order_line_options_key(p_modifiers jsonb)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(string_agg(r.name, chr(1) order by r.ord), '')
    from private.order_line_option_rows(p_modifiers) r;
$function$;

comment on function private.order_line_options_key(jsonb) is
  'order_items.modifiers as a sort key (option names joined by chr(1)); twin of orderLineOptionsKey in packages/shared.';

revoke all on function private.order_line_options_key(jsonb) from public, anon, authenticated;

-- The options as a bill shows them: [{name, price_delta}] in the order chosen, [] for none. Only
-- the name and the price: the group and option ids mean nothing to a diner.
create or replace function private.order_line_options(p_modifiers jsonb)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('name', r.name, 'price_delta', r.price_delta) order by r.ord),
                  '[]'::jsonb)
    from private.order_line_option_rows(p_modifiers) r;
$function$;

comment on function private.order_line_options(jsonb) is
  'order_items.modifiers as [{name, price_delta}] for a bill; read by private.order_line_option_rows.';

revoke all on function private.order_line_options(jsonb) from public, anon, authenticated;

-- 5. The SQL that lists lines, in menu order ------------------------------------------------------
-- The ORDER BY in all three is compareOrderLines: category, dish, name, options, age, id.

CREATE OR REPLACE FUNCTION public.get_driver_order(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_driver_id uuid := private.driver_id_for_user();
  v_result    jsonb;
begin
  if v_driver_id is null then raise exception 'not_a_driver'; end if;

  select jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'customer_name', o.customer_name,
    'customer_phone', o.customer_phone,
    'delivery_address', o.delivery_address,
    'customer_notes', o.customer_notes,
    'order_items', coalesce((
      select jsonb_agg(jsonb_build_object('item_name', oi.item_name, 'quantity', oi.quantity)
                       order by oi.category_position nulls last, oi.item_position nulls last,
                                oi.item_name collate "C",
                                private.order_line_options_key(oi.modifiers) collate "C",
                                oi.created_at, oi.id)
      from public.order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.deliveries d
  join public.orders o on o.id = d.order_id
  where d.id = p_delivery_id
    and d.driver_id = v_driver_id;   -- caller must be the assigned/offered driver

  return v_result; -- null when not found / not theirs
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_table_session_bill(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  s public.table_sessions%rowtype;
  v_staff boolean;
  v_member boolean;
  v_rows jsonb;
  v_label text;
begin
  select * into s from public.table_sessions where id = p_session_id;
  if s.id is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  v_staff  := private.staff_has_capability(s.branch_id, 'counter.access')
           or private.staff_has_capability(s.branch_id, 'orders.view');
  v_member := exists (select 1 from public.table_session_participants p
                       where p.session_id = s.id and p.user_id = v_uid);
  if not (v_staff or v_member) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select coalesce(nullif(btrim(t.display_name), ''), 'Table ' || t.table_number) into v_label
    from public.tables t where t.id = s.table_id;

  -- customer_phone is never projected, and customer_name only reaches staff: a table-mate
  -- is not entitled to the phone number of whoever else is sitting there.
  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
             'order_id', o.id,
             'order_number', o.order_number,
             'round', o.session_seq,
             'status', o.status::text,
             'created_at', o.created_at,
             'subtotal', o.subtotal,
             'tax_amount', o.tax_amount,
             'service_fee', o.service_fee,
             'tip_amount', o.tip_amount,
             'discount_amount', o.discount_amount,
             'total', o.total,
             'mine', (o.customer_id in (select private.customer_ids_for_user())),
             'paid', exists (select 1 from public.payments p
                              where p.order_id = o.id and p.status = 'completed'),
             -- A line's options ride along ([{name, price_delta}]): without them two SET A lines
             -- that differ only by the egg look like the same dish listed twice.
             'items', coalesce((select jsonb_agg(jsonb_build_object(
                                         'name', oi.item_name,
                                         'quantity', oi.quantity,
                                         'unit_price', oi.unit_price,
                                         'subtotal', oi.subtotal,
                                         'notes', oi.notes,
                                         'options', private.order_line_options(oi.modifiers))
                                       order by oi.category_position nulls last,
                                                oi.item_position nulls last,
                                                oi.item_name collate "C",
                                                private.order_line_options_key(oi.modifiers) collate "C",
                                                oi.created_at, oi.id)
                                  from public.order_items oi where oi.order_id = o.id),
                               '[]'::jsonb))
           || case when v_staff then jsonb_build_object('customer_name', o.customer_name)
                   else '{}'::jsonb end as x
      from public.orders o
     where o.session_id = s.id and o.status not in ('cancelled', 'refunded')
  ) q;

  return jsonb_build_object(
    'session_id', s.id,
    'status', s.status,
    'table_id', s.table_id,
    'table_label', v_label,
    'opened_at', s.opened_at,
    'closed_at', s.closed_at,
    'closed_reason', s.closed_reason,
    'bill_requested_at', s.bill_requested_at,
    'party_size', s.party_size,
    'is_staff', v_staff,
    'orders', v_rows,
    'order_count', jsonb_array_length(v_rows),
    'running_total', coalesce((select sum(o.total) from public.orders o
                                where o.session_id = s.id
                                  and o.status not in ('cancelled', 'refunded')), 0),
    'outstanding', coalesce((select sum(o.total) from public.orders o
                              where o.session_id = s.id
                                and o.status not in ('cancelled', 'refunded')
                                and not exists (select 1 from public.payments p
                                                 where p.order_id = o.id
                                                   and p.status = 'completed')), 0),
    'session_code', case when v_staff or v_member then s.session_code else null end);
end $function$;

CREATE OR REPLACE FUNCTION public.issue_tax_invoice(p_order_id uuid, p_buyer_name text DEFAULT NULL::text, p_buyer_tax_id text DEFAULT NULL::text, p_buyer_address text DEFAULT NULL::text, p_buyer_email text DEFAULT NULL::text, p_invoice_type text DEFAULT 'tax_invoice'::text)
 RETURNS tax_invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_branch_id uuid;
  v_seq bigint;
  v_invoice public.tax_invoices%rowtype;
  v_line_items jsonb;
  v_buyer_name text;
  v_year int := extract(year from now())::int;
begin
  if v_uid is null then raise exception 'auth_required'; end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  -- Bugfix: order_status has no 'delivered' value; only 'completed' is valid here.
  -- Also allow 'ready' and 'confirmed' for early invoice issuance.
  if v_order.status not in ('completed','ready','confirmed') then
    raise exception 'order_not_completed';
  end if;

  v_branch_id := v_order.branch_id;
  -- Owner, admin and manager, as before — now wherever their row was created.
  if not private.staff_has_capability(v_branch_id, 'orders.refund') then
    raise exception 'not_authorized';
  end if;

  v_buyer_name := coalesce(p_buyer_name, v_order.customer_name, 'Walk-in customer');

  insert into public.tax_invoice_sequence(branch_id, next_value)
  values (v_branch_id, 1)
  on conflict (branch_id) do nothing;

  update public.tax_invoice_sequence
     set next_value = next_value + 1,
         updated_at = now()
   where branch_id = v_branch_id
  returning next_value - 1 into v_seq;

  -- Bugfix: order_items columns are item_name (not name) and subtotal (not line_total).
  -- In menu order, like the bill and the receipt: the invoice keeps this snapshot for good.
  --
  -- The unit is the one the line was charged at, options included, so quantity x unit is the
  -- line. order_items.unit_price is the plain dish and the options live in modifier_total, so
  -- copying unit_price printed "1 | $8.00 | $10.00" for #A-2609-0005's SET A with the $2.00
  -- fried egg. The rule is orderLineUnitPrice's in packages/shared/src/utils/money.ts, which every
  -- other bill uses (edit the two together): unit_price plus modifier_total per unit, to four
  -- decimals; and where those cannot reproduce the charged subtotal (a line edited by hand), the
  -- subtotal split evenly, to four decimals, so the invoice still agrees with what was paid.
  select jsonb_agg(jsonb_build_object(
           'name', oi.item_name,
           'quantity', oi.quantity,
           'unit_price', case when oi.subtotal is null
                                or round(u.unit * u.qty, 2) = oi.subtotal then u.unit
                              else round(oi.subtotal / u.qty, 4) end,
           'line_total', oi.subtotal
         ) order by oi.category_position nulls last, oi.item_position nulls last,
                    oi.item_name collate "C",
                    private.order_line_options_key(oi.modifiers) collate "C",
                    oi.created_at, oi.id)
    into v_line_items
    from public.order_items oi
   cross join lateral (
     select q.qty,
            round(oi.unit_price + coalesce(oi.modifier_total, 0) / q.qty, 4) as unit
       from (select greatest(coalesce(oi.quantity, 1), 1) as qty) q
   ) u
   where oi.order_id = p_order_id;

  insert into public.tax_invoices (
    order_id, branch_id, invoice_number, invoice_type,
    buyer_name, buyer_tax_id, buyer_address, buyer_email,
    subtotal, vat_amount, total, line_items,
    status, issued_at, created_by
  ) values (
    p_order_id,
    v_branch_id,
    'INV-' || v_year || '-' || lpad(v_seq::text, 6, '0'),
    p_invoice_type,
    v_buyer_name,
    p_buyer_tax_id,
    p_buyer_address,
    p_buyer_email,
    v_order.subtotal,
    coalesce(v_order.tax_amount, 0),
    v_order.total,
    coalesce(v_line_items, '[]'::jsonb),
    'issued',
    now(),
    v_uid
  ) returning * into v_invoice;

  return v_invoice;
end $function$;

-- 6. Backfill: every line, from the current menu --------------------------------------------------

update public.order_items oi
   set category_position = p.category_position,
       item_position     = p.item_position
  from public.order_items src
 cross join lateral private.order_line_menu_position(src.menu_item_id, src.combo_id) p
 where src.id = oi.id
   and (oi.category_position, oi.item_position) is distinct from (p.category_position, p.item_position);
