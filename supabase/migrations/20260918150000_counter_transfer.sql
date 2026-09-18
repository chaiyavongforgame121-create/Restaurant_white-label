-- QR transfer at the counter: record_counter_transfer(p_order_id).
--
-- The owner asked for the till to show the branch's own payment QR (the one set up under Branch
-- settings -> Payment methods, stored in branches.settings.qr_transfer) and take a transfer there
-- and then. The database had no way to settle one:
--
--   - record_counter_payment deliberately skips transfer payments. A transfer placed from the
--     storefront is settled by decide_payment_proof against a photograph of the diner's slip, and
--     letting the till complete one would give the merchant a way around looking at the slip.
--   - orders_block_unpaid_transfer refuses any status move of an order whose transfer is unpaid,
--     so the till's old fallback (a raw `status = 'confirmed'` update) cannot work either, and a
--     counter transfer would sit in "awaiting payment" forever, hidden from the kitchen.
--
-- At the counter the cashier IS the person looking at the proof: the customer shows the banking
-- app's confirmation across the counter and the cashier taps "Payment received". This function is
-- that tap, and nothing wider:
--
--   - only an order the till rang up (source counter/pos). A diner's storefront transfer still
--     goes through slip review, so this cannot become a shortcut around decide_payment_proof;
--   - only someone with counter.access at the ORDER's branch (private.staff_has_capability, which
--     covers owner rows, restaurant-wide rows, owner_user_id and platform admins). A cashier of
--     one branch cannot settle another branch's transfer;
--   - the amount is the order's own total, never a number from the browser;
--   - idempotent: a second tap, or a retry after a dropped response, returns the same payment
--     without a second settlement or a second audit row;
--   - confirmed_by is the caller's staff row for THIS branch (private.staff_row_for_branch), so a
--     settlement at one branch is not attributed to the caller's row at another.
--
-- Completing the payment fires payments_sync_awaiting, which clears orders.awaiting_payment, and
-- the order then moves pending -> confirmed exactly as decide_payment_proof moves an approved one,
-- which is what puts the ticket on the kitchen board.

create or replace function public.record_counter_transfer(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch  uuid;
  v_total   numeric;
  v_status  text;
  v_source  text;
  v_payment public.payments%rowtype;
  v_staff   uuid;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  -- Locked so two taps cannot both see a pending payment and both write an audit row.
  select o.branch_id, o.total, o.status::text, o.source
    into v_branch, v_total, v_status, v_source
    from public.orders o
   where o.id = p_order_id
   for update;
  if v_branch is null then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if not private.staff_has_capability(v_branch, 'counter.access') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  -- A storefront transfer is settled against the diner's slip, not at the till.
  if coalesce(v_source, 'web') not in ('counter', 'pos') then
    raise exception 'not_a_counter_order' using errcode = 'P0001';
  end if;

  -- A completed transfer first, so a repeat call finds the one it already settled; then the
  -- pending one this call is here to settle.
  select p.* into v_payment
    from public.payments p
   where p.order_id = p_order_id
     and p.method = 'transfer'
   order by (p.status = 'completed') desc, (p.status = 'pending') desc, p.created_at desc
   limit 1;
  if v_payment.id is null then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;

  if v_payment.status = 'completed' then
    return v_payment.id;
  end if;
  if v_payment.status <> 'pending' then
    raise exception 'payment_not_settleable' using errcode = 'P0001';
  end if;
  -- The kitchen rejected it, or somebody cancelled it, between Charge and "Payment received".
  -- Taking the money now would settle an order nobody is going to cook.
  if v_status in ('cancelled', 'refunded') then
    raise exception 'order_not_settleable' using errcode = 'P0001';
  end if;

  v_staff := private.staff_row_for_branch(v_branch);

  update public.payments
     set status = 'completed',
         amount = coalesce(v_total, amount),
         paid_at = now(),
         confirmed_at = now(),
         confirmed_by = coalesce(v_staff, confirmed_by),
         gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'pending', false,
                                 'settled_at', now(),
                                 'settled_via', 'counter',
                                 'verified_by', 'cashier'
                               )
   where id = v_payment.id;

  -- payments_sync_awaiting has just cleared awaiting_payment, and the transfer is now completed,
  -- so orders_block_unpaid_transfer lets this through.
  if v_status = 'pending' then
    update public.orders
       set status = 'confirmed',
           confirmed_at = coalesce(confirmed_at, now())
     where id = p_order_id
       and status = 'pending';
  end if;

  insert into public.audit_logs (branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_branch, auth.uid(), 'staff', 'counter_transfer_confirmed', 'payment', v_payment.id,
          jsonb_build_object('order_id', p_order_id, 'method', 'transfer', 'amount', v_total));

  return v_payment.id;
end
$function$;

comment on function public.record_counter_transfer(uuid) is
  'The till''s "Payment received" for a QR transfer rung up at the counter. counter.access at the '
  'order''s branch; counter/pos orders only; idempotent; amount is orders.total.';

revoke all on function public.record_counter_transfer(uuid) from public;
revoke all on function public.record_counter_transfer(uuid) from anon;
grant execute on function public.record_counter_transfer(uuid) to authenticated;
grant execute on function public.record_counter_transfer(uuid) to service_role;
