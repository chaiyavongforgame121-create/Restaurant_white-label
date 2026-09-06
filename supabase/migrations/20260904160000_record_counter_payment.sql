-- Money taken at the till was never recorded as received.
--
-- place-order inserts the payments row with status 'pending', and nothing in the counter's
-- cash or card path ever moved it: the till only wrote orders.status. Live proof on this
-- project — every payments row with method 'cash' or 'card' sits at 'pending' with a null
-- paid_at, including rows whose order is already 'completed'. Any reconciliation or
-- end-of-day cash-up therefore reads zero settled revenue for the entire cash business;
-- only QR transfers, which have decide_payment_proof, ever reach 'completed'.
--
-- A browser cannot be trusted to declare that money arrived, so this is an RPC rather than
-- a widened UPDATE policy on payments: it re-reads the order's own total, refuses a
-- transfer (that has its own proof flow), stamps the staff member who took the money, and
-- writes an audit row. It is gated on counter.access — the till's own right, which is what
-- the `cashier` role actually holds — or payments.decide for the back office.

create or replace function public.record_counter_payment(
  p_order_id uuid,
  p_tendered numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
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
  -- staff row. coalesce keeps whatever was already there rather than blanking it.
  select sm.id into v_staff
    from public.staff_members sm
    join public.branches b on b.restaurant_id = sm.restaurant_id
   where b.id = v_branch
     and sm.user_id = auth.uid()
     and sm.status = 'active'
   limit 1;

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
end $$;

revoke execute on function public.record_counter_payment(uuid, numeric) from public, anon;
grant  execute on function public.record_counter_payment(uuid, numeric) to authenticated;

-- Rows stranded by the old behaviour: cash on an order the kitchen already completed. The
-- food went out and a walk-in pays at the counter, so that money is in the drawer even
-- though nothing ever said so. Card is deliberately left alone — no Stripe key is
-- configured on this project, so a 'pending' card row is not evidence that a card was
-- charged, and asserting it would overstate revenue. Stamped so a backfilled settlement
-- can be told apart from one a cashier actually made.
update public.payments p
   set status = 'completed',
       paid_at = coalesce(o.completed_at, o.created_at),
       gateway_metadata = coalesce(p.gateway_metadata, '{}'::jsonb)
                          || jsonb_build_object('settled_via', 'backfill_20260904160000')
  from public.orders o
 where o.id = p.order_id
   and p.method = 'cash'
   and p.status = 'pending'
   and o.status = 'completed';

create index if not exists payments_counter_pending_idx
  on public.payments (branch_id, status) where method in ('cash', 'card');
