-- The storefront asks this one function "what may this branch sell right now", and
-- every customer surface derives `canDeliver` from it. Folding delivery hours in here
-- means the order-type gate, the checkout payment matrix and the menu all respect the
-- window without each having to learn about it.
--
-- `delivery` now means "sellable right now". `delivery_entitled` is kept separate so
-- the UI can tell "your restaurant never bought delivery" apart from "delivery is
-- closed until 5pm" — those need different words, and merging them would tell a paying
-- merchant their add-on had vanished.
create or replace function public.storefront_status(p_branch_id uuid)
returns jsonb language sql stable security definer set search_path to 'public','pg_temp' as $function$
  select coalesce((
    select jsonb_build_object(
      'entitled',           coalesce(b.entitled_through is not null and b.entitled_through > now(), false),
      'delivery',           coalesce(b.entitled_through > now()
                                     and (be.features -> 'delivery') = to_jsonb(true)
                                     and public.is_delivery_available(b.id), false),
      'delivery_entitled',  coalesce(b.entitled_through > now() and (be.features -> 'delivery') = to_jsonb(true), false),
      'delivery_available', public.is_delivery_available(b.id),
      'delivery_hours_on',  coalesce((b.settings->>'delivery_hours_enabled')::boolean, false),
      'delivery_mode',      coalesce(b.settings->>'delivery_mode', 'platform'),
      'delivery_windows',   coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_delivery_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      'card_payment',       coalesce(b.entitled_through > now() and (be.features -> 'card_payment') = to_jsonb(true), false)
    )
    from public.branches b
    left join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    where b.id = p_branch_id
  ), jsonb_build_object('entitled', false, 'delivery', false, 'delivery_entitled', false,
                        'delivery_available', false, 'delivery_hours_on', false,
                        'delivery_mode', 'platform', 'delivery_windows', '[]'::jsonb,
                        'card_payment', false));
$function$;
