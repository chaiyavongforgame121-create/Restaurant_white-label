-- Accepting a staff invitation could not work.
--
-- The accept page ran a plain UPDATE on staff_members from the browser, filtered on the
-- invitation id and the signed-in account's email, and asked for exactly one row back. Two
-- things guaranteed zero rows, which surfaced as "accept_invite_failed: Cannot coerce the result
-- to a single JSON object":
--
--   1. RLS. The only UPDATE policy on staff_members is staff_manager_update
--      (user_manages_restaurant). A person accepting an invitation manages nothing yet, so their
--      update matched no row — every time, for every invitee.
--   2. private.guard_staff_role_escalation refuses any update where the row is the caller's own
--      and its status changes. Accepting an invitation is exactly that: pending -> active on the
--      row being claimed. So even past RLS, the trigger would have raised.
--
-- Accepting now goes through accept_staff_invite(), which checks what the old filter only
-- implied: the caller's CONFIRMED email is the invited address (an unconfirmed sign-up could
-- otherwise claim an invitation meant for an address it does not own), the invitation is still
-- pending and unclaimed, and the role is not being changed. The trigger allows that one
-- transition and nothing else a person may do to their own row.
--
-- get_staff_invite() lets the accept page say which restaurant and role the link is for, and
-- which address it was sent to, before anyone is signed in. The id is an unguessable UUID that
-- was emailed to that address; the address is only returned while the invitation is open.

begin;

create or replace function private.guard_staff_role_escalation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- No JWT = service role / SQL console / migrations. Trusted by construction.
  if auth.uid() is null or private.user_is_platform_admin() then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.user_id = auth.uid()
     and (new.role is distinct from old.role or new.status is distinct from old.status)
     -- The one change a person may make to their own row: claiming an invitation. It was
     -- pending and unclaimed, it was addressed to this account's confirmed email, it becomes
     -- active, and the role the inviter chose stays exactly as it was.
     and not (
       tg_op = 'UPDATE'
       and old.status = 'pending'
       and old.user_id is null
       and new.status = 'active'
       and new.role = old.role
       and exists (
         select 1 from auth.users u
          where u.id = auth.uid()
            and u.email_confirmed_at is not null
            and lower(u.email) = lower(old.invited_email)
       )
     ) then
    raise exception 'staff_self_role_change_forbidden'
      using hint = 'You cannot change your own role or status.';
  end if;

  if new.role = 'owner'
     and (tg_op = 'INSERT' or new.role is distinct from old.role)
     and not private.user_owns_restaurant(new.restaurant_id) then
    raise exception 'staff_grant_owner_forbidden'
      using hint = 'Only an owner can grant the owner role.';
  end if;

  return new;
end;
$function$;

create or replace function public.get_staff_invite(p_staff_id uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'status', sm.status,
    'role', sm.role,
    -- Only while the invitation is open: once it is used, a forwarded link reveals nothing.
    'invited_email', case when sm.status = 'pending' then sm.invited_email end,
    -- The name the staff screens show: the restaurant's default brand, as the admin header uses.
    'restaurant_name', coalesce(
      (select nullif(trim(br.name), '') from public.brands br
        where br.restaurant_id = r.id order by br.is_default desc, br.created_at asc limit 1),
      nullif(trim(r.brand_settings ->> 'brandName'), ''),
      r.name),
    'branch_name', b.name)
  from public.staff_members sm
  join public.restaurants r on r.id = sm.restaurant_id
  left join public.branches b on b.id = sm.branch_id
  where sm.id = p_staff_id;
$function$;

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
begin
  if v_uid is null then raise exception 'sign_in_required'; end if;

  select lower(u.email), u.email_confirmed_at is not null
    into v_email, v_confirmed
    from auth.users u where u.id = v_uid;

  select * into v_row from public.staff_members where id = p_staff_id for update;
  if not found then raise exception 'invite_not_found'; end if;

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
    -- uniq_staff_user_branch: this account already works at the same branch (or restaurant-wide).
    raise exception 'already_staff_here';
  end;

  return jsonb_build_object('staff_id', v_row.id, 'restaurant_id', v_row.restaurant_id,
    'branch_id', v_row.branch_id, 'role', v_row.role, 'already_accepted', false);
end $function$;

revoke execute on function public.get_staff_invite(uuid) from public;
grant execute on function public.get_staff_invite(uuid) to anon, authenticated;
revoke execute on function public.accept_staff_invite(uuid) from public, anon;
grant execute on function public.accept_staff_invite(uuid) to authenticated;

commit;
