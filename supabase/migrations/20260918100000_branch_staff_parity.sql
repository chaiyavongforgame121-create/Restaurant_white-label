-- Staff authorization is the same on every branch: the owner and restaurant-wide staff are not
-- refused on a branch their staff row does not name.
--
-- The owner of Coastal Grill opened a second branch, Food Thai Thai, and found half the back
-- office refusing him there. Every owner and admin staff row of the restaurant names Hamburger (the
-- first branch), and about fifteen functions still asked for "a staff row whose branch_id is THIS
-- branch" — with no owner arm, no restaurant-wide (branch_id null) arm, no restaurants.owner_user_id
-- arm, and mostly no status = 'active' check either, so a suspended or removed member still passed.
-- 20260916140000 fixed my_capabilities and the payout functions; these were missed:
--   cancel_order (kitchen Reject, Orders cancel), refund_order, recall_order, issue_tax_invoice,
--   reorder_menu_categories, reorder_menu_items, set_menu_item_category, duplicate_menu_category,
--   requeue_failed_delivery, forecast_orders, get_sales_tax_report, tip_pool_distribution,
--   clock_in (not_staff_at_branch) and clock_out (an arbitrary "limit 1" staff row).
-- Each now asks private.staff_has_capability(<branch>, '<capability>'), the one rule RLS and the
-- admin layout already use: owner row anywhere in the restaurant, restaurant-wide row, a row at
-- this branch, owner_user_id or platform admin — active rows only. The capability sets match
-- today's role lists, so nobody gains or loses a permission on their own branch (one exception:
-- requeue_failed_delivery took any active staff row; delivery.manage is exactly the people who can
-- open the two back-office screens that call it):
--   cancel_order            orders.cancel or kitchen.access (the kitchen's Reject is a cancel)
--   refund_order            orders.refund
--   issue_tax_invoice       orders.refund (owner, admin, manager — as before)
--   recall_order            kitchen.access
--   menu reorder/duplicate  menu.manage
--   requeue_failed_delivery delivery.manage (it is only reachable from the back office)
--   reports                 reports.view
--   driver payouts          drivers.manage (the four payout functions had the owner arm already;
--                           this adds owner_user_id and keeps them identical to each other)
-- Error codes are unchanged (not_authorized, forbidden, not_staff_at_branch) so the UI maps hold.
--
-- Also in this migration:
--   * recall_order compared the status with 'dispatching', which is not an order_status value, so
--     Recall raised "invalid input value for enum" on EVERY branch. Only 'ready' is recallable.
--   * cancel_order's customer arm had a NULL hole: `v_order.customer_id <> v_customer_id` is null
--     for a walk-in order (customer_id null), so any signed-in diner could cancel any walk-in order.
--     It also read ONE customers row per user; the customers work moves to a row per (branch, user),
--     so the order must name any of the caller's rows. edit_pending_order had the same NULL hole.
--   * Stock comes back on cancellation through a trigger instead of cancel_order's inline UPDATE.
--     The inline one gave back only one line when an order had two lines of the same dish (UPDATE
--     ... FROM applies one joined row per target), ignored combos, and never ran for the other ways
--     an order is cancelled (decide_payment_proof's reject). The trigger expands lines with the same
--     helper as the sale-side decrement (private.order_line_stock_components) and fires only on the
--     status transition, so it cannot restore twice. A full refund before the kitchen started
--     (pending/confirmed -> refunded) gives stock back too; combo lines sold before combos took
--     stock give nothing back.
--   * refund_order let a null amount through its range check.
--   * get_sales_tax_report compared the status with 'delivered', not an order_status value, so it
--     raised on every call (the same defect as recall_order's 'dispatching').
--   * pay_driver_withdrawal / reject_driver_withdrawal lose PUBLIC and anon execute.
--   * clock_in / clock_out / my_open_shift: the shift is opened with the caller's staff row for the
--     branch (exact branch first, then restaurant-wide, then the owner row); staff_shifts.branch_id
--     stays the branch clocked in at. clock_out closes only the caller's own shift.
--   * private.staff_row_for_branch: the same row choice, for the *_by_staff / confirmed_by audit
--     columns. record_counter_payment, decide_payment_proof and the table-session functions picked
--     "any staff row of the restaurant, limit 1", which stamped Food Thai Thai's cash-ups with the
--     owner's Hamburger row.
--   * RLS policies that compared staff_members.branch_id with the row's branch are rebuilt on the
--     helpers (tip splits, promo redemptions, shifts, support tickets, sync jobs, gift-card
--     redemptions, tax-invoice sequence). Shift writes lose their "your own shift" arms: they let
--     a cashier move their shift to another branch or restaurant and rewrite its hours.
--   * private.order_ids_for_customer covers every customers row of the caller.
--   * custom_access_token_hook's branch_ids claim gets the owner arm and a restaurant check.
--
-- Every function is its live definition with the authorization (or the named defect) changed.
-- supabase/tests/branch_staff_parity.sql (rolled back) checks every function above as the owner,
-- a Hamburger-only admin, the cashier, the kitchen and a diner on both branches, the stock
-- restore, and lints pg_proc / pg_policies for any remaining branch-pinned staff check.

begin;

-- ---------------------------------------------------------------------------------------------
-- Shared: the caller's staff row for a branch.
-- ---------------------------------------------------------------------------------------------

-- The staff row that represents the caller AT this branch, for attribution: a row naming this
-- branch first, then a restaurant-wide row (branch_id null), then an owner row pinned elsewhere.
-- Null for the owner-by-owner_user_id and platform admins, who hold access without a staff row.
create or replace function private.staff_row_for_branch(p_branch_id uuid)
 returns uuid
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select sm.id
    from public.branches b
    join public.staff_members sm on sm.restaurant_id = b.restaurant_id
   where b.id = p_branch_id
     and sm.user_id = auth.uid()
     and sm.status = 'active'
     and (sm.branch_id = b.id or sm.branch_id is null or sm.role = 'owner')
   order by case when sm.branch_id = b.id then 0
                 when sm.branch_id is null then 1
                 else 2 end,
            sm.created_at, sm.id
   limit 1;
$function$;

revoke all on function private.staff_row_for_branch(uuid) from public, anon;
grant execute on function private.staff_row_for_branch(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Orders: cancel, refund, recall, receipt.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_is_staff boolean;
  v_is_customer boolean;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  -- Staff who may cancel at this branch, and the kitchen, whose Reject is a cancel. The helper
  -- covers owner rows, restaurant-wide rows, owner_user_id, platform admins and active status.
  v_is_staff := private.staff_has_capability(v_order.branch_id, 'orders.cancel')
             or private.staff_has_capability(v_order.branch_id, 'kitchen.access');
  -- A diner may cancel an order only when it names one of their customer rows. A walk-in order
  -- names nobody: the old `customer_id <> mine` was null there, and null never raised.
  v_is_customer := v_order.customer_id is not null
    and v_order.customer_id in (select c.id from public.customers c where c.user_id = v_uid);
  if not v_is_staff and not v_is_customer then
    raise exception 'not_authorized';
  end if;
  if v_order.status in ('completed','cancelled','refunded') then
    raise exception 'cannot_cancel_status:%', v_order.status;
  end if;
  if not v_is_staff and v_order.status not in ('pending','confirmed') then
    raise exception 'too_late_for_customer_cancel';
  end if;

  update public.orders
     set status = 'cancelled',
         cancellation_reason = coalesce(v_reason, cancellation_reason),
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
           'status', 'cancelled', 'at', now(), 'by', case when v_is_staff then 'staff' else 'customer' end,
           'reason', v_reason
         )
   where id = p_order_id;

  -- Stock is given back by the orders_restore_stock_on_cancel trigger, which every path into
  -- 'cancelled' goes through.

  return jsonb_build_object('ok', true, 'order_id', p_order_id);
end $function$;

CREATE OR REPLACE FUNCTION public.refund_order(p_order_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  if not private.staff_has_capability(v_order.branch_id, 'orders.refund') then
    raise exception 'not_authorized';
  end if;
  -- A null amount compared as null and slipped past the old `<= 0 or > total` test.
  if p_amount is null or p_amount <= 0 or p_amount > coalesce(v_order.total, 0) then
    raise exception 'invalid_refund_amount';
  end if;
  -- Mark order; actual Omise refund call happens in refund-payment edge function
  update public.orders
     set status = case when p_amount >= v_order.total then 'refunded' else status end,
         cancellation_reason = case when p_amount >= v_order.total
                                    then coalesce(v_reason, cancellation_reason)
                                    else cancellation_reason end,
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
           'status', 'refund', 'at', now(), 'by', v_uid, 'amount', p_amount, 'reason', v_reason
         )
   where id = p_order_id;
  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  select b.restaurant_id, v_order.branch_id, v_uid, 'staff', 'refund', 'order', p_order_id,
         jsonb_build_object('amount', p_amount, 'reason', v_reason)
    from public.branches b where b.id = v_order.branch_id;
  return jsonb_build_object('ok', true, 'amount', p_amount);
end $function$;

CREATE OR REPLACE FUNCTION public.recall_order(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  if not private.staff_has_capability(v_order.branch_id, 'kitchen.access') then
    raise exception 'not_authorized';
  end if;
  -- Only a ticket the kitchen has marked ready comes back. ('dispatching' was listed here, but it
  -- is a delivery status, not an order_status, and the comparison itself raised.)
  if v_order.status <> 'ready' then
    raise exception 'not_recallable_status:%', v_order.status;
  end if;
  -- Within 5 min only
  if (select coalesce((status_history->-1->>'at')::timestamptz, created_at) < now() - interval '5 min'
        from public.orders where id = p_order_id) then
    raise exception 'recall_window_passed';
  end if;
  update public.orders
     set status = 'preparing',
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
           'status', 'preparing', 'at', now(), 'by', 'recall'
         )
   where id = p_order_id;
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
  select jsonb_agg(jsonb_build_object(
           'name', oi.item_name,
           'quantity', oi.quantity,
           'unit_price', oi.unit_price,
           'line_total', oi.subtotal
         ))
    into v_line_items
    from public.order_items oi
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

-- Not called by any app today, and its order_items insert still names columns that no longer
-- exist (name, line_total), so it cannot complete. Its authorization is fixed anyway so that
-- whoever revives it does not revive the hole: a walk-in order (customer_id null) passed the old
-- `customer_id <> mine` check, and only one of the caller's customer rows was considered.
CREATE OR REPLACE FUNCTION public.edit_pending_order(p_order_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_subtotal numeric := 0;
  v_item jsonb;
  v_price numeric;
  v_name text;
  v_station text;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if not exists (select 1 from public.customers where user_id = v_uid) then
    raise exception 'no_customer_record';
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.customer_id is null
     or v_order.customer_id not in (select c.id from public.customers c where c.user_id = v_uid) then
    raise exception 'not_your_order';
  end if;
  if v_order.status not in ('pending','confirmed') then
    raise exception 'order_locked_status:%', v_order.status;
  end if;

  -- Wipe and rebuild order_items
  delete from public.order_items where order_id = p_order_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    -- Only this branch's dishes: another branch's menu is not this order's menu.
    select price, name, station into v_price, v_name, v_station
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid
       and branch_id = v_order.branch_id;
    if v_price is null then raise exception 'item_not_found:%', v_item->>'menu_item_id'; end if;
    insert into public.order_items (order_id, menu_item_id, name, quantity, unit_price, line_total, notes, station)
    values (p_order_id, (v_item->>'menu_item_id')::uuid, v_name,
            (v_item->>'quantity')::int, v_price,
            v_price * (v_item->>'quantity')::int, v_item->>'notes', v_station);
    v_subtotal := v_subtotal + v_price * (v_item->>'quantity')::int;
  end loop;
  update public.orders
     set subtotal = v_subtotal,
         total = v_subtotal + coalesce(delivery_fee,0) + coalesce(service_fee,0) +
                 coalesce(tax_amount,0) + coalesce(tip_amount,0) - coalesce(discount_amount,0)
   where id = p_order_id;
  return jsonb_build_object('ok', true, 'subtotal', v_subtotal);
end $function$;

-- ---------------------------------------------------------------------------------------------
-- Stock comes back when an order is cancelled — by whatever path.
-- ---------------------------------------------------------------------------------------------

-- The mirror image of order_items_decrement_stock (20260918170000_stock_integrity), which takes
-- stock when a line is inserted. Both expand a line with private.order_line_stock_components, so
-- what a sale takes and what a cancellation gives back cannot drift apart:
--   * a dish line (menu_item_id set) is that dish x line quantity;
--   * a combo line (menu_item_id null, combo_id set) is each dish in order_items.combo_contents
--     (the snapshot place-order stores, quantity per ONE combo) when the line has one, else the
--     combo's current combo_items; component quantity x line quantity.
-- The parts are summed per dish over the whole order first, so two "1x Pad Kra Pao" lines give
-- back 2 (cancel_order's old UPDATE ... FROM applied one joined row per dish and gave back 1).
-- Like the sale, only tracked dishes with a count, and only dishes of the order's own branch, move.
-- Stock comes back when the order is un-sold:
--   * into 'cancelled' from any live status (not from 'refunded': see below);
--   * into 'refunded' from 'pending' or 'confirmed': a full refund before the kitchen started on it
--     is a cancellation with money back, nothing was made. From 'preparing' on, the food was (being)
--     made and the stock is gone.
-- Moving out of 'cancelled' into a live status (a manual un-cancel) sells it again through
-- private.take_stock_for_sale, so a later second cancel cannot give it back twice.
-- 'cancelled' -> 'refunded' and 'refunded' -> 'cancelled' move nothing: whatever was given back
-- already was, and 'refunded' is terminal (no function moves an order out of it).
-- Combo lines written before the combo-aware decrement went live (20260918170000_stock_integrity,
-- applied 2026-09-18 05:45:50 UTC) never took their dishes (the old decrement returned on a null
-- menu_item_id), so they give nothing back and take nothing on an un-cancel. Without this, the
-- kitchen rejecting one of the open pre-September-18 combo orders put a sold-out Fountain Cola back
-- on sale. No combo line was written between 00:36 UTC that day and the apply, so the cutoff is
-- exact for the data.
-- Nothing else on the dish (sold_out_until, is_active) is touched.
-- Note: the sale clamps at 0, so an oversold line gives back more than it took. There is no record
-- of the clamp to undo against.
create or replace function private.tg_orders_restore_stock_on_cancel()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  v_qty int;
  v_give_back boolean;
  v_take_again boolean;
begin
  if new.status is not distinct from old.status then return new; end if;
  v_give_back := (new.status = 'cancelled' and old.status <> 'refunded')
              or (new.status = 'refunded' and old.status in ('pending', 'confirmed'));
  v_take_again := old.status = 'cancelled' and new.status not in ('cancelled', 'refunded');
  if not (v_give_back or v_take_again) then
    return new;
  end if;

  for r in
    select c.menu_item_id, sum(c.quantity)::int as qty
      from public.order_items oi
      cross join lateral private.order_line_stock_components(
        oi.menu_item_id, oi.combo_id, oi.combo_contents, oi.quantity) c
     where oi.order_id = new.id
       -- A combo line from before combos took stock took none.
       and not (oi.menu_item_id is null and oi.created_at < timestamptz '2026-09-18 05:45:50+00')
     group by c.menu_item_id
     order by c.menu_item_id   -- one lock order for every writer, so two cancels cannot deadlock
  loop
    if v_take_again then
      -- Un-cancelled: the order is live again and takes its stock like a sale.
      perform private.take_stock_for_sale(r.menu_item_id, r.qty, new.branch_id);
      continue;
    end if;

    select mi.stock_quantity into v_qty
      from public.menu_items mi
     where mi.id = r.menu_item_id
       and mi.track_stock
       and mi.stock_quantity is not null
       and (new.branch_id is null or mi.branch_id = new.branch_id)
       for update;
    if not found then continue; end if;

    update public.menu_items
       set stock_quantity = v_qty + r.qty,
           updated_at = now()
     where id = r.menu_item_id;
  end loop;

  return new;
end $function$;

revoke all on function private.tg_orders_restore_stock_on_cancel() from public, anon, authenticated;

drop trigger if exists orders_restore_stock_on_cancel on public.orders;
create trigger orders_restore_stock_on_cancel
  after update of status on public.orders
  for each row
  when (new.status is distinct from old.status)
  execute function private.tg_orders_restore_stock_on_cancel();

-- ---------------------------------------------------------------------------------------------
-- Menu.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reorder_menu_categories(p_branch_id uuid, p_orders jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if not private.staff_has_capability(p_branch_id, 'menu.manage') then
    raise exception 'not_authorized';
  end if;

  update public.menu_categories mc
     set display_order = (e->>'display_order')::int,
         updated_at = now()
    from jsonb_array_elements(p_orders) e
   where mc.id = (e->>'id')::uuid
     and mc.branch_id = p_branch_id;
end $function$;

CREATE OR REPLACE FUNCTION public.reorder_menu_items(p_branch_id uuid, p_orders jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if not private.staff_has_capability(p_branch_id, 'menu.manage') then
    raise exception 'not_authorized';
  end if;

  update public.menu_items mi
     set display_order = (e->>'display_order')::int,
         updated_at = now()
    from jsonb_array_elements(p_orders) e
   where mi.id = (e->>'id')::uuid
     and mi.branch_id = p_branch_id;
end $function$;

CREATE OR REPLACE FUNCTION public.set_menu_item_category(p_branch_id uuid, p_item_id uuid, p_category_id uuid, p_display_order integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if not private.staff_has_capability(p_branch_id, 'menu.manage') then
    raise exception 'not_authorized';
  end if;

  update public.menu_items
     set category_id = p_category_id,
         display_order = p_display_order,
         updated_at = now()
   where id = p_item_id
     and branch_id = p_branch_id;
end $function$;

CREATE OR REPLACE FUNCTION public.duplicate_menu_category(p_category_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_src public.menu_categories%rowtype;
  v_new_cat_id uuid;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_src from public.menu_categories where id = p_category_id;
  if not found then raise exception 'category_not_found'; end if;
  if not private.staff_has_capability(v_src.branch_id, 'menu.manage') then
    raise exception 'not_authorized';
  end if;
  insert into public.menu_categories (branch_id, name, name_translations, description, icon_emoji, display_order)
  values (v_src.branch_id, v_src.name || ' (Copy)', v_src.name_translations, v_src.description,
          v_src.icon_emoji, v_src.display_order + 1)
  returning id into v_new_cat_id;
  insert into public.menu_items (
    branch_id, category_id, name, name_translations, description, description_translations,
    price, cost, image_url, is_active, is_recommended, station, display_order
  )
  select branch_id, v_new_cat_id, name, name_translations, description, description_translations,
         price, cost, image_url, false, is_recommended, station, display_order
    from public.menu_items where category_id = p_category_id;
  return v_new_cat_id;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- Deliveries.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.requeue_failed_delivery(p_delivery_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'private', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  d record;
  v_url text;
  v_key text;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;

  if not private.staff_has_capability(d.branch_id, 'delivery.manage') then
    raise exception 'forbidden';
  end if;
  if d.status <> 'failed' then raise exception 'not_failed'; end if;

  -- A requeued job restarts solo; any old pairing is dissolved.
  if d.batch_id is not null then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
  end if;

  update public.delivery_assignments
     set ended_at   = coalesce(ended_at, now()),
         status     = 'failed',
         end_kind   = coalesce(end_kind, 'requeued_by_staff'),
         end_reason = coalesce(end_reason, d.failed_reason)
   where delivery_id = p_delivery_id and ended_at is null;

  update public.deliveries
  set status = 'dispatching',
      driver_id = null,
      accepted_at = null,
      offered_at = null,
      offer_expires_at = null,
      failed_reason = null,
      failed_photo_url = null,
      dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
        || jsonb_build_object('type','requeued_by_staff','at', now())
  where id = p_delivery_id;

  v_url := private.get_setting('supabase_url');
  v_key := private.get_setting('service_role_key');
  if v_url is not null and v_key is not null then
    perform net.http_post(
      url := v_url || '/functions/v1/dispatch-driver',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_build_object('delivery_id', p_delivery_id),
      timeout_milliseconds := 5000
    );
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Reports (no app callers today; fixed so a future caller does not inherit the gap).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.forecast_orders(p_branch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
begin
  if not private.staff_has_capability(p_branch_id, 'reports.view') then
    raise exception 'not_authorized';
  end if;

  with daily as (
    select date_trunc('day', created_at)::date as day, count(*) as orders, coalesce(sum(total),0) as revenue
      from public.orders
     where branch_id = p_branch_id
       and created_at >= now() - interval '28 days'
       and status in ('completed','confirmed','preparing','ready','out_for_delivery')
     group by 1
  ),
  weekday_avg as (
    select extract(dow from day) as dow, avg(orders) as avg_orders, avg(revenue) as avg_revenue
      from daily group by extract(dow from day)
  )
  select jsonb_agg(jsonb_build_object(
    'date', (current_date + n)::text,
    'dow', extract(dow from (current_date + n)),
    'predicted_orders', round(coalesce(wa.avg_orders, 0)),
    'predicted_revenue', round(coalesce(wa.avg_revenue, 0), 2)
  ) order by n)
  into v_result
  from generate_series(0, 6) as n
  left join weekday_avg wa on wa.dow = extract(dow from (current_date + n));

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_tax_report(p_branch_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
begin
  if not private.staff_has_capability(p_branch_id, 'reports.view') then
    raise exception 'not_authorized';
  end if;

  with rows as (
    select
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
      count(*) as order_count,
      coalesce(sum(subtotal), 0) as gross,
      coalesce(sum(discount_amount), 0) as discounts,
      coalesce(sum(tax_amount), 0) as tax_collected,
      coalesce(sum(total), 0) as net_total
    from public.orders
    where branch_id = p_branch_id
      and created_at >= p_from
      and created_at <  p_to
      -- 'delivered' was listed here too; it is not an order_status value, so every call raised.
      and status in ('completed','confirmed','preparing','ready','out_for_delivery')
    group by 1
    order by 1
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'daily', coalesce(jsonb_agg(jsonb_build_object(
      'day', day,
      'order_count', order_count,
      'gross', gross,
      'discounts', discounts,
      'tax_collected', tax_collected,
      'net_total', net_total
    )), '[]'::jsonb),
    'total_tax_collected', coalesce(sum(tax_collected), 0),
    'total_gross', coalesce(sum(gross), 0)
  ) into v_result
  from rows;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tip_pool_distribution(p_branch_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(staff_member_id uuid, staff_email text, hours numeric, share numeric, payout numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total_tips numeric;
  v_total_hours numeric;
begin
  if not private.staff_has_capability(p_branch_id, 'reports.view') then
    raise exception 'not_authorized';
  end if;

  select coalesce(sum(tip_amount), 0) into v_total_tips
    from public.orders
   where branch_id = p_branch_id
     and created_at >= p_from
     and created_at <  p_to
     and status in ('completed','confirmed','ready','out_for_delivery')
     and channel <> 'delivery';   -- delivery tips go to the driver, not the staff pool

  select coalesce(sum(
    extract(epoch from (
      least(coalesce(s.clocked_out_at, p_to), p_to) -
      greatest(s.clocked_in_at, p_from)
    )) / 3600.0
  ), 0) into v_total_hours
  from public.staff_shifts s
  where s.branch_id = p_branch_id
    and s.clocked_in_at < p_to
    and coalesce(s.clocked_out_at, p_to) > p_from;

  if v_total_hours <= 0 then return; end if;

  return query
  with hrs as (
    select
      s.staff_member_id,
      sum(
        extract(epoch from (
          least(coalesce(s.clocked_out_at, p_to), p_to) -
          greatest(s.clocked_in_at, p_from)
        )) / 3600.0
      ) as h
    from public.staff_shifts s
    where s.branch_id = p_branch_id
      and s.clocked_in_at < p_to
      and coalesce(s.clocked_out_at, p_to) > p_from
    group by s.staff_member_id
  )
  select
    hrs.staff_member_id,
    coalesce(sm.invited_email, u.email)::text as staff_email,
    round(hrs.h::numeric, 2) as hours,
    round((hrs.h / v_total_hours)::numeric, 4) as share,
    round((v_total_tips * (hrs.h / v_total_hours))::numeric, 2) as payout
  from hrs
  join public.staff_members sm on sm.id = hrs.staff_member_id
  left join auth.users u on u.id = sm.user_id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Driver payouts: already had the owner and restaurant-wide arms; now the same helper as the rest,
-- which adds restaurants.owner_user_id and keeps the four identical.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_driver_payout_paid(p_branch_id uuid, p_driver_id uuid, p_period_start date, p_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_count int; v_total numeric;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if not private.staff_has_capability(p_branch_id, 'drivers.manage') then
    raise exception 'not_authorized';
  end if;

  update public.driver_earnings_ledger
     set status = 'paid', paid_at = now(), paid_by = v_uid, paid_reference = p_reference
   where branch_id = p_branch_id and driver_id = p_driver_id
     and payout_period_start = p_period_start and status = 'accrued';
  get diagnostics v_count = row_count;

  select coalesce(sum(total), 0) into v_total from public.driver_earnings_ledger
   where branch_id = p_branch_id and driver_id = p_driver_id
     and payout_period_start = p_period_start and status = 'paid';

  return jsonb_build_object('marked_paid', v_count, 'driver_id', p_driver_id,
    'period_start', p_period_start, 'period_paid_total', round(v_total, 2));
end;
$function$;

CREATE OR REPLACE FUNCTION public.pay_driver_withdrawal(p_withdrawal_id uuid, p_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  w record;
  v_receipt text;
  v_count int;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into w from public.driver_withdrawals where id = p_withdrawal_id for update;
  if not found then raise exception 'not_found'; end if;
  if not private.staff_has_capability(w.branch_id, 'drivers.manage') then
    raise exception 'not_authorized';
  end if;
  if w.status <> 'pending' then raise exception 'not_pending'; end if;

  v_receipt := 'RCPT-' || to_char(now(), 'YYYYMM') || '-'
            || lpad(nextval('public.withdrawal_receipt_seq')::text, 4, '0');

  update public.driver_earnings_ledger
     set status = 'paid', paid_at = now(), paid_by = v_uid, paid_reference = v_receipt
   where withdrawal_id = p_withdrawal_id and status = 'accrued';
  get diagnostics v_count = row_count;

  update public.driver_withdrawals
     set status = 'paid', approved_at = now(), approved_by = v_uid,
         paid_at = now(), receipt_number = v_receipt
   where id = p_withdrawal_id;

  return jsonb_build_object('receipt_number', v_receipt, 'amount', w.amount, 'entries_paid', v_count);
end;
$function$;

CREATE OR REPLACE FUNCTION public.reject_driver_withdrawal(p_withdrawal_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  w record;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into w from public.driver_withdrawals where id = p_withdrawal_id for update;
  if not found then raise exception 'not_found'; end if;
  if not private.staff_has_capability(w.branch_id, 'drivers.manage') then
    raise exception 'not_authorized';
  end if;
  if w.status <> 'pending' then raise exception 'not_pending'; end if;

  -- Release the tagged rows so they count toward the driver's next request.
  update public.driver_earnings_ledger
     set withdrawal_id = null
   where withdrawal_id = p_withdrawal_id and status = 'accrued';

  update public.driver_withdrawals
     set status = 'rejected', rejection_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_withdrawal_id;

  return jsonb_build_object('rejected', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.attach_driver_payout_slip(p_withdrawal_id uuid, p_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  w public.driver_withdrawals;
begin
  select * into w from public.driver_withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if not private.staff_has_capability(w.branch_id, 'drivers.manage') then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  -- Pending (transfer sent, about to be marked paid) and paid (slip filed afterwards, which
  -- is the common order -- merchants transfer first and screenshot second) are both
  -- legitimate. A rejected request has no money behind it.
  if w.status = 'rejected' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;

  if p_path is not null and split_part(p_path, '/', 1) <> p_withdrawal_id::text then
    raise exception 'path_not_owned' using errcode = 'P0001';
  end if;

  update public.driver_withdrawals
     set transfer_slip_path = p_path,
         transfer_slip_at = case when p_path is null then null else now() end
   where id = p_withdrawal_id;

  insert into public.audit_logs(branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (w.branch_id, v_uid, 'staff', 'driver_payout_slip_attached',
          'driver_withdrawal', p_withdrawal_id, jsonb_build_object('path', p_path));

  return jsonb_build_object('withdrawal_id', p_withdrawal_id, 'transfer_slip_path', p_path);
end;
$function$;

-- pay/reject were still executable by PUBLIC and anon (they refused an anonymous caller only
-- through auth_required); the other two payout functions were already signed-in only.
revoke all on function public.pay_driver_withdrawal(uuid, text) from public, anon;
revoke all on function public.reject_driver_withdrawal(uuid, text) from public, anon;
grant execute on function public.pay_driver_withdrawal(uuid, text) to authenticated, service_role;
grant execute on function public.reject_driver_withdrawal(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Time clock.
-- ---------------------------------------------------------------------------------------------

-- The shift is opened with the caller's row for this branch (exact, restaurant-wide, owner) and
-- stays filed under this branch, so each branch's hours and tip pool remain its own. One open
-- shift per person: a shift still open at another branch must be closed there first, or the
-- same hours would count in two tip pools. The check and the insert run under a per-person
-- transaction lock, so a double tap or two counters clocking in at once cannot both pass the
-- check (the open-shift index is per staff row and a person can hold several rows).
CREATE OR REPLACE FUNCTION public.clock_in(p_branch_id uuid, p_shift_role text DEFAULT 'general'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_staff_id uuid;
  v_shift_id uuid;
  v_open_branch uuid;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  v_staff_id := private.staff_row_for_branch(p_branch_id);
  if v_staff_id is null then raise exception 'not_staff_at_branch'; end if;
  perform pg_advisory_xact_lock(hashtext('clock_in:' || v_uid::text));
  select s.branch_id into v_open_branch
    from public.staff_shifts s
    join public.staff_members sm on sm.id = s.staff_member_id
   where sm.user_id = v_uid
     and s.clocked_out_at is null
   order by (s.branch_id = p_branch_id) desc, s.clocked_in_at desc
   limit 1;
  if found then
    if v_open_branch = p_branch_id then raise exception 'already_clocked_in'; end if;
    raise exception 'clocked_in_elsewhere';
  end if;
  insert into public.staff_shifts (staff_member_id, branch_id, shift_role)
    values (v_staff_id, p_branch_id, coalesce(p_shift_role, 'general'))
    returning id into v_shift_id;
  return v_shift_id;
end;
$function$;

-- Closes the caller's own shift: p_shift_id must belong to one of their staff rows (a second tap
-- on an already closed shift returns when it closed). Without p_shift_id, every open shift of
-- theirs closes. It used to resolve the caller as `staff_members where user_id = me limit 1`, an
-- arbitrary row, and re-stamp clocked_out_at on a shift that was already closed.
CREATE OR REPLACE FUNCTION public.clock_out(p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_when timestamptz := now();
  v_closed_at timestamptz;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if not exists (select 1 from public.staff_members where user_id = v_uid) then
    raise exception 'not_staff';
  end if;
  if p_shift_id is null then
    update public.staff_shifts s
      set clocked_out_at = v_when
    where s.clocked_out_at is null
      and s.staff_member_id in (select sm.id from public.staff_members sm where sm.user_id = v_uid);
  else
    update public.staff_shifts s
      set clocked_out_at = v_when
    where s.id = p_shift_id
      and s.clocked_out_at is null
      and s.staff_member_id in (select sm.id from public.staff_members sm where sm.user_id = v_uid);
    if not found then
      select s.clocked_out_at into v_closed_at
        from public.staff_shifts s
       where s.id = p_shift_id
         and s.staff_member_id in (select sm.id from public.staff_members sm where sm.user_id = v_uid);
      if v_closed_at is null then raise exception 'shift_not_found'; end if;
      return v_closed_at;
    end if;
  end if;
  return v_when;
end;
$function$;

-- The caller's open shift at this branch, for the counter's clock button: null when there is
-- none, else {shift_id, clock_in_at, role (the shift role), staff_member_id}. Reads only the
-- caller's own shifts, so it needs no further check.
create or replace function public.my_open_shift(p_branch_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
           'shift_id', s.id,
           'clock_in_at', s.clocked_in_at,
           'role', s.shift_role,
           'staff_member_id', s.staff_member_id)
    from public.staff_shifts s
    join public.staff_members sm on sm.id = s.staff_member_id
   where sm.user_id = auth.uid()
     and s.branch_id = p_branch_id
     and s.clocked_out_at is null
   order by s.clocked_in_at desc
   limit 1;
$function$;

revoke all on function public.my_open_shift(uuid) from public, anon;
grant execute on function public.my_open_shift(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Attribution: the staff row for THIS branch, not any row of the restaurant.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_counter_payment(p_order_id uuid, p_tendered numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch  uuid;
  v_total   numeric;
  v_status  text;
  v_payment public.payments%rowtype;
  v_staff   uuid;
begin
  select o.branch_id, o.total, o.status::text
    into v_branch, v_total, v_status
    from public.orders o
   where o.id = p_order_id;
  if v_branch is null then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if not (private.staff_has_capability(v_branch, 'counter.access')
          or private.staff_has_capability(v_branch, 'payments.decide')) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  -- A transfer settles through decide_payment_proof, against a photograph of the slip.
  -- Letting the till complete one would hand the merchant a way to skip looking at it.
  select p.* into v_payment
    from public.payments p
   where p.order_id = p_order_id
     and p.method <> 'transfer'
   order by (p.status = 'pending') desc, p.created_at desc
   limit 1;
  if v_payment.id is null then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;

  -- Idempotent. A cashier who taps Charge twice, or a client that retries after a dropped
  -- response, must not mint a second settlement or a second audit row.
  if v_payment.status = 'completed' then
    return v_payment.id;
  end if;
  if v_payment.status in ('refunded', 'voided') then
    raise exception 'payment_not_settleable' using errcode = 'P0001';
  end if;

  -- payments.confirmed_by references staff_members(id), NOT auth.users(id), and is null
  -- for the restaurant's owner_user_id and platform admins, who hold access without a
  -- staff row. coalesce keeps whatever was already there rather than blanking it. The row
  -- is the caller's row for THIS branch, not whichever row of the restaurant came first.
  v_staff := private.staff_row_for_branch(v_branch);

  -- The amount is re-read from the order rather than taken from the caller. The till
  -- applies its discount to orders.total after place-order priced the row, so the figure
  -- the payment was inserted with is stale by the time the cash is in the drawer — and a
  -- number the client supplied is exactly the number this function exists not to trust.
  update public.payments
     set status = 'completed',
         amount = coalesce(v_total, amount),
         paid_at = now(),
         confirmed_by = coalesce(v_staff, confirmed_by),
         confirmed_at = now(),
         gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'settled_at', now(),
                                 'settled_via', 'counter',
                                 'tendered', p_tendered
                               )
   where id = v_payment.id;

  -- Cash already reaches 'confirmed' through payments_confirm_cash_order; a card sale at
  -- the counter has no such trigger, and the till used to promote it with a raw update
  -- whose result nobody read.
  if v_status = 'pending' then
    update public.orders set status = 'confirmed' where id = p_order_id and status = 'pending';
  end if;

  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_branch, auth.uid(), 'staff', 'counter_payment_recorded', 'payment', v_payment.id,
          jsonb_build_object('order_id', p_order_id, 'method', v_payment.method, 'amount', v_total));

  return v_payment.id;
end $function$;

CREATE OR REPLACE FUNCTION public.decide_payment_proof(p_payment_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid;
  v_order uuid;
  v_staff uuid;
begin
  select p.branch_id, p.order_id into v_branch, v_order
    from public.payments p where p.id = p_payment_id;
  if v_branch is null then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;
  if not private.user_manages_branch(v_branch) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  v_staff := private.staff_row_for_branch(v_branch);

  update public.payments
     set status = case when p_approve then 'completed'::payment_status else 'failed'::payment_status end,
         confirmed_by = v_staff,
         confirmed_at = now(),
         paid_at = case when p_approve then now() else paid_at end,
         gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                            || jsonb_build_object('decision_note', p_note, 'decided_at', now())
                            || jsonb_build_object('pending', false)
   where id = p_payment_id;

  if p_approve then
    update public.orders
       set status = case when status = 'pending' then 'confirmed'::order_status else status end,
           awaiting_payment = false
     where id = v_order;
  else
    -- The stock this order took comes back through orders_restore_stock_on_cancel.
    update public.orders
       set status = 'cancelled',
           awaiting_payment = false,
           cancellation_reason = coalesce(nullif(btrim(p_note), ''), 'Payment slip was not accepted.'),
           status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object(
             'status', 'cancelled',
             'at', now(),
             'by', 'staff',
             'reason', coalesce(nullif(btrim(p_note), ''), 'Payment slip was not accepted.')
           )
     where id = v_order
       and status in ('pending', 'confirmed');
  end if;

  insert into public.audit_logs(branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_branch, auth.uid(), 'staff',
          case when p_approve then 'payment_proof_approved' else 'payment_proof_rejected' end,
          'payment', p_payment_id, jsonb_build_object('note', p_note));
end $function$;

CREATE OR REPLACE FUNCTION public.open_table_session(p_table_id uuid, p_party_size integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_bid uuid;
  v_staff uuid;
  v_ttl int;
  v_id uuid;
begin
  select branch_id into v_bid from public.tables where id = p_table_id and is_active;
  if v_bid is null then
    raise exception 'table_not_found' using errcode = 'P0001';
  end if;
  if not private.staff_has_capability(v_bid, 'counter.access') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select id into v_id from public.table_sessions
   where table_id = p_table_id and status <> 'closed' limit 1;
  if v_id is not null then
    -- Idempotent: seating a table that is already seated is a no-op, not a second bill.
    if p_party_size is not null then
      update public.table_sessions set party_size = p_party_size where id = v_id;
    end if;
    update public.tables set status = 'occupied' where id = p_table_id;
    return v_id;
  end if;

  -- The same lookup record_counter_payment uses: the *_by_staff columns reference
  -- staff_members(id), and the restaurant's owner or a platform admin has no staff row.
  v_staff := private.staff_row_for_branch(v_bid);

  select greatest(30, least(1440, coalesce((b.settings->'dine_in'->>'ttl_min')::int, 240)))
    into v_ttl from public.branches b where b.id = v_bid;

  insert into public.table_sessions
    (branch_id, table_id, opened_via, opened_by_user, opened_by_staff, party_size, expires_at)
  values
    (v_bid, p_table_id, 'staff', auth.uid(), v_staff, p_party_size,
     now() + make_interval(mins => coalesce(v_ttl, 240)))
  returning id into v_id;

  update public.tables set status = 'occupied' where id = p_table_id;
  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_bid, auth.uid(), 'staff', 'table_session_opened', 'table_session', v_id,
          jsonb_build_object('table_id', p_table_id, 'via', 'staff', 'party_size', p_party_size));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.settle_table_session(p_session_id uuid, p_tendered numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  s public.table_sessions%rowtype;
  v_staff uuid;
  o record;
  v_settled int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_total numeric := 0;
begin
  select * into s from public.table_sessions where id = p_session_id;
  if s.id is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  if not (private.staff_has_capability(s.branch_id, 'counter.access')
          or private.staff_has_capability(s.branch_id, 'payments.decide')) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if s.status = 'closed' then
    return jsonb_build_object('already_closed', true, 'session_id', s.id,
                              'orders_settled', 0, 'skipped', '[]'::jsonb, 'total', 0);
  end if;

  for o in select id, order_number, status from public.orders
            where session_id = s.id and status not in ('cancelled', 'refunded')
            order by session_seq loop
    begin
      -- Reuses the one function allowed to say money arrived: it re-reads orders.total,
      -- refuses a QR transfer (those settle against a photograph via decide_payment_proof),
      -- stamps the staff member and writes its own audit row -- per order, which is what a
      -- split bill needs. A refusal is collected rather than swallowed, so the floor board
      -- can say "that round still needs its slip approved" instead of claiming it is paid.
      perform public.record_counter_payment(o.id, null::numeric);
      v_settled := v_settled + 1;
      if o.status = 'ready' then
        update public.orders set status = 'completed' where id = o.id and status = 'ready';
      end if;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('order_number', o.order_number, 'reason', sqlerrm);
    end;
  end loop;

  select coalesce(sum(total), 0) into v_total from public.orders
   where session_id = s.id and status not in ('cancelled', 'refunded');

  v_staff := private.staff_row_for_branch(s.branch_id);

  update public.table_sessions
     set status = 'closed', closed_at = now(), closed_reason = 'paid',
         closed_by_user = auth.uid(), closed_by_staff = coalesce(v_staff, closed_by_staff)
   where id = s.id;

  -- 'dirty', not 'open': the plates are still on it. The floor board's Clear action, or the
  -- next open_table_session, is what puts the table back into service.
  update public.tables set status = 'dirty' where id = s.table_id;

  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (s.branch_id, auth.uid(), 'staff', 'table_session_settled', 'table_session', s.id,
          jsonb_build_object('orders_settled', v_settled, 'skipped', v_skipped,
                             'total', v_total, 'tendered', p_tendered));

  return jsonb_build_object('session_id', s.id, 'orders_settled', v_settled,
                            'skipped', v_skipped, 'total', v_total);
end $function$;

CREATE OR REPLACE FUNCTION public.close_table_session(p_session_id uuid, p_reason text DEFAULT 'staff_closed'::text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  s public.table_sessions%rowtype;
  v_staff uuid;
  v_out numeric;
begin
  if p_reason not in ('staff_closed', 'voided', 'abandoned') then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  select * into s from public.table_sessions where id = p_session_id;
  if s.id is null then
    raise exception 'session_not_found' using errcode = 'P0001';
  end if;
  if s.status = 'closed' then
    return;
  end if;

  select coalesce(sum(o.total), 0) into v_out from public.orders o
   where o.session_id = s.id
     and o.status not in ('cancelled', 'refunded')
     and not exists (select 1 from public.payments p
                      where p.order_id = o.id and p.status = 'completed');

  -- Walking away from money is a manager's decision, not a cashier's.
  if v_out > 0 and not private.staff_has_capability(s.branch_id, 'payments.decide') then
    raise exception 'unpaid_needs_manager' using errcode = 'P0001';
  end if;
  if v_out = 0 and not private.staff_has_capability(s.branch_id, 'counter.access') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  v_staff := private.staff_row_for_branch(s.branch_id);

  update public.table_sessions
     set status = 'closed', closed_at = now(), closed_reason = p_reason,
         closed_by_user = auth.uid(), closed_by_staff = coalesce(v_staff, closed_by_staff),
         notes = coalesce(p_note, notes)
   where id = s.id;
  update public.tables set status = case when v_out > 0 then 'dirty' else 'open' end
   where id = s.table_id;

  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (s.branch_id, auth.uid(), 'staff', 'table_session_closed', 'table_session', s.id,
          jsonb_build_object('reason', p_reason, 'unpaid_total', v_out, 'note', p_note));
end $function$;

-- ---------------------------------------------------------------------------------------------
-- A diner's orders, over every customers row they hold.
-- ---------------------------------------------------------------------------------------------

-- One row per (restaurant, user) today and one per (branch, user) with the customers work, so a
-- diner has several rows; "limit 1" saw the orders of one of them. Kept for any caller that
-- wants one id, now at least the same one every time (the oldest).
CREATE OR REPLACE FUNCTION private.customer_id_for_user()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id FROM public.customers WHERE user_id = auth.uid() ORDER BY created_at, id LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION private.order_ids_for_customer()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o.id FROM public.orders o
   WHERE o.customer_id IN (SELECT c.id FROM public.customers c WHERE c.user_id = auth.uid());
$function$;

-- ---------------------------------------------------------------------------------------------
-- RLS policies that compared staff_members.branch_id with the row's branch.
-- Same audiences as before — "any staff of the branch" becomes user_branch_ids(), "owner, admin,
-- manager" becomes user_manages_branch() or the matching capability — minus rows that are not
-- active, plus the owner and restaurant-wide staff wherever their row was created. TO
-- authenticated: the helpers are not granted to anon, and anon never matched these anyway.
-- ---------------------------------------------------------------------------------------------

drop policy if exists order_tip_splits_staff_read on public.order_tip_splits;
create policy order_tip_splits_staff_read on public.order_tip_splits
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

drop policy if exists promo_redemptions_branch_staff_read on public.promo_redemptions;
create policy promo_redemptions_branch_staff_read on public.promo_redemptions
  for select to authenticated
  using (exists (
    select 1 from public.promos p
     where p.id = promo_redemptions.promo_id
       and p.branch_id in (select private.user_branch_ids())
  ));

-- Your own shifts, plus whoever keeps this branch's time log.
drop policy if exists shifts_self_read on public.staff_shifts;
create policy shifts_self_read on public.staff_shifts
  for select to authenticated
  using (
    exists (select 1 from public.staff_members sm
             where sm.id = staff_shifts.staff_member_id and sm.user_id = auth.uid())
    or private.staff_has_capability(staff_shifts.branch_id, 'staff.timelog')
  );

-- Writing shifts is the time-log keeper's job (staff.timelog at the shift's branch), before and
-- after the edit. A staff member's own shift is opened and closed only by clock_in / clock_out
-- (SECURITY DEFINER). The old self arms let anyone rewrite their own shift: move it to another
-- branch or another restaurant's branch (it then showed in that branch's time log and tip pool)
-- or backdate its hours, and insert an already closed, backdated shift of their own. No app
-- writes staff_shifts directly. A written shift must stay with a staff row that covers its branch
-- (the rule clock_in applies), so the owner cannot file a Hamburger cashier's hours under Food
-- Thai Thai, nor anyone file them under another restaurant. A keeper adds only closed shifts (a
-- forgotten clock-in); open shifts come from clock_in, which keeps one open shift per person.
drop policy if exists shifts_owner_update on public.staff_shifts;
create policy shifts_owner_update on public.staff_shifts
  for update to authenticated
  using (private.staff_has_capability(staff_shifts.branch_id, 'staff.timelog'))
  with check (
    private.staff_has_capability(staff_shifts.branch_id, 'staff.timelog')
    and exists (
      select 1
        from public.staff_members sm
        join public.branches b on b.id = staff_shifts.branch_id and b.restaurant_id = sm.restaurant_id
       where sm.id = staff_shifts.staff_member_id
         and (sm.branch_id = b.id or sm.branch_id is null or sm.role = 'owner'))
  );

drop policy if exists shifts_self_write on public.staff_shifts;
drop policy if exists shifts_timelog_insert on public.staff_shifts;
create policy shifts_timelog_insert on public.staff_shifts
  for insert to authenticated
  with check (
    staff_shifts.clocked_out_at is not null
    and private.staff_has_capability(staff_shifts.branch_id, 'staff.timelog')
    and exists (
      select 1
        from public.staff_members sm
        join public.branches b on b.id = staff_shifts.branch_id and b.restaurant_id = sm.restaurant_id
       where sm.id = staff_shifts.staff_member_id
         and (sm.branch_id = b.id or sm.branch_id is null or sm.role = 'owner'))
  );

-- Staff side of support tickets: cashier and up may file one (orders.view is exactly owner,
-- admin, manager, cashier); owner, admin and manager read and resolve them.
drop policy if exists tickets_self_insert on public.support_tickets;
create policy tickets_self_insert on public.support_tickets
  for insert to authenticated
  with check (
    exists (select 1 from public.customers c
             where c.id = support_tickets.customer_id and c.user_id = auth.uid())
    or private.staff_has_capability(support_tickets.branch_id, 'orders.view')
  );

drop policy if exists tickets_self_read on public.support_tickets;
create policy tickets_self_read on public.support_tickets
  for select to authenticated
  using (
    exists (select 1 from public.customers c
             where c.id = support_tickets.customer_id and c.user_id = auth.uid())
    or private.user_manages_branch(support_tickets.branch_id)
  );

drop policy if exists tickets_staff_update on public.support_tickets;
create policy tickets_staff_update on public.support_tickets
  for update to authenticated
  using (private.user_manages_branch(support_tickets.branch_id));

drop policy if exists sync_jobs_read on public.sync_jobs;
create policy sync_jobs_read on public.sync_jobs
  for select to authenticated
  using (exists (
    select 1 from public.integrations i
     where i.id = sync_jobs.integration_id
       and private.user_manages_branch(i.branch_id)
  ));

drop policy if exists gc_redemp_read on public.gift_card_redemptions;
create policy gc_redemp_read on public.gift_card_redemptions
  for select to authenticated
  using (
    redeemed_by = auth.uid()
    or exists (
      select 1 from public.gift_cards gc
       where gc.id = gift_card_redemptions.gift_card_id
         and private.user_manages_branch(gc.branch_id)
    )
  );

drop policy if exists tax_invoice_seq_staff_read on public.tax_invoice_sequence;
create policy tax_invoice_seq_staff_read on public.tax_invoice_sequence
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

-- ---------------------------------------------------------------------------------------------
-- JWT hook.
-- ---------------------------------------------------------------------------------------------

-- No policy, function, app or edge function reads the branch_ids / restaurant_ids claims today
-- (checked 2026-09-18: the only readers of auth.jwt() go through app_metadata.is_platform_admin,
-- and authorization always asks the private.* helpers). supabase_auth_admin holds EXECUTE, so the
-- hook may be enabled on sign-in. The claim is corrected anyway so it cannot mislead a future
-- reader: an owner row covers every branch of its restaurant, and a row's branch must belong to
-- that row's restaurant. The claims it writes are otherwise unchanged. Grants are untouched
-- (create or replace keeps them).
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id      uuid := (event ->> 'user_id')::uuid;
  v_claims       jsonb := event -> 'claims';
  v_branch_ids   uuid[];
  v_restaurant_ids uuid[];
  v_is_driver    boolean;
  v_is_customer  boolean;
BEGIN
  SELECT array_agg(DISTINCT b.id)
  INTO v_branch_ids
  FROM public.branches b
  WHERE b.restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_user_id = v_user_id
  )
  OR EXISTS (
    SELECT 1 FROM public.staff_members sm
     WHERE sm.user_id = v_user_id
       AND sm.status = 'active'
       AND sm.restaurant_id = b.restaurant_id
       AND (sm.branch_id = b.id OR sm.branch_id IS NULL OR sm.role = 'owner')
  );

  SELECT array_agg(DISTINCT r.id)
  INTO v_restaurant_ids
  FROM public.restaurants r
  WHERE r.owner_user_id = v_user_id
  OR r.id IN (SELECT restaurant_id FROM public.staff_members WHERE user_id = v_user_id AND status = 'active');

  SELECT EXISTS(SELECT 1 FROM public.drivers WHERE user_id = v_user_id) INTO v_is_driver;
  SELECT EXISTS(SELECT 1 FROM public.customers WHERE user_id = v_user_id) INTO v_is_customer;

  v_claims := jsonb_set(v_claims, '{branch_ids}', to_jsonb(COALESCE(v_branch_ids, ARRAY[]::uuid[])), true);
  v_claims := jsonb_set(v_claims, '{restaurant_ids}', to_jsonb(COALESCE(v_restaurant_ids, ARRAY[]::uuid[])), true);
  v_claims := jsonb_set(v_claims, '{is_driver}', to_jsonb(v_is_driver), true);
  v_claims := jsonb_set(v_claims, '{is_customer}', to_jsonb(v_is_customer), true);

  RETURN jsonb_build_object('claims', v_claims);
END;
$function$;

commit;
