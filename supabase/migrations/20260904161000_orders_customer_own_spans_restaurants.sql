-- A diner cannot read their own order at a second restaurant.
--
-- Customer identity here is per RESTAURANT, not per person: public.customers carries
-- (restaurant_id, user_id) behind customers_restaurant_user_uidx, and both
-- get_or_create_my_customer and place-order lazily create a fresh row the first time a
-- diner orders at a new tenant (supabase/functions/place-order/index.ts:366-377). One
-- phone that has eaten at two restaurants therefore owns two customers rows, and each
-- order is stamped with whichever of them matches the branch it was placed at.
--
-- orders_customer_own compared against private.customer_id_for_user(), which is
--   select id from public.customers where user_id = auth.uid() limit 1
-- -- one arbitrary row, no ordering, no restaurant scope. Whichever row Postgres felt
-- like returning won, and every order belonging to the diner's OTHER customers rows was
-- invisible to them: place-order redirects to /r/<tenant>/<branch>/orders/<number> the
-- moment the order is placed, and that page reads the row through RLS alone
-- (orders/[orderNumber]/page.tsx -> getOrderByNumber), so it 404s on the order they have
-- just paid for. So does its receipt, and so does the live map of a delivery already on
-- its way.
--
-- The predicate becomes set-based. It is not wider in any other direction: it still only
-- ever matches customers rows carrying this caller's own auth.uid(), so no diner gains
-- sight of anybody else's order.
--
-- The set comes from a private helper rather than an inline sub-select on public.customers
-- deliberately. A table referenced inside a policy expression is itself subject to RLS, so
-- an inline sub-select would make every diner's access to their own orders depend on
-- customers keeping a self-select policy -- and the day that policy is narrowed, orders
-- silently disappears for everyone rather than failing loudly. security definer settles
-- the identity question once, the same way private.user_branch_ids() does for staff.
--
-- private.customer_id_for_user() is left alone on purpose: it is referenced by other
-- policies and functions that pre-date this repo's migration history, and turning an
-- identity helper that answers with one id into one that answers with many is not a
-- change those call sites can absorb unread.

create or replace function private.customer_ids_for_user()
returns setof uuid
language sql stable security definer set search_path to 'public','pg_temp' as $function$
  select c.id from public.customers c where c.user_id = (select auth.uid());
$function$;

comment on function private.customer_ids_for_user() is
  'Every customers row belonging to the calling user. Identity is per restaurant, so a diner who has ordered at more than one tenant owns more than one row.';

revoke execute on function private.customer_ids_for_user() from public, anon;
grant  execute on function private.customer_ids_for_user() to authenticated;

-- SELECT only, deliberately. Every write to public.orders comes from place-order (service
-- role) or a security-definer RPC -- cancel_order, submit_payment_proof,
-- decide_payment_proof, progress_delivery. Nothing in apps/web updates an order as the
-- diner, so if the policy being replaced was cmd=ALL that was a hole, not a feature. The
-- staff-side policy on this table (orders_staff) is untouched.
drop policy if exists orders_customer_own on public.orders;

create policy orders_customer_own on public.orders
  for select to authenticated
  using (customer_id in (select private.customer_ids_for_user()));
