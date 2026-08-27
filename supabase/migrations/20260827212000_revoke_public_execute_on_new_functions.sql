-- `revoke execute ... from anon` does not do what it looks like it does.
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and `anon`
-- inherits from PUBLIC. Revoking from the role by name leaves the PUBLIC grant intact,
-- so the function stays callable over /rest/v1/rpc/ by an unauthenticated caller. The
-- Supabase advisor flagged exactly this on the functions added in this workstream.
--
-- These are all guarded internally (they check staff_has_capability / auth.uid()), so
-- this is defence in depth rather than a live hole — but an endpoint that should never
-- have been reachable is not one to leave reachable.

revoke execute on function public.advance_self_delivery(uuid, text) from public, anon;
grant  execute on function public.advance_self_delivery(uuid, text) to authenticated;

revoke execute on function public.decide_payment_proof(uuid, boolean, text) from public, anon;
grant  execute on function public.decide_payment_proof(uuid, boolean, text) to authenticated;

revoke execute on function public.submit_payment_proof(uuid, text) from public, anon;
grant  execute on function public.submit_payment_proof(uuid, text) to authenticated;

revoke execute on function public.set_branch_delivery_hours(uuid, jsonb) from public, anon;
grant  execute on function public.set_branch_delivery_hours(uuid, jsonb) to authenticated;

revoke execute on function public.my_capabilities(uuid) from public, anon;
grant  execute on function public.my_capabilities(uuid) to authenticated;

revoke execute on function private.staff_has_capability(uuid, text) from public, anon;
grant  execute on function private.staff_has_capability(uuid, text) to authenticated;

-- Trigger functions have no business being RPC endpoints at all.
revoke execute on function public.tg_block_unpaid_transfer_progress() from public, anon, authenticated;
revoke execute on function public.tg_enforce_delivery_hours() from public, anon, authenticated;

-- Deliberately still readable by anon: the storefront is public and needs to know
-- whether it may offer delivery before anyone signs in.
grant execute on function public.is_delivery_available(uuid, timestamptz) to anon, authenticated;
