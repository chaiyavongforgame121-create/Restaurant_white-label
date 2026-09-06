-- A rider could start an application and then never act on it again.
--
-- driver_approvals had exactly two driver-side policies: insert a pending row
-- (driver_approvals_driver_apply) and read their own rows (driver_approvals_driver_self).
-- No delete and no update. So a rider who tapped Apply on the wrong restaurant was stuck
-- with it for ever, and a rider who was turned down was turned down for ever: UNIQUE
-- (driver_id, branch_id) blocks a second insert and nothing driver-side may move the row
-- that is in the way. The app swallowed that duplicate error, so the button did nothing
-- and said nothing.
--
-- Two narrow additions, matching how every other driver-side write in this schema works:
-- a policy for the trivial case, a security definer function for the one with a rule.

-- Withdraw is only ever the rider's OWN row, and only while it is still pending. Once the
-- merchant has decided, the decision is theirs to keep — and withdrawing an approval would
-- strand the driver_branch_availability row driver_set_branch_online created for it.
drop policy if exists driver_approvals_driver_withdraw on public.driver_approvals;

create policy driver_approvals_driver_withdraw on public.driver_approvals
  for delete to authenticated
  using (driver_id = (select private.driver_id_for_user()) and status = 'pending');

-- Applying again after a rejection. Deliberately NOT an RLS update policy: WITH CHECK can
-- pin the new status to 'pending' but cannot stop the same statement rewriting `notes`,
-- `reviewed_by` or `branch_id`, so a rider could erase the reason they were turned down.
-- This function performs the whole transition itself and nothing else.
--
-- `suspended` is deliberately not re-appliable. That is a live discipline decision by the
-- merchant, and flipping it back to pending would erase it.
create or replace function public.driver_reapply_to_branch(p_branch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_driver   uuid := private.driver_id_for_user();
  v_status   public.driver_approval_status;
  v_reviewed timestamptz;
begin
  if v_driver is null then
    raise exception 'driver_not_found' using errcode = 'P0001';
  end if;

  select status, reviewed_at
    into v_status, v_reviewed
    from public.driver_approvals
   where driver_id = v_driver and branch_id = p_branch_id
     for update;

  if not found then
    raise exception 'no_application' using errcode = 'P0001';
  end if;

  if v_status <> 'rejected' then
    raise exception 'not_rejected' using errcode = 'P0001';
  end if;

  -- The merchant's queue orders by applied_at desc, so an unlimited re-apply lets a
  -- rejected rider sit at the top of it as often as they like. One week between attempts.
  if v_reviewed is not null and v_reviewed > now() - interval '7 days' then
    raise exception 'reapply_too_soon' using errcode = 'P0001';
  end if;

  update public.driver_approvals
     set status      = 'pending',
         applied_at  = now(),
         reviewed_at = null,
         reviewed_by = null,
         notes       = null
   where driver_id = v_driver and branch_id = p_branch_id;

  return jsonb_build_object('branch_id', p_branch_id, 'status', 'pending');
end;
$function$;

revoke execute on function public.driver_reapply_to_branch(uuid) from public, anon;
grant execute on function public.driver_reapply_to_branch(uuid) to authenticated;
