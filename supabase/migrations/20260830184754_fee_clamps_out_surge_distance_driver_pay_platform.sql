-- Four owner decisions (2026-08-31), and each one needed a server change to actually take
-- effect. The UI removals alone would have left the old behaviour running invisibly.
--
-- 1. Minimum / maximum delivery fee removed. Deleting the two inputs alone would have left
--    quote_delivery still clamping to its hardcoded 2.99 and 9.99 — an invisible floor and,
--    much worse, an invisible $9.99 ceiling on every long delivery, which the restaurant
--    absorbed. Measured after this change: a 45.75 km quote went from $9.99 to $59.35.
--
-- 2. Surge now starts at a distance. It multiplied every fee including a 0.5 mi hop;
--    delivery_surge_from_mi says how far out it begins. 0 keeps today's behaviour.
--
-- 3. Driver pay moves to the platform. platform_settings.defaults already carries
--    driver_base_pay and driver_per_mile_pay and the platform settings screen already edits
--    them — but staff_assign_driver read branches.settings and fell back to a hardcoded 2.0,
--    so the platform figures were decorative. Removing the per-branch inputs without this
--    would have silently pinned every rider to $2 + $1/mi.
--
-- 4. A QR order now waits for the CUSTOMER to confirm payment. Uploading a slip is no longer
--    the same act as saying "I have paid" — the merchant should not be asked to approve a
--    photo the customer is still replacing.
--
-- The function bodies below are the exact text applied to production; see the sibling
-- migrations for the surrounding history.

create or replace function public.quote_delivery(p_branch_id uuid, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  b record; s jsonb; v_km numeric; v_radius numeric;
  v_surge numeric; v_surge_from_km numeric; v_fee numeric; v_eta int;
begin
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return jsonb_build_object('deliverable', false, 'reason', 'invalid_coordinates');
  end if;

  select geo_location, settings into b from public.branches where id = p_branch_id and is_active;
  if not found or b.geo_location is null then
    return jsonb_build_object('deliverable', false, 'reason', 'branch_unavailable');
  end if;

  if not private.branch_has_feature(p_branch_id, 'delivery') then
    return jsonb_build_object('deliverable', false, 'reason', 'delivery_not_entitled');
  end if;

  s := coalesce(b.settings, '{}'::jsonb);
  v_km := round((ST_Distance(b.geo_location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) / 1000.0)::numeric, 2);
  v_radius := coalesce((s->>'delivery_radius_km')::numeric, 5 * 1.609344);
  if v_km > v_radius then
    return jsonb_build_object('deliverable', false, 'reason', 'out_of_range', 'distance_km', v_km, 'radius_km', v_radius);
  end if;

  -- Surge applies from a distance, not to everything. Stored in miles because that is the
  -- unit the merchant sets it in; 0 (the default) means "from the first metre".
  v_surge_from_km := greatest(0, coalesce((s->>'delivery_surge_from_mi')::numeric, 0)) * 1.609344;
  v_surge := greatest(1, coalesce((s->>'delivery_surge_multiplier')::numeric, 1));
  if v_km < v_surge_from_km then v_surge := 1; end if;

  -- No min/max clamp. The merchant removed both inputs, and a hidden ceiling here would have
  -- kept capping the fee at $9.99 with nothing on any screen to explain it.
  v_fee := coalesce((s->>'delivery_base_fee')::numeric, 2.49)
         + v_km * coalesce((s->>'delivery_per_km_fee')::numeric, 2 / 1.609344);
  v_fee := round(greatest(0, v_fee) * v_surge, 2);

  v_eta := coalesce((s->>'prep_time_min')::int, 15)
         + coalesce((s->>'busy_extra_prep_min')::int, 0)
         + ceil(v_km / 24.0 * 60)::int;

  return jsonb_build_object('deliverable', true, 'distance_km', v_km, 'fee', v_fee, 'eta_min', v_eta, 'surge', v_surge);
end;
$function$;

-- One place decides rider pay, and it is the platform, not each branch.
create or replace function private.driver_pay_rates()
returns table(base_pay numeric, per_km_pay numeric)
language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select
    greatest(0, coalesce((ps.defaults->>'driver_base_pay')::numeric, 2.0)),
    greatest(0, coalesce((ps.defaults->>'driver_per_mile_pay')::numeric, 1.0)) / 1.609344
  from public.platform_settings ps where ps.id = 1
  union all
  select 2.0, 1.0 / 1.609344
  where not exists (select 1 from public.platform_settings where id = 1)
  limit 1;
$function$;

revoke execute on function private.driver_pay_rates() from public, anon;

-- A slip is not a payment. The customer uploads, checks it, replaces it if they got the
-- wrong screenshot, and only then says "I have paid" — which is the moment the merchant is
-- asked to look.
create or replace function public.confirm_payment_proof(p_order_id uuid)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payment_id uuid; v_has_proof boolean;
begin
  select p.id, coalesce(nullif(btrim(p.proof_image_url), ''), null) is not null
    into v_payment_id, v_has_proof
    from public.payments p
    join public.orders o on o.id = p.order_id
    left join public.customers c on c.id = o.customer_id
   where p.order_id = p_order_id and p.method = 'transfer' and c.user_id = auth.uid()
   order by p.created_at desc limit 1;

  if v_payment_id is null then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;
  if not v_has_proof then
    raise exception 'slip_required'
      using errcode = 'P0001', hint = 'Upload a photo of your transfer before confirming.';
  end if;

  update public.payments
     set gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                            || jsonb_build_object('customer_confirmed_at', now(), 'pending', true)
   where id = v_payment_id;
end;
$function$;

revoke execute on function public.confirm_payment_proof(uuid) from public, anon;
grant execute on function public.confirm_payment_proof(uuid) to authenticated;

-- Slips already submitted under the old one-step flow count as confirmed; they were sent
-- with no other way to say so.
update public.payments
   set gateway_metadata = coalesce(gateway_metadata, '{}'::jsonb)
                          || jsonb_build_object('customer_confirmed_at', coalesce(
                               gateway_metadata->>'proof_submitted_at', now()::text))
 where method = 'transfer'
   and coalesce(nullif(btrim(proof_image_url), ''), null) is not null
   and gateway_metadata->>'customer_confirmed_at' is null;

-- Rider pay now comes from private.driver_pay_rates() (platform_settings.defaults) rather
-- than branches.settings with a hardcoded 2.0 fallback. Everything else in these two is
-- unchanged.
create or replace function public.staff_assign_driver(p_delivery_id uuid, p_driver_id uuid)
returns void language plpgsql security definer
set search_path to 'public', 'net', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  d record; v_settings jsonb; v_ttl int; v_base numeric; v_perkm numeric;
  v_earnings numeric; v_now timestamptz := now(); v_expires timestamptz;
  v_tip numeric; v_pct numeric; v_net numeric; v_mode text; v_visible numeric;
begin
  if v_user is null then raise exception 'auth_required'; end if;

  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;

  perform 1 from public.staff_members sm
   where sm.user_id = v_user and sm.branch_id = d.branch_id and sm.status = 'active';
  if not found then raise exception 'forbidden'; end if;

  if d.status not in ('pending','dispatching','assigned') then raise exception 'not_assignable'; end if;
  if d.accepted_at is not null then raise exception 'already_accepted'; end if;

  if d.batch_id is not null then
    update public.deliveries set batch_id = null, batch_seq = null where batch_id = d.batch_id;
  end if;

  perform 1
    from public.drivers dr
    join public.driver_approvals da on da.driver_id = dr.id and da.branch_id = d.branch_id
   where dr.id = p_driver_id and da.status = 'approved' and dr.kyc_status = 'verified';
  if not found then raise exception 'driver_not_eligible'; end if;

  if exists (
    select 1 from public.deliveries del
    where del.driver_id = p_driver_id and del.id <> p_delivery_id
      and del.status in ('assigned','picked_up','in_transit')
  ) then raise exception 'driver_busy'; end if;

  select settings into v_settings from public.branches where id = d.branch_id;
  v_ttl := coalesce((v_settings->>'offer_ttl_seconds')::int, 75);
  -- Platform rates, not per-branch. The branch inputs are gone from the admin.
  select base_pay, per_km_pay into v_base, v_perkm from private.driver_pay_rates();
  v_earnings := least(
    round((v_base + v_perkm * coalesce(d.distance_km, 0))::numeric, 2),
    private.branch_driver_pay_cap(d.branch_id)
  );
  v_expires := v_now + make_interval(secs => v_ttl);

  select coalesce(tip_amount, 0) into v_tip from public.orders where id = d.order_id;
  v_tip := greatest(0, coalesce(v_tip, 0));
  v_pct := greatest(0, least(100,
    coalesce((v_settings->'tip_config'->'delivery'->'distribution'->>'driver')::numeric, 100)));
  v_net := round(v_tip * v_pct / 100.0, 2);
  select tips->>'mode' into v_mode from public.platform_settings where id = 1;
  v_visible := case when v_mode = 'transparent' then round(v_tip, 2) else null end;

  update public.deliveries
  set driver_id = p_driver_id, status = 'assigned', offered_at = v_now,
      offer_expires_at = v_expires, accepted_at = null, driver_earnings = v_earnings,
      net_tip = v_net, tip_visible_total = v_visible,
      dispatch_attempts = coalesce(dispatch_attempts, 0) + 1,
      dispatch_history = coalesce(dispatch_history, '[]'::jsonb)
        || jsonb_build_object('type','offered','manual',true,'driver_id',p_driver_id,'by_user',v_user,'at',v_now)
  where id = p_delivery_id;

  insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
  values (d.branch_id, 'driver', p_driver_id, 'push', 'new_dispatch',
          jsonb_build_object('delivery_id', d.id, 'order_id', d.order_id,
                             'distance_km', d.distance_km, 'earnings', v_earnings,
                             'net_tip', v_net, 'expires_in_seconds', v_ttl, 'manual', true));
end;
$function$;

create or replace function public.accrue_driver_earnings()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_settings jsonb; v_base_setting numeric; v_earnings numeric; v_base numeric; v_distance numeric;
  v_tip numeric; v_tip_net numeric; v_pstart date;
begin
  if new.driver_id is null then return new; end if;
  if new.status is distinct from 'delivered' then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  select settings into v_settings from public.branches where id = new.branch_id;
  -- Same source as the offer, so the ledger split cannot disagree with what was promised.
  select base_pay into v_base_setting from private.driver_pay_rates();

  v_earnings := coalesce(new.driver_earnings, 0);
  v_base     := round(least(v_base_setting, v_earnings), 2);
  v_distance := round(v_earnings - v_base, 2);

  v_tip := coalesce(new.net_tip, 0);
  v_tip_net := round(greatest(0, v_tip), 2);
  v_pstart := date_trunc('week', coalesce(new.delivered_at, now()))::date;

  insert into public.driver_earnings_ledger
    (driver_id, branch_id, delivery_id, order_id, base_pay, distance_pay, tip_net, total,
     status, payout_period_start, payout_period_end, delivered_at)
  values
    (new.driver_id, new.branch_id, new.id, new.order_id, v_base, v_distance, v_tip_net,
     round(v_base + v_distance + v_tip_net, 2),
     'pending', v_pstart, (v_pstart + 6), coalesce(new.delivered_at, now()))
  on conflict do nothing;

  return new;
end;
$function$;
