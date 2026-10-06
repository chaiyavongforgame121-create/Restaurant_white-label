-- A rider's decline that lands once the offer has run out is the offer expiring, not a decline.
--
-- FavorGO sends reject_dispatch(…, 'timeout') when its countdown ends, so the next rider is asked at
-- once instead of at the next 30-second sweep. That call, or a Decline tapped after the deadline the
-- sweep has not reached yet, was recorded as a decline: the turn ended 'rejected', the history said
-- 'rejected' and a single offer's strike was a 'reject'. It now takes the expiry's labels, the same
-- ones private.expire_dispatch_offers writes: the turn ends 'expired' / 'offer_expired', the history
-- entry is 'offer_expired', and the strike is a 'timeout' (a stack's included, as the sweep does).
-- The cascade is unchanged: the next rider is offered straight away.
--
-- 20261006100000's body otherwise.
create or replace function public.reject_dispatch(p_delivery_id uuid, p_reason text default 'declined')
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_driver_id uuid;
  v_branch uuid;
  v_batch uuid;
  v_row record;
  r record;
  v_redispatch_id uuid;
  v_expired boolean;
begin
  if v_user_id is null then raise exception 'auth_required'; end if;
  select id into v_driver_id from public.drivers where user_id = v_user_id;
  if v_driver_id is null then raise exception 'driver_not_found'; end if;

  select branch_id into v_branch from public.deliveries
   where id = p_delivery_id and driver_id = v_driver_id;
  if not found then raise exception 'forbidden'; end if;
  perform private.dispatch_lock_branch(v_branch);

  select batch_id into v_batch from public.deliveries where id = p_delivery_id;
  perform 1 from public.deliveries x
   where x.id = p_delivery_id or (v_batch is not null and x.batch_id = v_batch)
   order by x.id
   for update;

  select * into v_row from public.deliveries
  where id = p_delivery_id and driver_id = v_driver_id
  for update;
  if not found then raise exception 'forbidden'; end if;
  if v_row.accepted_at is not null then return; end if;
  if v_row.status <> 'assigned' then return; end if;

  -- The phone's countdown decline, or any decline past the server's deadline, is an expiry.
  v_expired := p_reason = 'timeout'
               or (v_row.offer_expires_at is not null and v_row.offer_expires_at <= now());

  if v_row.batch_id is null then
    update public.delivery_assignments
       set ended_at = now(),
           status = case when v_expired then 'expired' else 'rejected' end,
           end_kind = case when v_expired then 'offer_expired' else 'rejected' end,
           end_reason = p_reason
     where delivery_id = p_delivery_id and driver_id = v_driver_id and ended_at is null;

    update public.deliveries
    set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
        dispatch_history = private.dispatch_history_append(dispatch_history,
          jsonb_build_object('type', case when v_expired then 'offer_expired' else 'rejected' end,
                             'at',now(),'reason',p_reason,'driver_id',v_driver_id,
                             'round',dispatch_round_started_at))
    where id = p_delivery_id;
    v_redispatch_id := p_delivery_id;
    perform private.record_driver_penalty(v_driver_id, case when v_expired then 'timeout' else 'reject' end,
                                          p_delivery_id);
  else
    for r in
      select id, batch_seq from public.deliveries
      where batch_id = v_row.batch_id and driver_id = v_driver_id and accepted_at is null
        and status = 'assigned'
      order by id
      for update
    loop
      update public.delivery_assignments
         set ended_at = now(),
             status = case when v_expired then 'expired' else 'rejected' end,
             end_kind = case when v_expired then 'offer_expired' else 'rejected' end,
             end_reason = p_reason
       where delivery_id = r.id and driver_id = v_driver_id and ended_at is null;

      update public.deliveries
      set driver_id = null, status = 'dispatching', offered_at = null, offer_expires_at = null,
          dispatch_history = private.dispatch_history_append(dispatch_history,
            jsonb_build_object('type', case when v_expired then 'offer_expired' else 'rejected' end,
                               'at',now(),'reason',p_reason,'driver_id',v_driver_id,
                               'batch',true,'round',dispatch_round_started_at))
      where id = r.id;
      -- The cascade starts from stop 1 when it was released, else from any stop that was.
      if r.batch_seq = 1 or v_redispatch_id is null then v_redispatch_id := r.id; end if;
    end loop;
    v_redispatch_id := coalesce(v_redispatch_id, p_delivery_id);
    -- Explicit DECLINE of a stacked offer: penalty-free (bigger ask; Deliveroo model).
    -- An expired one (the countdown lapsed): counts once — ignoring an offer strands
    -- customers regardless of batch-ness, matching the server sweep.
    if v_expired then
      perform private.record_driver_penalty(v_driver_id, 'timeout', p_delivery_id);
    end if;
  end if;

  -- D2: the next rider, now. The stack stays a stack (claim_batch_sibling honours it).
  perform private.dispatch_delivery_safely(v_redispatch_id, 'auto');
end;
$function$;

revoke all on function public.reject_dispatch(uuid, text) from public, anon;
grant execute on function public.reject_dispatch(uuid, text) to authenticated, service_role;
