-- An owner is the owner of every branch, whichever branch their staff row was created at.
--
-- The owner of Coastal Grill (chaiyavongboy1@gmail.com) holds one staff row: role 'owner',
-- restaurant Coastal Grill, branch_id = Hamburger. Opening the restaurant's second branch, Food
-- Thai Thai, showed "No admin access — your account isn't a member of staff at Food Thai Thai".
--
-- 20260916073000 already taught private.user_manages_branch and private.staff_has_capability that
-- an owner row covers every branch, and private.user_branch_ids / user_owns_restaurant agreed. But
-- public.my_capabilities — the set the admin layout gates the entire back office on — still
-- demanded branch_id is null or = this branch, so the owner was refused at the door of a branch the
-- database would have let them run. The same exact-branch rule, without the owner arm, was still in:
--   - the four driver-payout functions (pay, reject, attach slip, mark paid), so this owner could
--     not pay a driver at their second branch;
--   - toggle_item_availability, which checked branch_id = the item's branch exactly — refusing
--     restaurant-wide staff (branch_id null) and owners-by-restaurant too, and never checking that
--     the staff row was active;
--   - enqueue_sync_job, owner-only but again pinned to one branch and blind to owner_user_id;
--   - private.user_has_role_in_branch (no callers today; fixed so a future one cannot bring it back).
--
-- Left alone on purpose: public.custom_access_token_hook builds a branch_ids JWT claim with the
-- same gap, but no policy or app code reads that claim, and a mistake in a hook that runs on every
-- sign-in would lock everyone out. set_staff_branch_scope already goes through user_owns_restaurant.
--
-- Every function except the last two is its live definition with the one clause changed.

begin;

CREATE OR REPLACE FUNCTION public.my_capabilities(p_branch_id uuid)
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select rc.capability
    from public.branches b
    join public.staff_members sm on sm.restaurant_id = b.restaurant_id
    join public.role_capabilities rc on rc.role = sm.role::text
   where b.id = p_branch_id
     and sm.user_id = auth.uid()
     and sm.status = 'active'
     -- An owner owns the restaurant, so every branch of it, whichever branch their row names.
     and (sm.role = 'owner' or sm.branch_id is null or sm.branch_id = b.id)
  union
  -- The restaurant owner_user_id path and platform admins hold everything.
  select rc.capability from public.role_capabilities rc
   where rc.role = 'owner'
     and (
       private.user_is_platform_admin()
       or exists (select 1 from public.branches b
                    join public.restaurants r on r.id = b.restaurant_id
                   where b.id = p_branch_id and r.owner_user_id = auth.uid())
     );
$function$;

CREATE OR REPLACE FUNCTION private.user_has_role_in_branch(p_branch_id uuid, p_role staff_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.branches b
    JOIN public.restaurants r ON r.id = b.restaurant_id
    WHERE b.id = p_branch_id AND r.owner_user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1
    FROM public.staff_members sm
    JOIN public.branches b ON b.id = p_branch_id
    WHERE sm.user_id = auth.uid()
      AND sm.status = 'active'
      AND sm.role = p_role
      AND (sm.branch_id = p_branch_id
           OR ((sm.branch_id IS NULL OR sm.role = 'owner') AND sm.restaurant_id = b.restaurant_id))
  );
$function$;

CREATE OR REPLACE FUNCTION public.mark_driver_payout_paid(p_branch_id uuid, p_driver_id uuid, p_period_start date, p_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_count int; v_total numeric;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if not private.user_is_platform_admin()
     and not exists (
       select 1 from public.staff_members s
       where s.user_id = v_uid and s.status = 'active' and s.role in ('owner','admin','manager')
         and s.restaurant_id = (select restaurant_id from public.branches where id = p_branch_id)
         and (s.role = 'owner' or s.branch_id = p_branch_id or s.branch_id is null)
     )
  then raise exception 'not_authorized'; end if;

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
  if not private.user_is_platform_admin()
     and not exists (
       select 1 from public.staff_members s
       where s.user_id = v_uid and s.status = 'active' and s.role in ('owner','admin','manager')
         and s.restaurant_id = (select restaurant_id from public.branches where id = w.branch_id)
         and (s.role = 'owner' or s.branch_id = w.branch_id or s.branch_id is null)
     )
  then raise exception 'not_authorized'; end if;
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

  if not private.user_is_platform_admin()
     and not exists (
       select 1 from public.staff_members s
        where s.user_id = v_uid
          and s.status = 'active'
          and s.role in ('owner','admin','manager')
          and s.restaurant_id = (select restaurant_id from public.branches where id = w.branch_id)
          and (s.role = 'owner' or s.branch_id = w.branch_id or s.branch_id is null)
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
  if not private.user_is_platform_admin()
     and not exists (
       select 1 from public.staff_members s
       where s.user_id = v_uid and s.status = 'active' and s.role in ('owner','admin','manager')
         and s.restaurant_id = (select restaurant_id from public.branches where id = w.branch_id)
         and (s.role = 'owner' or s.branch_id = w.branch_id or s.branch_id is null)
     )
  then raise exception 'not_authorized'; end if;
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

CREATE OR REPLACE FUNCTION public.toggle_item_availability(p_item_id uuid, p_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_branch_id uuid;
  v_restaurant_id uuid;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select mi.branch_id, b.restaurant_id into v_branch_id, v_restaurant_id
    from public.menu_items mi join public.branches b on b.id = mi.branch_id
   where mi.id = p_item_id;
  if v_branch_id is null then raise exception 'item_not_found'; end if;
  -- The same roles as before, now scoped the way every other staff check is: an active row at this
  -- restaurant whose branch is this one, or every branch (null), or which is the owner's. The owner
  -- by restaurants.owner_user_id and platform admins come through user_owns_restaurant.
  if not (
    private.user_owns_restaurant(v_restaurant_id)
    or exists (
      select 1 from public.staff_members sm
       where sm.user_id = v_uid
         and sm.status = 'active'
         and sm.restaurant_id = v_restaurant_id
         and sm.role in ('owner','admin','manager','kitchen','cashier')
         and (sm.role = 'owner' or sm.branch_id is null or sm.branch_id = v_branch_id)
    )
  ) then raise exception 'not_authorized'; end if;
  update public.menu_items set is_active = p_active, updated_at = now() where id = p_item_id;
end $function$;

CREATE OR REPLACE FUNCTION public.enqueue_sync_job(p_integration_id uuid, p_kind text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_branch_id uuid;
  v_id uuid;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select branch_id into v_branch_id from public.integrations where id = p_integration_id;
  if v_branch_id is null then raise exception 'integration_not_found'; end if;
  -- Owner-only, as before — but the owner of the restaurant, not only an owner row pinned to this
  -- branch: user_owns_restaurant covers owner_user_id, any active owner row and platform admins.
  if not private.user_owns_restaurant((select restaurant_id from public.branches where id = v_branch_id)) then
    raise exception 'not_authorized';
  end if;

  insert into public.sync_jobs (integration_id, kind, payload)
    values (p_integration_id, p_kind, coalesce(p_payload, '{}'::jsonb))
    returning id into v_id;
  return v_id;
end;
$function$;

commit;
