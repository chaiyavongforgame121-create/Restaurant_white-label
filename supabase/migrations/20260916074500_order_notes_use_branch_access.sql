-- Saving a diner's note follows the same branch-access rule as everything else.
--
-- admin_edit_order_notes carried its own copy of the old check:
--   exists (select 1 from staff_members
--            where user_id = auth.uid() and branch_id = <order's branch> and role in (...))
-- so on a branch the merchant owns but holds no staff row for, the Customer note dialog
-- answered "not_authorized". It also never checked status, so an invited-not-accepted row
-- counted as access. private.user_branch_ids() is the answer the rest of the back office uses:
-- every branch of a restaurant the caller owns, every branch when their staff row is an owner
-- or scoped to all branches, and their own branch otherwise.

begin;

create or replace function public.admin_edit_order_notes(p_order_id uuid, p_notes text)
 returns orders
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.branch_id not in (select private.user_branch_ids()) then
    raise exception 'not_authorized';
  end if;
  if v_order.status not in ('pending','confirmed','preparing') then
    raise exception 'order_locked_status:%', v_order.status;
  end if;
  update public.orders
     set customer_notes = p_notes
   where id = p_order_id
   returning * into v_order;
  return v_order;
end $function$;

commit;
