-- Self-delivery: the restaurant delivers with its own staff instead of handing the
-- order to a platform rider. branches.settings.delivery_mode = 'platform' (default,
-- unchanged behaviour) | 'self'.
--
-- The whole delivery lifecycle assumes a rider holding the driver app: driver_id is
-- FK'd to drivers, progress_delivery enforces photo and sequence rules, and the
-- customer's tracking map follows driver_lat/lng. Rather than fake a driver row, self
-- mode keeps the delivery in the branch's hands and gives staff an explicit advance
-- action. The customer still gets status changes; what they do not get is a live map,
-- because there is no device reporting a position.

create or replace function public.orders_after_ready_dispatch()
returns trigger language plpgsql security definer set search_path to 'public','net','private' as $$
declare
  v_url text;
  v_key text;
  v_delivery_id uuid;
  v_mode text;
begin
  if (TG_OP <> 'UPDATE') then return new; end if;
  if new.status is not distinct from old.status then return new; end if;
  if new.status <> 'ready' then return new; end if;
  if new.channel <> 'delivery' then return new; end if;
  if new.held then return new; end if;

  select id into v_delivery_id from public.deliveries where order_id = new.id limit 1;
  if v_delivery_id is null then return new; end if;

  select coalesce(b.settings->>'delivery_mode', 'platform') into v_mode
    from public.branches b where b.id = new.branch_id;

  -- Self-delivery: mark it ready to go out and stop. Leaving it in 'dispatching' would
  -- show the merchant a job for ever waiting on a rider who is never coming.
  if v_mode = 'self' then
    update public.deliveries
       set status = 'assigned'
     where id = v_delivery_id and status in ('pending', 'dispatching');
    return new;
  end if;

  update public.deliveries set status = 'dispatching'
   where id = v_delivery_id and status = 'pending';

  v_url := private.get_setting('supabase_url');
  v_key := private.get_setting('service_role_key');
  if v_url is null or v_key is null then return new; end if;

  perform net.http_post(
    url := v_url || '/functions/v1/dispatch-driver',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_build_object('delivery_id', v_delivery_id, 'order_id', new.id),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

-- Staff-driven advance. Deliberately separate from progress_delivery: that one
-- authorises the assigned RIDER and demands pickup/POD photos from a phone.
create or replace function public.advance_self_delivery(p_delivery_id uuid, p_to text)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare
  v_branch uuid;
  v_order  uuid;
  v_mode   text;
  v_status text;
begin
  select d.branch_id, d.order_id, d.status::text into v_branch, v_order, v_status
    from public.deliveries d where d.id = p_delivery_id;
  if v_branch is null then raise exception 'delivery_not_found' using errcode = 'P0001'; end if;

  if not private.staff_has_capability(v_branch, 'delivery.manage') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select coalesce(b.settings->>'delivery_mode','platform') into v_mode
    from public.branches b where b.id = v_branch;
  if v_mode <> 'self' then
    raise exception 'not_self_delivery' using errcode = 'P0001';
  end if;

  if p_to = 'picked_up' then
    if v_status not in ('assigned','dispatching','pending') then
      raise exception 'bad_transition' using errcode = 'P0001';
    end if;
    update public.deliveries
       set status = 'picked_up', picked_up_at = coalesce(picked_up_at, now())
     where id = p_delivery_id;
    update public.orders set status = 'out_for_delivery'
     where id = v_order and status in ('ready','confirmed','preparing');

  elsif p_to = 'delivered' then
    if v_status <> 'picked_up' then
      raise exception 'bad_transition' using errcode = 'P0001';
    end if;
    update public.deliveries
       set status = 'delivered', delivered_at = coalesce(delivered_at, now())
     where id = p_delivery_id;
    update public.orders set status = 'completed' where id = v_order;

  else
    raise exception 'bad_target' using errcode = 'P0001';
  end if;

  insert into public.audit_logs(branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_branch, auth.uid(), 'staff', 'self_delivery_' || p_to, 'delivery', p_delivery_id, '{}'::jsonb);
end $$;

revoke execute on function public.advance_self_delivery(uuid, text) from anon;
grant execute on function public.advance_self_delivery(uuid, text) to authenticated;
