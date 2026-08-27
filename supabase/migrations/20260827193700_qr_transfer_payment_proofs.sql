-- QR-transfer payments: the diner scans the restaurant's own QR, transfers, and uploads
-- a photo of the slip; the merchant approves or rejects it.
--
-- payments.method already permits 'transfer' (payments_method_check), and
-- proof_image_url / confirmed_by / confirmed_at already exist and were unused --
-- fossils of the dropped PromptPay flow. So this migration adds no columns to payments.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 10485760,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.owns_order_folder(p_name text)
returns boolean language sql stable security definer set search_path to 'public','pg_temp' as $$
  select exists (
    select 1 from public.orders o
      join public.customers c on c.id = o.customer_id
     where o.id::text = (storage.foldername(p_name))[1] and c.user_id = auth.uid()
  );
$$;

create or replace function private.staffs_order_folder(p_name text)
returns boolean language sql stable security definer set search_path to 'public','pg_temp' as $$
  select exists (
    select 1 from public.orders o
     where o.id::text = (storage.foldername(p_name))[1]
       and o.branch_id in (select private.user_branch_ids())
  );
$$;

drop policy if exists payment_proofs_customer_insert on storage.objects;
create policy payment_proofs_customer_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'payment-proofs' and private.owns_order_folder(name));

drop policy if exists payment_proofs_customer_read on storage.objects;
create policy payment_proofs_customer_read on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs'
         and (private.owns_order_folder(name) or private.staffs_order_folder(name)));

create or replace function public.submit_payment_proof(p_order_id uuid, p_path text)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_payment_id uuid;
begin
  select p.id into v_payment_id
    from public.payments p
    join public.orders o on o.id = p.order_id
    left join public.customers c on c.id = o.customer_id
   where p.order_id = p_order_id and p.method = 'transfer' and c.user_id = auth.uid()
   order by p.created_at desc limit 1;
  if v_payment_id is null then raise exception 'payment_not_found' using errcode = 'P0001'; end if;
  update public.payments
     set proof_image_url = p_path,
         status = 'pending',
         gateway_metadata = coalesce(gateway_metadata,'{}'::jsonb)
                            || jsonb_build_object('proof_submitted_at', now())
   where id = v_payment_id;
  return v_payment_id;
end $$;

revoke execute on function public.submit_payment_proof(uuid, text) from anon;
grant execute on function public.submit_payment_proof(uuid, text) to authenticated;

create or replace function public.decide_payment_proof(
  p_payment_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_branch uuid; v_order uuid; v_staff uuid;
begin
  select p.branch_id, p.order_id into v_branch, v_order
    from public.payments p where p.id = p_payment_id;
  if v_branch is null then raise exception 'payment_not_found' using errcode = 'P0001'; end if;
  if not private.user_manages_branch(v_branch) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  -- payments.confirmed_by references staff_members(id), NOT auth.users(id).
  select sm.id into v_staff
    from public.staff_members sm
    join public.branches b on b.restaurant_id = sm.restaurant_id
   where b.id = v_branch and sm.user_id = auth.uid() and sm.status = 'active'
   limit 1;

  update public.payments
     set status = case when p_approve then 'completed'::payment_status else 'failed'::payment_status end,
         confirmed_by = v_staff,
         confirmed_at = now(),
         paid_at = case when p_approve then now() else paid_at end,
         gateway_metadata = coalesce(gateway_metadata,'{}'::jsonb)
                            || jsonb_build_object('decision_note', p_note, 'decided_at', now())
   where id = p_payment_id;

  if p_approve then
    update public.orders set status = 'confirmed' where id = v_order and status = 'pending';
  end if;

  insert into public.audit_logs(branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_branch, auth.uid(), 'staff',
          case when p_approve then 'payment_proof_approved' else 'payment_proof_rejected' end,
          'payment', p_payment_id, jsonb_build_object('note', p_note));
end $$;

revoke execute on function public.decide_payment_proof(uuid, boolean, text) from anon;
grant execute on function public.decide_payment_proof(uuid, boolean, text) to authenticated;

-- The kitchen writes orders.status directly, so "do not cook before the slip is
-- approved" has to be enforced here rather than in a screen.
create or replace function public.tg_block_unpaid_transfer_progress()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  if new.status = old.status then return new; end if;
  if new.status not in ('confirmed','preparing','ready','out_for_delivery','completed') then
    return new;
  end if;
  if exists (select 1 from public.payments p
              where p.order_id = new.id and p.method = 'transfer')
     and not exists (select 1 from public.payments p
                      where p.order_id = new.id and p.method = 'transfer'
                        and p.status = 'completed')
  then
    raise exception 'transfer_payment_not_approved' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists orders_block_unpaid_transfer on public.orders;
create trigger orders_block_unpaid_transfer
  before update of status on public.orders
  for each row execute function public.tg_block_unpaid_transfer_progress();

create index if not exists payments_transfer_pending_idx
  on public.payments (branch_id, status) where method = 'transfer';
