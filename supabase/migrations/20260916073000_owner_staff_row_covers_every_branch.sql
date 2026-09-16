-- An owner's staff row covers every branch of their restaurant.
--
-- staff_members.branch_id is where a person signed up, not the limit of what they may touch:
-- private.user_branch_ids() has said so since 20260913110000 ("An owner staff row tied to one
-- branch still owns the whole restaurant"). The two helpers that gate WRITES never got the same
-- treatment — they accept a row only when sm.branch_id is null or equals the branch. So a
-- merchant whose owner row sits on their first branch was, on every later branch:
--   * refused opening hours and closures (RLS on branch_hours / branch_closures),
--   * told "You are not staff of <branch>" in the back office,
--   * refused order notes, menu writes and everything else behind staff_has_capability.
-- The restaurant's own owner_user_id is no help either: a store created by the platform (or
-- transferred) can have a different account there, which is exactly this merchant's case.
--
-- Roles other than owner keep their scope: an admin or manager pinned to one branch still
-- reaches only that branch (or all of them, with a null scope).

begin;

create or replace function private.user_manages_branch(p_branch_id uuid)
 returns boolean
 language sql
 stable security definer
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
         -- An owner owns the restaurant, so every branch of it; the others keep their scope.
         and (sm.role = 'owner' or sm.branch_id is null or sm.branch_id = b.id)
    ),
  false);
$function$;

create or replace function private.staff_has_capability(p_branch_id uuid, p_capability text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    private.user_is_platform_admin()
    or exists (
      select 1
        from public.branches b
        join public.restaurants r on r.id = b.restaurant_id
       where b.id = p_branch_id and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1
        from public.branches b
        join public.staff_members sm on sm.restaurant_id = b.restaurant_id
        join public.role_capabilities rc on rc.role = sm.role::text
       where b.id = p_branch_id
         and sm.user_id = auth.uid()
         and sm.status = 'active'
         and (sm.role = 'owner' or sm.branch_id is null or sm.branch_id = b.id)
         and rc.capability = p_capability
    ),
  false);
$function$;

commit;
