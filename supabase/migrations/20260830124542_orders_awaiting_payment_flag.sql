-- Keeping unpaid QR orders off the kitchen board needs a fact the KITCHEN can read.
--
-- My previous attempt embedded payments(method, status) in the kitchen query and filtered on
-- it. That cannot work, twice over:
--
--   * payments_staff_read requires the 'payments.view' capability, which a kitchen role does
--     not have. The embed comes back empty, the filter reads that as "no transfer payment",
--     and the ticket is shown. A fail-open disguised as a check.
--   * the filter lived in the server page, while kitchen-view.tsx re-fetches the board on
--     every realtime event with its own select that has no payments embed — so even where
--     the read was permitted, the first refresh put the ticket straight back.
--
-- orders.awaiting_payment is on the orders row itself, which anyone who can see the board can
-- already read, and it survives the client refetch because it travels with the order.
alter table public.orders
  add column if not exists awaiting_payment boolean not null default false;

comment on column public.orders.awaiting_payment is
  'True while a QR-transfer payment on this order has not been approved. The kitchen board '
  'and any other "is this real work yet" check reads THIS, not payments, because payments '
  'is capability-gated and invisible to kitchen staff.';

create or replace function private.sync_order_awaiting_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  if v_order is null then return null; end if;
  update public.orders o
     set awaiting_payment = exists (
           select 1 from public.payments p
            where p.order_id = v_order
              and p.method = 'transfer'
              and p.status <> 'completed'
         )
   where o.id = v_order;
  return null;
end;
$function$;

drop trigger if exists payments_sync_awaiting on public.payments;
create trigger payments_sync_awaiting
after insert or update or delete on public.payments
for each row execute function private.sync_order_awaiting_payment();

revoke execute on function private.sync_order_awaiting_payment() from public, anon;

-- Approving is what makes the order real work. The trigger above already flips the flag when
-- payments.status becomes 'completed', but be explicit rather than relying on ordering.
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
                            || jsonb_build_object('pending', false)
   where id = p_payment_id;

  if p_approve then
    update public.orders
       set status = case when status = 'pending' then 'confirmed'::order_status else status end,
           awaiting_payment = false
     where id = v_order;
  else
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

revoke execute on function public.decide_payment_proof(uuid, boolean, text) from public, anon;
grant execute on function public.decide_payment_proof(uuid, boolean, text) to authenticated;

-- Backfill every order that already has an unapproved transfer.
update public.orders o
   set awaiting_payment = true
 where o.status in ('pending','confirmed')
   and exists (
     select 1 from public.payments p
      where p.order_id = o.id and p.method = 'transfer' and p.status <> 'completed'
   );
