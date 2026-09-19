-- Close the one direct write to an order's amounts that 20260918200000 kept for the old till.
--
-- The counter released before 7ef04d2 put a cashier's discount on a fresh sale with a plain
-- UPDATE of orders.discount_amount and orders.total. The counter deployed since sends
-- discount_percent to place-order, which prices the discount before tax and the card fee, and
-- writes only orders.status afterwards. With every till on the new build, amounts are set only by
-- place-order and SECURITY DEFINER functions; a signed-in client may change the status alone.
--
-- Deliberately NOT done here: revoking anon's SELECT on menu_items.stock_quantity. The storefront
-- no longer reads it (it reads out_of_stock), but v_active_combos is a security_invoker view whose
-- is_available compares stock_quantity with the combo's quantity, so the revoke breaks the combos
-- row for signed-out visitors (checked: 42501 on v_active_combos as anon).

revoke update (discount_amount, total) on public.orders from authenticated;

drop trigger if exists orders_money_guard on public.orders;
drop function if exists private.tg_orders_money_guard();
