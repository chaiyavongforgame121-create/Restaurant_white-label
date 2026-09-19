-- Changing a team member's role, and telling that person's open screens when it happens.
--
-- A role was fixed at the invitation: turning a cashier into a kitchen hand, or a manager into an
-- admin, meant removing the person and inviting them again, and nothing a signed-in tablet had
-- open noticed any change to its own access until someone reloaded it.
--
-- 1. public.set_staff_role(p_staff_id, p_role). Writes to staff_members go through trusted code
--    (no UPDATE policy exists, so a direct client UPDATE matches no rows), and this is the one
--    route for a role. Who may call it mirrors set_staff_status and set_staff_branch_scope:
--      * staff.manage where the row works. A row with no branch works at every branch, so it
--        needs the owner (user_owns_restaurant: owner of record, an active owner row, or a
--        platform admin) or an admin row of that restaurant with no branch; being an admin of
--        one branch is not enough;
--      * nobody changes their own row (cannot_change_own_role), in any of their rows;
--      * an owner row is never changed here (owner_role_locked): ownership is created by
--        onboarding and is not a role to hand out or take away from a list;
--      * only admin, manager, cashier, kitchen, server or staff can be given
--        (role_not_assignable). Never owner; never driver, whose riders are signed up and
--        approved through the driver app, not promoted from the counter;
--      * only the owner (or a platform admin) may change an admin row or make someone an admin
--        (admin_requires_owner), as only the owner may invite one: an admin must not raise
--        anyone to their own level, nor move another admin down;
--      * a removed row is history (staff_removed); a pending invitation may have its role
--        changed before it is accepted, and the accepted row takes the new role;
--      * the same role again is a no-op that says {changed: false}.
--    The row is locked FOR UPDATE, so two admins pressing Apply at once cannot interleave, and
--    each change writes an audit_logs row the same way set_staff_status does.
--
--    private.guard_staff_role_escalation still runs underneath, with auth.uid() still the
--    caller, so it re-checks this function's write: no self change, and a new owner/admin role
--    only for the owner. It only looked at the NEW role, though, so a definer path that forgot
--    the owner check could have demoted, suspended or moved an admin for a branch admin. It
--    now also refuses a non-owner changing the role, status, branch or account of a row that
--    WAS an owner or admin. Nothing legitimate is refused: set_staff_status,
--    set_staff_branch_scope and this function already keep those rows owner-only, invite-staff
--    writes as the service role, and the two invitation-claim paths return before this check.
--    Direct client writes stay where they were: there is no UPDATE policy at all.
--
-- 2. public.staff_members joins the supabase_realtime publication, so a signed-in person's own
--    screens can subscribe to `user_id=eq.<their id>` and reload when their row changes.
--    What each subscriber receives is still decided by RLS: realtime.apply_rls re-reads the row
--    as the subscriber for every INSERT and UPDATE, so staff_self_read (user_id = auth.uid(), no
--    status condition) delivers a person their own row even after it becomes suspended or
--    removed, and staff_roster_read delivers other rows only to those who can already select
--    them. REPLICA IDENTITY stays DEFAULT: an UPDATE filter is matched against the new row,
--    which the WAL always carries in full, and the watcher compares against what it already
--    knows rather than against old values.
--
--    DELETE events are the exception: realtime.apply_rls delivers them without an RLS check, to
--    any subscriber of the table (anon included), carrying only the primary key. So anyone can
--    learn that some staff_members id was deleted, and when, as they already can for every other
--    table in this publication (orders, order_items, menu_items, ...). Nothing else leaks: under
--    DEFAULT the old tuple is the id alone, so a DELETE filter on any other column never matches
--    and cannot be used as an oracle. The watcher does not subscribe to DELETEs at all: the app
--    never deletes a claimed row (cancel_staff_invite only deletes unclaimed invitations), and
--    it re-reads its own rows on every reconnect and whenever the tab comes back.

create or replace function public.set_staff_role(p_staff_id uuid, p_role public.staff_role)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_uid     uuid := auth.uid();
  v_row     public.staff_members%rowtype;
  v_owns    boolean;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  -- Checked before the row is read, so the answer says nothing about any row.
  if p_role is null or p_role not in ('admin', 'manager', 'cashier', 'kitchen', 'server', 'staff') then
    raise exception 'role_not_assignable' using errcode = '22023',
      hint = 'Use admin, manager, cashier, kitchen, server or staff.';
  end if;

  select * into v_row from public.staff_members where id = p_staff_id for update;
  if not found then
    raise exception 'staff_not_found' using errcode = 'P0002';
  end if;

  v_owns := private.user_owns_restaurant(v_row.restaurant_id);

  -- staff.manage where the row works, exactly as set_staff_status decides it. An owner row names
  -- the branch the owner signed up at but reaches every branch, so it counts as restaurant-wide.
  -- Everything below this check can describe the row, so it comes first.
  if v_row.role = 'owner' or v_row.branch_id is null then
    v_allowed := v_owns or exists (
      select 1
        from public.staff_members sm
        join public.role_capabilities rc on rc.role = sm.role::text and rc.capability = 'staff.manage'
       where sm.restaurant_id = v_row.restaurant_id
         and sm.user_id = v_uid
         and sm.status = 'active'
         and sm.branch_id is null
    );
  else
    v_allowed := private.staff_has_capability(v_row.branch_id, 'staff.manage');
  end if;
  if not v_allowed then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if v_row.user_id = v_uid then
    raise exception 'cannot_change_own_role' using errcode = '42501',
      hint = 'Ask the owner to change your own role.';
  end if;

  if v_row.role = 'owner' then
    raise exception 'owner_role_locked' using errcode = 'P0001',
      hint = 'An owner stays an owner.';
  end if;

  if v_row.status = 'removed' then
    raise exception 'staff_removed' using errcode = 'P0001',
      hint = 'Invite the person again to give them access.';
  end if;

  -- Only the owner may add an admin (invite-staff), so only the owner may make or unmake one.
  if (v_row.role = 'admin' or p_role = 'admin') and not v_owns then
    raise exception 'admin_requires_owner' using errcode = '42501',
      hint = 'Only the owner can make someone an admin or change an admin.';
  end if;

  if v_row.role = p_role then
    return jsonb_build_object('ok', true, 'staff_id', v_row.id, 'role', p_role, 'changed', false);
  end if;

  update public.staff_members set role = p_role where id = v_row.id;

  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_row.restaurant_id, v_row.branch_id, v_uid, 'staff', 'staff_role_changed', 'staff_member', v_row.id,
          jsonb_build_object('user_id', v_row.user_id, 'status', v_row.status,
                             'from_role', v_row.role, 'to_role', p_role));

  return jsonb_build_object('ok', true, 'staff_id', v_row.id, 'role', p_role, 'changed', true);
end;
$$;

comment on function public.set_staff_role(uuid, public.staff_role) is
  'Changes a team member''s role. staff.manage where the row works; never an owner row, never your own, never to owner or driver; admin rows and admin grants are owner-only. Audited.';

revoke all on function public.set_staff_role(uuid, public.staff_role) from public, anon;
grant execute on function public.set_staff_role(uuid, public.staff_role) to authenticated;

-- As live (20260918200000), plus the arm for a row that was an owner or admin before the write.
create or replace function private.guard_staff_role_escalation()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

    -- Accepting an invitation to a branch this account was removed from (accept_staff_invite):
    -- the caller's own removed row becomes active with the role, permissions and address of an
    -- open invitation to the caller's confirmed email at the same restaurant and branch, and
    -- nothing else about it changes.
    v_is_claim :=
          old.status = 'removed'
      and old.user_id = v_uid
      and new.user_id = v_uid
      and new.status = 'active'
      and new.branch_id is not distinct from old.branch_id
      and new.restaurant_id = old.restaurant_id
      and new.pin_hash is not distinct from old.pin_hash
      and exists (
        select 1
          from public.staff_members inv
          join auth.users u on u.id = v_uid
         where inv.id <> old.id
           and inv.status = 'pending'
           and inv.user_id is null
           and inv.restaurant_id = new.restaurant_id
           and inv.branch_id is not distinct from new.branch_id
           and inv.role = new.role
           and inv.permissions is not distinct from new.permissions
           and inv.invited_email is not distinct from new.invited_email
           and u.email_confirmed_at is not null
           and lower(u.email) = lower(inv.invited_email)
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

  if (
       new.role in ('owner', 'admin')
       and (tg_op = 'INSERT'
            or new.role is distinct from old.role
            or new.invited_email is distinct from old.invited_email
            or new.branch_id is distinct from old.branch_id
            or new.user_id is distinct from old.user_id)
     ) or (
       -- Taking an owner or admin down, suspending them or moving them is as owner-only as
       -- making one.
       tg_op = 'UPDATE'
       and old.role in ('owner', 'admin')
       and (new.role is distinct from old.role
            or new.status is distinct from old.status
            or new.branch_id is distinct from old.branch_id
            or new.user_id is distinct from old.user_id)
     ) then
    if not private.user_owns_restaurant(new.restaurant_id) then
      raise exception 'staff_grant_owner_forbidden'
        using hint = 'Only the owner can create or change an owner or admin.';
    end if;
  end if;

  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'staff_members'
  ) then
    alter publication supabase_realtime add table public.staff_members;
  end if;
end $$;
