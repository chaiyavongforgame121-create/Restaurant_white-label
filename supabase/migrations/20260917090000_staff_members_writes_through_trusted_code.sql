-- Staff rows are written only by trusted code. A manager could make themselves an admin.
--
-- Found reviewing 20260916150000 and proved live in rolled-back transactions:
--
--   staff_manager_insert / staff_manager_update let any caller for whom
--   private.user_manages_restaurant() is true write staff_members directly — and that helper
--   accepts ANY active manager, ignoring the branch they are scoped to. The escalation guard only
--   looked at a row's role when its user_id was the caller's. So a manager scoped to one branch could:
--     A. INSERT an active admin row with user_id = themselves (older hole, predates this week);
--     B. INSERT a pending admin row addressed to their own email and claim it with
--        accept_staff_invite (new route through the 20260916150000 exemption);
--     C. PATCH the owner's pending invite for someone else to role=admin + their own email, then
--        claim it;
--     D. do the same with role=manager and branch_id null to reach branches never assigned;
--     F. UPDATE their own row's branch_id to null for every branch.
--   invite-staff says only owners and admins may invite and only the owner may add an admin; none of
--   that held for a direct PostgREST write.
--
-- Nothing in the apps writes staff_members directly. Rows come from invite-staff (service role,
-- which enforces who may invite whom), create_restaurant_with_branch, set_staff_branch_scope and
-- accept_staff_invite (all SECURITY DEFINER). So the client write policies go, leaving the table
-- read-only to end users, and the trigger is tightened as a second line in case a policy or a new
-- SECURITY DEFINER function ever lets a client write through again:
--   - the only change a person may make to their own row is claiming an invitation, and the claim
--     may touch nothing but user_id, status, accepted_at and updated_at;
--   - nobody may insert a row for themselves;
--   - only the owner (or a platform admin) may create or change a row into owner/admin, and the
--     claim is checked first so an owner's admin invitation can still be accepted by the invitee.
--
-- Also: uniq_staff_user_branch left restaurant_id out, so someone restaurant-wide at restaurant A
-- could never accept a restaurant-wide invitation from restaurant B (and was told they already work
-- "at this restaurant"). And my_pending_staff_invite() lets the landing route send an invitee who
-- signs in without the link to their invitation instead of the create-a-restaurant wizard.

begin;

drop policy if exists staff_manager_insert on public.staff_members;
drop policy if exists staff_manager_update on public.staff_members;
-- staff_manager_delete stays: removing a person is a manager's job and grants nothing.

create or replace function private.guard_staff_role_escalation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_is_claim boolean := false;
begin
  -- No JWT = service role / SQL console / migrations. Trusted by construction.
  if v_uid is null or private.user_is_platform_admin() then
    return new;
  end if;

  -- Claiming an invitation: pending and unclaimed, addressed to this account's confirmed email,
  -- becoming active as this account — and nothing else about the row changes.
  if tg_op = 'UPDATE' then
    v_is_claim :=
          old.status = 'pending'
      and old.user_id is null
      and new.user_id = v_uid
      and new.status = 'active'
      and new.role = old.role
      and new.branch_id is not distinct from old.branch_id
      and new.restaurant_id = old.restaurant_id
      and new.invited_email is not distinct from old.invited_email
      and new.permissions is not distinct from old.permissions
      and new.pin_hash is not distinct from old.pin_hash
      and exists (
        select 1 from auth.users u
         where u.id = v_uid
           and u.email_confirmed_at is not null
           and lower(u.email) = lower(old.invited_email)
      );
    if v_is_claim then
      return new;
    end if;
  end if;

  if tg_op = 'INSERT' and new.user_id = v_uid and not private.user_owns_restaurant(new.restaurant_id) then
    raise exception 'staff_self_insert_forbidden'
      using hint = 'Staff rows for yourself come from an invitation.';
  end if;

  if tg_op = 'UPDATE'
     and (old.user_id = v_uid or new.user_id = v_uid)
     and (new.role is distinct from old.role
          or new.status is distinct from old.status
          or new.branch_id is distinct from old.branch_id
          or new.user_id is distinct from old.user_id)
     and not private.user_owns_restaurant(new.restaurant_id) then
    raise exception 'staff_self_role_change_forbidden'
      using hint = 'You cannot change your own role, status or branch.';
  end if;

  if new.role in ('owner', 'admin')
     and (tg_op = 'INSERT'
          or new.role is distinct from old.role
          or new.invited_email is distinct from old.invited_email
          or new.branch_id is distinct from old.branch_id
          or new.user_id is distinct from old.user_id)
     and not private.user_owns_restaurant(new.restaurant_id) then
    raise exception 'staff_grant_owner_forbidden'
      using hint = 'Only the owner can create or change an owner or admin.';
  end if;

  return new;
end;
$function$;

drop index if exists public.uniq_staff_user_branch;
create unique index uniq_staff_user_branch on public.staff_members
  (user_id, restaurant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where user_id is not null;

-- The newest open invitation addressed to the signed-in account's confirmed email. Only the id:
-- the landing route redirects to /invite/accept, which shows the details.
create or replace function public.my_pending_staff_invite()
 returns uuid
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select sm.id
    from public.staff_members sm
    join auth.users u on u.id = auth.uid()
   where u.email_confirmed_at is not null
     and lower(u.email) = lower(sm.invited_email)
     and sm.status = 'pending'
     and sm.user_id is null
   order by sm.created_at desc
   limit 1;
$function$;

revoke execute on function public.my_pending_staff_invite() from public, anon;
grant execute on function public.my_pending_staff_invite() to authenticated;

commit;
