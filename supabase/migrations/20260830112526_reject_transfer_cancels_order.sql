-- Rejecting a QR transfer did nothing to the order.
--
-- decide_payment_proof set payments.status = 'failed' and stopped there. The order stayed
-- 'pending', which means it stayed on the kitchen board (that query is
-- `status in ('pending','confirmed','preparing','ready')`) and stayed in the merchant's
-- "waiting for you" list, because gateway_metadata.pending was never cleared either. Live
-- example: A-2608-303185, rejected with the note "ฟฟฟ" at 11:15, still pending and still on
-- both screens afterwards. The customer was told nothing at all.
--
-- Rejecting now cancels the order, records why, and clears the pending flag. Approving
-- clears the flag too — it was only ever removed by nothing.
alter table public.orders add column if not exists cancellation_reason text;

comment on column public.orders.cancellation_reason is
  'Why the order was cancelled, shown to the customer. Set by decide_payment_proof on a '
  'rejected transfer slip; free for other cancellation paths to use.';

create or replace function public.decide_payment_proof(p_payment_id uuid, p_approve boolean, p_note text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  -- payments.confirmed_by references staff_members(id), NOT auth.users(id). A platform
  -- admin has no staff row and correctly records NULL rather than tripping the FK.
  select sm.id into v_staff
    from public.staff_members sm
    join public.branches b on b.restaurant_id = sm.restaurant_id
   where b.id = v_branch
     and sm.user_id = auth.uid()
     and sm.status = 'active'
   limit 1;

  update public.payments
     set status = case when p_approve then 'completed'::payment_status else 'failed'::payment_status end,
         confirmed_by = v_staff,
         confirmed_at = now(),
         paid_at = case when p_approve then now() else paid_at end,
         gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                            || jsonb_build_object('decision_note', p_note, 'decided_at', now())
                            -- The flag the merchant's "waiting for you" list reads. A decided
                            -- slip is not waiting for anyone.
                            || jsonb_build_object('pending', false)
   where id = p_payment_id;

  if p_approve then
    -- Approving is what releases the ticket to the kitchen.
    update public.orders set status = 'confirmed'
     where id = v_order and status = 'pending';
  else
    -- Rejecting ends the order. Leaving it 'pending' kept a dead ticket in front of the
    -- kitchen and told the customer nothing; there is no other path back from a refused
    -- payment, so say so once and stop.
    update public.orders
       set status = 'cancelled',
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

revoke execute on function public.decide_payment_proof(uuid, boolean, text) from public, anon;
grant execute on function public.decide_payment_proof(uuid, boolean, text) to authenticated;

-- Repair the rows already stranded by the old behaviour: a refused slip whose order is
-- still sitting in the kitchen queue.
update public.orders o
   set status = 'cancelled',
       cancellation_reason = coalesce(
         nullif(btrim(p.gateway_metadata->>'decision_note'), ''),
         'Payment slip was not accepted.')
  from public.payments p
 where p.order_id = o.id
   and p.method = 'transfer'
   and p.status = 'failed'
   and o.status in ('pending', 'confirmed');

-- ...and clear the stale pending flag on every already-decided slip.
update public.payments
   set gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb) || jsonb_build_object('pending', false)
 where method = 'transfer'
   and status in ('completed', 'failed')
   and coalesce((gateway_metadata->>'pending')::boolean, false) = true;
