-- quote_delivery survives a fractional minute.
--
-- `(s->>'prep_time_min')::int` does not round, it RAISES: '15.5'::int is an error. The
-- delivery settings card writes whatever the merchant types (`step="1"` on a number input
-- is advisory — typing, pasting and scripted changes all bypass it), so one decimal in the
-- prep-time box makes this function throw. quoteDelivery() in the storefront swallows the
-- error and returns null, and place-order's `const { data: q }` ignores it too, so BOTH
-- sides silently fall back to the legacy flat fee: distance pricing AND surge stop working
-- for that branch, with nothing on any screen to say why.
--
-- Rounding instead of casting makes the function total. The admin card now also rounds the
-- minute fields on save, so this is the second lock on the same door — a hand-edited jsonb
-- or an older client can still put a decimal in there.
--
-- Nothing else changes: the radius test, the surge threshold, the fee and their order are
-- byte-identical to 20260830184754_fee_clamps_out_surge_distance_driver_pay_platform.sql.
-- packages/shared/src/utils/delivery-settings.ts mirrors this arithmetic and
-- delivery-settings.test.ts asserts the two agree, reading the newest migration that
-- defines this function to check the text has not moved out from under it.

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
  -- unit the merchant sets it in; 0 (the default) means "from the first metre". Note the
  -- comparison is against the ROUNDED km, so an address exactly on the threshold may or may
  -- not surge depending on which side of the half-metre it fell.
  v_surge_from_km := greatest(0, coalesce((s->>'delivery_surge_from_mi')::numeric, 0)) * 1.609344;
  v_surge := greatest(1, coalesce((s->>'delivery_surge_multiplier')::numeric, 1));
  if v_km < v_surge_from_km then v_surge := 1; end if;

  -- No min/max clamp. The merchant removed both inputs, and a hidden ceiling here would have
  -- kept capping the fee at $9.99 with nothing on any screen to explain it.
  v_fee := coalesce((s->>'delivery_base_fee')::numeric, 2.49)
         + v_km * coalesce((s->>'delivery_per_km_fee')::numeric, 2 / 1.609344);
  v_fee := round(greatest(0, v_fee) * v_surge, 2);

  -- round(...)::int, not ::int: 15.5 minutes must round to 16, not abort the whole quote.
  v_eta := round(coalesce((s->>'prep_time_min')::numeric, 15))::int
         + round(coalesce((s->>'busy_extra_prep_min')::numeric, 0))::int
         + ceil(v_km / 24.0 * 60)::int;

  return jsonb_build_object('deliverable', true, 'distance_km', v_km, 'fee', v_fee, 'eta_min', v_eta, 'surge', v_surge);
end;
$function$;
