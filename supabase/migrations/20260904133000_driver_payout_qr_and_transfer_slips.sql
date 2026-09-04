-- Paying a rider is still a hand-typed bank transfer, and nothing records that it happened.
--
-- A withdrawal carries only free-text bank_name / account_number / account_name, retyped into
-- the request sheet every time (the earnings screen prefills them from the rider's PREVIOUS
-- request row -- the only place bank details are stored at all). The merchant reads that
-- account number off a screen and keys it into their banking app, and once the money is sent
-- there is nowhere to file the slip: pay_driver_withdrawal mints a receipt number and nothing
-- else, so the rider's own receipt carries no proof that the transfer was made.
--
-- Two halves, both mirroring the diner-side QR-transfer flow from
-- 20260827193700_qr_transfer_payment_proofs.sql: the rider's receiving QR (scan instead of
-- type) and the merchant's transfer slip (proof instead of trust).

-- 1. The rider's receiving QR -------------------------------------------------------------
-- It lives in the EXISTING private driver-kyc bucket under <driver_id>/, so
-- driver_kyc_self_upload / _self_update / _self_read already scope the rider's write and
-- driver_kyc_admin_read already lets branch staff sign it. No new bucket, no new policy.
-- That inherits driver_kyc_admin_read's bucket-wide reach (any active owner/admin/manager,
-- not just this rider's branches) -- acceptable for a QR whose whole purpose is to be shown
-- to whoever is paying, and strictly less exposed than the licence photos already in there.

alter table public.drivers
  add column if not exists payout_qr_path text;

comment on column public.drivers.payout_qr_path is
  'Object path in the private driver-kyc bucket (<driver_id>/payout_qr.<ext>) holding the rider''s receiving QR. Written only through set_driver_payout_qr; read by the rider and by branch staff through a short-lived signed URL.';

-- drivers_self is FOR ALL with no column guard, so a plain table update would let a rider
-- point this at ANOTHER rider's folder -- which driver_kyc_admin_read would then happily sign
-- for the merchant. Pin the folder to the caller, the way submit_payment_proof keeps
-- payments.status out of the diner's reach.
create or replace function public.set_driver_payout_qr(p_path text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_driver uuid := private.driver_id_for_user();
begin
  if v_driver is null then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if p_path is not null and split_part(p_path, '/', 1) <> v_driver::text then
    raise exception 'path_not_owned' using errcode = 'P0001';
  end if;

  update public.drivers set payout_qr_path = p_path where id = v_driver;
  return v_driver;
end;
$function$;

revoke execute on function public.set_driver_payout_qr(text) from public, anon;
grant execute on function public.set_driver_payout_qr(text) to authenticated;

-- 2. The merchant's transfer slip ----------------------------------------------------------

alter table public.driver_withdrawals
  add column if not exists transfer_slip_path text,
  add column if not exists transfer_slip_at timestamptz;

comment on column public.driver_withdrawals.transfer_slip_path is
  'Object path in the private payout-slips bucket (<withdrawal_id>/<uuid>.<ext>) holding the merchant''s bank transfer slip. Written only through attach_driver_payout_slip.';

-- payment-proofs cannot hold these: its folder helpers key on an order id, and a payout has
-- no order behind it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payout-slips', 'payout-slips', false, 10485760,
        array['image/png','image/jpeg','image/webp','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.staffs_withdrawal_folder(p_name text)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1 from public.driver_withdrawals w
     where w.id::text = (storage.foldername(p_name))[1]
       and w.branch_id in (select private.user_branch_ids())
  );
$$;

create or replace function private.owns_withdrawal_folder(p_name text)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1 from public.driver_withdrawals w
     where w.id::text = (storage.foldername(p_name))[1]
       and w.driver_id = private.driver_id_for_user()
  );
$$;

revoke execute on function private.staffs_withdrawal_folder(text) from public, anon;
grant execute on function private.staffs_withdrawal_folder(text) to authenticated;
revoke execute on function private.owns_withdrawal_folder(text) from public, anon;
grant execute on function private.owns_withdrawal_folder(text) to authenticated;

drop policy if exists payout_slips_staff_insert on storage.objects;
create policy payout_slips_staff_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'payout-slips' and private.staffs_withdrawal_folder(name));

drop policy if exists payout_slips_staff_update on storage.objects;
create policy payout_slips_staff_update on storage.objects
  for update to authenticated
  using (bucket_id = 'payout-slips' and private.staffs_withdrawal_folder(name));

-- The proof is for the rider as much as for the merchant, so the rider reads it too.
drop policy if exists payout_slips_read on storage.objects;
create policy payout_slips_read on storage.objects
  for select to authenticated
  using (bucket_id = 'payout-slips'
         and (private.staffs_withdrawal_folder(name) or private.owns_withdrawal_folder(name)));

-- driver_withdrawals has no insert or update policy at all -- every write is a definer RPC.
-- The gate below is the one from pay_driver_withdrawal, verbatim, so "may pay" and "may file
-- the slip" cannot drift apart. This is a separate function rather than a new argument on
-- pay_driver_withdrawal because a defaulted argument creates a second overload and PostgREST
-- can no longer resolve the existing two-argument call.
create or replace function public.attach_driver_payout_slip(p_withdrawal_id uuid, p_path text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  w public.driver_withdrawals;
begin
  select * into w from public.driver_withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if not private.user_is_platform_admin()
     and not exists (
       select 1 from public.staff_members s
        where s.user_id = v_uid
          and s.status = 'active'
          and s.role in ('owner','admin','manager')
          and s.restaurant_id = (select restaurant_id from public.branches where id = w.branch_id)
          and (s.branch_id = w.branch_id or s.branch_id is null)
     )
  then
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

revoke execute on function public.attach_driver_payout_slip(uuid, text) from public, anon;
grant execute on function public.attach_driver_payout_slip(uuid, text) to authenticated;
