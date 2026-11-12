-- Deleting a removed team member from the Staff page (the owner's report of 2026-11-12: someone
-- whose access was taken away stays on the list for good, as "Removed. Invite them again to give
-- access back", and cannot be deleted). Only a pending invitation had a way off the list (Cancel:
-- public.cancel_staff_invite deletes a pending row nobody has claimed); set_staff_status makes a
-- removed row final and nothing ever deleted one.
--
-- public.delete_removed_staff_member(p_staff_id) -> jsonb (new) deletes one removed row.
--
-- 1. WHO MAY: exactly cancel_staff_invite's checks as live (20260918190000 §7), in the same order:
--      no session: sign_in_required (42501);
--      staff.manage where the row works: its branch (private.staff_has_capability), or, for an
--        owner row or a row with no branch, restaurant-wide authority (the owner through
--        private.user_owns_restaurant, which also passes a platform admin, or an active
--        staff.manage row of that restaurant with no branch): else not_authorized (42501);
--      an owner or admin row is the owner's alone, as only the owner invites an admin:
--        not_authorized (42501).
--    The errors that differ: a missing row is staff_not_found (P0002), as set_staff_status says
--    it; any status but removed is staff_not_removed (P0001), and that row stays. A pending
--    invitation is withdrawn with Cancel, and an active or suspended member is removed first.
--
-- 2. HISTORY STAYS: a removed row that work history points at is kept (staff_has_history, P0001).
--    Five foreign keys reference staff_members(id) on live: orders.staff_id, payments.confirmed_by,
--    table_sessions.opened_by_staff and table_sessions.closed_by_staff (ON DELETE SET NULL), and
--    staff_shifts.staff_member_id (ON DELETE CASCADE). Deleting such a row would wipe who rang up
--    the sale, confirmed the payment or seated the table, and delete the time log outright. A
--    sixth foreign key must be added to the checks below; the test pins the set.
--    The check cannot race a new reference. The row is locked FOR UPDATE before anything is read,
--    and every insert or update that makes a row point at it takes FOR KEY SHARE on it (the
--    foreign key's check), which conflicts with FOR UPDATE: such a write waits for this delete
--    and then fails on the key instead of pointing at a member who is gone. A write that took its
--    FOR KEY SHARE first makes FOR UPDATE wait until it commits, and the checks after it (each
--    statement reads afresh under READ COMMITTED, as PostgREST runs) then see what it wrote.
--
-- 3. AUDIT: one audit_logs row like set_staff_status's (actor_type 'staff', entity_type
--    'staff_member', the row's restaurant and branch), action 'staff_member_deleted', metadata
--    role, invited_email and user_id: the row itself is gone, so the log is what still says who it
--    was.
--
-- 4. INVITING AGAIN: invite-staff looks the address up per (restaurant, email, branch). It revived
--    the removed row; after a delete it finds none and inserts a new pending row, as for someone
--    never invited, and accepting it no longer meets uniq_staff_user_branch, which left with the
--    row. A row kept for its history is still revived as before.
--
-- 5. CANCEL KEEPS HISTORY TOO: public.cancel_staff_invite is re-created from its live definition
--    (20260918190000 §7, read with pg_get_functiondef on 2026-11-12) with the same argument,
--    answer, owner, grants, checks and errors. One thing is new. invite-staff revives a removed row
--    as the new invitation (pending, user_id null), so a member with orders, payments, shifts or
--    sittings on record who is invited again sits on the Staff page as a pending invitation with a
--    Cancel button, and Cancel deleted any pending row: the history this delete keeps went with it
--    (SET NULL on the sale, the payment and the sittings, the shifts CASCADE-deleted), with no audit
--    row. Now a pending row that work history points at is withdrawn by putting it back to removed
--    ({cancelled: true, kept: true}, audited as staff_status_changed pending -> removed), and one
--    with no history is deleted as before ({cancelled: true}). The same lock covers the same race.
--    A Cancel pressed again on such a row (another tab, another admin, a page not yet refreshed)
--    is told invite_already_cancelled (P0001) instead of invite_not_pending, which the Staff page
--    reads as "they joined".
--
-- 6. ACCEPTING KEEPS HISTORY TOO: public.accept_staff_invite is re-created from its live definition
--    (read with pg_get_functiondef on 2026-11-12) with the same argument, answer, owner, grants,
--    checks and errors, and two changes:
--      an invitation put back to removed by Cancel (status removed, nobody's) is invite_not_found,
--        as a deleted one was, so its link says it no longer exists rather than "already used";
--      when the account already has a removed row at that branch (uniq_staff_user_branch), that
--        row comes back as before, and the spent invitation is deleted only if no work history
--        points at it; a revived row with history goes back to removed instead. (Reached when one
--        account holds two rows at a branch, one of them nobody's since invite-staff revived it.)
--
-- 7. THE PERSON'S OWN SCREENS: a removed row gave no access, and a deleted one gives none either.
--    StaffAccessWatcher does not subscribe to DELETEs (realtime delivers them to every subscriber,
--    with the id alone, as it always has for cancel_staff_invite); it re-reads its rows on every
--    reconnect and tab wake, finds one fewer, and reloads an open screen of theirs once, which
--    then shows what it did before (their access was already none).
--
-- Deploy: the migration first, then the admin, whose Delete button calls this function (without
-- it the button only says the delete failed) and whose Cancel reads `kept` and
-- invite_already_cancelled (an older admin drops a kept row from its list until the page reloads,
-- then shows it as removed, and words a second Cancel as a generic failure).
--
-- Rolled-back checks: supabase/tests/delete_removed_staff_member.sql.

begin;

create or replace function public.delete_removed_staff_member(p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_row     public.staff_members%rowtype;
  v_owns    boolean;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  -- Locked first: a write pointing a new order, payment, shift or sitting at this row waits on it.
  select * into v_row
    from public.staff_members
   where id = p_staff_id
     for update;
  if not found then
    raise exception 'staff_not_found' using errcode = 'P0002';
  end if;

  v_owns := private.user_owns_restaurant(v_row.restaurant_id);

  -- cancel_staff_invite's rule: staff.manage at the row's branch. A row with no branch (or an
  -- owner row) works at every branch, so it needs restaurant-wide authority.
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

  -- Only the owner may invite an admin (invite-staff), so only the owner may delete one.
  if v_row.role in ('owner', 'admin') and not v_owns then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if v_row.status <> 'removed' then
    raise exception 'staff_not_removed' using errcode = 'P0001',
      hint = 'Cancel a pending invitation; remove an active or suspended member first.';
  end if;

  -- Every foreign key into staff_members: the work this person did stays attributed to them.
  if exists (select 1 from public.orders o where o.staff_id = v_row.id)
     or exists (select 1 from public.payments p where p.confirmed_by = v_row.id)
     or exists (select 1 from public.staff_shifts s where s.staff_member_id = v_row.id)
     or exists (select 1 from public.table_sessions ts
                 where ts.opened_by_staff = v_row.id or ts.closed_by_staff = v_row.id) then
    raise exception 'staff_has_history' using errcode = 'P0001',
      hint = 'They have orders, payments, shifts or table sittings on record, so they stay on the list. They can still be invited again.';
  end if;

  delete from public.staff_members where id = v_row.id;

  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_row.restaurant_id, v_row.branch_id, v_uid, 'staff', 'staff_member_deleted', 'staff_member', v_row.id,
          jsonb_build_object('role', v_row.role, 'invited_email', v_row.invited_email, 'user_id', v_row.user_id));

  return jsonb_build_object('staff_id', p_staff_id, 'deleted', true);
end;
$function$;

comment on function public.delete_removed_staff_member(uuid) is
  'Deletes a removed team member''s row with no orders, payments, shifts or table sittings pointing at it. Who may: as cancel_staff_invite (staff.manage where the row works; owner and admin rows owner-only). Audited.';

-- As cancel_staff_invite and set_staff_status: the service role reaches it too, and having no
-- auth.uid() it is told to sign in.
revoke all on function public.delete_removed_staff_member(uuid) from public, anon;
grant execute on function public.delete_removed_staff_member(uuid) to authenticated, service_role;

-- cancel_staff_invite as live, plus the history check before the delete (section 5).
create or replace function public.cancel_staff_invite(p_staff_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_row     public.staff_members%rowtype;
  v_owns    boolean;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  select * into v_row
    from public.staff_members
   where id = p_staff_id
     for update;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;

  v_owns := private.user_owns_restaurant(v_row.restaurant_id);

  -- The same rule as set_staff_status: staff.manage at the branch the invitation is for. A row
  -- with no branch (or an owner row) works at every branch, so it needs restaurant-wide
  -- authority. Being an admin of some other branch is not enough.
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

  -- Only the owner may invite an admin (invite-staff), so only the owner may withdraw one.
  if v_row.role in ('owner', 'admin') and not v_owns then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Put back to removed by an earlier Cancel (section 5): the invitation is already withdrawn, and
  -- invite_not_pending would read as "they joined".
  if v_row.status = 'removed' and v_row.user_id is null then
    raise exception 'invite_already_cancelled' using errcode = 'P0001';
  end if;
  if v_row.status <> 'pending' or v_row.user_id is not null then
    raise exception 'invite_not_pending' using errcode = 'P0001';
  end if;

  -- invite-staff revives a removed row as the new invitation, so this one may carry the work the
  -- person did before. Withdrawing it puts it back to removed instead of deleting that history.
  if exists (select 1 from public.orders o where o.staff_id = v_row.id)
     or exists (select 1 from public.payments p where p.confirmed_by = v_row.id)
     or exists (select 1 from public.staff_shifts s where s.staff_member_id = v_row.id)
     or exists (select 1 from public.table_sessions ts
                 where ts.opened_by_staff = v_row.id or ts.closed_by_staff = v_row.id) then
    update public.staff_members set status = 'removed' where id = v_row.id;
    insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
    values (v_row.restaurant_id, v_row.branch_id, v_uid, 'staff', 'staff_status_changed', 'staff_member', v_row.id,
            jsonb_build_object('from_status', 'pending', 'to_status', 'removed', 'role', v_row.role,
                               'user_id', v_row.user_id, 'reason', 'invitation_cancelled_history_kept'));
    return jsonb_build_object('staff_id', p_staff_id, 'cancelled', true, 'kept', true);
  end if;

  delete from public.staff_members where id = p_staff_id;

  return jsonb_build_object('staff_id', p_staff_id, 'cancelled', true);
end;
$function$;

comment on function public.cancel_staff_invite(uuid) is
  'Withdraws a pending, unclaimed staff invitation: deletes it, or puts it back to removed when orders, payments, shifts or table sittings point at it (an invitation revived from a removed member). Owner or admin of the restaurant (owner only for an admin invitation), or a platform admin.';

revoke all on function public.cancel_staff_invite(uuid) from public, anon;
grant execute on function public.cancel_staff_invite(uuid) to authenticated, service_role;

-- accept_staff_invite as live, with the two changes of section 6.
create or replace function public.accept_staff_invite(p_staff_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed boolean;
  v_row public.staff_members%rowtype;
  v_old public.staff_members%rowtype;
begin
  if v_uid is null then raise exception 'sign_in_required'; end if;

  select lower(u.email), u.email_confirmed_at is not null
    into v_email, v_confirmed
    from auth.users u where u.id = v_uid;

  select * into v_row from public.staff_members where id = p_staff_id for update;
  if not found then raise exception 'invite_not_found'; end if;
  -- Withdrawn by Cancel but kept for its history: as gone as a deleted invitation.
  if v_row.status = 'removed' and v_row.user_id is null then raise exception 'invite_not_found'; end if;

  -- Opening the link twice, or reloading the page after accepting, is not an error.
  if v_row.user_id = v_uid and v_row.status = 'active' then
    return jsonb_build_object('staff_id', v_row.id, 'restaurant_id', v_row.restaurant_id,
      'branch_id', v_row.branch_id, 'role', v_row.role, 'already_accepted', true);
  end if;

  if v_row.status <> 'pending' or v_row.user_id is not null then raise exception 'invite_not_pending'; end if;
  if v_email is null or v_email <> lower(v_row.invited_email) then raise exception 'invite_email_mismatch'; end if;
  if not v_confirmed then raise exception 'email_not_confirmed'; end if;

  begin
    update public.staff_members
       set user_id = v_uid, status = 'active', accepted_at = now()
     where id = v_row.id;
  exception when unique_violation then
    -- uniq_staff_user_branch: this account already has a row at the same branch (or
    -- restaurant-wide). A row the owner REMOVED comes back with this invitation's role and
    -- permissions, so the person keeps one row per branch and its history (shifts, sales rung up),
    -- and the spent invitation is deleted, as cancel_staff_invite deletes one. An active or
    -- suspended row is still refused: that person is on the team (Reactivate is on the Staff page).
    select * into v_old
      from public.staff_members
     where user_id = v_uid
       and restaurant_id = v_row.restaurant_id
       and branch_id is not distinct from v_row.branch_id
       and id <> v_row.id
       for update;
    if not found or v_old.status <> 'removed' then
      raise exception 'already_staff_here';
    end if;

    -- guard_staff_role_escalation allows exactly this while the invitation still exists.
    update public.staff_members
       set role = v_row.role,
           permissions = v_row.permissions,
           invited_email = v_row.invited_email,
           invited_at = v_row.invited_at,
           status = 'active',
           accepted_at = now()
     where id = v_old.id;
    -- The invitation may be a removed row invite-staff revived, with the work done on it: that
    -- goes back to removed instead of taking the history with it.
    if exists (select 1 from public.orders o where o.staff_id = v_row.id)
       or exists (select 1 from public.payments p where p.confirmed_by = v_row.id)
       or exists (select 1 from public.staff_shifts s where s.staff_member_id = v_row.id)
       or exists (select 1 from public.table_sessions ts
                   where ts.opened_by_staff = v_row.id or ts.closed_by_staff = v_row.id) then
      update public.staff_members set status = 'removed' where id = v_row.id;
    else
      delete from public.staff_members where id = v_row.id;
    end if;

    return jsonb_build_object('staff_id', v_old.id, 'restaurant_id', v_old.restaurant_id,
      'branch_id', v_old.branch_id, 'role', v_row.role, 'already_accepted', false, 'revived', true);
  end;

  return jsonb_build_object('staff_id', v_row.id, 'restaurant_id', v_row.restaurant_id,
    'branch_id', v_row.branch_id, 'role', v_row.role, 'already_accepted', false);
end $function$;

revoke all on function public.accept_staff_invite(uuid) from public, anon;
grant execute on function public.accept_staff_invite(uuid) to authenticated, service_role;

commit;
