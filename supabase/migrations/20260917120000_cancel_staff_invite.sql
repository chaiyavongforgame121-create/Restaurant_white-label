-- Cancelling a staff invitation, and closing the table-wide DELETE on staff_members.
--
-- Invitations are now shared as links (LINE, chat), so an owner needs a way to take one back: a
-- link sent to the wrong address, or to someone who left before starting. Until now a pending row
-- could only be overwritten by inviting the same address again.
--
-- The only DELETE route was the policy staff_manager_delete, `private.user_manages_restaurant`,
-- which is true for any active owner, admin OR MANAGER of the restaurant and has no row checks: a
-- manager could delete the owner's or an admin's membership, and nothing in the app deletes staff
-- rows directly (writes already go through trusted code since 20260917090000). The policy is
-- dropped; cancelling goes through this function, which mirrors invite-staff's rules:
--   * the caller is an active owner or admin of the row's restaurant (or its owner of record, or a
--     platform admin);
--   * only the owner cancels an admin invitation, as only the owner can send one;
--   * only a pending row nobody has claimed can be cancelled; a member who joined is not
--     "un-invited" by deleting their row.

create or replace function public.cancel_staff_invite(p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_row         public.staff_members%rowtype;
  v_caller_role text;
begin
  if auth.uid() is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  select * into v_row
    from public.staff_members
   where id = p_staff_id
     for update;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;

  if private.user_is_platform_admin() then
    v_caller_role := 'owner';
  elsif exists (
    select 1 from public.restaurants r
     where r.id = v_row.restaurant_id and r.owner_user_id = auth.uid()
  ) then
    v_caller_role := 'owner';
  else
    select sm.role::text
      into v_caller_role
      from public.staff_members sm
     where sm.restaurant_id = v_row.restaurant_id
       and sm.user_id = auth.uid()
       and sm.status = 'active'
       and sm.role in ('owner', 'admin')
     order by (sm.role = 'owner') desc
     limit 1;
  end if;

  if v_caller_role is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_row.role = 'admin' and v_caller_role <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_row.status <> 'pending' or v_row.user_id is not null then
    raise exception 'invite_not_pending' using errcode = 'P0001';
  end if;

  delete from public.staff_members where id = p_staff_id;

  return jsonb_build_object('staff_id', p_staff_id, 'cancelled', true);
end;
$$;

comment on function public.cancel_staff_invite(uuid) is
  'Deletes a pending, unclaimed staff invitation. Owner or admin of the restaurant (owner only for an admin invitation), or a platform admin.';

revoke execute on function public.cancel_staff_invite(uuid) from public, anon;
grant  execute on function public.cancel_staff_invite(uuid) to authenticated;

drop policy if exists staff_manager_delete on public.staff_members;
