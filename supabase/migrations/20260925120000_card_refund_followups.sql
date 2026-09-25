-- Card refunds, follow-ups to Stripe Connect (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md, rule 6:
-- "cancelling a paid card order refunds it"). Runs after 20260925100000_stripe_connect_payments.sql
-- (payment_refunds, the online card payment rules) and 20260925110000_payments_report_refunds.sql.
--
-- 1. A PAID ONLINE CARD ORDER IS NEVER CLOSED WITHOUT ITS REFUND. Before this, the kitchen's Reject,
--    a cancel from Live deliveries, a diner's own cancel and refund_order could all mark an order
--    cancelled or refunded while the diner's money stayed in the branch's Stripe account. Now any
--    signed-in move into 'cancelled' or 'refunded' is refused with 'card_refund_required' while
--    part of a paid online card payment has no refund against it (pending or succeeded) in
--    payment_refunds. The back office answers that code by calling stripe-refund with cancel:true,
--    which refunds the rest on the branch's connected account, records it, and then cancels. The
--    check lives in a trigger, not only in cancel_order, because a kitchen tablet or a manager
--    holding orders.update can also write orders.status directly.
--
--    The service role (no JWT: the edge functions, pg_cron, the SQL console) is not held. The
--    30-minute expiry only cancels orders nobody has paid, place-order cancels an order whose
--    payment row could not be written, and stripe-refund cancels as the signed-in operator (with
--    their JWT), so it passes through this check like everyone else, after its refund.
--
--    A payment under a formal dispute (Stripe status needs_response, under_review or lost) is not
--    held either: Stripe has already taken the disputed amount out of the branch's balance and will
--    not refund a disputed charge, so insisting on a refund would leave the order impossible to
--    close. An inquiry (warning_*) or a won dispute leaves the money with the restaurant and is
--    held like any other paid payment.
--
-- 2. THE DINER CANNOT CANCEL A PAID CARD ORDER. cancel_order let a diner cancel while the order was
--    pending or confirmed, which covered an order whose card payment had just gone through (the
--    order page still showed "cancel" until realtime caught up). The refund is the restaurant's to
--    make, so a diner now gets 'card_paid_ask_restaurant' and the storefront tells them to contact
--    the restaurant. A payment Stripe is still processing is not "paid" yet: a diner who cancels
--    then is refunded automatically when it lands (stripe_connect_apply_payment_intent answers
--    refund_required for a closed order and the Connect webhook refunds it).
--
-- 3. REFUND_ORDER ADDS UP. It compared each call with the order total, so three partial refunds
--    that together returned the whole order never marked it refunded, and nothing stopped them
--    from adding up to more than the total. It now keeps a running sum:
--      * for an order paid online by card, the refunds Stripe made or is making (payment_refunds,
--        pending or succeeded), which already include the one the back office just made through
--        stripe-refund, and also those made in the branch's own Stripe Dashboard. The order is
--        marked refunded once they cover the card payment, and a call whose amount Stripe has not
--        refunded is refused ('card_refund_required'): the counter's Refund button, for one, only
--        ever wrote a status and would otherwise tell the diner their money went back when it did
--        not.
--      * for every other order (cash, QR transfer, a card swiped on the restaurant's own terminal),
--        refund_order's own earlier calls, read from its audit rows (the same rows the payments
--        report counts). A call that would take the sum past the total is refused with
--        'refund_exceeds_remaining:<what is left>'.
--    Both functions also lock the order row first, so two refunds pressed at once add up instead
--    of each passing the check alone, and a cancel cannot slip between a payment completing and
--    its check.

-- ---------------------------------------------------------------------------------------------
-- 1. What is still owed back on an order's online card payment
-- ---------------------------------------------------------------------------------------------

create or replace function private.order_card_refund_due(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  -- Per paid online card payment: its amount less what has gone back or is on its way, never
  -- below zero. "Gone back" is the larger of the payment_refunds rows (pending or succeeded) and
  -- the charge's own amount_refunded as the Connect webhook last recorded it, so a refund made in
  -- the Dashboard counts even before its refund rows were listed. A 'refunded' payment is back in
  -- full by definition and is not read at all.
  select coalesce(sum(greatest(
           p.amount - greatest(
             coalesce((select sum(r.amount)
                         from public.payment_refunds r
                        where r.payment_id = p.id
                          and r.status in ('pending', 'succeeded')), 0),
             case when p.gateway_metadata ->> 'amount_refunded' ~ '^[0-9]+(\.[0-9]+)?$'
                  then (p.gateway_metadata ->> 'amount_refunded')::numeric
                  else 0 end),
           0)), 0)
    from public.payments p
    join public.orders o on o.id = p.order_id
   where p.order_id = p_order_id
     and p.method = 'card'
     and p.gateway = 'stripe'
     and coalesce(o.source, 'web') = 'web'
     and p.status = 'completed'
     and coalesce(p.gateway_metadata ->> 'dispute_status', '') not in ('needs_response', 'under_review', 'lost');
$function$;

comment on function private.order_card_refund_due(uuid) is
  'Dollars of the order''s paid online card payment (method card, gateway stripe, source web) that have no pending or succeeded Stripe refund against them. Zero for any other order, and for a payment under a formal dispute (Stripe already took that money back). A signed-in caller may not cancel or refund the order while this is above zero.';

revoke all on function private.order_card_refund_due(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The guard: no signed-in close of an order whose card money has not gone back
-- ---------------------------------------------------------------------------------------------

create or replace function private.tg_orders_card_refund_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status not in ('cancelled', 'refunded') then
    return new;
  end if;
  -- The service role is trusted by construction (see the header): it never cancels a paid order.
  if auth.uid() is null then
    return new;
  end if;
  if private.order_card_refund_due(new.id) > 0 then
    raise exception 'card_refund_required'
      using errcode = 'P0001',
            hint = 'The diner paid this order online by card. Its card payment has to be refunded through Stripe before the order can be cancelled or marked refunded; the back office does both in one step.';
  end if;
  return new;
end $function$;

revoke all on function private.tg_orders_card_refund_guard() from public, anon, authenticated;

-- "orders_b_" so it runs right after orders_a_final_status_guard (which refuses reopening a closed
-- order) and before the other BEFORE UPDATE triggers write status history for a move that is
-- about to be refused.
drop trigger if exists orders_b_card_refund_guard on public.orders;
create trigger orders_b_card_refund_guard
  before update of status on public.orders
  for each row execute function private.tg_orders_card_refund_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. cancel_order
-- ---------------------------------------------------------------------------------------------

-- Re-created from the live definition (20260908111000) with the same arguments, answer and grants.
-- Changes: the order row is locked first; a diner may not cancel once their card payment went
-- through; staff get 'card_refund_required' up front (the trigger above would refuse anyway, but
-- only after the status history had been written).
create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_is_staff boolean;
  v_is_customer boolean;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  -- Locked: stripe_connect_apply_payment_intent completes a payment under the same order lock, so
  -- the payment checks below see a payment that went through a moment ago rather than missing it.
  select * into v_order from public.orders where id = p_order_id for update;
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
  -- Once the diner's card payment has gone through, only the restaurant can give it back, so only
  -- the restaurant may cancel. A refunded payment counts: whatever happened, the restaurant did it.
  if not v_is_staff
     and coalesce(v_order.source, 'web') = 'web'
     and exists (select 1 from public.payments p
                  where p.order_id = v_order.id
                    and p.method = 'card'
                    and p.gateway = 'stripe'
                    and p.status in ('completed', 'refunded'))
  then
    raise exception 'card_paid_ask_restaurant'
      using errcode = 'P0001',
            hint = 'The card payment for this order has gone through. Ask the restaurant to cancel it; they refund the card when they do.';
  end if;
  if private.order_card_refund_due(v_order.id) > 0 then
    raise exception 'card_refund_required'
      using errcode = 'P0001',
            hint = 'Refund the card payment through Stripe first (stripe-refund with cancel: true refunds and cancels in one step).';
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

-- ---------------------------------------------------------------------------------------------
-- 4. refund_order
-- ---------------------------------------------------------------------------------------------

-- Re-created from the live definition (20260908111000) with the same arguments and grants. The
-- answer gains 'refunded_in_full'. See the header, section 3.
create or replace function public.refund_order(p_order_id uuid, p_amount numeric, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_total numeric;
  v_card_paid numeric := 0;
  v_card_back numeric := 0;
  v_prior numeric := 0;
  v_closes boolean;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  -- Locked, so two refunds pressed at once are added up rather than each checked alone.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if not private.staff_has_capability(v_order.branch_id, 'orders.refund') then
    raise exception 'not_authorized';
  end if;
  v_total := coalesce(v_order.total, 0);
  -- A null amount compared as null and slipped past the old `<= 0 or > total` test.
  if p_amount is null or p_amount <= 0 or p_amount > v_total then
    raise exception 'invalid_refund_amount';
  end if;

  -- The diner's online card money: what was taken, and what Stripe has refunded or is refunding.
  if coalesce(v_order.source, 'web') = 'web' then
    select coalesce(sum(p.amount), 0),
           coalesce(sum(case
             when p.status = 'refunded' then p.amount
             else least(p.amount, coalesce((select sum(r.amount)
                                              from public.payment_refunds r
                                             where r.payment_id = p.id
                                               and r.status in ('pending', 'succeeded')), 0))
           end), 0)
      into v_card_paid, v_card_back
      from public.payments p
     where p.order_id = p_order_id
       and p.method = 'card'
       and p.gateway = 'stripe'
       and p.status in ('completed', 'refunded');
  end if;

  if v_card_paid > 0 then
    -- The money goes back through stripe-refund, which records it in payment_refunds before the
    -- back office calls this. This call only writes the order's own record of it, so it must not
    -- record more than Stripe has actually been asked to send back.
    if v_card_back < p_amount then
      raise exception 'card_refund_required'
        using errcode = 'P0001',
              hint = 'This order was paid online by card. Refund it from the order in the back office, which sends the money back through Stripe before recording it here.';
    end if;
    v_closes := v_card_back >= v_card_paid;
  else
    -- Earlier calls of this function on the order, from its own audit rows. A value that is not a
    -- plain amount is skipped rather than allowed to fail every later refund of the order.
    select coalesce(sum(case when a.metadata ->> 'amount' ~ '^[0-9]+(\.[0-9]+)?$'
                             then (a.metadata ->> 'amount')::numeric
                             else 0 end), 0)
      into v_prior
      from public.audit_logs a
     where a.entity_type = 'order'
       and a.entity_id = p_order_id
       and a.action = 'refund';
    if v_prior + p_amount > v_total then
      raise exception 'refund_exceeds_remaining:%', round(greatest(v_total - v_prior, 0), 2)
        using errcode = 'P0001',
              hint = 'Earlier refunds of this order already count toward its total.';
    end if;
    v_closes := v_prior + p_amount >= v_total;
  end if;

  update public.orders
     set status = case when v_closes then 'refunded' else status end,
         cancellation_reason = case when v_closes
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
  return jsonb_build_object('ok', true, 'amount', p_amount, 'refunded_in_full', v_closes);
end $function$;
