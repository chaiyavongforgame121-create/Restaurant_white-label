-- The `admin` role was added to staff_role and given 22 capabilities in
-- role_capabilities (owner 24 > admin 22 > manager 18), but these two helpers predate the
-- capability table and still carry a hardcoded role list. They were never updated, so every
-- RLS policy and SECURITY DEFINER function built on them treated an admin as LESS
-- privileged than a manager — silently, because RLS denies by filtering rows out rather
-- than raising.
--
-- Observed on production: an admin clicking Approve on a pending driver got
-- "That didn't save — you may not have permission to review drivers", because
-- driver_approvals_manager_update calls user_manages_branch().
--
-- Reached through these helpers, an admin could not: approve or reject drivers
-- (driver_approvals x3), manage staff (staff_members x3), edit the restaurant
-- (restaurants), manage loyalty rewards (loyalty_rewards), approve a QR transfer slip
-- (decide_payment_proof), write branch settings (guard_branch_privileged_columns), or move
-- the branch pin (set_branch_location).
--
-- user_owns_restaurant is deliberately NOT changed: it is the owner-only tier, and
-- invite-staff already relies on it to keep "only the owner can mint an admin" true.
create or replace function private.user_manages_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    private.user_is_platform_admin()
    or exists (
      select 1
        from public.branches b
        join public.restaurants r on r.id = b.restaurant_id
       where b.id = p_branch_id
         and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1
        from public.branches b
        join public.staff_members sm on sm.restaurant_id = b.restaurant_id
       where b.id = p_branch_id
         and sm.user_id = auth.uid()
         and sm.status = 'active'
         and sm.role in ('owner', 'admin', 'manager')
         and (sm.branch_id is null or sm.branch_id = b.id)
    ),
  false);
$function$;

create or replace function private.user_manages_restaurant(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    private.user_is_platform_admin()
    or exists (
      select 1 from public.restaurants r
       where r.id = p_restaurant_id and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.staff_members sm
       where sm.restaurant_id = p_restaurant_id
         and sm.user_id = auth.uid()
         and sm.status = 'active'
         and sm.role in ('owner', 'admin', 'manager')
    ),
    false);
$function$;

-- These live in `private` and are called from SECURITY DEFINER contexts; PUBLIC must not
-- hold EXECUTE, matching 20260827212000_revoke_public_execute_on_new_functions.sql.
revoke execute on function private.user_manages_branch(uuid) from public, anon;
revoke execute on function private.user_manages_restaurant(uuid) from public, anon;
